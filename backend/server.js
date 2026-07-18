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

const { apiLimiter, bulkImportLimiter, apiKeyLimiter, isPersonalApiKey } = require('./middleware/rateLimiter');
const { loadAllSchedules }      = require('./services/scheduler');
const statusPoller              = require('./services/statusPoller');
const complianceService          = require('./services/complianceService');
const capacityForecast           = require('./services/capacityForecast');
const scheduledJobs             = require('./services/scheduledJobs');
const { attachSSHProxy }        = require('./services/sshProxy');

if (!fs.existsSync('./logs')) fs.mkdirSync('./logs', { recursive: true });

// ── Required env validation ───────────────────────────────────────────────────
// PRODUCTION FIX: previously a missing JWT_SECRET / DB_PASSWORD / encryption
// key was only discovered the first time a route touched it — sometimes
// minutes into uptime, behind a 500 that gave no hint why. Real deployments
// (Docker/Proxmox/Traefik, not localhost) are exactly where a `.env` typo or
// an unset secret in the compose file goes unnoticed until it bites. Failing
// immediately at boot with a clear message beats a mysterious runtime crash.
const REQUIRED_ENV = ['JWT_SECRET', 'DB_PASSWORD', 'CREDENTIAL_ENCRYPTION_KEY'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error(`\n❌ Missing required environment variable(s): ${missingEnv.join(', ')}`);
  console.error('   Set these in backend/.env (or the container/compose env) before starting.\n');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && (process.env.CORS_ORIGIN || '').includes('localhost')) {
  console.warn('⚠  CORS_ORIGIN still points at localhost while NODE_ENV=production — the browser will be blocked. Set it to your real domain(s).');
}

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
// IMPORTANT: never compress an SSE stream. compression's default filter
// treats any "text/*" content-type (including text/event-stream) as
// compressible, so without an exclusion it wraps the stream response in a
// gzip Transform that buffers output waiting to fill its window. That
// silently breaks real-time flushing of keep-alive pings and live event
// pushes on every SSE endpoint in this app — the proxy in front of this
// (nginx/traefik) then sees long gaps with no bytes and kills the
// connection on its read timeout, which looks like "updates never show up"
// / a stream that endlessly reconnects, even though the server is actively
// writing to the response every few seconds.
//
// BUG FIX: this used to be a hand-maintained list of exact/regex path
// checks (metrics/stream, the terminal relay's output feed) — every time a
// new SSE endpoint was added elsewhere in the app, it had to remember to
// add itself here too, or it would silently get gzip-buffered. That's
// exactly what happened to routes/bulkCommand.js's GET /:runId/stream and
// routes/alerts.js's GET /stream: both were missing from this list, so the
// Bulk Command console's device_start/device_result events were being
// written by res.write() but sitting in the gzip Transform's buffer
// instead of reaching the browser — the console just looked like every
// device was stuck "Queued" forever, even though the run had already
// executed and completed server-side (check the audit log during a "stuck"
// run — it's there). Match on Content-Type instead: any handler that has
// already set text/event-stream is exempt, full stop, regardless of path.
app.use(compression({
  level: 4,
  threshold: 1024,
  filter: (req, res) => {
    if (res.getHeader('Content-Type') === 'text/event-stream') return false;
    return compression.filter(req, res);
  },
}));

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
// PRODUCTION FIX: a real deployment usually has more than one origin that
// needs to talk to the API (e.g. https://netcontrol.example.com AND
// https://www.example.com, or a staging subdomain) — CORS_ORIGIN used to be
// a single string, so only the first ever worked. Comma-separate multiple
// origins in the env var; a single origin still works exactly as before.
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // No Origin header (curl, server-to-server, same-origin) — allow.
    if (!origin) return callback(null, true);
    if (corsOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials:    true,
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'X-Metrics-Key'],
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
// trust proxy = 2: there are TWO reverse-proxy hops between the real client
// and this process — Traefik, then nginx (frontend) — and nginx's
// `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` appends its
// own connecting peer (Traefik's container IP) onto the chain. With this
// set to 1, Express only walked back one hop and resolved req.ip to that
// constant internal container IP for EVERY client, instead of each client's
// real public IP. Since express-rate-limit's default keyGenerator (and
// authLimiter specifically, which has no per-agent skip/bypass) buckets by
// req.ip, that collapsed EVERY browser and EVERY agent onto one shared rate
// limit bucket — heavy agent/API traffic could exhaust it and lock out
// real admin logins with 429s that had nothing to do with their own
// request volume. If you add/remove a reverse-proxy layer in front of this
// app, this number must be updated to match, or rate limiting silently
// breaks the same way again.
app.set('trust proxy', Number.isInteger(parseInt(process.env.TRUST_PROXY_HOPS)) ? parseInt(process.env.TRUST_PROXY_HOPS) : 2);

