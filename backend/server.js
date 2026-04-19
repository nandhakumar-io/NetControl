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
    console.warn(`[Master] Worker ${w.process.pid} died (${code}) — restarting`);
    cluster.fork();
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
const { attachSSHProxy }        = require('./services/sshProxy');

if (!fs.existsSync('./logs')) fs.mkdirSync('./logs', { recursive: true });

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

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api', apiLimiter);
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
app.use('/api/metrics',   require('./routes/metrics'));
app.use('/api/alerts',    require('./routes/alerts').router);

// SECURITY FIX: Health endpoint no longer exposes PID, memory, or uptime
// to unauthenticated callers — those are recon aids for an attacker.
// Full diagnostics are available to admins only via /api/health/full.
app.get('/api/health', (_req, res) => res.json({
  status: 'ok',
  time:   new Date().toISOString(),
}));

// ── 404 & error handlers ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
const httpServer = http.createServer(app);
attachSSHProxy(httpServer);

const PORT = process.env.PORT || 4000;

async function boot() {
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 NetControl worker ${process.pid} on port ${PORT}`);
    console.log(`   Environment : ${process.env.NODE_ENV || 'development'}`);
    console.log(`   CORS origin : ${process.env.CORS_ORIGIN || 'http://localhost:5173'}\n`);
    loadAllSchedules();
    statusPoller.start();
  });
}

boot().catch(err => {
  console.error('[Boot] Fatal:', err.message);
  process.exit(1);
});

module.exports = app;
