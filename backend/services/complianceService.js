// services/complianceService.js — Config drift / compliance snapshots
//
// Periodically (or on demand) SSH/WinRM into a device, pull three cheap
// fingerprints of its state — installed packages, running services, active
// firewall rules — and diff them against a saved "baseline". Any difference
// is surfaced as drift: an audit entry, an in-app notification, and a
// webhook, the same way alerts.js reports metric breaches.
//
// Collection commands are deliberately read-only and side-effect-free.
'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { decrypt } = require('./crypto');
const audit = require('./audit');
const webhook = require('./webhook');

// Register the event so it shows up in the webhook config UI's event list,
// same pattern as every other event in webhook.js.
webhook.EVENTS['compliance.drift'] = 'Config drift detected';

// ── Collection commands ───────────────────────────────────────────────────────
// Each returns a newline-separated, sorted list so diffing is a simple
// set comparison. Best-effort: if a given probe isn't available on the
// target (e.g. no dpkg on an RPM-based distro), it degrades to an empty
// list rather than failing the whole snapshot.
const LINUX_CMDS = {
  packages:
    `{ dpkg-query -W -f='\${Package}=\${Version}\\n' 2>/dev/null || rpm -qa --qf '%{NAME}=%{VERSION}-%{RELEASE}\\n' 2>/dev/null; } | sort`,
  services:
    `systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null | awk '{print $1}' | sort`,
  firewall_rules:
    `{ iptables -S 2>/dev/null; nft list ruleset 2>/dev/null; } | sort`,
};

const WINDOWS_CMDS = {
  packages:
    `powershell -NoProfile -Command "Get-Package -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name" 2>nul`,
  services:
    `powershell -NoProfile -Command "Get-Service | Where-Object {$_.Status -eq 'Running'} | Select-Object -ExpandProperty Name" 2>nul`,
  firewall_rules:
    `powershell -NoProfile -Command "Get-NetFirewallRule -Enabled True -ErrorAction SilentlyContinue | Select-Object -ExpandProperty DisplayName" 2>nul`,
};

// A quick, cheap probe used purely to tell "device unreachable" apart from
// "device reachable, but this particular command found nothing." If this
// fails, we treat the whole check as a connection failure rather than
// attributing it to any one probe (packages/services/firewall/files).
async function probeReachable(device) {
  const exec = device.os_type === 'linux' ? require('./ssh').execCommand : require('./winrm').execCommand;
  const cmd = device.os_type === 'linux' ? 'echo __ok__' : 'echo __ok__';
  await exec(device, cmd); // throws on connection/auth failure
}

function linuxCatCmd(path) {
  // -q makes it produce nothing (not an error) when the file doesn't exist,
  // so "file was removed" shows up as an empty-body diff rather than a
  // command failure the caller can't attribute to anything.
  return `cat -- ${JSON.stringify(path)} 2>/dev/null`;
}

function windowsCatCmd(path) {
  return `powershell -NoProfile -Command "Get-Content -Raw -ErrorAction SilentlyContinue -LiteralPath ${JSON.stringify(path)}" 2>nul`;
}

/** Read the current content of every watched file for a device. Best-effort
 * per file — a single missing/unreadable file becomes empty content rather
 * than failing the whole snapshot, same philosophy as the built-in probes. */
async function collectFiles(device, watchedPaths) {
  const exec = device.os_type === 'linux' ? require('./ssh').execCommand : require('./winrm').execCommand;
  const buildCmd = device.os_type === 'linux' ? linuxCatCmd : windowsCatCmd;
  const files = {};
  for (const path of watchedPaths) {
    try {
      const { stdout } = await exec(device, buildCmd(path));
      files[path] = stdout || '';
    } catch {
      files[path] = '';
    }
  }
  return files;
}

function safeJsonParse(str) {
  if (!str) return {};
  try { return JSON.parse(str); } catch { return {}; }
}