// ── Real IP ───────────────────────────────────────────────────────────────────
// SECURITY FIX: this used to take X-Forwarded-For.split(',')[0] — the
// LEFTMOST entry. XFF is built up left-to-right as a request passes through
// proxies (each hop appends its peer's address), so the leftmost entry is
// whatever the ORIGINAL CLIENT put there, which is fully attacker-controlled.
// A request could carry `X-Forwarded-For: 1.2.3.4` from the client itself,
// and nginx would append the real hop after it — taking [0] used the spoofed
// value, not the trusted one. That silently defeated IP-based brute-force
// banning (rotate the header, never get banned), the IP allowlist (spoof an
// allowed address), and poisoned the audit log's recorded source IP.
// `req.ip` (set by Express) already does this correctly: with `trust proxy`
// set to the exact number of real proxy hops (above), it walks in from the
// RIGHT side of the XFF chain by that many hops, which is the only part of
// the header proxies — not clients — can write. Use that instead of
// re-parsing the header ourselves.
app.use((req, _res, next) => {
  req.realIp = req.ip || 'unknown';
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
//
// BUG FIX: /api/metrics/stream (the dashboard's SSE feed) used to fall
// through into this same apiLimiter, keyed per-user. It's meant to be one
// long-lived connection, but as the comments on the /stream handler itself
// already note, a proxy read-timeout or an expired token mid-stream makes
// the frontend reconnect it repeatedly — and every reconnect burned one
// request out of that user's shared 3000/15min budget. A short reconnect
// storm (a flaky proxy hop, a laptop waking from sleep, several dashboard
// tabs open) could exhaust it in minutes, after which literally every other
// API call for that user — devices, groups, everything — started 429ing:
// "Too many requests" / "failed to load" across the whole app, with the
// actual cause invisible because it was the *stream* burning the budget,
// not whatever the person was trying to click on. It now gets its own
// dedicated, generous limiter (see sseStreamLimiter in rateLimiter.js)
// instead of sharing the general one.
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/refresh' || req.path === '/auth/google/status' || req.path === '/auth/logout') return next();
  if (req.path === '/metrics/stream') return next();
  // Same reasoning as /metrics/stream: this is a long-lived SSE connection
  // (the terminal relay's output feed), not a one-off API call, so it
  // shouldn't burn the shared apiLimiter budget every time nginx/Cloudflare
  // reconnects it. Previously missing here, so a flaky relay connection
  // (or several open terminal tabs) could exhaust a user's whole API quota
  // via reconnect storms — same failure mode metrics/stream used to have.
  if (/^\/terminal\/session\/[^/]+\/output$/.test(req.path)) return next();
  // Personal/CI API keys (nck_...) get their own per-key budget instead of
  // apiLimiter's per-user/per-IP one — see isPersonalApiKey in rateLimiter.js.
  if (isPersonalApiKey(req)) return apiKeyLimiter(req, res, next);
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
app.use('/api/orgs',      require('./routes/orgs'));
app.use('/api/runbooks',  require('./routes/runbooks'));
app.use('/api/devices',   require('./routes/devices'));
app.use('/api/search',    require('./routes/search'));
app.use('/api/groups',    require('./routes/groups'));
app.use('/api/actions',   require('./routes/actions'));
app.use('/api/schedules', require('./routes/schedules'));
app.use('/api/audit',     require('./routes/audit'));
app.use('/api/file-push', require('./routes/filePush'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/api-keys',  require('./routes/apiKeys'));
app.use('/api/security',   require('./routes/security'));
app.use('/api/metrics',   require('./routes/metrics'));
app.use('/api/alerts',    require('./routes/alerts').router);
app.use('/api/discovery', require('./routes/discovery'));
app.use('/api/synthetic-checks', require('./routes/syntheticChecks'));
app.use('/api/compliance', require('./routes/compliance'));
app.use('/api/capacity-forecast', require('./routes/capacityForecast'));
app.use('/api/agent-release', require('./routes/agentRelease'));
app.use('/api/bulk-command', require('./routes/bulkCommand'));
app.use('/api/saved-views', require('./routes/savedViews'));
app.use('/api/process-policies', require('./routes/processPolicies'));
app.use('/api/backup',   require('./routes/backup'));
app.use('/api/sla-reports', require('./routes/slaReports'));
app.use('/api/sla-report-schedules', require('./routes/slaReportSchedules'));
const { backupSchedulesRouter, logExportSchedulesRouter } = require('./routes/scheduledJobs');
app.use('/api/backup-schedules',     backupSchedulesRouter);
app.use('/api/log-export-schedules', logExportSchedulesRouter);
app.use('/api/digest', require('./routes/digest'));
app.use('/api/push',   require('./routes/push'));
app.use('/api/notification-prefs', require('./routes/notificationPrefs'));
app.use('/api/bulk-command-schedules', require('./routes/bulkCommandSchedules'));
app.use('/api/ops-calendar', require('./routes/opsCalendar'));

// BUG FIX: services/webTerminal.js implements the HTTP-relay fallback used
// by the terminal page (/api/terminal/open/:id, the SSE output stream, and
// the agent polling endpoints) but was never mounted here. Only the direct
// WebSocket SSH proxy (attachSSHProxy, below) was attached. That meant any
// time the WebSocket SSH path failed and the frontend fell back to the HTTP
// relay, every relay call hit the catch-all 404 handler below — exactly the
// "Relay failed: Not found" / "status code 404" error shown in the UI.
app.use('/api/terminal',  require('./services/webTerminal').router);
app.use('/api/wol-relay', require('./routes/wolRelay'));

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
  const { ping: dbPing, queryOne } = require('./db');
  const bus = require('./services/bus');

  const [dbOk, busStatus, heartbeat] = await Promise.all([
    dbPing(),
    Promise.resolve(bus.getStatus()),
    queryOne('SELECT last_run_at, devices_polled, cycle_ms, pid FROM poller_heartbeat WHERE id = 1').catch(() => null),
  ]);

  // POLLER_STALE_SEC: the poll loop ticks every 5s (statusPoller.js); 30s
  // is 6 missed cycles in a row, comfortably past a single slow tick, so
  // this only fires for an actually-dead process, not jitter.
  const POLLER_STALE_SEC = 30;
  const nowSec = Math.floor(Date.now() / 1000);
  const pollerAgeSec = heartbeat ? nowSec - heartbeat.last_run_at : null;
  const pollerAlive = heartbeat != null && pollerAgeSec <= POLLER_STALE_SEC;

  const healthy = dbOk && (busStatus.mode !== 'redis' || busStatus.connected) && pollerAlive;

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
      // Device status polling, scheduled backups/log-exports, and digests
      // all live exclusively in the separate `poller` process (poller.js)
      // — never in this web-tier process. If that process is down, none
      // of those run and there's otherwise no error anywhere to see —
      // devices just silently stay stuck on whatever status they last had
      // (often "unknown" for anything added since it died), and scheduled
      // exports/backups just show "Never run" forever. This is the
      // authoritative way to tell "is the poller actually alive" instead
      // of inferring it from those symptoms.
      poller: heartbeat == null
        ? { alive: false, note: 'No heartbeat row found yet — either the poller process has never completed a single cycle, or db/migrate-poller-heartbeat.js hasn\'t been run. Run `node db/migrate.js`, then check the poller container/process logs.' }
        : {
            alive: pollerAlive,
            lastRunSecondsAgo: pollerAgeSec,
            devicesPolled: heartbeat.devices_polled,
            lastCycleMs: heartbeat.cycle_ms,
            pid: heartbeat.pid,
            note: pollerAlive
              ? 'Poller is alive and completing poll cycles on schedule.'
              : `No poll cycle in the last ${pollerAgeSec}s (expected every ~5s) — the poller process is very likely crashed, not started, or stuck. Devices will stay on their last known status and scheduled backups/log exports/digests will not run until it's restarted.`,
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
      capacityForecast.start();
      scheduledJobs.start();
    }
  });
}

boot().catch(err => {
  console.error('[Boot] Fatal:', err.message);
  process.exit(1);
});

module.exports = app;