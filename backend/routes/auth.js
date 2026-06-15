// routes/auth.js — local login + Google OAuth + brute-force IP ban
// Replace backend/routes/auth.js with this file.
'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const https   = require('https');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const audit   = require('../services/audit');
const webhook = require('../services/webhook');
const { isIPAllowed, logBlockedAttempt } = require('../services/ipAllowlist');
const bf      = require('../services/bruteForce');
require('dotenv').config();

const router = express.Router();

// ── Shared helpers ─────────────────────────────────────────────────────────────
function signAccess(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRY || '8h' }
  );
}
async function createRefreshToken(userId, res) {
  const raw  = crypto.randomBytes(64).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const exp  = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  await execute(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    [uuidv4(), userId, hash, exp]
  );
  res.cookie('refreshToken', raw, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   7 * 24 * 60 * 60 * 1000,
    path:     '/api/auth',
  });
}

// ── POST /api/auth/login ───────────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  const ip = req.realIp || req.ip;
  try {
    // ── Brute-force check before touching the DB ──────────────────────────
    const banCheck = await bf.isBanned(ip);
    if (banCheck.banned) {
      const mins = Math.ceil(banCheck.remaining / 60);
      return res.status(429).json({
        error: `Too many failed attempts. This IP is temporarily blocked for ${mins} more minute${mins !== 1 ? 's' : ''}.`,
        code:  'IP_BANNED',
        remaining: banCheck.remaining,
      });
    }

    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    const user = await queryOne('SELECT * FROM users WHERE username = ?', [username.toLowerCase().trim()]);
    const hash = user?.password || '$2b$12$invalidhashfortimingprotection00000000000000000000000000';
    const valid = await bcrypt.compare(password, hash);

    if (!user || !valid) {
      // Record failure — may trigger a ban
      const bfResult = await bf.recordFailure(ip, username);
      await audit.log({ username, action: 'login_failed', ipSource: ip, result: 'failure', details: 'Invalid credentials' });
      webhook.fire('auth.login_failed', { username, ip, severity: 'warning', message: `Failed login for "${username}" from ${ip}` }).catch(() => {});

      if (bfResult.banned) {
        webhook.fire('auth.ip_banned', {
          ip, username, severity: 'critical',
          message: `IP ${ip} auto-banned after repeated login failures`,
        }).catch(() => {});
        return res.status(429).json({
          error: `Too many failed attempts. Your IP has been temporarily blocked.`,
          code: 'IP_BANNED',
        });
      }
      return res.status(401).json({
        error: 'Invalid credentials',
        attemptsRemaining: bfResult.remaining,
      });
    }

    if (!user.enabled) {
      await audit.log({ userId: user.id, username: user.username, action: 'login_failed', ipSource: ip, result: 'failure', details: 'Account disabled' });
      return res.status(403).json({ error: 'Account is disabled. Contact your administrator.' });
    }

    // IP allowlist check
    const ipCheck = await isIPAllowed(ip, user.id, user.role);
    if (!ipCheck.allowed) {
      await logBlockedAttempt({ username: user.username, ip, reason: `IP allowlist: ${ipCheck.reason}` });
      await audit.log({ userId: user.id, username: user.username, action: 'login_blocked_ip', ipSource: ip, result: 'failure', details: `IP not in allowlist` });
      webhook.fire('auth.ip_blocked', { username: user.username, ip, role: user.role, reason: ipCheck.reason, severity: 'warning', message: `Login blocked for ${user.username} from ${ip}` }).catch(() => {});
      return res.status(403).json({ error: 'Access denied: your IP address is not permitted.', code: 'IP_NOT_ALLOWED' });
    }

    // Success — reset brute-force counter
    bf.recordSuccess(ip);

    const accessToken = signAccess(user);
    await createRefreshToken(user.id, res);
    await execute('UPDATE users SET last_login = ? WHERE id = ?', [Math.floor(Date.now() / 1000), user.id]);
    await audit.log({ userId: user.id, username: user.username, action: 'login', ipSource: ip, result: 'success' });
    webhook.fire('auth.login', { username: user.username, ip, role: user.role, message: `${user.username} logged in from ${ip}` }).catch(() => {});

    res.json({ accessToken, user: { id: user.id, username: user.username, role: user.role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/auth/google ───────────────────────────────────────────────────────
const oauthStates = new Map();
setInterval(() => { const now = Date.now(); for (const [k,v] of oauthStates) if (v.expires < now) oauthStates.delete(k); }, 60_000);
function googleEnabled() { return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET); }
function googleTokenExchange(code, redirectUri) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString();
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad token response')); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
function decodeIdToken(token) { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return null; } }

router.get('/google', authLimiter, (req, res) => {
  if (!googleEnabled()) return res.status(501).json({ error: 'Google OAuth is not configured.' });
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { expires: Date.now() + 10 * 60 * 1000 });
  const redirectUri = `${process.env.BACKEND_URL || `http://localhost:${process.env.PORT||4000}`}/api/auth/google/callback`;
  const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, access_type: 'online', prompt: 'select_account' });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/google/callback', async (req, res) => {
  const frontendUrl = process.env.CORS_ORIGIN || 'http://localhost:5173';
  const ip = req.realIp || req.ip;
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Google sign-in was cancelled.')}`);
    if (!code || !state || !oauthStates.get(state)) return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Login session expired. Please try again.')}`);
    oauthStates.delete(state);
    const redirectUri = `${process.env.BACKEND_URL || `http://localhost:${process.env.PORT||4000}`}/api/auth/google/callback`;
    const tokenData = await googleTokenExchange(code, redirectUri);
    if (tokenData.error) return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Google authentication failed.')}`);
    const profile = decodeIdToken(tokenData.id_token);
    if (!profile?.email) return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Could not retrieve email from Google.')}`);
    const { email, name, sub: googleId } = profile;
    const allowedDomain = process.env.GOOGLE_ALLOWED_DOMAIN;
    if (allowedDomain && !email.endsWith(`@${allowedDomain}`)) return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent(`Only @${allowedDomain} accounts are permitted.`)}`);
    let user = await queryOne('SELECT * FROM users WHERE google_id = ?', [googleId]);
    if (!user) user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      if (process.env.GOOGLE_AUTO_PROVISION !== 'true') return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('No account found. Contact your administrator.')}`);
      const defaultRole = process.env.GOOGLE_DEFAULT_ROLE || 'viewer';
      const username = email.split('@')[0].replace(/[^a-z0-9._-]/gi, '_').toLowerCase();
      const existing = await queryOne('SELECT id FROM users WHERE username = ?', [username]);
      const finalUsername = existing ? `${username}_${crypto.randomBytes(3).toString('hex')}` : username;
      const newId = uuidv4();
      await execute(`INSERT INTO users (id, username, email, display_name, google_id, role, enabled, password, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, '', ?)`, [newId, finalUsername, email, name || email, googleId, defaultRole, Math.floor(Date.now() / 1000)]);
      user = await queryOne('SELECT * FROM users WHERE id = ?', [newId]);
    } else if (!user.google_id) {
      await execute('UPDATE users SET google_id = ?, display_name = COALESCE(NULLIF(display_name, ""), ?) WHERE id = ?', [googleId, name || email, user.id]);
    }
    if (!user.enabled) return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Your account is disabled.')}`);
    const ipCheck = await isIPAllowed(ip, user.id, user.role);
    if (!ipCheck.allowed) return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Access denied: your IP is not permitted.')}`);
    bf.recordSuccess(ip);
    const accessToken = signAccess(user);
    await createRefreshToken(user.id, res);
    await execute('UPDATE users SET last_login = ? WHERE id = ?', [Math.floor(Date.now() / 1000), user.id]);
    await audit.log({ userId: user.id, username: user.username, action: 'google_login', ipSource: ip, result: 'success', details: `via Google (${email})` });
    res.redirect(`${frontendUrl}/auth/callback#token=${encodeURIComponent(accessToken)}&user=${encodeURIComponent(JSON.stringify({ id: user.id, username: user.username, role: user.role }))}`);
  } catch (e) {
    console.error('[Google OAuth]', e.message);
    res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('An unexpected error occurred.')}`);
  }
});

router.get('/google/status', (req, res) => res.json({ enabled: googleEnabled() }));

// ── POST /api/auth/refresh ─────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const rawRefresh = req.cookies?.refreshToken;
    if (!rawRefresh) return res.status(401).json({ error: 'No refresh token' });
    const hash = crypto.createHash('sha256').update(rawRefresh).digest('hex');
    const record = await queryOne(`SELECT rt.*, u.username, u.role FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE rt.token_hash = ? AND rt.revoked = 0`, [hash]);
    if (!record || record.expires_at < Math.floor(Date.now() / 1000)) {
      res.clearCookie('refreshToken', { path: '/api/auth' });
      return res.status(401).json({ error: 'Refresh token invalid or expired' });
    }
    const liveUser = await queryOne('SELECT enabled FROM users WHERE id = ?', [record.user_id]);
    if (!liveUser || !liveUser.enabled) {
      await execute('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [record.user_id]);
      res.clearCookie('refreshToken', { path: '/api/auth' });
      return res.status(403).json({ error: 'Account is disabled.', code: 'ACCOUNT_DISABLED' });
    }
    res.json({ accessToken: jwt.sign({ id: record.user_id, username: record.username, role: record.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRY || '8h' }) });
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const rawRefresh = req.cookies?.refreshToken;
    if (rawRefresh) {
      const hash = crypto.createHash('sha256').update(rawRefresh).digest('hex');
      await execute('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?', [hash]);
    }
    res.clearCookie('refreshToken', { path: '/api/auth' });
    res.json({ message: 'Logged out' });
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

module.exports = router;