function normalizeList(raw) {
  return String(raw || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .sort();
}

function hashSnapshot({ packages, services, firewall_rules, files }) {
  const h = crypto.createHash('sha256')
    .update(packages || '')
    .update('\u0000')
    .update(services || '')
    .update('\u0000')
    .update(firewall_rules || '');
  // Fold in watched-file contents in a stable (sorted-path) order so the
  // hash doesn't depend on object key iteration order.
  for (const path of Object.keys(files || {}).sort()) {
    h.update('\u0000').update(path).update('\u0001').update(files[path] || '');
  }
  return h.digest('hex');
}

/** Diff two {path: content} maps. A path present in only one side counts as
 * fully added/removed; a path in both with different content is reported
 * with its own added/removed line sets. */
function diffFiles(oldFiles, newFiles) {
  const oldMap = oldFiles || {};
  const newMap = newFiles || {};
  const paths = new Set([...Object.keys(oldMap), ...Object.keys(newMap)]);
  const result = {};
  for (const path of paths) {
    const before = oldMap[path];
    const after = newMap[path];
    if (before === after) continue; // unchanged, or both missing
    if (before === undefined) {
      result[path] = { status: 'added', ...diffList('', after) };
    } else if (after === undefined) {
      result[path] = { status: 'removed', ...diffList(before, '') };
    } else {
      result[path] = { status: 'modified', ...diffList(before, after) };
    }
  }
  return result;
}

/** Set diff between two newline-joined, already-sorted lists. */
function diffList(oldText, newText) {
  const oldSet = new Set(normalizeList(oldText));
  const newSet = new Set(normalizeList(newText));
  const added = [...newSet].filter(x => !oldSet.has(x));
  const removed = [...oldSet].filter(x => !newSet.has(x));
  return { added, removed };
}

function buildDevice(row) {
  return {
    ...row,
    _ssh_password:   decrypt(row.ssh_password),
    _ssh_key:        decrypt(row.ssh_key),
    _winrm_password: decrypt(row.winrm_password),
  };
}

/** Pull the three fingerprints from a device over SSH (linux) or WinRM/RPC (windows). */
async function collect(device) {
  const cmds = device.os_type === 'linux' ? LINUX_CMDS : WINDOWS_CMDS;
  const exec = device.os_type === 'linux' ? require('./ssh').execCommand : require('./winrm').execCommand;

  const result = {};
  for (const [key, cmd] of Object.entries(cmds)) {
    try {
      const { stdout } = await exec(device, cmd);
      result[key] = normalizeList(stdout).join('\n');
    } catch (e) {
      // Best-effort per probe — one failing probe (e.g. firewall command not
      // present) shouldn't sink the whole snapshot.
      result[key] = '';
    }
  }
  return result;
}

/**
 * Run a single compliance check for one device: collect current state, save
 * it as a snapshot, diff against the active baseline (if any), and raise
 * drift notifications when something changed. Safe to call directly (manual
 * "run now") or from the periodic sweep.
 */
async function runCheck(deviceId) {
  const deviceRow = await queryOne('SELECT * FROM devices WHERE id = ?', [deviceId]);
  if (!deviceRow) throw new Error('Device not found');
  const device = buildDevice(deviceRow);

  const now = Math.floor(Date.now() / 1000);
  const snapshotId = uuidv4();
  let status = 'clean';
  let diff = null;
  let error = null;
  let unreachable = 0;
  let current = { packages: '', services: '', firewall_rules: '' };
  let currentFiles = {};

  const watched = await query(
    'SELECT file_path FROM compliance_watched_files WHERE device_id = ?', [deviceId]
  );
  const watchedPaths = watched.map(w => w.file_path);

  try {
    // Check reachability first, separately from the individual probes below.
    // A device that's simply down/unauthenticated must not be reported as
    // "clean" just because every best-effort probe degraded to empty output.
    await probeReachable(device);
    current = await collect(device);
    if (watchedPaths.length) currentFiles = await collectFiles(device, watchedPaths);
  } catch (e) {
    status = 'error';
    unreachable = 1;
    error = `Device unreachable: ${e.message}`;
  }

  const rawHash = status === 'error' ? null : hashSnapshot({ ...current, files: currentFiles });
  const baseline = await queryOne('SELECT * FROM compliance_baselines WHERE device_id = ?', [deviceId]);

  if (status !== 'error') {
    if (!baseline) {
      status = 'clean'; // nothing to compare against yet
    } else if (baseline.raw_hash === rawHash) {
      status = 'clean';
    } else {
      status = 'drift';
      diff = {
        packages:       diffList(baseline.packages, current.packages),
        services:       diffList(baseline.services, current.services),
        firewall_rules: diffList(baseline.firewall_rules, current.firewall_rules),
        files:          diffFiles(safeJsonParse(baseline.files), currentFiles),
      };
    }
  }

  await execute(
    `INSERT INTO compliance_snapshots
       (id, device_id, packages, services, firewall_rules, files, raw_hash, status, diff, error, unreachable, taken_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [snapshotId, deviceId, current.packages, current.services, current.firewall_rules,
     JSON.stringify(currentFiles), rawHash, status, diff ? JSON.stringify(diff) : null, error, unreachable, now]
  );

  await execute(
    `INSERT INTO compliance_config (device_id, enabled, check_interval_hours, last_checked_at, updated_at)
     VALUES (?, 1, 24, ?, ?)
     ON DUPLICATE KEY UPDATE last_checked_at = VALUES(last_checked_at)`,
    [deviceId, now, now]
  );

  if (status === 'drift') {
    const summary = summarizeDiff(diff);
    await audit.log({
      username: 'compliance-monitor', action: 'compliance_drift_detected',
      targetType: 'device', targetId: deviceId, targetName: device.name,
      ipSource: 'compliance-monitor', result: 'success', details: summary,
    });

    const admins = await query('SELECT id FROM users WHERE role = ? AND enabled = 1', ['admin']);
    try {
      const { pushNotification } = require('../routes/alerts');
      pushNotification(admins.map(a => a.id), {
        type: 'compliance_drift',
        severity: 'warning',
        device_id: deviceId,
        device_name: device.name,
        details: summary,
        snapshot_id: snapshotId,
        triggered_at: now,
      });
    } catch { /* alerts router not mounted yet at boot — non-fatal */ }

    webhook.fire('compliance.drift', {
      device_id: deviceId, device_name: device.name,
      message: `Config drift on ${device.name}: ${summary}`,
      severity: 'warning',
    }).catch(() => {});
  } else if (status === 'error') {
    await audit.log({
      username: 'compliance-monitor', action: 'compliance_check_failed',
      targetType: 'device', targetId: deviceId, targetName: device.name,
      ipSource: 'compliance-monitor', result: 'failure', details: error,
    });
  }

  return { id: snapshotId, status, diff, error, unreachable: !!unreachable, taken_at: now };
}

function summarizeDiff(diff) {
  const parts = [];
  for (const [category, val] of Object.entries(diff)) {
    if (category === 'files') {
      const changed = Object.keys(val || {});
      if (changed.length) parts.push(`${changed.length} watched file${changed.length === 1 ? '' : 's'} changed`);
      continue;
    }
    const { added, removed } = val;
    if (added.length) parts.push(`+${added.length} ${category}`);
    if (removed.length) parts.push(`-${removed.length} ${category}`);
  }
  return parts.length ? parts.join(', ') : 'no changes';
}

/** Promote a snapshot (or a fresh collection) to be the new baseline for a device. */
async function setBaseline(deviceId, { snapshotId, userId } = {}) {
  const now = Math.floor(Date.now() / 1000);
  let source;

  if (snapshotId) {
    source = await queryOne('SELECT * FROM compliance_snapshots WHERE id = ? AND device_id = ?', [snapshotId, deviceId]);
    if (!source) throw new Error('Snapshot not found');
    source.filesMap = safeJsonParse(source.files);
  } else {
    const deviceRow = await queryOne('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!deviceRow) throw new Error('Device not found');
    const device = buildDevice(deviceRow);
    const watched = await query('SELECT file_path FROM compliance_watched_files WHERE device_id = ?', [deviceId]);
    const watchedPaths = watched.map(w => w.file_path);
    const current = await collect(device);
    const currentFiles = watchedPaths.length ? await collectFiles(device, watchedPaths) : {};
    source = { ...current, filesMap: currentFiles, raw_hash: hashSnapshot({ ...current, files: currentFiles }) };
  }

  await execute(
    `INSERT INTO compliance_baselines (device_id, packages, services, firewall_rules, files, raw_hash, set_by, created_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE packages=VALUES(packages), services=VALUES(services),
       firewall_rules=VALUES(firewall_rules), files=VALUES(files), raw_hash=VALUES(raw_hash),
       set_by=VALUES(set_by), created_at=VALUES(created_at)`,
    [deviceId, source.packages, source.services, source.firewall_rules,
     JSON.stringify(source.filesMap || {}), source.raw_hash, userId || null, now]
  );

  return { device_id: deviceId, raw_hash: source.raw_hash, created_at: now };
}

/** Called on a timer (see server.js) — picks up every device that's due a check. */
async function runDueChecks() {
  const now = Math.floor(Date.now() / 1000);
  let due;
  try {
    due = await query(
      `SELECT device_id FROM compliance_config
        WHERE enabled = 1
          AND (last_checked_at IS NULL OR last_checked_at <= ? - (check_interval_hours * 3600))`,
      [now]
    );
  } catch (e) {
    console.error('[Compliance] failed to load due devices:', e.message);
    return;
  }

  for (const row of due) {
    try { await runCheck(row.device_id); }
    catch (e) { console.error(`[Compliance] check failed for ${row.device_id}:`, e.message); }
  }
}

let _timer = null;
function start() {
  if (_timer) return;
  // Sweep hourly; runDueChecks itself decides which devices are actually due
  // based on their own check_interval_hours.
  _timer = setInterval(() => runDueChecks().catch(() => {}), 60 * 60 * 1000);
  runDueChecks().catch(() => {}); // also catch up on anything overdue at boot
}
function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { runCheck, setBaseline, runDueChecks, start, stop, diffList, diffFiles, hashSnapshot };