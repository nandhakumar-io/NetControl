// server.js — NetControl Backend — optimised for 32GB/14-core/800 agents
'use strict';
require('dotenv').config();

const cluster = require('cluster');
const os      = require('os');

// ── Cluster mode in production ────────────────────────────────────────────────
// Spawn one worker per 2 CPU cores (leaves headroom for MySQL, OS, agents).
// Each worker handles HTTP + WebSocket independently.
// SSE notification bus uses in-memory Map per-worker — acceptable because
// each browser client is pinned to one worker. For multi-worker SSE sharing,
// use Redis pub/sub (see env REDIS_URL).
const WORKERS = process.env.NODE_ENV === 'production'
  ? Math.min(parseInt(process.env.WEB_WORKERS) || Math.ceil(os.cpus().length / 2), 8)
  : 1;

if (cluster.isPrimary && WORKERS > 1) {
  console.log(`[Master] Spawning ${WORKERS} workers on ${os.cpus().length} cores`);
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  cluster.on('exit', (w, code) => {
    console.warn(`[Master] Worker ${w.process.pid} died (${code}) — restarting in 2s`);
    // Small delay before respawn: if the crash is caused by something
    // persistent (DB down, missing table, bad config), forking immediately
    // creates a tight infinite crash loop — hundreds of new DB pools spun up
    // and torn down per second, burning CPU and DB connections without ever
    // giving the underlying problem a chance to be noticed/fixed.
    setTimeout(() => cluster.fork(), 2000);
  });
  return; // master process exits here
}

// ── Worker / single-process boot ─────────────────────────────────────────────
const express      = require('express');
const http         = require('http');
const helmet       = require('helmet');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const compression  = require('compression');
const fs           = require('fs');

const { apiLimiter, bulkImportLimiter } = require('./middleware/rateLimiter');
const { loadAllSchedules }      = require('./services/scheduler');
const statusPoller              = require('./services/statusPoller');
const complianceService          = require('./services/complianceService');
const { attachSSHProxy }        = require('./services/sshProxy');

if (!fs.existsSync('./logs')) fs.mkdirSync('./logs', { recursive: true });

// Safety net: an unguarded rejected promise anywhere at boot (or later)
// otherwise crashes the whole Node process by default since Node 15+.
// Log it loudly instead of taking the worker down — individual routes/
// services should still handle their own errors properly; this is a
// last-resort backstop, not a substitute for that.
process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err);
});

const app = express();

// ── Gzip compression — major win for JSON API responses ──────────────────────
app.use(compression({ level: 4, threshold: 1024 }));

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin:         process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials:    true,
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'X-Metrics-Key'],
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
app.set('trust proxy', 1);

// ── Real IP ───────────────────────────────────────────────────────────────────
// SECURITY FIX: x-forwarded-for can be spoofed by clients.
// Only use it when NODE_ENV=production (i.e. actually behind a reverse proxy).
// In development, use req.ip directly to avoid spoofed IP bypass of rate limits.
app.use((req, _res, next) => {
  if (process.env.NODE_ENV === 'production') {
    const fwd = req.headers['x-forwarded-for'];
    req.realIp = fwd ? String(fwd).split(',')[0].trim() : (req.ip || 'unknown');
  } else {
    req.realIp = req.ip || 'unknown';
  }
  next();
});

// ── Soft identity peek (rate-limiting only) ──────────────────────────────────
// apiLimiter's keyGenerator wants req.user.id so each signed-in user gets
// their own bucket, but requireAuth only runs later, per-route. Without this,
// req.user is always undefined here and every request falls back to req.ip —
// which means everyone behind the same NAT/VPN/proxy IP shares ONE bucket.
// This does a non-enforcing JWT decode (no DB hit, no 401 on failure) purely
// so the limiter can key by user. Real auth/enabled checks still happen in
// requireAuth further down the chain — this changes nothing about security.
const jwt = require('jsonwebtoken');
app.use((req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
      req.user = { id: payload.id };
    } catch { /* invalid/expired — fall back to IP in the limiter; requireAuth rejects it properly later */ }
  }
  next();
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Auth-session endpoints (refresh, google status, logout) are excluded — they
// must keep working even when a busy dashboard has used up the general API
// budget, otherwise a 429 there cascades into a forced logout / a Google
// button that looks "unavailable" when it's really just rate-limited.
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/refresh' || req.path === '/auth/google/status' || req.path === '/auth/logout') return next();
  return apiLimiter(req, res, next);
});
app.use('/api/devices/bulk-import', bulkImportLimiter);

