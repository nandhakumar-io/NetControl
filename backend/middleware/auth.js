// middleware/auth.js — JWT verification + action PIN verification
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

/**
 * Middleware: Verify JWT access token from Authorization header.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Middleware: Verify action PIN from request body.
 * The client must send { actionPin: "..." } alongside every destructive action.
 * The PIN hash lives in env — it's a server-level secret, not per-user.
 */
async function requireActionPin(req, res, next) {
  const { actionPin } = req.body;
  if (!actionPin || typeof actionPin !== 'string') {
    return res.status(403).json({ error: 'Action PIN required' });
  }

  const pinHash = process.env.ACTION_PIN_HASH;
  if (!pinHash) {
    return res.status(500).json({ error: 'Action PIN not configured on server' });
  }

  const valid = await bcrypt.compare(actionPin, pinHash);
  if (!valid) {
    return res.status(403).json({ error: 'Invalid action PIN' });
  }

  next();
}

module.exports = { requireAuth, requireActionPin };