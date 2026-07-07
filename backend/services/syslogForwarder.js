// services/syslogForwarder.js — Forwards audit log events to an external
// syslog server (RFC 5424) over UDP or TCP, so the institution's existing
// log aggregator (rsyslog, syslog-ng, Graylog, Splunk, ELK, etc.) can ingest
// NetControl's audit trail. Replaces the earlier SNMP-trap forwarder —
// syslog is the more broadly-compatible choice for log aggregation and
// doesn't require a private enterprise OID.
//
// Configuration lives in the `system_settings` table (editable from the
// Audit Log page by admins) and falls back to environment variables so the
// feature also works out of the box on a fresh deploy.
'use strict';

const dgram = require('dgram');
const net   = require('net');
const os    = require('os');
const { execute, query } = require('../db');

const FACILITY = 16; // local0 — generic local-use facility, matches most NMS defaults
const SEVERITY = { success: 6, partial: 4, failure: 3 }; // Informational / Warning / Error
const APP_NAME = 'netcontrol';
const HOSTNAME = (process.env.SYSLOG_REPORTED_HOSTNAME || os.hostname() || '-').replace(/\s+/g, '_');

const DEFAULTS = {
  enabled:  false,
  host:     process.env.SYSLOG_SERVER_HOST || '',
  port:     parseInt(process.env.SYSLOG_SERVER_PORT) || 514,
  protocol: (process.env.SYSLOG_PROTOCOL || 'udp').toLowerCase() === 'tcp' ? 'tcp' : 'udp',
};

const SETTINGS_KEYS = {
  enabled:  'syslog_enabled',
  host:     'syslog_host',
  port:     'syslog_port',
  protocol: 'syslog_protocol',
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
      `SELECT \`key\`, value FROM system_settings WHERE \`key\` IN (?, ?, ?, ?)`,
      Object.values(SETTINGS_KEYS)
    );
    for (const row of rows) {
      if (row.key === SETTINGS_KEYS.enabled)  cfg.enabled  = row.value === '1' || row.value === 'true';
      if (row.key === SETTINGS_KEYS.host)     cfg.host     = row.value || cfg.host;
      if (row.key === SETTINGS_KEYS.port)     cfg.port     = parseInt(row.value) || cfg.port;
      if (row.key === SETTINGS_KEYS.protocol) cfg.protocol = row.value === 'tcp' ? 'tcp' : 'udp';
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
  if ('enabled' in partial)  entries.push([SETTINGS_KEYS.enabled,  partial.enabled ? '1' : '0']);
  if ('host' in partial)     entries.push([SETTINGS_KEYS.host,     String(partial.host || '')]);
  if ('port' in partial)     entries.push([SETTINGS_KEYS.port,     String(parseInt(partial.port) || 514)]);
  if ('protocol' in partial) entries.push([SETTINGS_KEYS.protocol, partial.protocol === 'tcp' ? 'tcp' : 'udp']);

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

// RFC 5424 structured data, e.g. [netcontrol@55555 action="wake" result="success"]
// 55555 mirrors the placeholder private-enterprise number used elsewhere in
// this codebase — swap for a real IANA PEN before relying on SD-ID validation
// in a strict downstream parser.
function sdEscape(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\]/g, '\\]');
}

function buildStructuredData(entry) {
  const fields = {
    user:    entry.username    || 'system',
    action:  entry.action      || '',
    target:  entry.target_name || entry.targetName || '',
    ip:      entry.ip_source   || entry.ipSource    || '',
    result:  entry.result      || 'unknown',
  };
  const pairs = Object.entries(fields).map(([k, v]) => `${k}="${sdEscape(v)}"`).join(' ');
  return `[netcontrol@55555 ${pairs}]`;
}

function rfc5424Timestamp(epochSeconds) {
  return new Date((epochSeconds || Math.floor(Date.now() / 1000)) * 1000).toISOString();
}

