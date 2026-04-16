// server.js — NetControl Backend
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const fs = require('fs');

const { apiLimiter } = require('./middleware/rateLimiter');
const { loadAllSchedules } = require('./services/scheduler');

// Ensure logs directory exists
if (!fs.existsSync('./logs')) fs.mkdirSync('./logs', { recursive: true });

const app = express();

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Body / Cookie parsing ─────────────────────────────────────────────────────
app.use(express.json({ limit: '50kb' })); // Prevent huge payloads
app.use(cookieParser());

// ── Trust proxy (if behind nginx/load balancer) ───────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// ── Global rate limiting ──────────────────────────────────────────────────────
app.use('/api', apiLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/devices',   require('./routes/devices'));
app.use('/api/groups',    require('./routes/groups'));
app.use('/api/actions',   require('./routes/actions'));
app.use('/api/schedules', require('./routes/schedules'));
app.use('/api/audit',     require('./routes/audit'));
app.use('/api/file-push', require('./routes/filePush'));

// Health check (no auth needed)
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── 404 & Error handlers ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 NetControl backend running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Allowed origin: ${process.env.CORS_ORIGIN || 'http://localhost:5173'}\n`);

  // Load scheduled tasks
  loadAllSchedules();
});

module.exports = app;    