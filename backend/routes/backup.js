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
const { body, param, query: queryValidator, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const { requireAuth, requireRole, requirePermission, requireActionPin } = require('../middleware/auth');
const { query, queryOne, execute } = require('../db');
const backupService = require('../services/backupService');
const remoteBrowse = require('../services/remoteBrowse');
const destinations = require('../services/backupDestinations');
const { decrypt } = require('../services/crypto');
const audit = require('../services/audit');
const webhook = require('../services/webhook');

const router = express.Router();
router.use(requireAuth);
router.use(requirePermission(8192));

const FORMATS = ['zip', 'tar', 'tar.gz'];

// ── Helpers ──────────────────────────────────────────────────────────────────
async function loadDeviceWithCreds(deviceId) {
  const d = await queryOne(`SELECT * FROM devices WHERE id = ?`, [deviceId]);
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
               AND (ssh_password IS NOT NULL OR ssh_key IS NOT NULL)) AS sshCapable
       FROM devices ORDER BY name`
    );
    res.json([
      { id: LOCAL_DEVICE_ID, name: 'This server (local)', ip_address: null, os_type: null, status: 'online', isLocal: true, sshCapable: true },
      ...rows.map(r => ({ ...r, isLocal: false, sshCapable: !!r.sshCapable })),
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
    const device = await loadDeviceWithCreds(req.params.deviceId);
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
    const device = await loadDeviceWithCreds(req.params.deviceId);
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
    const rows = await query(`SELECT id, name, type, config, created_at FROM backup_destinations ORDER BY name`);
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
    body('type').isIn(['s3', 'remote_folder']),
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
      } else if (type === 'remote_folder') {
        if (!config.deviceId) return res.status(400).json({ error: 'config.deviceId is required' });
        if (!config.remotePath) return res.status(400).json({ error: 'config.remotePath is required' });
        const device = await queryOne(`SELECT id, name FROM devices WHERE id = ?`, [config.deviceId]);
        if (!device) return res.status(400).json({ error: 'Selected device not found' });
        config.deviceName = device.name; // denormalized for display in redactConfig()
      }

      const id = uuidv4();
      await execute(
        `INSERT INTO backup_destinations (id, name, type, config, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, name, type, destinations.encryptConfig(config), req.user.id, Math.floor(Date.now() / 1000)]
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
      const existing = await queryOne(`SELECT * FROM backup_destinations WHERE id = ?`, [req.params.id]);
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
      } else if (existing.type === 'remote_folder') {
        if (!config.deviceId) return res.status(400).json({ error: 'config.deviceId is required' });
        if (!config.remotePath) return res.status(400).json({ error: 'config.remotePath is required' });
        const device = await queryOne(`SELECT id, name FROM devices WHERE id = ?`, [config.deviceId]);
        if (!device) return res.status(400).json({ error: 'Selected device not found' });
        config.deviceName = device.name;
      }

      await execute(
        `UPDATE backup_destinations SET name = ?, config = ? WHERE id = ?`,
        [name, destinations.encryptConfig(config), req.params.id]
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
    const row = await queryOne(`SELECT * FROM backup_destinations WHERE id = ?`, [req.params.id]);
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
              created_by, created_by_name, created_at, completed_at
       FROM backups ORDER BY created_at DESC`
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
        const d = await queryOne(`SELECT name FROM devices WHERE id = ?`, [deviceId]);
        if (!d) return res.status(400).json({ error: 'Source device not found' });
        sourceDeviceName = d.name;
        if (!mount) return res.status(400).json({ error: 'mount is required when backing up from a device' });
      }

      if (req.body.destinationId) {
        const destRow = await queryOne(`SELECT * FROM backup_destinations WHERE id = ?`, [req.body.destinationId]);
        if (!destRow) return res.status(400).json({ error: 'Destination not found' });
        const config = destinations.decryptConfig(destRow.config);
        destinationName = destRow.name;
        if (destRow.type === 'remote_folder') {
          const destDevice = await loadDeviceWithCreds(config.deviceId);
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
                created_by, created_by_name, created_at)
         VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, '', 'pending', ?, ?, ?)`,
        [id, sourcePath, isRemoteSource ? deviceId : null, sourceDeviceName, effectiveFormat,
         req.body.destinationId || null, destinationName, destination.type,
         req.user.id, req.user.username, nowSec]
      );

      const cfg = backupService.FORMAT_CONFIG[effectiveFormat];
      const baseName = (label || path.basename(sourcePath) || 'backup').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80) || 'backup';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archiveName = `${baseName}-${stamp}.${cfg.ext}`;

      let stream, sourceRel, sourceType;
      if (isRemoteSource) {
        const device = await loadDeviceWithCreds(deviceId);
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
        `UPDATE backups SET source_type = ?, archive_name = ?, size_bytes = ?, checksum_sha256 = ?,
                status = 'completed', completed_at = ? WHERE id = ?`,
        [sourceType, archiveName, result.bytes, result.checksum, Math.floor(Date.now() / 1000), id]
      );

      // Retention only applies to what's actually sitting in local storage —
      // S3/remote-folder archives are managed by that destination's own
      // lifecycle rules, not this server's disk.
      let removedIds = [];
      if (destination.type === 'local') {
        const rowsNewestFirst = await query(
          `SELECT id, archive_name FROM backups WHERE status = 'completed' AND destination_type = 'local' ORDER BY created_at DESC`
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

// ── GET /api/backup/:id/download ─────────────────────────────────────────────
// Only meaningful for local-destination archives — S3/remote-folder archives
// live elsewhere and are downloaded from that destination directly.
router.get('/:id/download', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const row = await queryOne(`SELECT * FROM backups WHERE id = ?`, [req.params.id]);
    if (!row || row.status !== 'completed') return res.status(404).json({ error: 'Backup not found' });
    if (row.destination_type !== 'local') {
      return res.status(400).json({ error: `This backup was written to ${row.destination_type === 's3' ? 'S3' : 'a remote folder'}, not local storage — download it from there.` });
    }

    const filePath = backupService.archiveFilePath(row.archive_name);
    res.download(filePath, row.archive_name, async (err) => {
      if (err) return; // response already sent or connection dropped — nothing more to do
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
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/backup/:id — admin only ───────────────────────────────────────
router.delete('/:id', requireRole('admin'), [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const row = await queryOne(`SELECT * FROM backups WHERE id = ?`, [req.params.id]);
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

module.exports = router;