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

function normalizeList(raw) {
  return String(raw || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .sort();
}

function hashSnapshot({ packages, services, firewall_rules }) {
  return crypto.createHash('sha256')
    .update(packages || '')
    .update('\u0000')
    .update(services || '')
    .update('\u0000')
    .update(firewall_rules || '')
    .digest('hex');
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
  let current = { packages: '', services: '', firewall_rules: '' };

  try {
    current = await collect(device);
  } catch (e) {
    status = 'error';
    error = e.message;
  }

  const rawHash = status === 'error' ? null : hashSnapshot(current);
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
      };
    }
  }

  await execute(
    `INSERT INTO compliance_snapshots
       (id, device_id, packages, services, firewall_rules, raw_hash, status, diff, error, taken_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [snapshotId, deviceId, current.packages, current.services, current.firewall_rules,
     rawHash, status, diff ? JSON.stringify(diff) : null, error, now]
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

  return { id: snapshotId, status, diff, error, taken_at: now };
}

function summarizeDiff(diff) {
  const parts = [];
  for (const [category, { added, removed }] of Object.entries(diff)) {
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
  } else {
    const deviceRow = await queryOne('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!deviceRow) throw new Error('Device not found');
    const device = buildDevice(deviceRow);
    const current = await collect(device);
    source = { ...current, raw_hash: hashSnapshot(current) };
  }

  await execute(
    `INSERT INTO compliance_baselines (device_id, packages, services, firewall_rules, raw_hash, set_by, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE packages=VALUES(packages), services=VALUES(services),
       firewall_rules=VALUES(firewall_rules), raw_hash=VALUES(raw_hash),
       set_by=VALUES(set_by), created_at=VALUES(created_at)`,
    [deviceId, source.packages, source.services, source.firewall_rules, source.raw_hash, userId || null, now]
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

module.exports = { runCheck, setBaseline, runDueChecks, start, stop, diffList, hashSnapshot };
