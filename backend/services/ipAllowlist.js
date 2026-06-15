// services/ipAllowlist.js — CIDR-based IP allowlist enforcement
// Supports IPv4 exact IPs, IPv4 CIDR ranges, and IPv4-mapped IPv6 (::ffff:x.x.x.x)
'use strict';

const { query, queryOne, execute } = require('../db');
const { v4: uuidv4 } = require('uuid');

// ── CIDR matching ─────────────────────────────────────────────────────────────

/** Normalise an IPv4-mapped IPv6 address to plain IPv4 */
function normaliseIP(ip) {
  if (!ip) return '0.0.0.0';
  // ::ffff:192.168.1.1  →  192.168.1.1
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  // Handle localhost
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

/** Convert dotted-quad IPv4 to a 32-bit unsigned integer */
function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Return true if `ip` falls within the given `cidr`.
 * cidr can be:
 *   - exact IP:      "192.168.1.5"
 *   - CIDR notation: "192.168.1.0/24"
 */
function ipMatchesCidr(ip, cidr) {
  try {
    const normIp = normaliseIP(ip);
    const ipInt  = ipToInt(normIp);
    if (ipInt === null) return false;

    if (!cidr.includes('/')) {
      // Exact match
      return normIp === normaliseIP(cidr);
    }

    const [base, prefixStr] = cidr.split('/');
    const prefix = parseInt(prefixStr, 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;

    const baseInt = ipToInt(base.trim());
    if (baseInt === null) return false;

    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ipInt & mask) >>> 0 === (baseInt & mask) >>> 0;
  } catch {
    return false;
  }
}

// ── In-memory cache (30s TTL) to avoid per-request DB hits ───────────────────
let _cache      = null;
let _cacheTime  = 0;
const CACHE_TTL = 30_000; // ms

async function getAllowedRanges() {
  const now = Date.now();
  if (_cache && (now - _cacheTime) < CACHE_TTL) return _cache;
  try {
    _cache     = await query('SELECT * FROM ip_allowlist WHERE enabled = 1');
    _cacheTime = now;
  } catch {
    _cache = [];
  }
  return _cache;
}

/** Invalidate cache after any write operation */
function invalidateCache() { _cache = null; }

/**
 * Check whether a given IP is permitted for the user.
 *
 * Rules (most-specific wins, checked in order):
 *   1. If NO rules are configured at all → allow everything (safe default, allow admin bootstrap)
 *   2. If rules exist:
 *      a. Check user-specific rules (user_id matches) — if any match, allow
 *      b. Check role-level rules (role matches)       — if any match, allow
 *      c. Check global rules   (user_id IS NULL AND role IS NULL)
 *      d. If any of the above matched → allow; otherwise → deny
 */
async function isIPAllowed(ip, userId, role) {
  const ranges = await getAllowedRanges();

  // No rules at all → allow (bootstrapping)
  if (ranges.length === 0) return { allowed: true, reason: 'no_rules' };

  const norm = normaliseIP(ip);

  // Always allow loopback (localhost health checks, same-machine requests)
  if (norm === '127.0.0.1' || norm === '::1') return { allowed: true, reason: 'loopback' };

  // Split by rule type
  const userRules   = ranges.filter(r => r.user_id === userId);
  const roleRules   = ranges.filter(r => !r.user_id && r.role === role);
  const globalRules = ranges.filter(r => !r.user_id && !r.role);

  // If there are user-specific rules, they override everything for this user
  if (userRules.length > 0) {
    const hit = userRules.find(r => ipMatchesCidr(ip, r.cidr));
    return hit
      ? { allowed: true,  reason: 'user_rule',  rule: hit }
      : { allowed: false, reason: 'user_rule_no_match', ruleCount: userRules.length };
  }

  // Role-level rules
  if (roleRules.length > 0) {
    const hit = roleRules.find(r => ipMatchesCidr(ip, r.cidr));
    return hit
      ? { allowed: true,  reason: 'role_rule',  rule: hit }
      : { allowed: false, reason: 'role_rule_no_match', ruleCount: roleRules.length };
  }

  // Global rules
  if (globalRules.length > 0) {
    const hit = globalRules.find(r => ipMatchesCidr(ip, r.cidr));
    return hit
      ? { allowed: true,  reason: 'global_rule',  rule: hit }
      : { allowed: false, reason: 'global_rule_no_match', ruleCount: globalRules.length };
  }

  // Rules exist but none apply to this user/role → allow (rules are additive for now)
  return { allowed: true, reason: 'no_applicable_rules' };
}

// ── CRUD helpers ──────────────────────────────────────────────────────────────

async function listRules(opts = {}) {
  let sql = 'SELECT i.*, u.username FROM ip_allowlist i LEFT JOIN users u ON u.id = i.user_id';
  const params = [];
  const where  = [];
  if (opts.userId) { where.push('i.user_id = ?'); params.push(opts.userId); }
  if (opts.role)   { where.push('i.role = ?');    params.push(opts.role);   }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY i.created_at DESC';
  return query(sql, params);
}

async function createRule({ userId = null, role = null, cidr, label = null, enabled = true, createdBy = null }) {
  const id  = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  await execute(
    `INSERT INTO ip_allowlist (id, user_id, role, cidr, label, enabled, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId || null, role || null, cidr, label, enabled ? 1 : 0, createdBy || null, now]
  );
  invalidateCache();
  return id;
}

async function updateRule(id, patch) {
  const allowed = ['cidr', 'label', 'enabled', 'user_id', 'role'];
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
  }
  if (!sets.length) return;
  vals.push(id);
  await execute(`UPDATE ip_allowlist SET ${sets.join(', ')} WHERE id = ?`, vals);
  invalidateCache();
}

async function deleteRule(id) {
  await execute('DELETE FROM ip_allowlist WHERE id = ?', [id]);
  invalidateCache();
}

async function logBlockedAttempt({ username, ip, reason }) {
  const now = Math.floor(Date.now() / 1000);
  await execute(
    'INSERT INTO ip_block_log (id, username, ip, reason, blocked_at) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), username || null, ip, reason, now]
  ).catch(() => {});
}

module.exports = {
  isIPAllowed,
  ipMatchesCidr,
  normaliseIP,
  listRules,
  createRule,
  updateRule,
  deleteRule,
  logBlockedAttempt,
  invalidateCache,
};

