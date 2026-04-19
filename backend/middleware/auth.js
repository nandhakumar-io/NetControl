// middleware/auth.js — JWT verification + role guard + action PIN verification
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { queryOne } = require('../db');
require('dotenv').config();

/**
 * Middleware: Verify JWT access token from Authorization header.
 * Also checks the DB to ensure the user is still enabled — catching
 * the case where an admin disables a user who still holds a valid token.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Live DB check: reject immediately if the account has been disabled
    const liveUser = await queryOne(
      'SELECT id, username, role, enabled FROM users WHERE id = ?',
      [payload.id]
    );
    if (!liveUser || !liveUser.enabled) {
      return res.status(403).json({ error: 'Account is disabled.', code: 'ACCOUNT_DISABLED' });
    }

    // Attach fresh data (role may have changed too)
    req.user = { ...payload, role: liveUser.role };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Middleware factory: restrict access to specific roles.
 * Usage: router.delete('/:id', requireAuth, requireRole('admin'), handler)
 *
 * Built-in role hierarchy:
 *   admin    — full access
 *   operator — can run device actions; cannot manage users/settings
 *   viewer   — read-only; cannot run actions or manage anything
 *
 * Custom roles stored in DB also pass through here — the permissions
 * bitmask is checked per-route using requirePermission() instead.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: roles,
        current: req.user.role,
      });
    }
    next();
  };
}

/**
 * Middleware factory: check a specific permission bit for custom roles.
 * Permission bits are stored as an integer on the users row (permissions column).
 *
 * Bit map (powers of 2):
 *   1   - view_devices
 *   2   - manage_devices      (add / edit / delete)
 *   4   - run_actions         (wake / shutdown / restart)
 *   8   - view_groups
 *   16  - manage_groups
 *   32  - view_schedules
 *   64  - manage_schedules
 *   128 - view_audit
 *   256 - manage_users        (admin only by convention)
 *   512 - manage_roles        (admin only by convention)
 *
 * Admins always pass; operators pass bits 1|4|8|32; viewers pass 1|8|32|128.
 */
const ROLE_PERMISSIONS = {
  admin:    0xFFFF, // all bits
  operator: 1 | 4 | 8 | 32 | 128,
  viewer:   1 | 8 | 32 | 128,
};

function requirePermission(bit) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });

    // Built-in roles use the static map
    const staticPerms = ROLE_PERMISSIONS[req.user.role];
    const perms = staticPerms !== undefined ? staticPerms : (req.user.permissions || 0);

    if ((perms & bit) === 0) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * Middleware: Verify action PIN from request body.
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

module.exports = { requireAuth, requireRole, requirePermission, requireActionPin, ROLE_PERMISSIONS };

