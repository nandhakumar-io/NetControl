// middleware/auth.js — JWT verification + role guard + action PIN verification
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { queryOne, execute } = require('../db');
const bus = require('../services/bus');
const { redisReady, withRedisTimeout } = require('../services/redisSafe');
require('dotenv').config();

// ── Personal/automation API keys ─────────────────────────────────────────────
// These are distinct from the per-device agent keys used by routes/metrics.js
// (prefix 'nca_', looked up against devices.agent_key_hash). Long-lived
// scoped keys for scripts/Terraform/CI use their own prefix ('nck_') and
// their own table (api_keys) so revoking a script's key can never touch a
// device's agent registration, and vice versa. See routes/apiKeys.js.
const API_KEY_PREFIX = 'nck_';
function hashApiKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }

// ── Force-revoke denylist ─────────────────────────────────────────────────────
// A forced admin revoke (POST /api/sessions/user/:id/revoke-all) only marks
// refresh_tokens as revoked, which blocks the next /api/auth/refresh — the
// access token itself is a stateless JWT and stays valid until it naturally
// expires (up to JWT_EXPIRY, 8h by default). That's a long window for a
// token an admin just tried to kill because of a suspected compromise.
//
// This adds a cheap denylist: `revokeUserTokens(userId)` stamps "anything
// issued before right now is dead" for that user, and requireAuth rejects
// any JWT whose `iat` is at or before that stamp — so a force-revoke takes
// effect on the very next request, not at natural token expiry.
//
// Same dual-mode pattern as the action-PIN limiter below this file: real
// Redis (via bus.js's shared client, so the stamp is visible to every
// worker/process) when configured, in-memory Map fallback for single-
// process/dev. The TTL is bounded by JWT_EXPIRY, since nothing older than
// that could still be a live token anyway — no need to remember it forever.
function jwtExpirySeconds() {
  const raw = process.env.JWT_EXPIRY || '8h';
  const m = /^(\d+)\s*([smhd])?$/i.exec(String(raw).trim());
  if (!m) return 8 * 3600;
  const n = parseInt(m[1], 10);
  switch ((m[2] || 's').toLowerCase()) {
    case 'd': return n * 86400;
    case 'h': return n * 3600;
    case 'm': return n * 60;
    default:  return n;
  }
}
const TOKEN_DENYLIST_TTL_SEC = jwtExpirySeconds();
const denylistLocal = new Map(); // userId -> revokedAtEpochSec

/**
 * Denylist every access token currently held by `userId`, effective
 * immediately. Called from POST /api/sessions/user/:id/revoke-all — the
 * refresh-token revoke there already stops re-issuance; this stops the
 * live JWT too.
 */
async function revokeUserTokens(userId) {
  const now = Math.floor(Date.now() / 1000);
  const redis = bus.getClient();
  if (redisReady(redis, bus)) {
    try {
      await withRedisTimeout(redis.set(`revoke:${userId}`, String(now), 'EX', TOKEN_DENYLIST_TTL_SEC));
      return;
    } catch (e) {
      console.error('[Auth] revokeUserTokens: Redis write failed, falling back to in-memory:', e.message);
    }
  }
  denylistLocal.set(userId, now);
}

