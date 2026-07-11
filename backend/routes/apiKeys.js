// routes/apiKeys.js — Long-lived scoped API keys for scripts/Terraform/CI
//
// These are deliberately NOT sessions: no refresh token, no expiring-JWT
// dance, no login event. A key is a bearer credential a user generates for
// themselves (name, optional expiry, optional narrowed permission bitmask)
// and hands to a script/CI pipeline via the X-Api-Key header. See
// middleware/auth.js (authenticateApiKey) for how it's verified on each
// request, and middleware/rateLimiter.js (apiKeyLimiter) for its own rate
// budget separate from human dashboard traffic.
//
// The raw key is only ever returned once, at creation. Only its SHA-256
// hash is stored (api_keys.key_hash), the same treatment as agent_key_hash
// and refresh_tokens.token_hash elsewhere in this codebase.
'use strict';
const express = require('express');
const crypto  = require('crypto');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth, API_KEY_PREFIX, hashApiKey, ROLE_PERMISSIONS } = require('../middleware/auth');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth);

function genApiKey() { return API_KEY_PREFIX + crypto.randomBytes(24).toString('hex'); }

const KEY_FIELDS = `id, name, key_prefix, permissions, created_at, expires_at,
  last_used_at, last_used_ip, revoked, revoked_at`;

// ── GET /api/api-keys — list the caller's own keys ────────────────────────────
// Never returns key_hash or the raw key — only enough to recognize a key
// (name + first characters) and see whether/when it's been used.
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT ${KEY_FIELDS} FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

// ── POST /api/api-keys — create a new key ─────────────────────────────────────
// permissions is optional and, if provided, is ANDed against the caller's
// own current permissions — a key can never be granted more than its
// creator already has, and an operator/viewer can still self-serve a
// narrowly-scoped key for their own scripts without admin involvement.
router.post('/',
  body('name').trim().notEmpty().isLength({ max: 100 }).withMessage('Name is required'),
  body('expiresInDays').optional({ nullable: true }).isInt({ min: 1, max: 3650 }),
  body('permissions').optional({ nullable: true }).isInt({ min: 0 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
      // SECURITY/BUG FIX: this used to read req.user.permissions directly,
      // but that DB column only holds meaningful bits for role='custom' —
      // built-in roles (admin/operator/viewer) get their real permission
      // bits from the static ROLE_PERMISSIONS map in middleware/auth.js
      // (see requirePermission()), and typically have permissions=0 in the
      // DB since it's unused for them. Reading the column directly meant
      // every key created by a normal admin/operator/viewer account came
      // out scoped to 0 — a silently useless key. The `?? 0xFFFF` fallback
      // was also a landmine: if req.user.permissions were ever undefined
      // on some other auth path, it would mint a FULL-permission key
      // regardless of the creator's actual role. Resolve permissions the
      // same way requirePermission() does, and fail closed (0) rather than
      // open (0xFFFF) if nothing resolves.
      const callerPerms = ROLE_PERMISSIONS[req.user.role] !== undefined
        ? ROLE_PERMISSIONS[req.user.role]
        : (req.user.permissions || 0);
      const requested = req.body.permissions !== undefined && req.body.permissions !== null
        ? parseInt(req.body.permissions)
        : callerPerms;
      const scopedPermissions = requested & callerPerms;

      const rawKey = genApiKey();
      const id = uuidv4();
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = req.body.expiresInDays
        ? now + (parseInt(req.body.expiresInDays) * 86400)
        : null;

      await execute(
        `INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, permissions, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.user.id, req.body.name, rawKey.slice(0, 12), hashApiKey(rawKey), scopedPermissions, now, expiresAt]
      );

      await audit.log({
        userId: req.user.id, username: req.user.username, action: 'create_api_key',
        targetType: 'api_key', targetId: id, targetName: req.body.name,
        ipSource: req.realIp || req.ip, result: 'success',
      });

      // Only time the raw key is ever available — the client must save it now.
      res.status(201).json({
        id, name: req.body.name, key: rawKey, permissions: scopedPermissions,
        expiresAt, createdAt: now,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to create API key' });
    }
  }
);

// ── DELETE /api/api-keys/:id — revoke a key ───────────────────────────────────
// Soft-revoke (not a hard delete) so the audit trail and last-used history
// survive; authenticateApiKey() checks the revoked flag on every request.
router.delete('/:id', async (req, res) => {
  try {
    const key = await queryOne('SELECT id, name FROM api_keys WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!key) return res.status(404).json({ error: 'API key not found' });

    await execute('UPDATE api_keys SET revoked = 1, revoked_at = UNIX_TIMESTAMP() WHERE id = ?', [req.params.id]);

    await audit.log({
      userId: req.user.id, username: req.user.username, action: 'revoke_api_key',
      targetType: 'api_key', targetId: key.id, targetName: key.name,
      ipSource: req.realIp || req.ip, result: 'success',
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

module.exports = router;