function buildMessage(entry) {
  const severity = SEVERITY[entry.result] ?? 6;
  const pri = FACILITY * 8 + severity;
  const timestamp = rfc5424Timestamp(entry.timestamp);
  const msgId = (entry.action || '-').slice(0, 32).replace(/\s+/g, '_');
  const structuredData = buildStructuredData(entry);
  const msg = entry.details ? String(entry.details).slice(0, 1024) : '-';

  // <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
  return `<${pri}>1 ${timestamp} ${HOSTNAME} ${APP_NAME} ${process.pid} ${msgId} ${structuredData} ${msg}`;
}

function sendUdp(host, port, message) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const buf = Buffer.from(message, 'utf8');
    socket.send(buf, port, host, (error) => {
      socket.close();
      if (error) resolve({ ok: false, error: error.message });
      else resolve({ ok: true });
    });
  });
}

function sendTcp(host, port, message) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: 'Connection timed out' });
    }, 4000);

    socket.once('error', (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, error: error.message });
    });

    socket.connect(port, host, () => {
      // RFC 6587 octet-counting framing, so multiple messages on one TCP
      // stream can't run together or get mis-split by the receiver.
      const buf = Buffer.from(message, 'utf8');
      const framed = `${buf.length} ${message}`;
      socket.write(framed, 'utf8', () => {
        clearTimeout(timeout);
        socket.end();
        resolve({ ok: true });
      });
    });
  });
}

// Sends one audit entry as a syslog message. Resolves { ok, error }. Never
// throws — this is fire-and-forget from the audit logger's point of view,
// so a misconfigured or unreachable syslog server never blocks a power action.
async function sendEntry(entry, cfgOverride = null) {
  const cfg = cfgOverride || await getConfig();

  if (!cfg.enabled || !cfg.host) {
    return { ok: false, error: 'Syslog forwarding disabled or no host configured', skipped: true };
  }

  const message = buildMessage(entry);
  let result;
  try {
    result = cfg.protocol === 'tcp'
      ? await sendTcp(cfg.host, cfg.port, message)
      : await sendUdp(cfg.host, cfg.port, message);
  } catch (e) {
    result = { ok: false, error: e.message };
  }

  if (result.ok) {
    stats.sent++; stats.lastSuccessAt = Math.floor(Date.now() / 1000);
  } else {
    stats.failed++; stats.lastError = result.error;
  }
  return result;
}

// Fire-and-forget wrapper used by services/audit.js right after an audit row
// is written — marks the row synced/unsynced without making the caller wait.
async function forwardAndMark(entry) {
  const result = await sendEntry(entry);
  if (result.skipped) return; // don't touch the DB flag if forwarding isn't even configured
  try {
    await execute(
      `UPDATE audit_log SET syslog_synced = ?, syslog_synced_at = ? WHERE id = ?`,
      [result.ok ? 1 : 0, Math.floor(Date.now() / 1000), entry.id]
    );
  } catch { /* best-effort — never let this break audit logging */ }
}

// Used by a scheduled log export whose target is "syslog" instead of a
// file destination — sends each matching audit row as its own message.
// Returns a summary rather than throwing, so one bad row doesn't abort
// the rest of the batch.
async function exportEntries(entries, cfgOverride = null) {
  const cfg = cfgOverride || await getConfig(true);
  let sent = 0, failed = 0;
  for (const entry of entries) {
    const result = await sendEntry(entry, cfg);
    if (result.ok) sent++; else if (!result.skipped) failed++;
    else throw new Error(result.error); // not configured at all — stop immediately
  }
  return { sent, failed, total: entries.length };
}

async function testConnection(cfgOverride) {
  return sendEntry({
    id: 'test',
    timestamp: Math.floor(Date.now() / 1000),
    username: 'system',
    action: 'syslog_test',
    target_name: 'connection-test',
    ip_source: '127.0.0.1',
    result: 'success',
    details: 'Test message sent from NetControl Audit Log settings',
  }, cfgOverride);
}

function getStats() {
  return { ...stats };
}

module.exports = { getConfig, setConfig, sendEntry, forwardAndMark, exportEntries, testConnection, getStats };