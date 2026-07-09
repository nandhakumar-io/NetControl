// services/backupVerify.js — Post-backup restore verification
//
// A checksum recorded at write time only proves the bytes were correct the
// moment they were written. It says nothing about whether the destination
// (a bucket, a remote disk, an SFTP target) still holds those exact bytes
// later — silent bit rot, a truncated multipart upload, or someone editing
// the object out-of-band would all go undetected until the day someone
// actually needs to restore from it. This service closes that gap by:
//
//   1. Reading the archive back from wherever it actually lives (local disk,
//      S3, Azure Blob, or the remote SFTP folder — see
//      services/backupDestinations.js readFromDestination) and recomputing a
//      sha256 over exactly the bytes stored there, compared against
//      checksum_sha256 recorded at write time.
//   2. Decrypting (if the archive was written encrypted) and doing a genuine
//      structural read-through of the archive format itself — walking every
//      zip central-directory entry (yauzl validates each entry's CRC32 as
//      it's read) or every tar header/body pair (tar-stream) — so a file
//      that happens to still hash-match but is a corrupted/truncated archive
//      still gets caught.
//
// Called automatically (fire-and-forget, non-blocking) right after a backup
// completes in routes/backup.js, and on demand via POST /:id/verify.
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const tarStream = require('tar-stream');
const yauzl = require('yauzl');

const destinations = require('./backupDestinations');
const { createDecryptStream } = require('./crypto');

class VerifyError extends Error {}

// ── Structural checks ─────────────────────────────────────────────────────────
// Both checks buffer the (already-decrypted) archive to a temp file first —
// zip's central directory lives at the end of the file, so true streaming
// validation isn't possible anyway, and this keeps the tar path just as
// robust against a stream that errors partway through.
function verifyZipFile(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true }, (err, zipfile) => {
      if (err) return reject(new VerifyError(`Not a valid zip archive: ${err.message}`));
      let entryCount = 0;
      zipfile.on('error', (e) => reject(new VerifyError(`Zip archive corrupted: ${e.message}`)));
      zipfile.on('entry', (entry) => {
        entryCount++;
        if (/\/$/.test(entry.fileName)) { zipfile.readEntry(); return; } // directory entry, no data to check
        zipfile.openReadStream(entry, (err, readStream) => {
          // openReadStream/consuming the stream is where yauzl surfaces a
          // CRC32 mismatch — a truncated or bit-flipped entry throws here.
          if (err) return reject(new VerifyError(`Zip entry "${entry.fileName}" unreadable: ${err.message}`));
          readStream.on('error', (e) => reject(new VerifyError(`Zip entry "${entry.fileName}" failed CRC check: ${e.message}`)));
          readStream.on('end', () => zipfile.readEntry());
          readStream.resume();
        });
      });
      zipfile.on('end', () => resolve({ entryCount }));
      zipfile.readEntry();
    });
  });
}

function verifyTarFile(filePath, gzip) {
  return new Promise((resolve, reject) => {
    const extract = tarStream.extract();
    let entryCount = 0;
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(new VerifyError(`Tar archive corrupted: ${e.message}`)); } };

    extract.on('entry', (header, stream, next) => {
      entryCount++;
      let seen = 0;
      stream.on('data', (chunk) => { seen += chunk.length; });
      stream.on('end', () => {
        // tar-stream itself throws on a malformed header/frame; this extra
        // check catches the case where a body was silently truncated short
        // of what its own header declared.
        if (header.size && seen !== header.size) {
          return fail(new Error(`entry "${header.name}" declared ${header.size} bytes but only ${seen} were readable`));
        }
        next();
      });
      stream.on('error', fail);
      stream.resume();
    });
    extract.on('finish', () => { if (!settled) { settled = true; resolve({ entryCount }); } });
    extract.on('error', fail);

    const source = fs.createReadStream(filePath);
    source.on('error', fail);
    (gzip ? source.pipe(zlib.createGunzip().on('error', fail)) : source).pipe(extract);
  });
}

async function verifyArchiveStructure(filePath, format) {
  if (format === 'zip') return verifyZipFile(filePath);
  if (format === 'tar') return verifyTarFile(filePath, false);
  if (format === 'tar.gz') return verifyTarFile(filePath, true);
  throw new VerifyError(`Unknown archive format: ${format}`);
}

// ── Main entry point ──────────────────────────────────────────────────────────
// `row` is a full `backups` table row. `storeDir` is BACKUP_STORE_DIR, only
// used for destination_type === 'local'.
async function verifyBackup(row, storeDir) {
  const rawStream = await destinations.readFromDestination(row, storeDir);

  const hash = crypto.createHash('sha256');
  const forStructuralCheck = new PassThrough();
  rawStream.on('data', (chunk) => { hash.update(chunk); forStructuralCheck.write(chunk); });
  rawStream.on('end', () => forStructuralCheck.end());
  rawStream.on('error', (e) => forStructuralCheck.destroy(e));

  const rawDone = new Promise((resolve, reject) => {
    rawStream.on('end', resolve);
    rawStream.on('error', reject);
  });

  const archiveByteStream = row.encrypted ? forStructuralCheck.pipe(createDecryptStream()) : forStructuralCheck;

  const tmpPath = path.join(os.tmpdir(), `netcontrol-verify-${row.id}-${Date.now()}.tmp`);
  const writeTemp = new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    archiveByteStream.on('error', (e) => { out.destroy(); reject(e); });
    out.on('error', reject);
    out.on('close', resolve);
    archiveByteStream.pipe(out);
  });

  try {
    await Promise.all([rawDone, writeTemp]);
    const checksum = hash.digest('hex');

    if (row.checksum_sha256 && checksum !== row.checksum_sha256) {
      throw new VerifyError(
        `Checksum mismatch — expected ${row.checksum_sha256.slice(0, 12)}…, got ${checksum.slice(0, 12)}… ` +
        `(the stored archive no longer matches what was written)`
      );
    }

    const { entryCount } = await verifyArchiveStructure(tmpPath, row.format);
    return { status: 'passed', checksum, entryCount };
  } catch (e) {
    return { status: 'failed', checksum: null, error: e.message };
  } finally {
    await fs.promises.unlink(tmpPath).catch(() => {});
  }
}

module.exports = { verifyBackup, VerifyError };