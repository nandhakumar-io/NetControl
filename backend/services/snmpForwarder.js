// services/snmpForwarder.js — Forwards audit log events to an external SNMP
// server as SNMPv1/v2c traps, so the institution's existing NMS (PRTG,
// Zabbix, SolarWinds, Nagios, etc.) can ingest NetControl's audit trail
// alongside the rest of its network monitoring.
//
// Configuration lives in the `system_settings` table (editable from the
// Audit Log page by admins) and falls back to environment variables so the
// feature also works out of the box on a fresh deploy.
'use strict';

const snmp = require('net-snmp');
const { execute, query } = require('../db');

// Private-enterprise OID arc reserved for NetControl. 55555 is an
// unassigned/placeholder enterprise number — swap it for a real IANA
// Private Enterprise Number (https://www.iana.org/assignments/enterprise-numbers)
// before relying on this for a production NMS that validates enterprise OIDs.
const ENTERPRISE_OID = '1.3.6.1.4.1.55555.1.1';
const TRAP_OID       = `${ENTERPRISE_OID}.0.1`; // specific-trap: netcontrolAuditEvent

const VARBIND_OIDS = {
  timestamp:  `${ENTERPRISE_OID}.1`,
  username:   `${ENTERPRISE_OID}.2`,
  action:     `${ENTERPRISE_OID}.3`,
  targetName: `${ENTERPRISE_OID}.4`,
  ipSource:   `${ENTERPRISE_OID}.5`,
  result:     `${ENTERPRISE_OID}.6`,
  details:    `${ENTERPRISE_OID}.7`,
};

const DEFAULTS = {
  enabled:   false,
  host:      process.env.SNMP_SERVER_HOST || '',
  port:      parseInt(process.env.SNMP_SERVER_PORT) || 162,
  community: process.env.SNMP_COMMUNITY   || 'public',
  version:   process.env.SNMP_VERSION     || '2c', // '1' | '2c'
};

const SETTINGS_KEYS = {
  enabled:   'snmp_enabled',
  host:      'snmp_host',
  port:      'snmp_port',
  community: 'snmp_community',
  version:   'snmp_version',
};

// ── In-memory config cache (short TTL — admin changes should apply fast,
//    but we don't want a DB round-trip on every single audit event) ─────────
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 5000;

// Rolling counters for the status endpoint / UI badge — reset on process boot.
const stats = {
  sent: 0,
  failed: 0,
  lastSuccessAt: null,
  lastError: null,
};

async function getConfig(forceRefresh = false) {
  if (!forceRefresh && _cache && (Date.now() - _cacheAt) < CACHE_TTL_MS) {
    return _cache;
  }
  const cfg = { ...DEFAULTS };
  try {
    const rows = await query(
      `SELECT \`key\`, value FROM system_settings WHERE \`key\` IN (?, ?, ?, ?, ?)`,
      Object.values(SETTINGS_KEYS)
    );
    for (const row of rows) {
      if (row.key === SETTINGS_KEYS.enabled)   cfg.enabled   = row.value === '1' || row.value === 'true';
      if (row.key === SETTINGS_KEYS.host)      cfg.host      = row.value || cfg.host;
      if (row.key === SETTINGS_KEYS.port)      cfg.port      = parseInt(row.value) || cfg.port;
      if (row.key === SETTINGS_KEYS.community) cfg.community = row.value || cfg.community;
      if (row.key === SETTINGS_KEYS.version)   cfg.version   = row.value || cfg.version;
    }
  } catch (e) {
    // system_settings table may not exist yet (pre-migration) — fall back to env defaults silently
  }
  _cache = cfg;
  _cacheAt = Date.now();
  return cfg;
}

