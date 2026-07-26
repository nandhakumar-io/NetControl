// routes/sessions.js — session visibility + revocation
//
// refresh_tokens (routes/auth.js) is the actual session store — one row
// per browser/device that's logged in. This route surfaces that table to
// the frontend: a user can see and end their own sessions, and an admin
// can force-revoke every session belonging to a specific user (e.g. after
// a suspected compromise), without needing DB access.
//
// Revoking a session sets refresh_tokens.revoked=1, which blocks that
// session's next /api/auth/refresh call — so the still-live access token
// (JWT, short-lived per JWT_EXPIRY) keeps working until it naturally
// expires, then the session is dead for good. That's the same limitation
// /api/users' "disable user" revoke-on-disable and Google-unlink paths
// already accept — this route doesn't invent a new tradeoff, just exposes
// the existing one through a UI.
'use strict';
const express = require('express');
const crypto = require('crypto');
const { param, validationResult } = require('express-validator');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth);

const SESSION_FIELDS = `id, ip_address, user_agent, created_at, last_used_at, expires_at`;

function currentSessionHash(req) {
  const raw = req.cookies?.refreshToken;
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function shapeSession(row, currentHash) {
  return {
    id: row.id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    current: currentHash ? row.token_hash === currentHash : false,
  };
}

// ── GET /api/sessions — the current user's own active sessions ──────────────
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT ${SESSION_FIELDS}, token_hash FROM refresh_tokens
       WHERE user_id = ? AND revoked = 0 AND expires_at > UNIX_TIMESTAMP()
       ORDER BY last_used_at DESC, created_at DESC`,
      [req.user.id]
    );
    const currentHash = currentSessionHash(req);
    res.json(rows.map(r => shapeSession(r, currentHash)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/sessions/:id — revoke one of the current user's own sessions ─
// Deliberately allowed to revoke the CURRENT session too (that's just
// "log out this device"); the frontend should confirm before doing so.
router.delete('/:id', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const result = await execute(
      'UPDATE refresh_tokens SET revoked = 1 WHERE id = ? AND user_id = ? AND revoked = 0',
      [req.params.id, req.user.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Session not found' });
    await audit.log({
      userId: req.user.id, username: req.user.username, action: 'session_revoked_self',
      targetType: 'session', targetId: req.params.id, ipSource: req.realIp || req.ip, result: 'success',
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/sessions — revoke every OTHER session for the current user ───
// "Log out everywhere else" — keeps the session making this request alive
// so the user isn't immediately booted out by their own request.
router.delete('/', async (req, res) => {
  try {
    const currentHash = currentSessionHash(req);
    const result = await execute(
      currentHash
        ? 'UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0 AND token_hash != ?'
        : 'UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0',
      currentHash ? [req.user.id, currentHash] : [req.user.id]
    );
    await audit.log({
      userId: req.user.id, username: req.user.username, action: 'sessions_revoked_all_others',
      targetType: 'user', targetId: req.user.id, ipSource: req.realIp || req.ip, result: 'success',
      details: `${result.affectedRows} session(s) revoked`,
    });
    res.json({ success: true, revoked: result.affectedRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/sessions/user/:userId — admin: list a specific user's sessions ──
router.get('/user/:userId', requireRole('admin'), [param('userId').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const target = await queryOne('SELECT id, username FROM users WHERE id = ?', [req.params.userId]);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const rows = await query(
      `SELECT ${SESSION_FIELDS} FROM refresh_tokens
       WHERE user_id = ? AND revoked = 0 AND expires_at > UNIX_TIMESTAMP()
       ORDER BY last_used_at DESC, created_at DESC`,
      [req.params.userId]
    );
    res.json({ username: target.username, sessions: rows.map(r => shapeSession(r, null)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/sessions/user/:userId/revoke-all — admin: force-revoke every ───
// active session for a user org-wide (e.g. a compromised account). Kills
// every device/browser that user is currently signed in on the moment
// their refresh token would next be used — same JWT-expiry caveat noted
// at the top of this file.
router.post('/user/:userId/revoke-all', requireRole('admin'), [param('userId').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const target = await queryOne('SELECT id, username FROM users WHERE id = ?', [req.params.userId]);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const result = await execute(
      'UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0',
      [req.params.userId]
    );

    await audit.log({
      userId: req.user.id, username: req.user.username, action: 'sessions_force_revoked_admin',
      targetType: 'user', targetId: target.id, targetName: target.username,
      ipSource: req.realIp || req.ip, result: 'success',
      details: `${result.affectedRows} session(s) revoked by admin`,
    });

    res.json({ success: true, revoked: result.affectedRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;