// ── Disabled-account check ────────────────────────────────────────────────────
const { queryOne } = require('./db');
async function rejectDisabled(req, res, next) {
  if (!req.user) return next();
  try {
    const user = await queryOne('SELECT enabled FROM users WHERE id = ?', [req.user.id]);
    if (!user || user.enabled === 0)
      return res.status(403).json({ error: 'Account disabled. Contact an administrator.' });
    next();
  } catch { next(); }
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api',           rejectDisabled);
app.use('/api/devices',   require('./routes/devices'));
app.use('/api/groups',    require('./routes/groups'));
app.use('/api/actions',   require('./routes/actions'));
app.use('/api/schedules', require('./routes/schedules'));
app.use('/api/audit',     require('./routes/audit'));
app.use('/api/file-push', require('./routes/filePush'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/security',   require('./routes/security'));
app.use('/api/metrics',   require('./routes/metrics'));
app.use('/api/alerts',    require('./routes/alerts').router);
app.use('/api/discovery', require('./routes/discovery'));
app.use('/api/compliance', require('./routes/compliance'));
app.use('/api/process-policies', require('./routes/processPolicies'));

// BUG FIX: services/webTerminal.js implements the HTTP-relay fallback used
// by the terminal page (/api/terminal/open/:id, the SSE output stream, and
// the agent polling endpoints) but was never mounted here. Only the direct
// WebSocket SSH proxy (attachSSHProxy, below) was attached. That meant any
// time the WebSocket SSH path failed and the frontend fell back to the HTTP
// relay, every relay call hit the catch-all 404 handler below — exactly the
// "Relay failed: Not found" / "status code 404" error shown in the UI.
app.use('/api/terminal',  require('./services/webTerminal').router);

// SECURITY FIX: Health endpoint no longer exposes PID, memory, or uptime
// to unauthenticated callers — those are recon aids for an attacker.
// Full diagnostics are available to admins only via /api/health/full.
app.get('/api/health', (_req, res) => res.json({
  status: 'ok',
  time:   new Date().toISOString(),
}));

// ── GET /api/health/full — admin-only deep diagnostics ───────────────────────
// Exists specifically so "agent is sending metrics but the dashboard shows
// it offline / no data" can be diagnosed from the app itself. That symptom
// is almost always the Redis bus being down or misconfigured (see
// services/bus.js): without it, each clustered web worker only sees
// metrics/status changes that arrived on ITS OWN process, so whichever
// worker a given browser request lands on may simply never have heard
// about a device another worker is actively receiving agent POSTs for.
app.get('/api/health/full', require('./middleware/auth').requireAuth, require('./middleware/auth').requireRole('admin'), async (_req, res) => {
  const { ping: dbPing } = require('./db');
  const bus = require('./services/bus');

  const [dbOk, busStatus] = await Promise.all([
    dbPing(),
    Promise.resolve(bus.getStatus()),
  ]);

  const healthy = dbOk && (busStatus.mode !== 'redis' || busStatus.connected);

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    time:   new Date().toISOString(),
    pid:    process.pid,
    uptimeSec: Math.round(process.uptime()),
    checks: {
      database: { connected: dbOk },
      bus: {
        ...busStatus,
        note: busStatus.mode === 'in-process-fallback'
          ? 'REDIS_URL is not set on this worker — cross-worker metric/status sync is OFF. Fine for a single-process/dev setup only.'
          : busStatus.connected
            ? 'Redis reachable — metrics and device-status changes sync across all web workers.'
            : 'REDIS_URL is set but Redis is NOT reachable right now — cross-worker sync is broken. Agents may appear offline/silent on some workers while genuinely online.',
      },
    },
  });
});

// ── 404 & error handlers ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
const httpServer = http.createServer(app);
attachSSHProxy(httpServer);

const PORT = process.env.PORT || 8000;

async function boot() {
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 NetControl worker ${process.pid} on port ${PORT}`);
    console.log(`   Environment : ${process.env.NODE_ENV || 'development'}`);
    console.log(`   CORS origin : ${process.env.CORS_ORIGIN || 'http://localhost:5173'}\n`);

    // PROCESS_ROLE=web (default) | all
    // In production, polling/scheduling/compliance run in their own
    // `poller` process (see poller.js) so they run exactly ONCE regardless
    // of how many clustered web workers are handling HTTP traffic. Before
    // this change, every worker called these independently — with
    // WORKERS>1 that meant scheduled wake/shutdown/etc actions fired once
    // PER WORKER, and the status poller ran N times in parallel hammering
    // the same devices. PROCESS_ROLE=all restores the old single-process
    // behaviour for local dev where there's no separate poller container.
    const role = process.env.PROCESS_ROLE || 'web';
    if (role === 'all') {
      loadAllSchedules();
      statusPoller.start();
      complianceService.start();
    }
  });
}

boot().catch(err => {
  console.error('[Boot] Fatal:', err.message);
  process.exit(1);
});

module.exports = app;