// middleware/rateLimiter.js — Tuned for 32GB/14-core server + 300-800 agents
'use strict';
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// ── Window ─────────────────────────────────────────────────────────────────────
const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;

// ── Detect agent requests ─────────────────────────────────────────────────────
const isAgent = (req) => !!(req.headers['x-api-key'] || req.headers['x-metrics-key']);

// ── General browser/dashboard limiter ────────────────────────────────────────
// Agents are fully skipped — they have dedicated limiters below.
// 800 agents × 12 req/min browser tabs = comfortable with 3000/15min.
const apiLimiter = rateLimit({
  windowMs,
  max:            parseInt(process.env.RATE_LIMIT_MAX) || 3000,
  standardHeaders: true, legacyHeaders: false,
  message:        { error: 'Too many requests, please slow down' },
  skip:           (req) => isAgent(req),
  keyGenerator:   (req) => req.user?.id || req.ip,
});

// ── Agent metrics ingest ──────────────────────────────────────────────────────
// 800 agents × 12/min = 9600/min peak. Per-key bucket → each device independent.
// 60/min per key = one push every second — far more than needed (default 5s).
const agentIngestLimiter = rateLimit({
  windowMs:       60 * 1000,
  max:            parseInt(process.env.AGENT_INGEST_LIMIT) || 60,
  standardHeaders: true, legacyHeaders: false,
  keyGenerator:   (req) => req.headers['x-api-key'] || req.ip,
  message:        { error: 'Agent posting too frequently' },
  skip:           () => false,
});

// ── Agent relay (terminal I/O polling) ────────────────────────────────────────
// Active shell sessions generate heavy output. 6000/min per key.
const agentRelayLimiter = rateLimit({
  windowMs:       60 * 1000,
  max:            parseInt(process.env.AGENT_RELAY_LIMIT) || 6000,
  standardHeaders: true, legacyHeaders: false,
  keyGenerator:   (req) => req.headers['x-api-key'] || req.ip,
  message:        { error: 'Terminal relay rate limit exceeded' },
});

// ── Power actions ─────────────────────────────────────────────────────────────
const actionLimiter = rateLimit({
  windowMs,
  max:            parseInt(process.env.ACTION_RATE_LIMIT_MAX) || 1000,
  standardHeaders: true, legacyHeaders: false,
  message:        { error: 'Too many action requests' },
  keyGenerator:   (req) => req.user?.id || req.ip,
});

// ── Auth ──────────────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs:       15 * 60 * 1000,
  max:            10,
  standardHeaders: true, legacyHeaders: false,
  message:        { error: 'Too many login attempts' },
});

// ── Bulk import ───────────────────────────────────────────────────────────────
const bulkImportLimiter = rateLimit({
  windowMs:       15 * 60 * 1000,
  max:            parseInt(process.env.BULK_IMPORT_RATE_LIMIT_MAX) || 10,
  standardHeaders: true, legacyHeaders: false,
  message:        { error: 'Too many bulk import requests' },
  keyGenerator:   (req) => req.user?.id || req.ip,
});

// ── Registration ──────────────────────────────────────────────────────────────
// 800 agents rebooting simultaneously = 800 registrations at once.
// 1000/15min per IP (lab router) is safe.
const registerLimiter = rateLimit({
  windowMs:       15 * 60 * 1000,
  max:            parseInt(process.env.REGISTER_RATE_LIMIT) || 1000,
  standardHeaders: true, legacyHeaders: false,
  message:        { error: 'Too many registration attempts' },
  keyGenerator:   (req) => req.ip,
});

module.exports = {
  apiLimiter, actionLimiter, authLimiter,
  bulkImportLimiter, agentIngestLimiter,
  agentRelayLimiter, registerLimiter,
};
