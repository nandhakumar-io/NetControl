// routes/auth.js — local login + Google OAuth + brute-force IP ban
'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const audit   = require('../services/audit');
const webhook = require('../services/webhook');
const { isIPAllowed, logBlockedAttempt } = require('../services/ipAllowlist');
const bf      = require('../services/bruteForce');
const twoFactor = require('../services/twoFactor');
require('dotenv').config();

const router = express.Router();

// ── Shared helpers ─────────────────────────────────────────────────────────────
function signAccess(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, permissions: user.permissions || 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRY || '8h' }
  );
}
// Short-lived, single-purpose token issued after password verification for
// accounts with 2FA enabled. It can ONLY be redeemed at /api/auth/2fa/verify
// (checked via `purpose`) and expires in 5 minutes — it carries no role or
// permissions, so on its own it grants no access to anything.
function signMfaToken(userId) {
  return jwt.sign({ id: userId, purpose: '2fa_pending' }, process.env.JWT_SECRET, { expiresIn: '5m' });
}
function verifyMfaToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET); // throws if invalid/expired
  if (payload.purpose !== '2fa_pending') throw new Error('Invalid token purpose');
  return payload;
}
function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role, permissions: user.permissions || 0 };
}
async function createRefreshToken(userId, res) {
  const raw  = crypto.randomBytes(64).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const exp  = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  await execute(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    [uuidv4(), userId, hash, exp]
  );
  // BUG FIX ("login session expired" after Google sign-in):
  // Local logins POST to /api/auth/login through the frontend's own nginx
  // proxy, so the browser treats it as same-origin (netcontrol.notoriousdev.in)
  // and the refreshToken cookie is scoped there. Google's OAuth redirect,
  // though, must land on a publicly registered callback URI — BACKEND_URL,
  // i.e. netcontrol-api.notoriousdev.in directly — a *different* origin from
  // the frontend. Without an explicit cookie Domain, the refresh cookie set
  // during that callback is scoped only to netcontrol-api.notoriousdev.in.
  // The frontend always calls same-origin /api/... through its own nginx
  // proxy and never talks to that host directly, so the browser never sends
  // that cookie back — /api/auth/refresh 401s on the first token expiry, and
  // the user gets bounced with "Session expired. Please log in again."
  // Setting Domain to the shared parent domain (e.g. ".notoriousdev.in")
  // makes the cookie valid on both subdomains. No-op if COOKIE_DOMAIN isn't
  // set (previous host-only behavior), so this doesn't break same-origin setups.
  res.cookie('refreshToken', raw, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   7 * 24 * 60 * 60 * 1000,
    path:     '/api/auth',
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  });
}

// ── First-run setup ────────────────────────────────────────────────────────────
// Before this existed, the ONLY way to get a working instance was to run
// `node db/setup.js` (or hand-write SQL) with direct DB credentials — fine
// for the original deployment, a real barrier for anyone else cloning the
// repo. This route does the same job (create the first admin) over HTTP,
// but is only ever usable once: it hard-fails the moment a single row
// exists in `users`, so it can be left mounted in production without being
// a standing "create admin" backdoor. db/setup.js still works and is
// unaffected — whichever happens first wins, the other becomes a no-op.

// GET /api/auth/setup — tells the frontend whether to show the setup wizard
// or the normal login screen. No auth required by design: an unconfigured
// instance has no admin to authenticate as yet.
router.get('/setup', async (req, res) => {
  try {
    const row = await queryOne('SELECT COUNT(*) AS c FROM users');
    res.json({ needsSetup: row.c === 0 });
  } catch (e) {
    // Table may not exist yet if migrations haven't run — surface as "needs setup"
    // rather than a raw 500, since that's the state the operator needs to fix first.
    res.json({ needsSetup: true });
  }
});

