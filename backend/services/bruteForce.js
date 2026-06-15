// services/bruteForce.js — Automatic IP ban after repeated login failures
//
// How it works:
//   - Every failed login attempt increments a counter in ip_ban_log (in-memory cache)
//   - After THRESHOLD failures within WINDOW_SEC, the IP is temporarily banned
//   - Ban duration grows exponentially: 1st ban=5min, 2nd=15min, 3rd=60min, 4th+=24h
//   - Bans are stored in DB (ip_bans table) so they survive server restarts
//   - Admin can view and manually lift bans via /api/security/bans
//   - Successful login resets the failure counter for that IP
//
// Config (env vars):
//   BF_THRESHOLD=5        — failures before ban (default 5)
//   BF_WINDOW_SEC=300     — rolling window in seconds (default 5 min)
//   BF_MAX_BAN_SEC=86400  — maximum ban duration (default 24h)

'use strict';
const { query, queryOne, execute } = require('../db');
const { v4: uuidv4 } = require('uuid');

const THRESHOLD    = parseInt(process.env.BF_THRESHOLD    || '5',  10);
const WINDOW_SEC   = parseInt(process.env.BF_WINDOW_SEC   || '300', 10);
const MAX_BAN_SEC  = parseInt(process.env.BF_MAX_BAN_SEC  || '86400', 10);

// Ban durations per strike (seconds): 5m, 15m, 1h, 24h
const BAN_DURATIONS = [300, 900, 3600, MAX_BAN_SEC];

// In-memory attempt cache: ip → [timestamp, timestamp, ...]
// Kept small — only stores recent attempts within the window
const attempts = new Map();

function cleanOldAttempts(ip) {
  const cutoff = Math.floor(Date.now() / 1000) - WINDOW_SEC;
  const list = attempts.get(ip) || [];
  const fresh = list.filter(ts => ts > cutoff);
  if (fresh.length) attempts.set(ip, fresh);
  else attempts.delete(ip);
  return fresh;
}

// ── Check if IP is currently banned ───────────────────────────────────────────
async function isBanned(ip) {
  const now = Math.floor(Date.now() / 1000);
  const ban = await queryOne(
    'SELECT * FROM ip_bans WHERE ip = ? AND expires_at > ? AND lifted_at IS NULL ORDER BY created_at DESC LIMIT 1',
    [ip, now]
  ).catch(() => null);
  if (!ban) return { banned: false };
  const remaining = ban.expires_at - now;
  return {
    banned:    true,
    reason:    ban.reason,
    expiresAt: ban.expires_at,
    remaining, // seconds
    banId:     ban.id,
  };
}

// ── Record a failed attempt; ban if threshold crossed ────────────────────────
async function recordFailure(ip, username) {
  const now = Math.floor(Date.now() / 1000);
  const list = cleanOldAttempts(ip);
  list.push(now);
  attempts.set(ip, list);

  // Persist to attempt log (fire-and-forget)
  execute(
    'INSERT INTO ip_ban_log (id, ip, username, attempted_at) VALUES (?, ?, ?, ?)',
    [uuidv4(), ip, username || null, now]
  ).catch(() => {});

  if (list.length >= THRESHOLD) {
    // Count prior bans to determine duration
    const priorBans = await query(
      'SELECT id FROM ip_bans WHERE ip = ?',
      [ip]
    ).catch(() => []);
    const strikeIdx = Math.min(priorBans.length, BAN_DURATIONS.length - 1);
    const duration  = BAN_DURATIONS[strikeIdx];
    const expiresAt = now + duration;

    const banId = uuidv4();
    await execute(
      `INSERT INTO ip_bans (id, ip, reason, attempts, duration_sec, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [banId, ip, `${list.length} failed logins in ${WINDOW_SEC}s`, list.length, duration, now, expiresAt]
    ).catch(() => {});

    // Clear attempts so the counter resets after ban
    attempts.delete(ip);

    console.warn(`[BruteForce] Banned ${ip} for ${Math.round(duration/60)}min (strike ${strikeIdx+1}, ${list.length} failures)`);
    return { banned: true, expiresAt, duration };
  }

  return { banned: false, remaining: THRESHOLD - list.length };
}

// ── Record a successful login — resets failure counter ────────────────────────
function recordSuccess(ip) {
  attempts.delete(ip);
}

// ── Admin: list all active bans ───────────────────────────────────────────────
async function listBans(includeExpired = false) {
  const now = Math.floor(Date.now() / 1000);
  const sql = includeExpired
    ? 'SELECT * FROM ip_bans ORDER BY created_at DESC LIMIT 200'
    : 'SELECT * FROM ip_bans WHERE expires_at > ? AND lifted_at IS NULL ORDER BY created_at DESC';
  return query(sql, includeExpired ? [] : [now]).catch(() => []);
}

// ── Admin: lift a ban manually ────────────────────────────────────────────────
async function liftBan(banId, liftedBy) {
  const now = Math.floor(Date.now() / 1000);
  await execute(
    'UPDATE ip_bans SET lifted_at = ?, lifted_by = ? WHERE id = ?',
    [now, liftedBy || null, banId]
  );
  // Also clear in-memory attempts for any IP in this ban
  const ban = await queryOne('SELECT ip FROM ip_bans WHERE id = ?', [banId]).catch(() => null);
  if (ban) attempts.delete(ban.ip);
}

// ── Current attempt counts (for admin dashboard) ──────────────────────────────
function getAttemptCounts() {
  const result = [];
  for (const [ip, list] of attempts.entries()) {
    const fresh = cleanOldAttempts(ip);
    if (fresh.length) result.push({ ip, count: fresh.length, threshold: THRESHOLD });
  }
  return result;
}

module.exports = { isBanned, recordFailure, recordSuccess, listBans, liftBan, getAttemptCounts };

