// services/agentRelease.js — DB-backed canary rollout + rollback for agent
// self-update. Every uploaded build is kept as a row in `agent_releases`
// (not overwritten), each with its own rollout_percent and status. Devices
// are bucketed deterministically by hash(device_id:version) so the same
// cohort stays "in the canary" as the percentage is dialed up, and rollback
// is just flipping which row is `active` — no re-upload needed.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');

const RELEASE_DIR = path.resolve(process.env.AGENT_RELEASE_DIR || path.resolve(__dirname, '..', '..', 'data', 'agent-release'));
const RELEASES_SUBDIR = path.join(RELEASE_DIR, 'releases');
const LEGACY_SCRIPT_PATH = path.join(RELEASE_DIR, 'netcontrol-agent.js');
const LEGACY_MANIFEST_PATH = path.join(RELEASE_DIR, 'release.json');

const HEALTH_GRACE_SEC = parseInt(process.env.AGENT_UPDATE_GRACE_SEC || '600', 10);
const UNHEALTHY_PAUSE_THRESHOLD = 0.20;

fs.mkdirSync(RELEASES_SUBDIR, { recursive: true });

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function bucketOf(deviceId, version) {
  const h = crypto.createHash('sha256').update(`${deviceId}:${version}`).digest();
  return h.readUInt32BE(0) % 100;
}

async function seedIfEmpty() {
  const existing = await queryOne(`SELECT id FROM agent_releases LIMIT 1`);
  if (existing) return;
  try {
    if (!fs.existsSync(LEGACY_SCRIPT_PATH)) {
      const shippedScript = path.resolve(__dirname, '..', '..', 'agent', 'netcontrol-agent.js');
      const shippedPkg = path.resolve(__dirname, '..', '..', 'agent', 'package.json');
      if (!fs.existsSync(shippedScript)) return;
      const content = fs.readFileSync(shippedScript);
      const version = fs.existsSync(shippedPkg)
        ? (JSON.parse(fs.readFileSync(shippedPkg, 'utf8')).version || '1.0.0')
        : '1.0.0';
      await saveRelease(content, { version, notes: 'Initial release (seeded from repo)', uploadedBy: null, rolloutPercent: 100 });
      console.log(`[AgentRelease] Seeded initial release v${version} from agent/netcontrol-agent.js`);
      return;
    }
    const content = fs.readFileSync(LEGACY_SCRIPT_PATH);
    let version = '1.0.0', notes = 'Migrated from legacy single-release manifest', uploadedBy = null;
    if (fs.existsSync(LEGACY_MANIFEST_PATH)) {
      const m = JSON.parse(fs.readFileSync(LEGACY_MANIFEST_PATH, 'utf8'));
      version = m.version || version;
      notes = m.notes || notes;
      uploadedBy = m.uploaded_by || null;
    }
    await saveRelease(content, { version, notes, uploadedBy, rolloutPercent: 100 });
    console.log(`[AgentRelease] Migrated legacy release v${version} into agent_releases`);
  } catch (e) {
    console.warn('[AgentRelease] Seed skipped:', e.message);
  }
}
const seedPromise = seedIfEmpty().catch(e => console.warn('[AgentRelease] seed error:', e.message));

function toManifest(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    notes: row.notes,
    sha256: row.sha256,
    rollout_percent: row.rollout_percent,
    status: row.status,
    uploaded_by: row.uploaded_by,
    uploaded_at: row.uploaded_at,
  };
}

async function getManifest() {
  await seedPromise;
  const row = await queryOne(`SELECT * FROM agent_releases WHERE status = 'active' ORDER BY uploaded_at DESC LIMIT 1`);
  return toManifest(row);
}