/** True if a token for `userId` issued at `issuedAt` (JWT `iat`, seconds) has been force-revoked. */
async function isTokenRevoked(userId, issuedAt) {
  if (!issuedAt) return false;
  const redis = bus.getClient();
  if (redisReady(redis, bus)) {
    try {
      const val = await withRedisTimeout(redis.get(`revoke:${userId}`));
      if (val === null || val === undefined) return false;
      return issuedAt <= parseInt(val, 10);
    } catch (e) {
      console.error('[Auth] isTokenRevoked: Redis read failed, falling back to in-memory:', e.message);
    }
  }
  const revokedAt = denylistLocal.get(userId);
  if (revokedAt === undefined) return false;
  return issuedAt <= revokedAt;
}

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
    // EventSource (used for GET /api/alerts/stream) can't set custom
    // headers, so the frontend passes the JWT as ?token=... instead of an
    // Authorization header. Without this, every SSE connection 401'd
    // silently (EventSource retries invisibly rather than surfacing an
    // error), so live push notifications never arrived — the bell only
    // ever reflected whatever GET /alerts/notifications loaded on mount,
    // making it look like notifications only "showed up after a refresh".
    const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
    if (!authHeader && queryToken) {
      const payload = jwt.verify(queryToken, process.env.JWT_SECRET);
      const liveUser = await queryOne(
        'SELECT id, username, role, enabled, permissions, active_org_id FROM users WHERE id = ?',
        [payload.id]
      );
      if (!liveUser || !liveUser.enabled) {
        return res.status(403).json({ error: 'Account is disabled.', code: 'ACCOUNT_DISABLED' });
      }
      if (await isTokenRevoked(payload.id, payload.iat)) {
        return res.status(401).json({ error: 'Session was revoked. Please sign in again.', code: 'TOKEN_REVOKED' });
      }
      req.user = {
        ...payload, role: liveUser.role, permissions: liveUser.permissions || 0,
        activeOrgId: liveUser.active_org_id || null,
      };
      return next();
    }

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const payload = jwt.verify(token, process.env.JWT_SECRET);

      // Live DB check: reject immediately if the account has been disabled
      const liveUser = await queryOne(
        'SELECT id, username, role, enabled, permissions, active_org_id FROM users WHERE id = ?',
        [payload.id]
      );
      if (!liveUser || !liveUser.enabled) {
        return res.status(403).json({ error: 'Account is disabled.', code: 'ACCOUNT_DISABLED' });
      }
      if (await isTokenRevoked(payload.id, payload.iat)) {
        return res.status(401).json({ error: 'Session was revoked. Please sign in again.', code: 'TOKEN_REVOKED' });
      }

      // Attach fresh data (role/permissions may have changed since the token was issued)
      req.user = {
        ...payload, role: liveUser.role, permissions: liveUser.permissions || 0,
        activeOrgId: liveUser.active_org_id || null,
      };
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
 *   32768 - manage_runbooks    (create/edit/test auto-remediation runbooks
 *                                that alert rules can trigger to run
 *                                arbitrary commands on a device UNATTENDED
 *                                — admin only by convention; deliberately
 *                                its own bit rather than reusing
 *                                manage_process_policies, since granting one
 *                                should not silently grant the other)
 *   65536 - manage_synthetic_checks (create/edit/run/delete HTTP/TCP/SSH
 *                                health checks against a device — admin
 *                                only by convention)
 *
 * Admins always pass; operators pass bits 1|4|8|32; viewers pass 1|8|32|128.
 */
