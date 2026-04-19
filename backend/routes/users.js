// routes/users.js — User management (admin only)
const express = require('express');
const bcrypt  = require('bcryptjs');
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

// ── GET /api/users — list all users (admin only) ─────────────────────────────
router.get('/', requireRole('admin'), async (req, res) => {
  try {
    const users = await query(
      `SELECT id, username, role, permissions, enabled, created_at, last_login
       FROM users ORDER BY created_at ASC`
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
      'SELECT id, username, role, permissions, enabled, created_at, last_login FROM users WHERE id = ?',
      [req.params.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/users — create user (admin only) ───────────────────────────────
router.post('/',
  requireRole('admin'),
  [
    body('username').trim().notEmpty().isLength({ min: 3, max: 50 })
      .matches(/^[a-zA-Z0-9_.-]+$/).withMessage('Username may only contain letters, numbers, _ . -'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role').isIn(['admin', 'operator', 'viewer', 'custom']),
    body('permissions').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { username, password, role, permissions } = req.body;
      const lower = username.toLowerCase().trim();

      const existing = await queryOne('SELECT id FROM users WHERE username = ?', [lower]);
      if (existing) return res.status(409).json({ error: 'Username already exists' });

      const hash = await bcrypt.hash(password, 12);
      const id   = uuidv4();

      await execute(
        'INSERT INTO users (id, username, password, role, permissions, enabled) VALUES (?, ?, ?, ?, ?, 1)',
        [id, lower, hash, role, permissions || 0]
      );

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'create_user', targetType: 'user', targetId: id,
        targetName: lower, ipSource: req.realIp, result: 'success',
      });

      const user = await queryOne(
        'SELECT id, username, role, permissions, enabled, created_at, last_login FROM users WHERE id = ?',
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
    body('password').optional().isLength({ min: 6 }),
    body('role').optional().isIn(['admin', 'operator', 'viewer', 'custom']),
    body('permissions').optional().isInt({ min: 0 }),
    body('enabled').optional().isBoolean(),
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

      // Check username uniqueness if changing
      if (username !== existing.username) {
        const clash = await queryOne('SELECT id FROM users WHERE username = ? AND id != ?', [username, req.params.id]);
        if (clash) return res.status(409).json({ error: 'Username already taken' });
      }

      if (req.body.password) {
        const hash = await bcrypt.hash(req.body.password, 12);
        await execute(
          'UPDATE users SET username=?, role=?, permissions=?, enabled=?, password=? WHERE id=?',
          [username, role, permissions, enabled, hash, req.params.id]
        );
      } else {
        await execute(
          'UPDATE users SET username=?, role=?, permissions=?, enabled=? WHERE id=?',
          [username, role, permissions, enabled, req.params.id]
        );
      }

      // If the user was just disabled, revoke all their refresh tokens immediately
      // so they cannot silently obtain new access tokens
      if (enabled === 0 && existing.enabled !== 0) {
        await execute('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [req.params.id]);
      }

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'edit_user', targetType: 'user', targetId: req.params.id,
        targetName: username, ipSource: req.realIp, result: 'success',
        details: `role=${role} enabled=${enabled}`,
      });

      const user = await queryOne(
        'SELECT id, username, role, permissions, enabled, created_at, last_login FROM users WHERE id = ?',
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
    const offset = parseInt(req.query.offset) || 0;

    const entries = await query(
      `SELECT * FROM audit_log WHERE username = ?
       ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      [user.username, limit, offset]
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
