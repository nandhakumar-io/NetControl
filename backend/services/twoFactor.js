// services/twoFactor.js — TOTP secret/backup-code lifecycle for local accounts
//
// Secrets are encrypted at rest with the same AES-256-GCM helper already used
// for device SSH/WinRM credentials and backup destination configs
// (services/crypto.js) — never stored or logged in plaintext.
//
// Backup codes are one-time: only their bcrypt hashes are stored, the
// plaintext list is generated once at confirm/regenerate time and returned
// to the caller to show the user exactly once. Each code is removed from the
// stored list the moment it's redeemed, so it can't be reused.
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { encrypt, decrypt } = require('./crypto');

// otplib defaults (30s step, 6 digits, SHA1) match every common authenticator
// app (Google Authenticator, Authy, 1Password, etc.) — deliberately left at
// defaults rather than tightened, since a mismatch here just breaks scanning.
authenticator.options = { window: 1 }; // allow the previous/next 30s step for clock skew

const BACKUP_CODE_COUNT = 10;

function generateSecret() {
  return authenticator.generateSecret();
}

function encryptSecret(secret) {
  return encrypt(secret);
}
function decryptSecret(ciphertext) {
  return decrypt(ciphertext);
}

function keyUri(secret, username, issuer = 'NetControl') {
  return authenticator.keyuri(username, issuer, secret);
}

async function qrCodeDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl);
}

function verifyToken(secret, token) {
  if (!secret || !token) return false;
  try {
    return authenticator.verify({ token: String(token).replace(/\s+/g, ''), secret });
  } catch {
    return false;
  }
}

// ── Backup codes ─────────────────────────────────────────────────────────────
// Format: 4 groups separated by dashes, uppercase alphanumeric minus
// ambiguous characters (0/O, 1/I/L) — easy to read back over the phone to
// an admin during account recovery.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCode() {
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (i === 4) out += '-';
  }
  return out;
}

async function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  const plain = Array.from({ length: count }, randomCode);
  const hashed = await Promise.all(plain.map(code => bcrypt.hash(code, 10)));
  return { plain, hashed };
}

function encryptBackupCodes(hashedArray) {
  return encrypt(JSON.stringify(hashedArray));
}
function decryptBackupCodes(ciphertext) {
  if (!ciphertext) return [];
  const plain = decrypt(ciphertext);
  if (!plain) return [];
  try { return JSON.parse(plain); } catch { return []; }
}

// Checks `code` against the stored hashed list. Returns the remaining list
// (with the matched code removed) if valid, or null if no match — caller is
// responsible for persisting the returned list so the code can't be reused.
async function redeemBackupCode(hashedArray, code) {
  const candidate = String(code || '').trim().toUpperCase();
  for (let i = 0; i < hashedArray.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(candidate, hashedArray[i])) {
      return [...hashedArray.slice(0, i), ...hashedArray.slice(i + 1)];
    }
  }
  return null;
}

module.exports = {
  generateSecret, encryptSecret, decryptSecret, keyUri, qrCodeDataUrl, verifyToken,
  generateBackupCodes, encryptBackupCodes, decryptBackupCodes, redeemBackupCode,
  BACKUP_CODE_COUNT,
};