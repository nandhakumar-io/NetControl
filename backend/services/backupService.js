// services/backupService.js — File/folder backup: browse, archive (zip/tar/tar.gz), verify, retain
//
// Design:
//  - BACKUP_ROOT (env, default: project root one level above backend/) is the
//    only directory tree an admin can pick a source file/folder from. All
//    paths coming from the client are resolved against it and re-checked
//    with the same '..'-rejection pattern already used in routes/filePush.js
//    (path.posix.normalize + '..' check) so this can't be used to read
//    arbitrary filesystem paths outside the sanctioned tree.
//  - BACKUP_STORE_DIR (env, default: backend/backups) is where finished
//    archives are written. It's never itself browsable/backup-able as a
//    source, to avoid an archive being able to include earlier archives
//    recursively.
//  - Archives are built with `archiver`, which supports zip, tar, and
//    tar+gzip from the same API — no shelling out to system `zip`/`tar`
//    binaries, so this works identically across the linux/windows Docker
//    images this project already ships (see backend/Dockerfile).
//  - Every completed archive gets a sha256 checksum recorded in the
//    `backups` table (see db/migrate-backups.js) so a later download can be
//    verified for integrity — a corrupted or truncated archive doesn't fail
//    silently.
//  - CUSTOM TWEAK — retention: after each successful backup, anything past
//    BACKUP_RETENTION_COUNT (env, default 20) is pruned automatically
//    (oldest-first), so a "backup a folder every day" habit doesn't
//    quietly fill the disk. Set to 0 to disable pruning entirely.

'use strict';
const fs       = require('fs');
const fsp      = require('fs/promises');
const path     = require('path');
const crypto   = require('crypto');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');

const BACKUP_ROOT      = path.resolve(process.env.BACKUP_ROOT || path.resolve(__dirname, '..', '..'));
const BACKUP_STORE_DIR = path.resolve(process.env.BACKUP_STORE_DIR || path.resolve(__dirname, '..', 'backups'));
const RETENTION_COUNT  = process.env.BACKUP_RETENTION_COUNT !== undefined
  ? parseInt(process.env.BACKUP_RETENTION_COUNT) : 20;

// Directories that should never appear in the browser or be selectable as a
// backup source — noisy, huge, or would let a backup include other backups.
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git', path.basename(BACKUP_STORE_DIR)]);

fs.mkdirSync(BACKUP_STORE_DIR, { recursive: true });

class BackupPathError extends Error {}

// ── Path safety ────────────────────────────────────────────────────────────────
// Resolves a client-supplied relative path against BACKUP_ROOT and rejects
// anything that escapes it — same pattern as filePush.js's remotePath guard,
// applied here to a local path instead of a remote SSH one.
function resolveSafePath(relPath) {
  const clean = path.posix.normalize('/' + String(relPath || '').replace(/\\/g, '/')).replace(/^\/+/, '');
  if (clean.split('/').includes('..')) throw new BackupPathError('Path traversal not allowed');
  const abs = path.resolve(BACKUP_ROOT, clean);
  if (abs !== BACKUP_ROOT && !abs.startsWith(BACKUP_ROOT + path.sep)) {
    throw new BackupPathError('Path escapes the backup root');
  }
  return { abs, rel: clean };
}

// ── Browsing ───────────────────────────────────────────────────────────────────
async function browse(relPath) {
  const { abs, rel } = resolveSafePath(relPath || '');
  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new BackupPathError('Not a directory');

  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // hide dotfiles/dirs (.env, .git, etc.)
    if (entry.isDirectory() && EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const entryAbs = path.join(abs, entry.name);
    let size = null;
    try {
      const st = await fsp.stat(entryAbs);
      size = entry.isDirectory() ? null : st.size;
    } catch { /* skip unreadable entries (broken symlinks, perms) */ }
    items.push({
      name: entry.name,
      path: rel ? `${rel}/${entry.name}` : entry.name,
      type: entry.isDirectory() ? 'folder' : 'file',
      size,
    });
  }
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));

  return {
    path: rel,
    parent: rel ? path.posix.dirname(rel).replace(/^\.$/, '') : null,
    items,
  };
}

// ── Archive creation (streaming, destination-agnostic) ──────────────────────────
// Used by routes/backup.js together with services/backupDestinations.js so a
// local source can be sent to ANY destination (local / S3 / remote folder),
// not just BACKUP_STORE_DIR. createArchive() below (local source → local
// disk only) is kept as-is for anything still calling it directly.
function buildLocalArchiveStream({ sourcePath, format }) {
  const { PassThrough } = require('stream');
  const { abs: sourceAbs, rel: sourceRel } = resolveSafePath(sourcePath);
  if (!Object.prototype.hasOwnProperty.call(FORMAT_CONFIG, format)) {
    throw new BackupPathError(`Unsupported format: ${format}`);
  }
  const stat = fs.statSync(sourceAbs, { throwIfNoEntry: false });
  if (!stat) throw new BackupPathError('Source path does not exist');
  if (stat.isDirectory() && EXCLUDED_DIR_NAMES.has(path.basename(sourceAbs))) {
    throw new BackupPathError('This folder cannot be backed up');
  }

  const cfg = FORMAT_CONFIG[format];
  const archiver = require('archiver');
  const archive = archiver(cfg.archiverFormat, cfg.archiverOpts);
  const out = new PassThrough();
  archive.on('warning', (err) => { if (err.code !== 'ENOENT') out.destroy(err); });
  archive.on('error', (err) => out.destroy(err));
  archive.pipe(out);
  if (stat.isDirectory()) archive.directory(sourceAbs, path.basename(sourceAbs));
  else archive.file(sourceAbs, { name: path.basename(sourceAbs) });
  archive.finalize();

  return { stream: out, sourceRel, sourceType: stat.isDirectory() ? 'folder' : 'file' };
}

