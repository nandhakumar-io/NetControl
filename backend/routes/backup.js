// routes/backup.js — File/folder backup: browse, create, list, download, delete
//
// Mirrors the shape of routes/filePush.js: requireAuth + requirePermission
// gate every route, requireActionPin gates the mutating ones, and every
// action is written to the audit log + fired as a webhook so it shows up
// alongside every other privileged action in this app.
//
// A backup now has two independently-chosen sides:
//   SOURCE      — either the NetControl server's own sanctioned BACKUP_ROOT
//                 (unchanged, see services/backupService.js), or a disk on
//                 another registered Linux device, browsed live over SFTP
//                 (services/remoteBrowse.js). GET /devices lists what's
//                 eligible, GET /devices/:id/disks lists mount points on it,
//                 GET /devices/:id/browse walks a directory on it.
//   DESTINATION — 'local' (BACKUP_STORE_DIR, the original-only behavior),
//                 or a saved S3 bucket / remote-device folder
//                 (backup_destinations table, services/backupDestinations.js).
//                 GET /destinations lists what's configured; POST/DELETE
//                 manage them (admin + action PIN, since they hold or point
//                 at credentials).
//
// Remote sources support the same zip/tar/tar.gz formats as local ones —
// built with the target device's own `tar`/`zip` over SSH, streamed directly
// to wherever the destination is, so data never needs a slow SFTP
// file-by-file pull just to get archived.

'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const { body, param, query: queryValidator, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const { requireAuth, requireRole, requirePermission, requireActionPin } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const { query, queryOne, execute } = require('../db');
const backupService = require('../services/backupService');
const remoteBrowse = require('../services/remoteBrowse');
const destinations = require('../services/backupDestinations');
const backupVerify = require('../services/backupVerify');
const { decrypt } = require('../services/crypto');
const audit = require('../services/audit');
const webhook = require('../services/webhook');

const router = express.Router();
router.use(requireAuth);
router.use(requireOrgContext);
router.use(requirePermission(8192));

const FORMATS = ['zip', 'tar', 'tar.gz'];

