// services/backupDestinations.js — Where a finished backup archive is written.
//
// Three destination kinds:
//   local         — unchanged original behavior: written under BACKUP_STORE_DIR.
//   s3            — streamed to an S3-compatible bucket via @aws-sdk/lib-storage's
//                   Upload helper, which handles multipart upload so we don't
//                   need to know the final size (or buffer the whole archive)
//                   up front.
//   remote_folder — streamed over SFTP to a folder on another registered
//                   device, reusing the same SSH connection style as
//                   services/scpPush.js / services/remoteBrowse.js.
//
// Every destination writer is handed the *same* readable stream produced by
// services/backupService.buildArchiveStream, and returns { bytes, checksum }
// computed while the bytes fly past — one pass over the data regardless of
// where it ends up, same as the original local-only implementation did.

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { decrypt, encrypt } = require('./crypto');
const remoteBrowse = require('./remoteBrowse');

class DestinationError extends Error {}

// ── Config encrypt/decrypt — stored as one encrypted JSON blob per row ────────
function encryptConfig(obj) {
  return encrypt(JSON.stringify(obj || {}));
}
function decryptConfig(ciphertext) {
  const plain = decrypt(ciphertext);
  if (!plain) throw new DestinationError('Could not decrypt destination config — is CREDENTIAL_ENCRYPTION_KEY unchanged?');
  return JSON.parse(plain);
}

// Redacts secrets before a destination row is ever sent to the client.
function redactConfig(type, config) {
  if (type === 's3') {
    return { bucket: config.bucket, region: config.region, prefix: config.prefix || '', accessKeyId: config.accessKeyId ? `${config.accessKeyId.slice(0, 4)}••••` : null };
  }
  if (type === 'remote_folder') {
    return { deviceId: config.deviceId, deviceName: config.deviceName, remotePath: config.remotePath };
  }
  return {};
}

// ── Local (default / original behavior) ────────────────────────────────────────
function writeLocal(stream, archiveName, storeDir) {
  return new Promise((resolve, reject) => {
    const destAbs = path.join(storeDir, archiveName);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const output = fs.createWriteStream(destAbs);
    stream.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });
    stream.on('error', (err) => { fs.unlink(destAbs, () => {}); reject(err); });
    output.on('error', (err) => { fs.unlink(destAbs, () => {}); reject(err); });
    output.on('close', () => resolve({ bytes, checksum: hash.digest('hex') }));
    stream.pipe(output);
  });
}

// ── S3 ──────────────────────────────────────────────────────────────────────────
async function writeS3(stream, archiveName, config) {
  const { S3Client } = require('@aws-sdk/client-s3');
  const { Upload } = require('@aws-sdk/lib-storage');

  const hash = crypto.createHash('sha256');
  let bytes = 0;
  stream.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });

  const client = new S3Client({
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const key = config.prefix ? `${config.prefix.replace(/\/+$/, '')}/${archiveName}` : archiveName;

  try {
    const upload = new Upload({
      client,
      params: { Bucket: config.bucket, Key: key, Body: stream },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
    });
    await upload.done();
  } catch (e) {
    throw new DestinationError(`S3 upload failed: ${e.message}`);
  }
  return { bytes, checksum: hash.digest('hex'), remoteKey: key };
}

// ── Remote folder (SFTP push to another device) ─────────────────────────────────
// NOTE: sftp.createWriteStream()'s 'close' event is unreliable on some SSH
// servers (see services/scpPush.js header comment) — piping straight into it
// can hang forever waiting for a 'close' that never fires. So this buffers
// the archive to a local temp file first (accurate size/hash from one pass
// over the stream), then pushes that buffer with the same open/write/close
// SFTP handshake scpPush.js already uses successfully, which does give a
// reliable completion callback.
// Recursively create a remote directory, one path segment at a time —
// sftp.mkdir only ever creates a single level, so a remotePath like
// "/home/kenpachi/backups/netcontrol" where "backups" doesn't exist yet
// would otherwise fail silently and only surface later as a confusing
// "No such file" from fastPut. Each segment's failure is checked against a
// stat: already-exists is fine, anything else (permission denied, read-only
// filesystem, etc.) is surfaced right here with the segment that failed.
async function ensureRemoteDir(sftp, remoteDir, withTimeout) {
  const parts = path.posix.normalize(remoteDir).split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += '/' + part;
    await withTimeout(new Promise((resolve, reject) => {
      sftp.mkdir(cur, { mode: 0o755 }, (mkdirErr) => {
        if (!mkdirErr) return resolve();
        sftp.stat(cur, (statErr, stat) => {
          if (!statErr && stat.isDirectory()) return resolve(); // already there — fine
          reject(new DestinationError(`Cannot create remote directory "${cur}": ${mkdirErr.message}`));
        });
      });
    }), `Remote mkdir ${cur}`);
  }
}

async function writeRemoteFolder(stream, archiveName, config, device) {
  const os = require('os');
  const fsp = require('fs/promises');
  const tmpPath = path.join(os.tmpdir(), `netcontrol-backup-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const hash = crypto.createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    stream.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });
    stream.on('error', reject);
    out.on('error', reject);
    out.on('close', resolve);
    stream.pipe(out);
  });

  const REMOTE_WRITE_TIMEOUT = 30000;
  const withTimeout = (promise, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new DestinationError(`${label} timed out after ${REMOTE_WRITE_TIMEOUT / 1000}s`)), REMOTE_WRITE_TIMEOUT)),
  ]);

  const conn = await withTimeout(remoteBrowse.connect(device), 'SSH connect');
  const remotePath = path.posix.join(config.remotePath, archiveName);
  try {
    const sftp = await withTimeout(new Promise((resolve, reject) => conn.sftp((err, s) => err ? reject(err) : resolve(s))), 'SFTP session open');

    // Ensure the full destination directory path exists, one segment at a
    // time, and fail loudly (not silently) if it can't be created.
    await ensureRemoteDir(sftp, config.remotePath, withTimeout);

    await withTimeout(new Promise((resolve, reject) => {
      // fastPut streams the local file in properly-sized chunks itself and
      // gives one clean completion callback — the same fix scpPush.js
      // already applied for exactly this reliability issue.
      sftp.fastPut(tmpPath, remotePath, { mode: 0o644 }, (err) => err ? reject(new DestinationError(`SFTP upload failed: ${err.message}`)) : resolve());
    }), 'SFTP upload');
  } finally {
    try { conn.end(); } catch {}
    await fsp.unlink(tmpPath).catch(() => {});
  }
  return { bytes, checksum: hash.digest('hex'), remotePath };
}

// ── Dispatch ────────────────────────────────────────────────────────────────────
// `destination` shape: { type, config, device? } — device is only needed
// (and only loaded by the caller) for type === 'remote_folder'.
async function writeToDestination(stream, archiveName, destination, storeDir) {
  switch (destination.type) {
    case 'local':          return writeLocal(stream, archiveName, storeDir);
    case 's3':             return writeS3(stream, archiveName, destination.config);
    case 'remote_folder':  return writeRemoteFolder(stream, archiveName, destination.config, destination.device);
    default: throw new DestinationError(`Unknown destination type: ${destination.type}`);
  }
}

module.exports = {
  DestinationError,
  encryptConfig, decryptConfig, redactConfig,
  writeToDestination,
};