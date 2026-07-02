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

module.exports = { encrypt, decrypt };