// ── Archive creation ───────────────────────────────────────────────────────────
const FORMAT_CONFIG = {
  zip:     { ext: 'zip',     archiverFormat: 'zip', archiverOpts: { zlib: { level: 9 } } },
  tar:     { ext: 'tar',     archiverFormat: 'tar', archiverOpts: {} },
  'tar.gz': { ext: 'tar.gz', archiverFormat: 'tar', archiverOpts: { gzip: true, gzipOptions: { level: 9 } } },
};

function sanitizeName(name) {
  return (name || 'backup').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80) || 'backup';
}

// Streams the archive to disk, computing a sha256 checksum as bytes are
// written (rather than re-reading the finished file afterward) so large
// backups don't need a second full pass over the archive just to hash it.
async function createArchive({ sourcePath, format, label }) {
  const { abs: sourceAbs, rel: sourceRel } = resolveSafePath(sourcePath);
  if (!Object.prototype.hasOwnProperty.call(FORMAT_CONFIG, format)) {
    throw new BackupPathError(`Unsupported format: ${format}`);
  }
  const stat = await fsp.stat(sourceAbs).catch(() => null);
  if (!stat) throw new BackupPathError('Source path does not exist');
  if (stat.isDirectory() && EXCLUDED_DIR_NAMES.has(path.basename(sourceAbs))) {
    throw new BackupPathError('This folder cannot be backed up');
  }

  const cfg = FORMAT_CONFIG[format];
  const baseName = sanitizeName(label || path.basename(sourceAbs));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveName = `${baseName}-${stamp}.${cfg.ext}`;
  const destAbs = path.join(BACKUP_STORE_DIR, archiveName);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destAbs);
    const archive = archiver(cfg.archiverFormat, cfg.archiverOpts);
    const hash = crypto.createHash('sha256');
    let bytes = 0;

    archive.on('data', (chunk) => { hash.update(chunk); bytes += chunk.length; });
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });
    archive.on('error', reject);
    output.on('close', () => resolve({ bytes, checksum: hash.digest('hex') }));
    output.on('error', reject);

    archive.pipe(output);
    if (stat.isDirectory()) {
      archive.directory(sourceAbs, path.basename(sourceAbs));
    } else {
      archive.file(sourceAbs, { name: path.basename(sourceAbs) });
    }
    archive.finalize();
  }).then(({ bytes, checksum }) => {
    return fsp.stat(destAbs).then(() => ({ archiveName, destAbs, bytes, checksum }));
  }, async (err) => {
    // Clean up a partial file on failure so it doesn't linger as orphaned disk usage.
    await fsp.unlink(destAbs).catch(() => {});
    throw err;
  }).then((result) => {
    return { ...result, sourceRel, sourceType: stat.isDirectory() ? 'folder' : 'file' };
  });

  // (the chained .then above returns the final resolved value to the caller)
}

// ── Retention ──────────────────────────────────────────────────────────────────
// Deletes the oldest completed backups beyond RETENTION_COUNT. Takes the full
// row list (already ordered) rather than querying itself, so routes/backup.js
// stays the only module that talks to the DB and this stays a pure fs helper.
async function pruneOldArchives(rowsNewestFirst) {
  if (!RETENTION_COUNT || rowsNewestFirst.length <= RETENTION_COUNT) return [];
  const toRemove = rowsNewestFirst.slice(RETENTION_COUNT);
  const removedIds = [];
  for (const row of toRemove) {
    const filePath = path.join(BACKUP_STORE_DIR, row.archive_name);
    await fsp.unlink(filePath).catch(() => {});
    removedIds.push(row.id);
  }
  return removedIds;
}

function archiveFilePath(archiveName) {
  return path.join(BACKUP_STORE_DIR, archiveName);
}

// ── Local disk info — parity with remoteBrowse.listDisks() for remote devices ──
// Reports usage for whatever filesystem BACKUP_ROOT lives on, using the same
// `df -PB1` parsing approach as services/remoteBrowse.js (byte-exact, one
// line per mount, no locale/column-width surprises).
function getLocalDiskInfo() {
  try {
    const { execSync } = require('child_process');
    const out = execSync(`df -PB1 "${BACKUP_ROOT}" 2>/dev/null`).toString();
    const line = out.trim().split('\n')[1]; // header, then the one line we asked for
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    const [filesystem, sizeStr, usedStr, availStr, pctStr, ...mountParts] = parts;
    return {
      filesystem,
      mount: mountParts.join(' ') || '/',
      sizeBytes: parseInt(sizeStr, 10) || 0,
      usedBytes: parseInt(usedStr, 10) || 0,
      availBytes: parseInt(availStr, 10) || 0,
      usedPct: parseInt(pctStr, 10) || 0,
    };
  } catch {
    return null; // e.g. Windows host — just hide disk-usage stats, browsing still works
  }
}

module.exports = {
  BACKUP_ROOT, BACKUP_STORE_DIR, RETENTION_COUNT,
  BackupPathError,
  browse, createArchive, buildLocalArchiveStream, pruneOldArchives, archiveFilePath,
  FORMAT_CONFIG, getLocalDiskInfo,
};