async function getScriptBuffer() {
  await seedPromise;
  const row = await queryOne(`SELECT * FROM agent_releases WHERE status = 'active' ORDER BY uploaded_at DESC LIMIT 1`);
  if (!row) return null;
  const filePath = path.join(RELEASE_DIR, row.storage_path);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

async function listReleases(limit = 20) {
  await seedPromise;
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  // NOTE: limit is interpolated directly, not bound as `LIMIT ?` — mysql2's
  // execute() (which db/index.js's query() always uses) doesn't reliably
  // accept a bound parameter inside LIMIT. Safe here since safeLimit is
  // already coerced to a bounded integer above (see routes/processPolicies.js
  // for the same pattern elsewhere in this codebase).
  const rows = await query(`SELECT * FROM agent_releases ORDER BY uploaded_at DESC LIMIT ${safeLimit}`);
  const out = [];
  for (const row of rows) {
    const health = await query(
      `SELECT agent_update_health AS h, COUNT(*) AS c FROM devices
       WHERE agent_version = ? AND agent_update_health IS NOT NULL GROUP BY agent_update_health`,
      [row.version]
    );
    const counts = { healthy: 0, unhealthy: 0, pending: 0 };
    for (const h of health) counts[h.h] = h.c;
    out.push({ ...toManifest(row), health: counts });
  }
  return out;
}

async function saveRelease(buffer, { version, notes, uploadedBy, rolloutPercent = 10 }) {
  await seedPromise;
  const dup = await queryOne(`SELECT id FROM agent_releases WHERE version = ?`, [version]);
  if (dup) throw new Error(`Version ${version} already exists`);

  const storagePath = path.join('releases', `${version}.js`);
  fs.writeFileSync(path.join(RELEASE_DIR, storagePath), buffer);

  const id = uuidv4();
  const digest = sha256(buffer);
  const now = Math.floor(Date.now() / 1000);

  await execute(`UPDATE agent_releases SET status = 'superseded' WHERE status = 'active'`);
  await execute(
    `INSERT INTO agent_releases (id, version, notes, sha256, storage_path, rollout_percent, status, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [id, version, notes || '', digest, storagePath, rolloutPercent, uploadedBy, now]
  );

  return toManifest(await queryOne(`SELECT * FROM agent_releases WHERE id = ?`, [id]));
}

async function setRolloutPercent(id, pct) {
  const row = await queryOne(`SELECT * FROM agent_releases WHERE id = ?`, [id]);
  if (!row) throw new Error('Release not found');
  await execute(`UPDATE agent_releases SET rollout_percent = ? WHERE id = ?`, [pct, id]);
  return true;
}

async function rollbackTo(id) {
  const target = await queryOne(`SELECT * FROM agent_releases WHERE id = ?`, [id]);
  if (!target) throw new Error('Release not found');
  await execute(`UPDATE agent_releases SET status = 'superseded' WHERE status = 'active'`);
  await execute(`UPDATE agent_releases SET status = 'active' WHERE id = ?`, [id]);
  return toManifest(target);
}

async function resumeRelease(id) {
  const row = await queryOne(`SELECT * FROM agent_releases WHERE id = ?`, [id]);
  if (!row) throw new Error('Release not found');
  if (row.status !== 'paused') throw new Error('Release is not paused');
  await execute(`UPDATE agent_releases SET status = 'superseded' WHERE status = 'active'`);
  await execute(`UPDATE agent_releases SET status = 'active' WHERE id = ?`, [id]);
  return true;
}

async function resolveUpdateForDevice(deviceId, currentVersion) {
  await seedPromise;
  const active = await queryOne(`SELECT * FROM agent_releases WHERE status = 'active' ORDER BY uploaded_at DESC LIMIT 1`);
  if (!active || !currentVersion) return { update_available: false, latest_version: active ? active.version : null };

  const newer = compareVersions(active.version, currentVersion) > 0;
  if (!newer) {
    markHealthyIfPending(deviceId, currentVersion).catch(() => {});
    return { update_available: false, latest_version: active.version };
  }

  const inCohort = bucketOf(deviceId, active.version) < active.rollout_percent;
  if (!inCohort) return { update_available: false, latest_version: active.version };

  const now = Math.floor(Date.now() / 1000);
  execute(`UPDATE devices SET agent_updated_at = ?, agent_update_health = 'pending' WHERE id = ?`, [now, deviceId])
    .catch(e => console.warn('[AgentRelease] failed to stamp update health:', e.message));

  return { update_available: true, latest_version: active.version };
}

async function markOfflineDuringUpdateGrace(deviceIds) {
  if (!deviceIds || !deviceIds.length) return;
  const now = Math.floor(Date.now() / 1000);
  const ph = deviceIds.map(() => '?').join(',');
  const rows = await query(
    `SELECT id FROM devices WHERE id IN (${ph}) AND agent_update_health = 'pending' AND agent_updated_at >= ?`,
    [...deviceIds, now - HEALTH_GRACE_SEC]
  );
  if (!rows.length) return;
  const ids = rows.map(r => r.id);
  const iph = ids.map(() => '?').join(',');
  await execute(`UPDATE devices SET agent_update_health = 'unhealthy' WHERE id IN (${iph})`, ids);
  await checkCanaryHealth();
}

async function markHealthyIfPending(deviceId, agentVersion) {
  const active = await queryOne(`SELECT version FROM agent_releases WHERE status = 'active' ORDER BY uploaded_at DESC LIMIT 1`);
  if (!active || active.version !== agentVersion) return;
  await execute(
    `UPDATE devices SET agent_update_health = 'healthy' WHERE id = ? AND agent_update_health = 'pending'`,
    [deviceId]
  ).catch(() => {});
}

async function checkCanaryHealth() {
  const active = await queryOne(`SELECT * FROM agent_releases WHERE status = 'active' ORDER BY uploaded_at DESC LIMIT 1`);
  if (!active || active.rollout_percent >= 100) return;

  const counts = await query(
    `SELECT agent_update_health AS h, COUNT(*) AS c FROM devices
     WHERE agent_version = ? AND agent_update_health IS NOT NULL GROUP BY agent_update_health`,
    [active.version]
  );
  const total = counts.reduce((s, r) => s + r.c, 0);
  const unhealthy = counts.find(r => r.h === 'unhealthy');
  if (total >= 3 && unhealthy && (unhealthy.c / total) > UNHEALTHY_PAUSE_THRESHOLD) {
    await execute(`UPDATE agent_releases SET status = 'paused' WHERE id = ?`, [active.id]);
    console.warn(`[AgentRelease] Auto-paused canary v${active.version}: ${unhealthy.c}/${total} reporting devices unhealthy`);
    require('./webhook').fire('system.agent_canary_paused', {
      severity: 'warning',
      message: `Agent canary v${active.version} auto-paused: ${unhealthy.c}/${total} devices unhealthy after update`,
    }).catch(() => {});
  }
}

module.exports = {
  getManifest, getScriptBuffer, listReleases, saveRelease, setRolloutPercent,
  rollbackTo, resumeRelease, resolveUpdateForDevice, markOfflineDuringUpdateGrace,
  markHealthyIfPending, checkCanaryHealth, compareVersions, RELEASE_DIR,
};