async function setConfig(partial, userId) {
  const now = Math.floor(Date.now() / 1000);
  const entries = [];
  if ('enabled' in partial)   entries.push([SETTINGS_KEYS.enabled,   partial.enabled ? '1' : '0']);
  if ('host' in partial)      entries.push([SETTINGS_KEYS.host,      String(partial.host || '')]);
  if ('port' in partial)      entries.push([SETTINGS_KEYS.port,      String(parseInt(partial.port) || 162)]);
  if ('community' in partial) entries.push([SETTINGS_KEYS.community, String(partial.community || 'public')]);
  if ('version' in partial)   entries.push([SETTINGS_KEYS.version,   partial.version === '1' ? '1' : '2c']);

  for (const [key, value] of entries) {
    await execute(
      `INSERT INTO system_settings (\`key\`, value, updated_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
      [key, value, userId || null, now]
    );
  }
  _cache = null; // force refresh on next read
  return getConfig(true);
}

function buildVarbinds(entry) {
  return [
    { oid: VARBIND_OIDS.timestamp,  type: snmp.ObjectType.OctetString, value: String(entry.timestamp || Math.floor(Date.now() / 1000)) },
    { oid: VARBIND_OIDS.username,   type: snmp.ObjectType.OctetString, value: String(entry.username   || 'system') },
    { oid: VARBIND_OIDS.action,     type: snmp.ObjectType.OctetString, value: String(entry.action     || '') },
    { oid: VARBIND_OIDS.targetName, type: snmp.ObjectType.OctetString, value: String(entry.target_name || entry.targetName || '') },
    { oid: VARBIND_OIDS.ipSource,   type: snmp.ObjectType.OctetString, value: String(entry.ip_source   || entry.ipSource   || '') },
    { oid: VARBIND_OIDS.result,     type: snmp.ObjectType.OctetString, value: String(entry.result      || 'unknown') },
    { oid: VARBIND_OIDS.details,    type: snmp.ObjectType.OctetString, value: String(entry.details      || '').slice(0, 255) },
  ];
}

// Sends one audit entry as an SNMP trap. Resolves { ok, error }. Never throws —
// this is fire-and-forget from the audit logger's point of view, so a
// misconfigured or unreachable SNMP server never blocks a power action.
function sendTrap(entry, cfgOverride = null) {
  return new Promise(async (resolve) => {
    const cfg = cfgOverride || await getConfig();

    if (!cfg.enabled || !cfg.host) {
      resolve({ ok: false, error: 'SNMP forwarding disabled or no host configured', skipped: true });
      return;
    }

    let session;
    try {
      session = snmp.createSession(cfg.host, cfg.community, {
        port:    cfg.port,
        version: cfg.version === '1' ? snmp.Version1 : snmp.Version2c,
        timeout: 4000,
      });
    } catch (e) {
      stats.failed++; stats.lastError = e.message;
      resolve({ ok: false, error: e.message });
      return;
    }

    const varbinds = buildVarbinds(entry);

    session.trap(TRAP_OID, varbinds, cfg.host, (error) => {
      session.close();
      if (error) {
        stats.failed++; stats.lastError = error.message || String(error);
        resolve({ ok: false, error: stats.lastError });
      } else {
        stats.sent++; stats.lastSuccessAt = Math.floor(Date.now() / 1000);
        resolve({ ok: true });
      }
    });
  });
}

// Fire-and-forget wrapper used by services/audit.js right after an audit row
// is written — marks the row synced/unsynced without making the caller wait.
async function forwardAndMark(entry) {
  const result = await sendTrap(entry);
  if (result.skipped) return; // don't touch the DB flag if forwarding isn't even configured
  try {
    await execute(
      `UPDATE audit_log SET snmp_synced = ?, snmp_synced_at = ? WHERE id = ?`,
      [result.ok ? 1 : 0, Math.floor(Date.now() / 1000), entry.id]
    );
  } catch { /* best-effort — never let this break audit logging */ }
}

async function testConnection(cfgOverride) {
  return sendTrap({
    id: 'test',
    timestamp: Math.floor(Date.now() / 1000),
    username: 'system',
    action: 'snmp_test',
    target_name: 'connection-test',
    ip_source: '127.0.0.1',
    result: 'success',
    details: 'Test trap sent from NetControl Audit Log settings',
  }, cfgOverride);
}

function getStats() {
  return { ...stats };
}

module.exports = { getConfig, setConfig, sendTrap, forwardAndMark, testConnection, getStats, TRAP_OID, ENTERPRISE_OID };