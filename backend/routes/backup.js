// routes/backup.js — File/folder backup: browse, create, list, download, delete
//
// Mirrors the shape of routes/filePush.js: requireAuth + requirePermission
// gate every route, requireActionPin gates the mutating one (create), and
// every action is written to the audit log + fired as a webhook so it shows
// up alongside every other privileged action in this app.
//
// "Choose their backup location" = the client picks BOTH:
//   - sourcePath : what to back up, browsed via GET /api/backup/browse
//                  (restricted to BACKUP_ROOT, see services/backupService.js)
//   - format     : zip | tar | tar.gz — the "common options" for archive type
// The destination directory on disk (BACKUP_STORE_DIR) stays fixed and
// non-browsable on purpose (see backupService.js header comment) so a backup
// can never be pointed at a location that lets it recursively include
// earlier archives or escape the sanctioned tree.

'use strict';
const express = require('express');
const path = require('path');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const { requireAuth, requireRole, requirePermission, requireActionPin } = require('../middleware/auth');
const { query, queryOne, execute } = require('../db');
const backupService = require('../services/backupService');
const audit = require('../services/audit');
const webhook = require('../services/webhook');

const router = express.Router();
router.use(requireAuth);
router.use(requirePermission(8192));

const FORMATS = ['zip', 'tar', 'tar.gz'];

// ── GET /api/backup/browse?path=some/sub/dir ─────────────────────────────────
// Lists folders/files under BACKUP_ROOT so the client can pick a source to
// back up. Empty/omitted path = BACKUP_ROOT itself.
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

// ── GET /api/backup ───────────────────────────────────────────────────────────
// List completed/pending/failed backups, newest first.
router.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, source_path, source_type, format, archive_name, size_bytes,
              checksum_sha256, status, error_message, created_by, created_by_name,
              created_at, completed_at
       FROM backups ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/backup ───────────────────────────────────────────────────────────
// Create a new archive from sourcePath in the chosen format. Requires the
// action PIN, same as other disk/device-mutating routes in this app.
router.post(
  '/',
  [
    body('sourcePath').notEmpty().isString().isLength({ max: 1000 }),
    body('format').isIn(FORMATS).withMessage(`format must be one of: ${FORMATS.join(', ')}`),
    body('label').optional().isString().isLength({ max: 80 }),
    body('actionPin').notEmpty().isString(),
  ],
  requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { sourcePath, format, label } = req.body;
    const id = uuidv4();
    const nowSec = Math.floor(Date.now() / 1000);

    try {
      // Row goes in as 'pending' first so a crash mid-archive still leaves
      // a trace instead of just silently never appearing.
      await execute(
        `INSERT INTO backups (id, source_path, source_type, format, archive_name, status, created_by, created_by_name, created_at)
         VALUES (?, ?, 'file', ?, '', 'pending', ?, ?, ?)`,
        [id, sourcePath, format, req.user.id, req.user.username, nowSec]
      );

      const result = await backupService.createArchive({ sourcePath, format, label });

      await execute(
        `UPDATE backups SET source_type = ?, archive_name = ?, size_bytes = ?, checksum_sha256 = ?,
                status = 'completed', completed_at = ? WHERE id = ?`,
        [result.sourceType, result.archiveName, result.bytes, result.checksum, Math.floor(Date.now() / 1000), id]
      );

      // Retention — prune anything past BACKUP_RETENTION_COUNT, oldest first.
      const rowsNewestFirst = await query(
        `SELECT id, archive_name FROM backups WHERE status = 'completed' ORDER BY created_at DESC`
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
        targetName: result.archiveName,
        ipSource: req.ip,
        result: 'success',
        details: `${result.sourceType} ${sourcePath} → ${result.archiveName} (${format}, ${result.bytes} bytes)`,
      });

      webhook.fire('backup.created', {
        id, source_path: sourcePath, format, archive_name: result.archiveName,
        bytes: result.bytes, created_by: req.user.username,
        severity: 'info',
        message: `${req.user.username} backed up ${sourcePath} → ${result.archiveName}`,
      }).catch(() => {});

      res.json({
        id, sourcePath, format,
        archiveName: result.archiveName,
        sizeBytes: result.bytes,
        checksum: result.checksum,
        status: 'completed',
        prunedCount: removedIds.length,
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

      const status = e instanceof backupService.BackupPathError ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
  }
);

// ── GET /api/backup/:id/download ─────────────────────────────────────────────
router.get('/:id/download', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const row = await queryOne(`SELECT * FROM backups WHERE id = ?`, [req.params.id]);
    if (!row || row.status !== 'completed') return res.status(404).json({ error: 'Backup not found' });

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

    const fs = require('fs/promises');
    await fs.unlink(backupService.archiveFilePath(row.archive_name)).catch(() => {});
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