const ROLE_PERMISSIONS = {
  // BUG FIX: this was 0xFFFF (bits 0-15 only), which stops at 32768
  // (manage_runbooks) — so the 65536 bit added for manage_synthetic_checks
  // fell outside the mask entirely and admins got 403'd trying to use
  // their own instance's Health Checks feature. 0x1FFFFF covers every bit
  // defined above with room for a few more before this needs touching
  // again; "admin always passes" should hold for any bit added here.
  admin:    0x1FFFFF, // all bits
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
 * Action-PIN attempt limiter — deliberately separate from services/bruteForce.js.
 * That module bans by IP and its lockout also blocks *login*; reusing it here
 * would mean a handful of wrong action-PIN guesses locks a legitimate operator
 * out of signing in entirely, which is a worse outage than the problem being
 * solved. This tracks failures per-user (not per-IP, since a shared office IP
 * shouldn't lock out everyone) via the same Redis client bus.js already
 * manages, so the count is consistent across every worker — same reasoning
 * as bruteForce.js's own fix for that. Falls back to an in-memory Map when
 * Redis isn't configured (single-process/dev).
 */
const PIN_THRESHOLD   = parseInt(process.env.PIN_ATTEMPT_THRESHOLD || '5', 10);
const PIN_WINDOW_SEC  = parseInt(process.env.PIN_ATTEMPT_WINDOW_SEC || '300', 10);   // 5 min
const PIN_LOCKOUT_SEC = parseInt(process.env.PIN_LOCKOUT_SEC || '900', 10);          // 15 min

const pinRedis = bus.getClient(); // null in single-process fallback mode
const pinAttemptsLocal = new Map();  // userId -> [timestamp, ...]
const pinLockoutsLocal = new Map();  // userId -> expiresAtEpochSec

function cleanLocalPinAttempts(userId) {
  const cutoff = Math.floor(Date.now() / 1000) - PIN_WINDOW_SEC;
  const fresh = (pinAttemptsLocal.get(userId) || []).filter(ts => ts > cutoff);
  if (fresh.length) pinAttemptsLocal.set(userId, fresh);
  else pinAttemptsLocal.delete(userId);
  return fresh;
}

async function isPinLocked(userId) {
  const now = Math.floor(Date.now() / 1000);
  if (pinRedis) {
    const expiresAt = await pinRedis.get(`pinlock:${userId}`).catch(() => null);
    if (!expiresAt) return { locked: false };
    return { locked: true, remaining: parseInt(expiresAt, 10) - now };
  }
  const expiresAt = pinLockoutsLocal.get(userId);
  if (!expiresAt || expiresAt <= now) { pinLockoutsLocal.delete(userId); return { locked: false }; }
  return { locked: true, remaining: expiresAt - now };
}

async function recordPinFailure(userId) {
  const now = Math.floor(Date.now() / 1000);
  let count;
  if (pinRedis) {
    const key = `pinattempts:${userId}`;
    count = await pinRedis.incr(key);
    if (count === 1) await pinRedis.expire(key, PIN_WINDOW_SEC);
  } else {
    const fresh = cleanLocalPinAttempts(userId);
    fresh.push(now);
    pinAttemptsLocal.set(userId, fresh);
    count = fresh.length;
  }
  if (count >= PIN_THRESHOLD) {
    const expiresAt = now + PIN_LOCKOUT_SEC;
    if (pinRedis) {
      await pinRedis.set(`pinlock:${userId}`, String(expiresAt), 'EX', PIN_LOCKOUT_SEC);
      await pinRedis.del(`pinattempts:${userId}`).catch(() => {});
    } else {
      pinLockoutsLocal.set(userId, expiresAt);
      pinAttemptsLocal.delete(userId);
    }
    console.warn(`[ActionPin] Locked out user ${userId} for ${Math.round(PIN_LOCKOUT_SEC / 60)}min after ${count} bad PIN attempts`);
  }
}

async function clearPinFailures(userId) {
  if (pinRedis) { await pinRedis.del(`pinattempts:${userId}`).catch(() => {}); return; }
  pinAttemptsLocal.delete(userId);
}

/**
 * Middleware: Verify action PIN from request body, with lockout after
 * repeated bad guesses so the shared PIN can't be brute-forced by a
 * logged-in-but-untrusted session (e.g. a stolen/leaked JWT with a valid
 * role but no PIN knowledge).
 */
async function requireActionPin(req, res, next) {
  const { actionPin } = req.body;
  const userId = req.user?.id;

  if (userId) {
    const lock = await isPinLocked(userId);
    if (lock.locked) {
      return res.status(429).json({
        error: `Too many incorrect PIN attempts. Try again in ${Math.ceil(lock.remaining / 60)} minute(s).`,
        code: 'PIN_LOCKED',
      });
    }
  }

  if (!actionPin || typeof actionPin !== 'string') {
    return res.status(403).json({ error: 'Action PIN required' });
  }

  const pinHash = process.env.ACTION_PIN_HASH;
  if (!pinHash) {
    return res.status(500).json({ error: 'Action PIN not configured on server' });
  }

  const valid = await bcrypt.compare(actionPin, pinHash);
  if (!valid) {
    if (userId) await recordPinFailure(userId);
    return res.status(403).json({ error: 'Invalid action PIN' });
  }

  if (userId) await clearPinFailures(userId);
  next();
}

module.exports = {
  requireAuth, requireRole, requirePermission, requireActionPin, ROLE_PERMISSIONS,
  API_KEY_PREFIX, hashApiKey, revokeUserTokens, isTokenRevoked,
};