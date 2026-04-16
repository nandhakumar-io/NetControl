// middleware/rateLimiter.js
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;

// General API limiter
const apiLimiter = rateLimit({
  windowMs,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down' },
});

// Stricter limiter for power actions
const actionLimiter = rateLimit({
  windowMs,
  max: parseInt(process.env.ACTION_RATE_LIMIT_MAX) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many action requests, please slow down' },
  keyGenerator: (req) => req.user?.id || req.ip, // per-user limit
});

// Very strict limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts' },
});

module.exports = { apiLimiter, actionLimiter, authLimiter };