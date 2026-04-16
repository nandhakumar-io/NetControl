// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const audit = require('../services/audit');
require('dotenv').config();

const router = express.Router();

// POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    const user = await queryOne('SELECT * FROM users WHERE username = ?', [username.toLowerCase().trim()]);

    const hash = user?.password || '$2b$12$invalidhashfortimingprotection00000000000000000000000000';
    const valid = await bcrypt.compare(password, hash);

    if (!user || !valid) {
      await audit.log({ username, action: 'login_failed', ipSource: req.ip, result: 'failure', details: 'Invalid credentials' });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const accessToken = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY || '8h' }
    );

    const rawRefresh = crypto.randomBytes(64).toString('hex');
    const refreshHash = crypto.createHash('sha256').update(rawRefresh).digest('hex');
    const refreshExpiry = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

    await execute(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
      [uuidv4(), user.id, refreshHash, refreshExpiry]
    );

    await execute('UPDATE users SET last_login = ? WHERE id = ?',
      [Math.floor(Date.now() / 1000), user.id]);

    res.cookie('refreshToken', rawRefresh, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/auth',
    });

    await audit.log({ userId: user.id, username: user.username, action: 'login', ipSource: req.ip, result: 'success' });

    res.json({ accessToken, user: { id: user.id, username: user.username, role: user.role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const rawRefresh = req.cookies?.refreshToken;
    if (!rawRefresh) return res.status(401).json({ error: 'No refresh token' });

    const hash = crypto.createHash('sha256').update(rawRefresh).digest('hex');
    const record = await queryOne(
      `SELECT rt.*, u.username, u.role
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = ? AND rt.revoked = 0`,
      [hash]
    );

    if (!record || record.expires_at < Math.floor(Date.now() / 1000)) {
      res.clearCookie('refreshToken', { path: '/api/auth' });
      return res.status(401).json({ error: 'Refresh token invalid or expired' });
    }

    const accessToken = jwt.sign(
      { id: record.user_id, username: record.username, role: record.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY || '8h' }
    );

    res.json({ accessToken });
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  try {
    const rawRefresh = req.cookies?.refreshToken;
    if (rawRefresh) {
      const hash = crypto.createHash('sha256').update(rawRefresh).digest('hex');
      await execute('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?', [hash]);
    }
    res.clearCookie('refreshToken', { path: '/api/auth' });
    res.json({ message: 'Logged out' });
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;