// ── Shared verify runner ──────────────────────────────────────────────────────
// Used both by the automatic post-backup check and the manual /:id/verify
// endpoint, so the DB update + webhook/audit behavior stays identical either
// way. Never throws — failures are recorded on the row, not surfaced as a
// request error, since a failed verify is an expected, actionable outcome,
// not a server error.
async function runVerification(row, actor) {
  const result = await backupVerify.verifyBackup(row, backupService.BACKUP_STORE_DIR);
  await execute(
    `UPDATE backups SET verify_status = ?, verified_at = ?, verify_error = ?, verify_checksum = ? WHERE id = ?`,
    [result.status, Math.floor(Date.now() / 1000), result.status === 'failed' ? result.error : null, result.checksum, row.id]
  );

  if (result.status === 'failed') {
    webhook.fire('backup.verify_failed', {
      id: row.id, archive_name: row.archive_name, destination: row.destination_name || 'local',
      error: result.error, severity: 'critical',
      message: `Restore verification FAILED for backup ${row.archive_name} (${row.destination_name || 'local'}): ${result.error}`,
    }).catch(() => {});
  } else {
    webhook.fire('backup.verified', {
      id: row.id, archive_name: row.archive_name, destination: row.destination_name || 'local',
      entryCount: result.entryCount, severity: 'info',
      message: `Backup ${row.archive_name} verified OK (${result.entryCount} archive entries readable)`,
    }).catch(() => {});
  }

  await audit.log({
    userId: actor?.id || null, username: actor?.username || 'system',
    action: 'backup_verify', targetType: 'backup', targetId: row.id, targetName: row.archive_name,
    result: result.status === 'passed' ? 'success' : 'failure',
    details: result.status === 'passed' ? `${result.entryCount} entries OK` : result.error,
  }).catch(() => {});

  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
async function loadDeviceWithCreds(deviceId, orgId) {
  const d = await queryOne(`SELECT * FROM devices WHERE id = ? AND org_id = ?`, [deviceId, orgId]);
  if (!d) return null;
  return {
    ...d,
    _ssh_password: decrypt(d.ssh_password),
    _ssh_key: decrypt(d.ssh_key),
  };
}

const LOCAL_DEVICE_ID = 'local';

// ── GET /api/backup/devices ───────────────────────────────────────────────────
// Sources a backup can be taken from: the NetControl server itself, plus any
// registered Linux device with SSH credentials configured (needed for both
// disk enumeration via `df` and directory listing via SFTP).
router.get('/devices', async (req, res) => {
  try {
    // Every registered device is shown — hiding devices without SSH creds
    // silently made it look like "my device disappeared" when in reality
    // most fleets here are Windows/WinRM or agent-managed, not SSH. Each
    // row instead carries sshCapable so the client can explain *why* a
    // device can't be browsed yet, rather than just omitting it.
    const rows = await query(
      `SELECT id, name, ip_address, os_type, status,
              (os_type = 'linux' AND ssh_username IS NOT NULL
               AND (ssh_password IS NOT NULL OR ssh_key IS NOT NULL)) AS sshCapable,
              (SELECT GROUP_CONCAT(dt.tag ORDER BY dt.tag SEPARATOR ',')
                 FROM device_tags dt WHERE dt.device_id = devices.id) AS tags_csv
       FROM devices WHERE org_id = ? ORDER BY name`,
      [req.orgId]
    );
    const tagFilter = (req.query.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    let mapped = rows.map(r => ({
      ...r, isLocal: false, sshCapable: !!r.sshCapable,
      tags: r.tags_csv ? r.tags_csv.split(',') : [], tags_csv: undefined,
    }));
    if (tagFilter.length) mapped = mapped.filter(d => d.tags.some(t => tagFilter.includes(t)));
    res.json([
      { id: LOCAL_DEVICE_ID, name: 'This server (local)', ip_address: null, os_type: null, status: 'online', isLocal: true, sshCapable: true, tags: [] },
      ...mapped,
    ]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/backup/devices/:deviceId/disks ──────────────────────────────────
router.get('/devices/:deviceId/disks', async (req, res) => {
  try {
    if (req.params.deviceId === LOCAL_DEVICE_ID) {
      const info = backupService.getLocalDiskInfo();
      return res.json(info ? [info] : []);
    }
    const device = await loadDeviceWithCreds(req.params.deviceId, req.orgId);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    const disks = await remoteBrowse.listDisks(device);
    res.json(disks);
  } catch (e) {
    const status = e instanceof remoteBrowse.RemoteBrowseError ? 400 : 502;
    res.status(status).json({ error: e.message });
  }
});

// ── GET /api/backup/devices/:deviceId/browse?mount=/home&path=sub/dir ────────
// mount is required for remote devices (which disk from GET disks the client
// picked); ignored for local, which stays scoped to BACKUP_ROOT as before.
router.get('/devices/:deviceId/browse', async (req, res) => {
  try {
    if (req.params.deviceId === LOCAL_DEVICE_ID) {
      const result = await backupService.browse(req.query.path || '');
      return res.json(result);
    }
    const device = await loadDeviceWithCreds(req.params.deviceId, req.orgId);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!req.query.mount) return res.status(400).json({ error: 'mount is required for a remote device' });
    const result = await remoteBrowse.browse(device, req.query.mount, req.query.path || '');
    res.json(result);
  } catch (e) {
    if (e instanceof backupService.BackupPathError || e instanceof remoteBrowse.RemoteBrowseError) {
      return res.status(400).json({ error: e.message });
    }
    res.status(502).json({ error: e.message });
  }
});

// Back-compat: the original local-only browse endpoint still works exactly
// as before for anything not yet updated to the device-scoped one above.
router.get('/browse', async (req, res) => {
  try {
    const result = await backupService.browse(req.query.path || '');
    res.json(result);
  } catch (e) {
    if (e instanceof backupService.BackupPathError) {
      return res.status(400).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/backup/destinations ──────────────────────────────────────────────
// Local is always available and always first. Saved destinations never
// expose their decrypted config — only what's safe to show in a picker.
router.get('/destinations', async (req, res) => {
  try {
    const rows = await query(`SELECT id, name, type, config, created_at FROM backup_destinations WHERE org_id = ? ORDER BY name`, [req.orgId]);
    const saved = rows.map(r => {
      let config = {};
      try { config = destinations.redactConfig(r.type, destinations.decryptConfig(r.config)); } catch { /* leave empty on decrypt failure */ }
      return { id: r.id, name: r.name, type: r.type, config, created_at: r.created_at };
    });
    res.json([
      { id: null, name: 'Local backup store', type: 'local', config: {} },
      ...saved,
    ]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/backup/destinations — admin only, create S3 or remote-folder ──
router.post(
  '/destinations',
  requireRole('admin'),
  [
    body('name').notEmpty().isString().isLength({ max: 100 }),
    body('type').isIn(['s3', 'azure_blob', 'remote_folder']),
    body('actionPin').notEmpty().isString(),
    body('config').isObject(),
  ],
  requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, type, config } = req.body;
    try {
      if (type === 's3') {
        for (const f of ['bucket', 'region', 'accessKeyId', 'secretAccessKey']) {
          if (!config[f]) return res.status(400).json({ error: `config.${f} is required for an S3 destination` });
        }
      } else if (type === 'azure_blob') {
        if (!config.container) return res.status(400).json({ error: 'config.container is required for an Azure destination' });
        if (!config.connectionString && !(config.accountName && config.accountKey)) {
          return res.status(400).json({ error: 'Azure destination needs either config.connectionString or both config.accountName and config.accountKey' });
        }
      } else if (type === 'remote_folder') {
        if (!config.deviceId) return res.status(400).json({ error: 'config.deviceId is required' });
        if (!config.remotePath) return res.status(400).json({ error: 'config.remotePath is required' });
        const device = await queryOne(`SELECT id, name FROM devices WHERE id = ? AND org_id = ?`, [config.deviceId, req.orgId]);
        if (!device) return res.status(400).json({ error: 'Selected device not found' });
        config.deviceName = device.name; // denormalized for display in redactConfig()
      }

      const id = uuidv4();
      await execute(
        `INSERT INTO backup_destinations (id, name, type, config, created_by, created_at, org_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, name, type, destinations.encryptConfig(config), req.user.id, Math.floor(Date.now() / 1000), req.orgId]
      );

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'backup_destination_create', targetType: 'backup_destination', targetId: id, targetName: name,
        ipSource: req.ip, result: 'success', details: `type=${type}`,
      });

      res.json({ id, name, type, config: destinations.redactConfig(type, config) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ── PUT /api/backup/destinations/:id — admin only, edit a saved destination ──
// Type is immutable on edit (S3 vs remote-folder have entirely different
// required fields) — switching kinds means delete + re-add instead. Secret
// fields (S3 secretAccessKey) can be left blank to keep the existing value,
// same pattern used when editing device SSH credentials elsewhere.
router.put(
  '/destinations/:id',
  requireRole('admin'),
  [
    param('id').isUUID(),
    body('name').notEmpty().isString().isLength({ max: 100 }),
    body('actionPin').notEmpty().isString(),
    body('config').isObject(),
  ],
  requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const existing = await queryOne(`SELECT * FROM backup_destinations WHERE id = ? AND org_id = ?`, [req.params.id, req.orgId]);
      if (!existing) return res.status(404).json({ error: 'Destination not found' });

      const { name } = req.body;
      const config = { ...req.body.config };

      if (existing.type === 's3') {
        if (!config.secretAccessKey || !config.accessKeyId) {
          const prevConfig = destinations.decryptConfig(existing.config);
          if (!config.secretAccessKey) config.secretAccessKey = prevConfig.secretAccessKey;
          if (!config.accessKeyId) config.accessKeyId = prevConfig.accessKeyId;
        }
        for (const f of ['bucket', 'region', 'accessKeyId', 'secretAccessKey']) {
          if (!config[f]) return res.status(400).json({ error: `config.${f} is required for an S3 destination` });
        }
      } else if (existing.type === 'azure_blob') {
        if (!config.connectionString && !config.accountKey) {
          const prevConfig = destinations.decryptConfig(existing.config);
          if (!config.connectionString) config.connectionString = prevConfig.connectionString;
          if (!config.accountKey) config.accountKey = prevConfig.accountKey;
          if (!config.accountName) config.accountName = prevConfig.accountName;
        }
        if (!config.container) return res.status(400).json({ error: 'config.container is required for an Azure destination' });
        if (!config.connectionString && !(config.accountName && config.accountKey)) {
          return res.status(400).json({ error: 'Azure destination needs either config.connectionString or both config.accountName and config.accountKey' });
        }
      } else if (existing.type === 'remote_folder') {
        if (!config.deviceId) return res.status(400).json({ error: 'config.deviceId is required' });
        if (!config.remotePath) return res.status(400).json({ error: 'config.remotePath is required' });
        const device = await queryOne(`SELECT id, name FROM devices WHERE id = ? AND org_id = ?`, [config.deviceId, req.orgId]);
        if (!device) return res.status(400).json({ error: 'Selected device not found' });
        config.deviceName = device.name;
      }

      await execute(
        `UPDATE backup_destinations SET name = ?, config = ? WHERE id = ? AND org_id = ?`,
        [name, destinations.encryptConfig(config), req.params.id, req.orgId]
      );

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'backup_destination_update', targetType: 'backup_destination', targetId: req.params.id, targetName: name,
        ipSource: req.ip, result: 'success', details: `type=${existing.type}`,
      });

      res.json({ id: req.params.id, name, type: existing.type, config: destinations.redactConfig(existing.type, config) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ── DELETE /api/backup/destinations/:id — admin only ─────────────────────────
router.delete('/destinations/:id', requireRole('admin'), [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const row = await queryOne(`SELECT * FROM backup_destinations WHERE id = ? AND org_id = ?`, [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Destination not found' });
    await execute(`DELETE FROM backup_destinations WHERE id = ?`, [row.id]);
    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'backup_destination_delete', targetType: 'backup_destination', targetId: row.id, targetName: row.name,
      ipSource: req.ip, result: 'success',
    });
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/backup ───────────────────────────────────────────────────────────
// List completed/pending/failed backups, newest first.
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, source_path, device_id, device_name, source_type, format,
              destination_id, destination_name, destination_type,
              archive_name, size_bytes, checksum_sha256, status, error_message,
              encrypted, verify_status, verified_at, verify_error, verify_checksum,
              created_by, created_by_name, created_at, completed_at
       FROM backups WHERE org_id = ? ORDER BY created_at DESC`,
      [req.orgId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/backup ───────────────────────────────────────────────────────────
// Create a new archive from sourcePath (optionally on deviceId/mount) in the
// chosen format, written to destinationId (or local if omitted/null).
// Requires the action PIN, same as other disk/device-mutating routes.
router.post(
  '/',
  [
    body('sourcePath').notEmpty().isString().isLength({ max: 1000 }),
    body('deviceId').optional({ nullable: true }).isString(),
    body('mount').optional({ nullable: true }).isString(),
    body('format').isIn(FORMATS).withMessage(`format must be one of: ${FORMATS.join(', ')}`),
    body('label').optional().isString().isLength({ max: 80 }),
    body('destinationId').optional({ nullable: true }).isUUID(),
    body('actionPin').notEmpty().isString(),
  ],
  requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { sourcePath, format, label, mount } = req.body;
    const deviceId = req.body.deviceId || LOCAL_DEVICE_ID;
    const isRemoteSource = deviceId !== LOCAL_DEVICE_ID;
    // Remote sources now support the same zip/tar/tar.gz choices as local
    // ones — built on the device itself (tar/zip) or via `zip` if installed
    // there, and streamed straight through rather than round-tripping every
    // file over SFTP first just to archive it locally. See remoteBrowse.archiveStream.
    const effectiveFormat = format;

    const id = uuidv4();
    const nowSec = Math.floor(Date.now() / 1000);
    let sourceDeviceName = null;
    let destination = { type: 'local', config: {} };
    let destinationName = null;

    try {
      if (isRemoteSource) {
        const d = await queryOne(`SELECT name FROM devices WHERE id = ? AND org_id = ?`, [deviceId, req.orgId]);
        if (!d) return res.status(400).json({ error: 'Source device not found' });
        sourceDeviceName = d.name;
        if (!mount) return res.status(400).json({ error: 'mount is required when backing up from a device' });
      }

      if (req.body.destinationId) {
        const destRow = await queryOne(`SELECT * FROM backup_destinations WHERE id = ? AND org_id = ?`, [req.body.destinationId, req.orgId]);
        if (!destRow) return res.status(400).json({ error: 'Destination not found' });
        const config = destinations.decryptConfig(destRow.config);
        destinationName = destRow.name;
        if (destRow.type === 'remote_folder') {
          const destDevice = await loadDeviceWithCreds(config.deviceId, req.orgId);
          if (!destDevice) return res.status(400).json({ error: 'Destination device not found' });
          destination = { type: 'remote_folder', config, device: destDevice };
        } else {
          destination = { type: destRow.type, config };
        }
      }

      // Row goes in as 'pending' first so a crash mid-archive still leaves a
      // trace instead of just silently never appearing.
      await execute(
        `INSERT INTO backups (id, source_path, device_id, device_name, source_type, format,
                destination_id, destination_name, destination_type, archive_name, status,
                created_by, created_by_name, created_at, org_id)
         VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, '', 'pending', ?, ?, ?, ?)`,
        [id, sourcePath, isRemoteSource ? deviceId : null, sourceDeviceName, effectiveFormat,
         req.body.destinationId || null, destinationName, destination.type,
         req.user.id, req.user.username, nowSec, req.orgId]
      );

      const cfg = backupService.FORMAT_CONFIG[effectiveFormat];
      const baseName = (label || path.basename(sourcePath) || 'backup').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80) || 'backup';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archiveName = `${baseName}-${stamp}.${cfg.ext}`;

      let stream, sourceRel, sourceType;
      if (isRemoteSource) {
        const device = await loadDeviceWithCreds(deviceId, req.orgId);
        const archiveResult = await remoteBrowse.archiveStream(device, mount, sourcePath, effectiveFormat);
        stream = archiveResult.stream;
        sourceRel = archiveResult.sourceRel;
        const st = await remoteBrowse.statAbs(device, mount, sourcePath);
        sourceType = st.isDirectory ? 'folder' : 'file';
      } else {
        const built = backupService.buildLocalArchiveStream({ sourcePath, format: effectiveFormat });
        stream = built.stream;
        sourceRel = built.sourceRel;
        sourceType = built.sourceType;
      }

      const result = await destinations.writeToDestination(stream, archiveName, destination, backupService.BACKUP_STORE_DIR);

      await execute(
        `UPDATE backups SET source_type = ?, archive_name = ?, size_bytes = ?, checksum_sha256 = ?, encrypted = ?,
                status = 'completed', completed_at = ? WHERE id = ?`,
        [sourceType, archiveName, result.bytes, result.checksum, result.encrypted ? 1 : 0, Math.floor(Date.now() / 1000), id]
      );

      // Retention only applies to what's actually sitting in local storage —
      // S3/remote-folder archives are managed by that destination's own
      // lifecycle rules, not this server's disk.
      let removedIds = [];
      if (destination.type === 'local') {
        const rowsNewestFirst = await query(
          `SELECT id, archive_name FROM backups WHERE status = 'completed' AND destination_type = 'local' AND org_id = ? ORDER BY created_at DESC`,
          [req.orgId]
        );
        removedIds = await backupService.pruneOldArchives(rowsNewestFirst);
        if (removedIds.length) {
          const placeholders = removedIds.map(() => '?').join(',');
          await execute(`DELETE FROM backups WHERE id IN (${placeholders})`, removedIds);
        }
      }

      await audit.log({
        userId: req.user.id,
        username: req.user.username,
        action: 'backup_create',
        targetType: 'backup',
        targetId: id,
        targetName: archiveName,
        ipSource: req.ip,
        result: 'success',
        details: `${sourceType} ${sourcePath}${sourceDeviceName ? ` on ${sourceDeviceName}` : ''} → ${destinationName || 'local'}/${archiveName} (${effectiveFormat}, ${result.bytes} bytes)`,
      });

      webhook.fire('backup.created', {
        id, source_path: sourcePath, device: sourceDeviceName, format: effectiveFormat, archive_name: archiveName,
        destination: destinationName || 'local', bytes: result.bytes, created_by: req.user.username,
        severity: 'info',
        message: `${req.user.username} backed up ${sourcePath} → ${destinationName || 'local'}/${archiveName}`,
      }).catch(() => {});

      // Fire-and-forget restore verification — reads the archive back from
      // wherever it was just written and confirms it's intact and
      // extractable. Doesn't block the response (this can mean re-downloading
      // from S3/Azure/SFTP, which shouldn't hold up the UI), but its result
      // lands on this row within moments and is visible via GET /api/backup.
      runVerification(
        { id, archive_name: archiveName, format: effectiveFormat, destination_id: req.body.destinationId || null,
          destination_name: destinationName, destination_type: destination.type, encrypted: result.encrypted,
          checksum_sha256: result.checksum },
        req.user
      ).catch(() => {});

      res.json({
        id, sourcePath, format: effectiveFormat,
        archiveName, sizeBytes: result.bytes, checksum: result.checksum,
        destination: destinationName || 'Local backup store',
        status: 'completed', prunedCount: removedIds.length,
      });
    } catch (e) {
      await execute(
        `UPDATE backups SET status = 'failed', error_message = ? WHERE id = ?`,
        [e.message, id]
      ).catch(() => {});

      await audit.log({
        userId: req.user.id,
        username: req.user.username,
        action: 'backup_create',
        targetType: 'backup',
        targetId: id,
        targetName: sourcePath,
        ipSource: req.ip,
        result: 'failure',
        details: e.message,
      });

      const status = (e instanceof backupService.BackupPathError || e instanceof remoteBrowse.RemoteBrowseError || e instanceof destinations.DestinationError) ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
  }
);

// ── POST /api/backup/database ─────────────────────────────────────────────────
// One-click backup of NetControl's own database (devices, users, audit log,
// alert rules, etc.) — separate from the file/folder source flow above since
// there's no path to browse and no device to pick; it's always "this app's
// own DB", always written to local storage so the resulting archive can be
// downloaded immediately via the same GET /:id/download route every other
// backup uses. Admin-only: a full mysqldump includes password hashes and any
// encrypted-at-rest secrets (API keys, backup destination credentials) in
// their still-decryptable-with-server-key form.
router.post(
  '/database',
  requireRole('admin'),
  [body('actionPin').notEmpty().isString()],
  requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const id = uuidv4();
    const nowSec = Math.floor(Date.now() / 1000);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveName = `netcontrol-db-${stamp}.tar.gz`;

    try {
      await execute(
        `INSERT INTO backups (id, source_path, device_id, device_name, source_type, format,
                destination_id, destination_name, destination_type, archive_name, status,
                created_by, created_by_name, created_at, org_id)
         VALUES (?, '(NetControl database)', NULL, NULL, 'database', 'tar.gz', NULL, NULL, 'local', ?, 'pending', ?, ?, ?, ?)`,
        [id, archiveName, req.user.id, req.user.username, nowSec, req.orgId]
      );

      const { stream } = backupService.buildDatabaseDumpStream();
      const result = await destinations.writeToDestination(stream, archiveName, { type: 'local', config: {} }, backupService.BACKUP_STORE_DIR);

      await execute(
        `UPDATE backups SET size_bytes = ?, checksum_sha256 = ?, encrypted = ?,
                status = 'completed', completed_at = ? WHERE id = ?`,
        [result.bytes, result.checksum, result.encrypted ? 1 : 0, Math.floor(Date.now() / 1000), id]
      );

      const rowsNewestFirst = await query(
        `SELECT id, archive_name FROM backups WHERE status = 'completed' AND destination_type = 'local' AND org_id = ? ORDER BY created_at DESC`,
        [req.orgId]
      );
      const removedIds = await backupService.pruneOldArchives(rowsNewestFirst);
      if (removedIds.length) {
        const placeholders = removedIds.map(() => '?').join(',');
        await execute(`DELETE FROM backups WHERE id IN (${placeholders})`, removedIds);
      }

      await audit.log({
        userId: req.user.id,
        username: req.user.username,
        action: 'backup_create',
        targetType: 'backup',
        targetId: id,
        targetName: archiveName,
        ipSource: req.ip,
        result: 'success',
        details: `database netcontrol → local/${archiveName} (tar.gz, ${result.bytes} bytes)`,
      });

      webhook.fire('backup.created', {
        id, source_path: '(NetControl database)', format: 'tar.gz', archive_name: archiveName,
        destination: 'local', bytes: result.bytes, created_by: req.user.username,
        severity: 'info',
        message: `${req.user.username} backed up the NetControl database → local/${archiveName}`,
      }).catch(() => {});

      res.json({
        id, format: 'tar.gz', archiveName, sizeBytes: result.bytes, checksum: result.checksum,
        destination: 'Local backup store', status: 'completed', prunedCount: removedIds.length,
      });
    } catch (e) {
      await execute(
        `UPDATE backups SET status = 'failed', error_message = ? WHERE id = ?`,
        [e.message, id]
      ).catch(() => {});

      await audit.log({
        userId: req.user.id,
        username: req.user.username,
        action: 'backup_create',
        targetType: 'backup',
        targetId: id,
        targetName: 'NetControl database',
        ipSource: req.ip,
        result: 'failure',
        details: e.message,
      });

      res.status(500).json({ error: e.message });
    }
  }
);

// ── GET /api/backup/:id/download ─────────────────────────────────────────────
// Only meaningful for local-destination archives — S3/remote-folder archives
// live elsewhere and are downloaded from that destination directly.
router.get('/:id/download', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const row = await queryOne(`SELECT * FROM backups WHERE id = ? AND org_id = ?`, [req.params.id, req.orgId]);
    if (!row || row.status !== 'completed') return res.status(404).json({ error: 'Backup not found' });
    if (row.destination_type !== 'local') {
      const label = { s3: 'S3', azure_blob: 'Azure Blob Storage', remote_folder: 'a remote folder' }[row.destination_type] || row.destination_type;
      return res.status(400).json({ error: `This backup was written to ${label}, not local storage — download it from there.` });
    }

    const filePath = backupService.archiveFilePath(row.archive_name);
    const finish = async () => {
      await audit.log({
        userId: req.user.id,
        username: req.user.username,
        action: 'backup_download',
        targetType: 'backup',
        targetId: row.id,
        targetName: row.archive_name,
        ipSource: req.ip,
        result: 'success',
      }).catch(() => {});
    };

    if (row.encrypted) {
      // Locally-stored archives are only ever encrypted if an admin opted
      // into BACKUP_ENCRYPT_LOCAL — decrypt on the way out so the download
      // is the same plain archive a human would expect to open.
      res.setHeader('Content-Disposition', `attachment; filename="${row.archive_name}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      const readStream = fs.createReadStream(filePath);
      readStream.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
      const decrypted = destinations.decryptReadStream(readStream);
      decrypted.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
      decrypted.pipe(res);
      res.on('finish', finish);
      return;
    }

    res.download(filePath, row.archive_name, async (err) => {
      if (err) return; // response already sent or connection dropped — nothing more to do
      await finish();
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/backup/:id/verify — re-run restore verification on demand ──────
// Useful for periodically re-checking older archives, or immediately after
// changing/rotating destination credentials, rather than waiting for the
// next scheduled backup of that same source to happen to touch this row.
router.post('/:id/verify', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const row = await queryOne(`SELECT * FROM backups WHERE id = ? AND org_id = ?`, [req.params.id, req.orgId]);
    if (!row || row.status !== 'completed') return res.status(404).json({ error: 'Backup not found' });

    const result = await runVerification(row, req.user);
    res.json({ id: row.id, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/backup/:id — admin only ───────────────────────────────────────
router.delete('/:id', requireRole('admin'), [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const row = await queryOne(`SELECT * FROM backups WHERE id = ? AND org_id = ?`, [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Backup not found' });

    if (row.destination_type === 'local') {
      const fs = require('fs/promises');
      await fs.unlink(backupService.archiveFilePath(row.archive_name)).catch(() => {});
    }
    // S3/remote-folder archives aren't deleted at the destination automatically
    // (this app doesn't hold long-lived delete-capable creds open outside a
    // backup run) — this only removes NetControl's own record of it.
    await execute(`DELETE FROM backups WHERE id = ?`, [row.id]);

    await audit.log({
      userId: req.user.id,
      username: req.user.username,
      action: 'backup_delete',
      targetType: 'backup',
      targetId: row.id,
      targetName: row.archive_name,
      ipSource: req.ip,
      result: 'success',
    });

    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;1