// POST /api/auth/setup — create the org name + first admin account.
// Rate-limited with authLimiter (10/15min/IP) — this is a one-shot
// operation for a legitimate operator, so that's plenty, and it closes off
// any window for a race/brute-force attempt to squat the first-admin slot
// on a freshly deployed, not-yet-configured instance.
router.post('/setup',
  authLimiter,
  body('username').trim().notEmpty().isLength({ min: 3, max: 50 })
    .matches(/^[a-zA-Z0-9_.-]+$/).withMessage('Username may only contain letters, numbers, dots, dashes and underscores'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('orgName').optional({ nullable: true }).trim().isLength({ max: 100 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
      // Re-check right before the insert (not just at GET time) — the whole
      // point of this route is to be safe to leave mounted, so the guard
      // has to be the source of truth at write time, not a client-trusted flag.
      const existing = await queryOne('SELECT COUNT(*) AS c FROM users');
      if (existing.c > 0) {
        return res.status(403).json({ error: 'Setup has already been completed. Log in normally, or ask an existing admin to create your account.' });
      }

      const { username, password, orgName } = req.body;
      const hash = await bcrypt.hash(password, 12);
      const id = uuidv4();
      const now = Math.floor(Date.now() / 1000);

      await execute(
        'INSERT INTO users (id, username, password, role, permissions, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        [id, username, hash, 'admin', 0xFFFF, now]
      );

      if (orgName) {
        await execute(
          `INSERT INTO system_settings (\`key\`, value, updated_by, updated_at)
           VALUES ('org_name', ?, ?, ?)
           ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
          [orgName, id, now]
        );
      }

      await audit.log({
        userId: id, username, action: 'first_run_setup',
        targetType: 'user', targetId: id, targetName: username,
        ipSource: req.realIp || req.ip, result: 'success',
        details: orgName ? `Org name set to "${orgName}"` : null,
      });

      // Auto-login: same tokens a normal /login issues, so the wizard can
      // drop the operator straight into the dashboard instead of a second
      // login prompt right after they just typed this password in.
      const user = { id, username, role: 'admin', permissions: 0xFFFF };
      const accessToken = signAccess(user);
      await createRefreshToken(id, res);

      res.status(201).json({ accessToken, user: publicUser(user) });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'That username is already taken.' });
      }
      res.status(500).json({ error: 'Setup failed' });
    }
  }
);

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

    // ── 2FA step-up ─────────────────────────────────────────────────────
    // Password is correct, but this account requires a second factor.
    // Issue only a short-lived, scope-limited mfaToken — no accessToken,
    // no refreshToken cookie — until /api/auth/2fa/verify confirms the code.
    if (user.totp_enabled) {
      await audit.log({ userId: user.id, username: user.username, action: 'login_password_ok_awaiting_2fa', ipSource: ip, result: 'success' });
      return res.json({ requires2FA: true, mfaToken: signMfaToken(user.id) });
    }

    const accessToken = signAccess(user);
    await createRefreshToken(user.id, res);
    await execute('UPDATE users SET last_login = ? WHERE id = ?', [Math.floor(Date.now() / 1000), user.id]);
    await audit.log({ userId: user.id, username: user.username, action: 'login', ipSource: ip, result: 'success' });
    webhook.fire('auth.login', { username: user.username, ip, role: user.role, message: `${user.username} logged in from ${ip}` }).catch(() => {});

    res.json({
      accessToken,
      user: publicUser(user),
      mustChangePassword: !!user.must_change_password,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/auth/2fa/verify — redeem an mfaToken + TOTP/backup code ────────
// Completes a login that was stepped up above. Rate-limited and brute-force
// tracked the same as /login itself, since this is just as sensitive a gate.
router.post('/2fa/verify', authLimiter, async (req, res) => {
  const ip = req.realIp || req.ip;
  const { mfaToken, code } = req.body;
  if (!mfaToken || !code) return res.status(400).json({ error: 'mfaToken and code are required' });

  try {
    const banCheck = await bf.isBanned(ip);
    if (banCheck.banned) {
      const mins = Math.ceil(banCheck.remaining / 60);
      return res.status(429).json({ error: `Too many failed attempts. This IP is temporarily blocked for ${mins} more minute${mins !== 1 ? 's' : ''}.`, code: 'IP_BANNED' });
    }

    let payload;
    try {
      payload = verifyMfaToken(mfaToken);
    } catch {
      return res.status(401).json({ error: 'Your login attempt expired. Please sign in again.' });
    }

    const user = await queryOne('SELECT * FROM users WHERE id = ?', [payload.id]);
    if (!user || !user.totp_enabled) return res.status(401).json({ error: 'Please sign in again.' });
    if (!user.enabled) return res.status(403).json({ error: 'Account is disabled. Contact your administrator.' });

    const secret = twoFactor.decryptSecret(user.totp_secret);
    let usedBackupCode = false;
    let ok = twoFactor.verifyToken(secret, code);
    let remainingBackupCodes = null;
    if (!ok) {
      const hashedCodes = twoFactor.decryptBackupCodes(user.totp_backup_codes);
      const result = await twoFactor.redeemBackupCode(hashedCodes, code);
      if (result !== null) { ok = true; usedBackupCode = true; remainingBackupCodes = result; }
    }

    if (!ok) {
      const bfResult = await bf.recordFailure(ip, user.username);
      await audit.log({ userId: user.id, username: user.username, action: '2fa_verify_failed', ipSource: ip, result: 'failure' });
      if (bfResult.banned) return res.status(429).json({ error: 'Too many failed attempts. Your IP has been temporarily blocked.', code: 'IP_BANNED' });
      return res.status(401).json({ error: 'Invalid authentication code', attemptsRemaining: bfResult.remaining });
    }

    if (usedBackupCode) {
      await execute('UPDATE users SET totp_backup_codes = ? WHERE id = ?', [twoFactor.encryptBackupCodes(remainingBackupCodes), user.id]);
    }

    const ipCheck = await isIPAllowed(ip, user.id, user.role);
    if (!ipCheck.allowed) {
      await logBlockedAttempt({ username: user.username, ip, reason: `IP allowlist: ${ipCheck.reason}` });
      await audit.log({ userId: user.id, username: user.username, action: 'login_blocked_ip', ipSource: ip, result: 'failure', details: 'IP not in allowlist (post-2FA)' });
      return res.status(403).json({ error: 'Access denied: your IP address is not permitted.', code: 'IP_NOT_ALLOWED' });
    }

    bf.recordSuccess(ip);
    const accessToken = signAccess(user);
    await createRefreshToken(user.id, res);
    await execute('UPDATE users SET last_login = ? WHERE id = ?', [Math.floor(Date.now() / 1000), user.id]);
    await audit.log({ userId: user.id, username: user.username, action: 'login', ipSource: ip, result: 'success', details: usedBackupCode ? 'via 2FA backup code' : 'via 2FA TOTP' });
    webhook.fire('auth.login', { username: user.username, ip, role: user.role, message: `${user.username} logged in from ${ip}${usedBackupCode ? ' (backup code used)' : ''}` }).catch(() => {});

    res.json({
      accessToken,
      user: publicUser(user),
      mustChangePassword: !!user.must_change_password,
      backupCodeUsed: usedBackupCode,
      backupCodesRemaining: usedBackupCode ? remainingBackupCodes.length : undefined,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Google OAuth (authorization-code flow, confidential client) ─────────────────
// The code is exchanged for tokens server-to-server (never exposed to the
// browser), and the returned ID token is cryptographically verified against
// Google's public keys — not just base64-decoded — so a malicious or
// mangled response can't be used to impersonate a user or wrong audience.
// BUG FIX ("Login session expired" on Google sign-in, ~7/8 of the time):
// server.js runs Node `cluster` with multiple worker processes behind
// Traefik's round-robin load balancing. An in-memory Map here is scoped to
// a single worker process. The request that starts the OAuth flow
// (/api/auth/google) can land on a different worker than the one that
// handles Google's redirect back (/api/auth/google/callback) — that worker
// never saw the state get set, so the lookup always misses and the login
// fails. Fixed by making the state a signed, self-verifying token (HMAC +
// expiry) instead of something looked up in per-process memory. No shared
// storage (Redis, DB, sticky sessions) needed — any worker can verify a
// state issued by any other worker.
function makeState() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const expires = Date.now() + 10 * 60 * 1000;
  const payload = `${nonce}.${expires}`;
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function verifyState(state) {
  if (!state || typeof state !== 'string') return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, expiresStr, sig] = parts;
  const payload = `${nonce}.${expiresStr}`;
  const expectedSig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('hex');
  if (sig.length !== expectedSig.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return false;
  const expires = parseInt(expiresStr, 10);
  if (!Number.isFinite(expires) || Date.now() > expires) return false;
  return true;
}

function googleEnabled() { return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET); }
function redirectUri() {
  return `${process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`}/api/auth/google/callback`;
}
function oauthClient() {
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri());
}

router.get('/google', authLimiter, (req, res) => {
  if (!googleEnabled()) return res.status(501).json({ error: 'Google OAuth is not configured.' });
  const state = makeState();
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(),
    response_type: 'code', scope: 'openid email profile', state,
    access_type: 'online', prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/google/callback', authLimiter, async (req, res) => {
  const frontendUrl = process.env.CORS_ORIGIN || 'http://localhost:5173';
  const ip = req.realIp || req.ip;
  const fail = (msg) => res.redirect(`${frontendUrl}/login?error=${encodeURIComponent(msg)}`);

  try {
    if (!googleEnabled()) return fail('Google sign-in is not configured.');
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return fail('Google sign-in was cancelled.');
    if (!code || !state || !verifyState(state)) return fail('Login session expired. Please try again.');

    const client = oauthClient();
    let idToken;
    try {
      const { tokens } = await client.getToken({ code, redirect_uri: redirectUri() });
      idToken = tokens.id_token;
    } catch (e) {
      console.error('[Google OAuth] token exchange failed:', e.message);
      return fail('Google authentication failed.');
    }
    if (!idToken) return fail('Google authentication failed.');

    // Cryptographically verifies signature, issuer, audience and expiry —
    // this is the step a raw base64 decode of the JWT payload would skip.
    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (e) {
      console.error('[Google OAuth] id_token verification failed:', e.message);
      return fail('Could not verify your Google identity.');
    }
    if (!payload?.email) return fail('Could not retrieve email from Google.');
    if (payload.email_verified === false) return fail('Your Google email address is not verified.');

    const email = payload.email.toLowerCase().trim();
    const name = payload.name;
    const googleId = payload.sub;

    const allowedDomain = process.env.GOOGLE_ALLOWED_DOMAIN;
    if (allowedDomain && !email.endsWith(`@${allowedDomain.toLowerCase()}`)) {
      return fail(`Only @${allowedDomain} accounts are permitted.`);
    }

    let user = await queryOne('SELECT * FROM users WHERE google_id = ?', [googleId]);
    if (!user) user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);

    if (!user) {
      if (process.env.GOOGLE_AUTO_PROVISION !== 'true') return fail('No account found for your Google email. Contact your administrator.');
      const defaultRole = process.env.GOOGLE_DEFAULT_ROLE || 'viewer';
      const baseUsername = email.split('@')[0].replace(/[^a-z0-9._-]/gi, '_').toLowerCase();
      const existing = await queryOne('SELECT id FROM users WHERE username = ?', [baseUsername]);
      const finalUsername = existing ? `${baseUsername}_${crypto.randomBytes(3).toString('hex')}` : baseUsername;
      const newId = uuidv4();
      // No usable local password — a random hash (never communicated to
      // anyone, never derivable) so bcrypt.compare() can never match it;
      // has_password=0 tells the UI/API this account can only sign in via Google.
      const unusableHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
      await execute(
        `INSERT INTO users (id, username, email, display_name, google_id, role, enabled, permissions, password, has_password, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, 0, ?)`,
        [newId, finalUsername, email, name || email, googleId, defaultRole, unusableHash, Math.floor(Date.now() / 1000)]
      );
      user = await queryOne('SELECT * FROM users WHERE id = ?', [newId]);
      await audit.log({ userId: newId, username: finalUsername, action: 'google_auto_provision', ipSource: ip, result: 'success', details: `role=${defaultRole} email=${email}` });
      webhook.fire('auth.user_provisioned', { username: finalUsername, email, role: defaultRole, message: `${finalUsername} auto-provisioned via Google sign-in` }).catch(() => {});
    } else if (!user.google_id) {
      // Existing local account, same email — link it (one-time, silent).
      await execute(
        'UPDATE users SET google_id = ?, display_name = COALESCE(NULLIF(display_name, \'\'), ?) WHERE id = ?',
        [googleId, name || email, user.id]
      );
      user.google_id = googleId;
      await audit.log({ userId: user.id, username: user.username, action: 'google_account_linked', ipSource: ip, result: 'success', details: email });
    }

    if (!user.enabled) return fail('Your account is disabled. Contact your administrator.');

    const ipCheck = await isIPAllowed(ip, user.id, user.role);
    if (!ipCheck.allowed) {
      await logBlockedAttempt({ username: user.username, ip, reason: `IP allowlist: ${ipCheck.reason}` });
      await audit.log({ userId: user.id, username: user.username, action: 'login_blocked_ip', ipSource: ip, result: 'failure', details: 'IP not in allowlist (google)' });
      return fail('Access denied: your IP is not permitted.');
    }

    bf.recordSuccess(ip);

    // ── 2FA step-up ─────────────────────────────────────────────────────
    // SECURITY FIX: this used to issue a full accessToken unconditionally,
    // which meant enabling 2FA on an account did nothing if you signed in
    // via Google instead of the password form — the whole point of 2FA
    // (a second factor beyond "whatever proved your identity to Google")
    // was silently skipped for every Google-linked account. Reuses the
    // exact same short-lived mfaToken + /api/auth/2fa/verify flow the
    // password login already uses, so there's only one 2FA
    // implementation to keep correct, not two.
    if (user.totp_enabled) {
      await audit.log({ userId: user.id, username: user.username, action: 'login_password_ok_awaiting_2fa', ipSource: ip, result: 'success', details: 'via Google' });
      return res.redirect(`${frontendUrl}/auth/callback#requires2FA=1&mfaToken=${encodeURIComponent(signMfaToken(user.id))}`);
    }

    const accessToken = signAccess(user);
    await createRefreshToken(user.id, res);
    await execute('UPDATE users SET last_login = ? WHERE id = ?', [Math.floor(Date.now() / 1000), user.id]);
    await audit.log({ userId: user.id, username: user.username, action: 'google_login', ipSource: ip, result: 'success', details: `via Google (${email})` });
    webhook.fire('auth.login', { username: user.username, ip, role: user.role, message: `${user.username} logged in via Google from ${ip}` }).catch(() => {});

    res.redirect(`${frontendUrl}/auth/callback#token=${encodeURIComponent(accessToken)}&user=${encodeURIComponent(JSON.stringify(publicUser(user)))}`);
  } catch (e) {
    console.error('[Google OAuth]', e.message);
    return fail('An unexpected error occurred.');
  }
});

router.get('/google/status', (req, res) => res.json({ enabled: googleEnabled() }));

// ── POST /api/auth/refresh ─────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const rawRefresh = req.cookies?.refreshToken;
    if (!rawRefresh) return res.status(401).json({ error: 'No refresh token' });
    const hash = crypto.createHash('sha256').update(rawRefresh).digest('hex');
    const record = await queryOne(`SELECT rt.*, u.username, u.role, u.permissions FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE rt.token_hash = ? AND rt.revoked = 0`, [hash]);
    if (!record || record.expires_at < Math.floor(Date.now() / 1000)) {
      res.clearCookie('refreshToken', { path: '/api/auth', ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}) });
      return res.status(401).json({ error: 'Refresh token invalid or expired' });
    }
    const liveUser = await queryOne('SELECT enabled, permissions FROM users WHERE id = ?', [record.user_id]);
    if (!liveUser || !liveUser.enabled) {
      await execute('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [record.user_id]);
      res.clearCookie('refreshToken', { path: '/api/auth', ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}) });
      return res.status(403).json({ error: 'Account is disabled.', code: 'ACCOUNT_DISABLED' });
    }
    res.json({ accessToken: jwt.sign(
      { id: record.user_id, username: record.username, role: record.role, permissions: liveUser.permissions || 0 },
      process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRY || '8h' }
    ) });
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
    res.clearCookie('refreshToken', { path: '/api/auth', ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}) });
    res.json({ message: 'Logged out' });
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

module.exports = router;