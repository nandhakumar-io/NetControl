// middleware/auth.js — JWT verification + role guard + action PIN verification
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { queryOne, execute } = require('../db');
require('dotenv').config();

// ── Personal/automation API keys ─────────────────────────────────────────────
// These are distinct from the per-device agent keys used by routes/metrics.js
// (prefix 'nca_', looked up against devices.agent_key_hash). Long-lived
// scoped keys for scripts/Terraform/CI use their own prefix ('nck_') and
// their own table (api_keys) so revoking a script's key can never touch a
// device's agent registration, and vice versa. See routes/apiKeys.js.
const API_KEY_PREFIX = 'nck_';
function hashApiKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }

// Fire-and-forget last-used stamp — must never slow down or fail the request
// that's using the key.
function touchApiKey(id, ip) {
  execute('UPDATE api_keys SET last_used_at = UNIX_TIMESTAMP(), last_used_ip = ? WHERE id = ?', [ip || null, id])
    .catch(() => {});
}

async function authenticateApiKey(req) {
  const raw = req.headers['x-api-key'];
  if (!raw || !raw.startsWith(API_KEY_PREFIX)) return null;

  const keyHash = hashApiKey(raw);
  const row = await queryOne(
    `SELECT ak.id AS key_id, ak.permissions AS key_permissions, ak.expires_at, ak.revoked,
            u.id, u.username, u.role, u.enabled
       FROM api_keys ak JOIN users u ON u.id = ak.user_id
      WHERE ak.key_hash = ?`,
    [keyHash]
  );
  if (!row || row.revoked || !row.enabled) return null;
  if (row.expires_at && row.expires_at < Math.floor(Date.now() / 1000)) return null;

  touchApiKey(row.key_id, req.realIp || req.ip);

  // A key's permissions were fixed (possibly narrowed) at creation time —
  // it never inherits permission changes later granted to the owning user,
  // so a compromised script key is bounded by what it was issued for.
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    permissions: row.key_permissions,
    apiKeyId: row.key_id,
  };
}

/**
 * Middleware: Verify JWT access token from Authorization header, OR a
 * long-lived personal API key (X-Api-Key: nck_...) for scripts/CI. Also
 * checks the DB to ensure the user is still enabled — catching the case
 * where an admin disables a user who still holds a valid token/key.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  try {
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const payload = jwt.verify(token, process.env.JWT_SECRET);

      // Live DB check: reject immediately if the account has been disabled
      const liveUser = await queryOne(
        'SELECT id, username, role, enabled, permissions FROM users WHERE id = ?',
        [payload.id]
      );
      if (!liveUser || !liveUser.enabled) {
        return res.status(403).json({ error: 'Account is disabled.', code: 'ACCOUNT_DISABLED' });
      }

      // Attach fresh data (role/permissions may have changed since the token was issued)
      req.user = { ...payload, role: liveUser.role, permissions: liveUser.permissions || 0 };
      return next();
    }

    if (req.headers['x-api-key']) {
      const apiUser = await authenticateApiKey(req);
      if (!apiUser) return res.status(401).json({ error: 'Invalid or expired API key' });
      req.user = apiUser;
      return next();
    }

    return res.status(401).json({ error: 'Authentication required' });
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
 *   256  - manage_users        (admin only by convention)
 *   512  - manage_roles        (admin only by convention)
 *   1024 - discover_network    (ping sweep / SNMP / nmap / LLDP-CDP scans —
 *                                admin only by convention; deliberately not
 *                                granted to operator/viewer by default since
 *                                network scanning is more sensitive than
 *                                routine device management)
 *   2048 - manage_compliance   (config-drift baselines/snapshots — admin
 *                                only by convention, same reasoning as
 *                                discover_network: this touches every
 *                                device's package/service/firewall state)
 *   4096 - manage_process_policies (restricted-program rules + kill
 *                                actions on agents — admin only by
 *                                convention; this can terminate arbitrary
 *                                processes on end-user machines)
 *   8192 - manage_backups      (browse BACKUP_ROOT, create/download/delete
 *                                archives — admin only by convention, same
 *                                reasoning as discover_network/compliance:
 *                                this reads arbitrary files under the
 *                                sanctioned tree and writes to disk)
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

module.exports = {
  requireAuth, requireRole, requirePermission, requireActionPin, ROLE_PERMISSIONS,
  API_KEY_PREFIX, hashApiKey,
};