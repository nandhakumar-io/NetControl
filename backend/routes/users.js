// routes/users.js — User management (admin only)
const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth);

// ── Helpers ──────────────────────────────────────────────────────────────────
function sanitizeUser(u) {
  const { password, ...safe } = u;
  return safe;
}

// Columns safe to return to the client. google_linked is derived so we never
// leak the raw Google subject id, just whether an account is linked.
const USER_FIELDS = `id, username, email, display_name, role, permissions, enabled,
  has_password, totp_enabled, (google_id IS NOT NULL) AS google_linked, created_at, last_login`;

// ── POST /api/users/me/change-password — any authenticated user ──────────────
// Used to satisfy must_change_password after the random one-time admin
// password is generated at setup, and generally available so any user can
// rotate their own password without admin involvement.
router.post('/me/change-password',
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const valid = await bcrypt.compare(req.body.currentPassword, user.password || '');
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

      const hash = await bcrypt.hash(req.body.newPassword, 12);
      await execute(
        'UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?',
        [hash, req.user.id]
      );
      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'change_own_password', targetType: 'user', targetId: req.user.id,
        targetName: req.user.username, ipSource: req.realIp, result: 'success',
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ── Two-factor authentication (TOTP) — self-service ───────────────────────────
const twoFactor = require('../services/twoFactor');

// GET /api/users/me/2fa/status — is 2FA on for the current account?
router.get('/me/2fa/status', async (req, res) => {
  try {
    const user = await queryOne('SELECT totp_enabled, totp_confirmed_at FROM users WHERE id = ?', [req.user.id]);
    res.json({ enabled: !!user?.totp_enabled, confirmedAt: user?.totp_confirmed_at || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/users/me/2fa/setup — start (or restart) setup: generates a new
// secret, stores it encrypted but NOT enabled yet (login isn't affected until
// /confirm succeeds), returns the QR code + manual entry key.
router.post('/me/2fa/setup', async (req, res) => {
  try {
    const user = await queryOne('SELECT username, totp_enabled FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.totp_enabled) return res.status(400).json({ error: '2FA is already enabled. Disable it first to re-run setup.' });

    const secret = twoFactor.generateSecret();
    await execute('UPDATE users SET totp_secret = ? WHERE id = ?', [twoFactor.encryptSecret(secret), req.user.id]);

    const otpauthUrl = twoFactor.keyUri(secret, user.username);
    const qrDataUrl = await twoFactor.qrCodeDataUrl(otpauthUrl);
    res.json({ secret, otpauthUrl, qrDataUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/users/me/2fa/confirm — verify a code against the pending secret
// from /setup, and if it matches, turn 2FA on and mint backup codes (shown
// to the user exactly once — only bcrypt hashes are ever stored).
router.post('/me/2fa/confirm',
  body('code').notEmpty().isString(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const user = await queryOne('SELECT username, totp_secret FROM users WHERE id = ?', [req.user.id]);
      if (!user?.totp_secret) return res.status(400).json({ error: 'No pending 2FA setup. Call /me/2fa/setup first.' });

      const secret = twoFactor.decryptSecret(user.totp_secret);
      if (!twoFactor.verifyToken(secret, req.body.code)) {
        return res.status(401).json({ error: 'Invalid code. Check your authenticator app and try again.' });
      }

      const { plain, hashed } = await twoFactor.generateBackupCodes();
      await execute(
        `UPDATE users SET totp_enabled = 1, totp_backup_codes = ?, totp_confirmed_at = ? WHERE id = ?`,
        [twoFactor.encryptBackupCodes(hashed), Math.floor(Date.now() / 1000), req.user.id]
      );

      await audit.log({
        userId: req.user.id, username: user.username,
        action: '2fa_enabled', targetType: 'user', targetId: req.user.id,
        targetName: user.username, ipSource: req.realIp, result: 'success',
      });

      res.json({ enabled: true, backupCodes: plain });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// POST /api/users/me/2fa/disable — requires current password + a valid TOTP
// or backup code, so a hijacked session alone can't turn protection off.
router.post('/me/2fa/disable',
  body('password').notEmpty(),
  body('code').notEmpty().isString(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const passOk = await bcrypt.compare(req.body.password, user.password || '');
      if (!passOk) return res.status(401).json({ error: 'Current password is incorrect' });

      const secret = twoFactor.decryptSecret(user.totp_secret);
      let ok = twoFactor.verifyToken(secret, req.body.code);
      if (!ok) {
        const hashedCodes = twoFactor.decryptBackupCodes(user.totp_backup_codes);
        ok = (await twoFactor.redeemBackupCode(hashedCodes, req.body.code)) !== null;
      }
      if (!ok) return res.status(401).json({ error: 'Invalid authentication code' });

      await execute(
        `UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL, totp_confirmed_at = NULL WHERE id = ?`,
        [req.user.id]
      );
      await audit.log({
        userId: req.user.id, username: user.username,
        action: '2fa_disabled', targetType: 'user', targetId: req.user.id,
        targetName: user.username, ipSource: req.realIp, result: 'success',
      });
      res.json({ enabled: false });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// POST /api/users/me/2fa/backup-codes/regenerate — invalidate old backup
// codes and issue a fresh set (e.g. after some have been used up).
router.post('/me/2fa/backup-codes/regenerate',
  body('code').notEmpty().isString(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const user = await queryOne('SELECT username, totp_enabled, totp_secret FROM users WHERE id = ?', [req.user.id]);
      if (!user?.totp_enabled) return res.status(400).json({ error: '2FA is not enabled' });
      if (!twoFactor.verifyToken(twoFactor.decryptSecret(user.totp_secret), req.body.code)) {
        return res.status(401).json({ error: 'Invalid code' });
      }
      const { plain, hashed } = await twoFactor.generateBackupCodes();
      await execute('UPDATE users SET totp_backup_codes = ? WHERE id = ?', [twoFactor.encryptBackupCodes(hashed), req.user.id]);
      await audit.log({
        userId: req.user.id, username: user.username,
        action: '2fa_backup_codes_regenerated', targetType: 'user', targetId: req.user.id,
        targetName: user.username, ipSource: req.realIp, result: 'success',
      });
      res.json({ backupCodes: plain });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// POST /api/users/:id/2fa/reset — admin-only escape hatch for a locked-out
// user (lost phone + backup codes). Turns 2FA off; the user re-enrolls from
// scratch. Heavily audited since this removes a security control from
// someone else's account.
router.post('/:id/2fa/reset', requireRole('admin'), param('id').isUUID(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const target = await queryOne('SELECT username FROM users WHERE id = ?', [req.params.id]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    await execute(
      `UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL, totp_confirmed_at = NULL WHERE id = ?`,
      [req.params.id]
    );
    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: '2fa_admin_reset', targetType: 'user', targetId: req.params.id,
      targetName: target.username, ipSource: req.realIp, result: 'success',
      details: `2FA reset for ${target.username} by admin ${req.user.username}`,
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/users — list all users (admin only) ─────────────────────────────
router.get('/', requireRole('admin'), async (req, res) => {
  try {
    const users = await query(
      `SELECT ${USER_FIELDS} FROM users ORDER BY created_at ASC`
    );
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/users/:id — get single user (admin only) ────────────────────────
router.get('/:id', requireRole('admin'), param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const user = await queryOne(
      `SELECT ${USER_FIELDS} FROM users WHERE id = ?`,
      [req.params.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/users — create user (admin only) ───────────────────────────────
// Password is optional IF an email is provided — that creates a "Google
// invite": the account has no usable local password (has_password=0) and
// can only sign in once the invited person completes Google sign-in with
// that exact email address, which auto-links it on first login.
router.post('/',
  requireRole('admin'),
  [
    body('username').trim().notEmpty().isLength({ min: 3, max: 50 })
      .matches(/^[a-zA-Z0-9_.-]+$/).withMessage('Username may only contain letters, numbers, _ . -'),
    body('password').optional({ nullable: true }).isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('email').optional({ nullable: true }).trim().isEmail().withMessage('Invalid email address').isLength({ max: 255 }),
    body('displayName').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('role').isIn(['admin', 'operator', 'viewer', 'custom']),
    body('permissions').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { username, password, role, permissions, displayName } = req.body;
    const email = req.body.email ? req.body.email.toLowerCase().trim() : null;

    if (!password && !email) {
      return res.status(400).json({ error: 'Provide a password, or an email to invite the user via Google sign-in.' });
    }

    try {
      const lower = username.toLowerCase().trim();

      const existing = await queryOne('SELECT id FROM users WHERE username = ?', [lower]);
      if (existing) return res.status(409).json({ error: 'Username already exists' });

      if (email) {
        const emailClash = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
        if (emailClash) return res.status(409).json({ error: 'A user with this email already exists' });
      }

      let hash, hasPassword;
      if (password) {
        hash = await bcrypt.hash(password, 12);
        hasPassword = 1;
      } else {
        // Unusable placeholder — never communicated, never derivable — so
        // local login is impossible until an admin sets a real password.
        hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
        hasPassword = 0;
      }
      const id = uuidv4();

      await execute(
        `INSERT INTO users (id, username, password, has_password, email, display_name, role, permissions, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [id, lower, hash, hasPassword, email, displayName || null, role, permissions || 0]
      );

      // Add the new user to an organization immediately — without this,
      // middleware/tenant.js's requireOrgContext hard-blocks every
      // device/group/schedule/etc. request with 400 NO_ACTIVE_ORG the
      // moment they log in, since nothing else ever grants org membership
      // for a user created this way. Prefer the creating admin's own active
      // org (the obvious intent: "add this person to the org I'm looking
      // at"); fall back to whatever org exists if the creator somehow has
      // none themselves, so a brand-new instance never produces an
      // unusable account.
      try {
        let orgId = req.orgId || req.user.activeOrgId || null;
        if (!orgId) {
          const anyOrg = await queryOne('SELECT id FROM organizations ORDER BY created_at LIMIT 1');
          orgId = anyOrg?.id || null;
        }
        if (orgId) {
          await execute(
            `INSERT IGNORE INTO org_members (id, org_id, user_id, org_role, created_at) VALUES (?, ?, ?, ?, ?)`,
            [uuidv4(), orgId, id, role === 'admin' ? 'admin' : role, Math.floor(Date.now() / 1000)]
          );
          await execute('UPDATE users SET active_org_id = ? WHERE id = ? AND active_org_id IS NULL', [orgId, id]);
        }
      } catch (orgErr) {
        // Never fail user creation over this — surface it loudly instead so
        // it gets noticed and fixed rather than silently producing another
        // orphaned account.
        console.error(`[users] Failed to add new user ${lower} to an organization:`, orgErr.message);
      }

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'create_user', targetType: 'user', targetId: id,
        targetName: lower, ipSource: req.realIp, result: 'success',
        details: email && !password ? `invited via Google (${email})` : undefined,
      });

      const user = await queryOne(
        `SELECT ${USER_FIELDS} FROM users WHERE id = ?`,
        [id]
      );
      res.status(201).json(user);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ── PUT /api/users/:id — update user (admin only) ────────────────────────────
router.put('/:id',
  requireRole('admin'),
  param('id').isUUID(),
  [
    body('username').optional().trim().notEmpty().isLength({ min: 3, max: 50 })
      .matches(/^[a-zA-Z0-9_.-]+$/),
    body('password').optional().isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('email').optional({ nullable: true }).trim().isEmail().withMessage('Invalid email address').isLength({ max: 255 }),
    body('displayName').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('role').optional().isIn(['admin', 'operator', 'viewer', 'custom']),
    body('permissions').optional().isInt({ min: 0 }),
    body('enabled').optional().isBoolean(),
    body('unlinkGoogle').optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const existing = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'User not found' });

      // Prevent the last admin from being demoted or disabled
      if (existing.role === 'admin') {
        const adminCount = await queryOne('SELECT COUNT(*) as c FROM users WHERE role = ?', ['admin']);
        if (adminCount.c <= 1) {
          const { role, enabled } = req.body;
          if ((role && role !== 'admin') || enabled === false) {
            return res.status(409).json({ error: 'Cannot demote or disable the last admin account' });
          }
        }
      }

      const username    = req.body.username    ? req.body.username.toLowerCase().trim() : existing.username;
      const role        = req.body.role        ?? existing.role;
      const permissions = req.body.permissions ?? existing.permissions;
      const enabled     = req.body.enabled     !== undefined ? (req.body.enabled ? 1 : 0) : existing.enabled;
      const displayName = req.body.displayName !== undefined ? (req.body.displayName || null) : existing.display_name;
      const email       = req.body.email       !== undefined ? (req.body.email ? req.body.email.toLowerCase().trim() : null) : existing.email;

      // Check username uniqueness if changing
      if (username !== existing.username) {
        const clash = await queryOne('SELECT id FROM users WHERE username = ? AND id != ?', [username, req.params.id]);
        if (clash) return res.status(409).json({ error: 'Username already taken' });
      }
      if (email && email !== existing.email) {
        const clash = await queryOne('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.params.id]);
        if (clash) return res.status(409).json({ error: 'A user with this email already exists' });
      }

      // Unlinking Google is only safe if the account can still authenticate
      // locally afterwards — either it already has a real password, or one
      // is being set in this same request.
      const unlinkGoogle = req.body.unlinkGoogle === true;
      if (unlinkGoogle && !existing.google_id) {
        return res.status(400).json({ error: 'This account is not linked to a Google account' });
      }
      if (unlinkGoogle && !existing.has_password && !req.body.password) {
        return res.status(400).json({ error: 'Set a password for this user before unlinking Google — otherwise they would be locked out.' });
      }

      const hasPassword = req.body.password ? 1 : existing.has_password;
      const googleId = unlinkGoogle ? null : existing.google_id;

      if (req.body.password) {
        const hash = await bcrypt.hash(req.body.password, 12);
        await execute(
          `UPDATE users SET username=?, role=?, permissions=?, enabled=?, password=?, has_password=?,
             email=?, display_name=?, google_id=? WHERE id=?`,
          [username, role, permissions, enabled, hash, hasPassword, email, displayName, googleId, req.params.id]
        );
      } else {
        await execute(
          `UPDATE users SET username=?, role=?, permissions=?, enabled=?, has_password=?,
             email=?, display_name=?, google_id=? WHERE id=?`,
          [username, role, permissions, enabled, hasPassword, email, displayName, googleId, req.params.id]
        );
      }

      // If the user was just disabled, revoke all their refresh tokens immediately
      // so they cannot silently obtain new access tokens
      if (enabled === 0 && existing.enabled !== 0) {
        await execute('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [req.params.id]);
      }
      // Same idea if Google was unlinked — force re-authentication
      if (unlinkGoogle) {
        await execute('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [req.params.id]);
      }

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: unlinkGoogle ? 'unlink_google_account' : 'edit_user', targetType: 'user', targetId: req.params.id,
        targetName: username, ipSource: req.realIp, result: 'success',
        details: `role=${role} enabled=${enabled}`,
      });

      const user = await queryOne(
        `SELECT ${USER_FIELDS} FROM users WHERE id = ?`,
        [req.params.id]
      );
      res.json(user);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ── DELETE /api/users/:id — delete user (admin only) ─────────────────────────
router.delete('/:id', requireRole('admin'), param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });

  try {
    if (req.params.id === req.user.id) {
      return res.status(409).json({ error: 'You cannot delete your own account' });
    }

    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Prevent deleting the last admin
    if (user.role === 'admin') {
      const adminCount = await queryOne('SELECT COUNT(*) as c FROM users WHERE role = ?', ['admin']);
      if (adminCount.c <= 1) {
        return res.status(409).json({ error: 'Cannot delete the last admin account' });
      }
    }

    // Revoke all refresh tokens for this user
    await execute('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [req.params.id]);
    await execute('DELETE FROM users WHERE id = ?', [req.params.id]);

    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'delete_user', targetType: 'user', targetId: req.params.id,
      targetName: user.username, ipSource: req.realIp, result: 'success',
    });

    res.json({ message: 'User deleted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/users/:id/activity — audit log entries for a specific user ───────
router.get('/:id/activity', requireRole('admin'), param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const user = await queryOne('SELECT username FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    // limit/offset inlined, not bound as `LIMIT ? OFFSET ?` — see
    // routes/processPolicies.js for why: mysql2's execute()-based query()
    // doesn't reliably support bound parameters inside LIMIT/OFFSET. Safe
    // here since both are already coerced to bounded non-negative integers.
    const entries = await query(
      `SELECT * FROM audit_log WHERE username = ?
       ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${offset}`,
      [user.username]
    );
    res.json(entries);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// ── GET /api/users/:id/groups — get group access for a user ──────────────────
router.get('/:id/groups', requireRole('admin'), async (req, res) => {
  try {
    const rows = await query(
      `SELECT g.id, g.name, g.description, uga.granted_at
         FROM user_group_access uga
         JOIN \`groups\` g ON g.id = uga.group_id
        WHERE uga.user_id = ?
        ORDER BY g.name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/users/:id/groups — set group access for a user (replaces all) ───
router.put('/:id/groups', requireRole('admin'), async (req, res) => {
  const { groupIds = [] } = req.body;
  const userId = req.params.id;
  const now = Math.floor(Date.now() / 1000);
  const pool = require('../db').getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM user_group_access WHERE user_id = ?', [userId]);
    if (groupIds.length > 0) {
      const vals = groupIds.map(gid => [userId, gid, req.user.id, now]);
      await conn.query(
        'INSERT INTO user_group_access (user_id, group_id, granted_by, granted_at) VALUES ?',
        [vals]
      );
    }
    await conn.commit();
    res.json({ ok: true, groupIds });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});