// services/crypto.js — AES-256-GCM encrypt/decrypt for stored credentials
//
// SECURITY FIX: Previously this used CryptoJS.AES.encrypt(plaintext, KEY) with
// KEY treated as a *passphrase* rather than a raw key. CryptoJS then derives
// the actual AES key via an MD5-based OpenSSL-style KDF (a single round of
// MD5, no iteration count) and uses CBC mode with no integrity check. That is
// weaker than intended: the 32-byte secret in .env was meant to be used
// directly as a 256-bit key, and CBC without a MAC allows ciphertext
// tampering to go undetected.
//
// This version uses the raw key directly with AES-256-GCM (authenticated
// encryption — tamper-evident, random 96-bit IV per call, stored inline).
// decrypt() stays backward compatible: it detects the new "gcm1:" prefix and
// falls back to the legacy CryptoJS format for data encrypted before this
// fix, so existing stored device credentials keep working without a forced
// re-entry / migration step.
const crypto = require('crypto');
const CryptoJS = require('crypto-js'); // kept only for legacy decrypt fallback
require('dotenv').config();

const KEY = process.env.CREDENTIAL_ENCRYPTION_KEY;
const ALGO = 'aes-256-gcm';
const PREFIX = 'gcm1:';

if (!KEY) {
  console.error('ERROR: CREDENTIAL_ENCRYPTION_KEY is not set in .env — credentials will NOT be saved!');
} else if (KEY.length !== 32) {
  console.error(`ERROR: CREDENTIAL_ENCRYPTION_KEY must be exactly 32 characters (got ${KEY.length}). Credentials will NOT be saved!`);
}

function rawKey() {
  return Buffer.from(KEY, 'utf8'); // 32 bytes = AES-256
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  if (!KEY || KEY.length !== 32) {
    console.error('encrypt() called but KEY is invalid — returning null');
    return null;
  }
  const iv = crypto.randomBytes(12); // 96-bit IV recommended for GCM
  const cipher = crypto.createCipheriv(ALGO, rawKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // store as prefix + base64(iv) : base64(tag) : base64(ciphertext)
  return PREFIX + [iv, tag, ciphertext].map(b => b.toString('base64')).join(':');
}

function decrypt(ciphertext) {
  if (!ciphertext) return null;
  if (!KEY || KEY.length !== 32) {
    console.error('decrypt() called but KEY is invalid — returning null');
    return null;
  }
  try {
    if (ciphertext.startsWith(PREFIX)) {
      const [ivB64, tagB64, dataB64] = ciphertext.slice(PREFIX.length).split(':');
      const iv = Buffer.from(ivB64, 'base64');
      const tag = Buffer.from(tagB64, 'base64');
      const data = Buffer.from(dataB64, 'base64');
      const decipher = crypto.createDecipheriv(ALGO, rawKey(), iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
      return plaintext.toString('utf8');
    }
    // Legacy format (pre-fix): fall back to CryptoJS passphrase-based decrypt
    // so previously-stored credentials still work.
    const bytes = CryptoJS.AES.decrypt(ciphertext, KEY);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch {
    return null;
  }
}

// ── Streaming encrypt/decrypt for large payloads (backup archives, log
// exports) ───────────────────────────────────────────────────────────────
// encrypt()/decrypt() above buffer the whole value in memory, which is fine
// for short strings (device credentials, destination configs) but wrong for
// multi-gigabyte backup archives. These variants wrap AES-256-GCM in a
// Transform stream so archive bytes are encrypted as they fly past on their
// way to disk/S3/Azure/SFTP, never fully buffered.
//
// Wire format: 12-byte IV, then ciphertext, then a 16-byte GCM auth tag
// appended at the very end (the tag can only be computed once the whole
// stream has been seen, so it can't go in a header). Decryption holds back
// the trailing 16 bytes of whatever it's seen so far — once more data
// arrives it knows the previously-held bytes were mid-stream ciphertext, and
// only the final held-back 16 bytes are ever treated as the tag.
const { Transform } = require('stream');

const IV_LENGTH  = 12;
const TAG_LENGTH = 16;

function createEncryptStream() {
  if (!KEY || KEY.length !== 32) {
    throw new Error('createEncryptStream() called but CREDENTIAL_ENCRYPTION_KEY is invalid');
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, rawKey(), iv);
  let ivSent = false;

  return new Transform({
    transform(chunk, enc, cb) {
      try {
        if (!ivSent) { this.push(iv); ivSent = true; }
        const out = cipher.update(chunk);
        if (out.length) this.push(out);
        cb();
      } catch (e) { cb(e); }
    },
    flush(cb) {
      try {
        if (!ivSent) { this.push(iv); ivSent = true; } // zero-byte source: still emit IV + tag
        const final = cipher.final();
        if (final.length) this.push(final);
        this.push(cipher.getAuthTag());
        cb();
      } catch (e) { cb(e); }
    },
  });
}

function createDecryptStream() {
  if (!KEY || KEY.length !== 32) {
    throw new Error('createDecryptStream() called but CREDENTIAL_ENCRYPTION_KEY is invalid');
  }
  let iv = null;
  let header = Buffer.alloc(0);   // buffering until we have the 12-byte IV
  let held = Buffer.alloc(0);     // trailing bytes held back in case they're the tag
  let decipher = null;

  return new Transform({
    transform(chunk, enc, cb) {
      try {
        let data = chunk;
        if (!iv) {
          header = Buffer.concat([header, data]);
          if (header.length < IV_LENGTH) return cb(); // still waiting for the full IV
          iv = header.subarray(0, IV_LENGTH);
          data = header.subarray(IV_LENGTH);
          decipher = crypto.createDecipheriv(ALGO, rawKey(), iv);
        }
        const combined = Buffer.concat([held, data]);
        if (combined.length <= TAG_LENGTH) {
          held = combined; // not enough yet to know what's ciphertext vs. tag
          return cb();
        }
        const toDecrypt = combined.subarray(0, combined.length - TAG_LENGTH);
        held = combined.subarray(combined.length - TAG_LENGTH);
        const out = decipher.update(toDecrypt);
        if (out.length) this.push(out);
        cb();
      } catch (e) { cb(e); }
    },
    flush(cb) {
      try {
        if (!decipher || held.length !== TAG_LENGTH) {
          return cb(new Error('Encrypted stream ended before a complete IV/tag was seen — data is truncated or not encrypted'));
        }
        decipher.setAuthTag(held);
        const final = decipher.final();
        if (final.length) this.push(final);
        cb();
      } catch (e) { cb(e); }
    },
  });
}

module.exports = { encrypt, decrypt, createEncryptStream, createDecryptStream };