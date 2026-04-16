// services/crypto.js — AES-256 encrypt/decrypt for stored credentials
const CryptoJS = require('crypto-js');
require('dotenv').config();

const KEY = process.env.CREDENTIAL_ENCRYPTION_KEY;

console.log(process.env.CREDENTIAL_ENCRYPTION_KEY.length);

// Warn but don't crash — crashing silently swallows all passwords
if (!KEY) {
  console.error('ERROR: CREDENTIAL_ENCRYPTION_KEY is not set in .env — credentials will NOT be saved!');
} else if (KEY.length !== 32) {
  console.error(`ERROR: CREDENTIAL_ENCRYPTION_KEY is ${KEY.length} chars — must be exactly 32. Credentials will NOT be saved!`);
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  if (!KEY || KEY.length !== 32) {
    console.error('encrypt() called but KEY is invalid — returning null');
    return null;
  }
  return CryptoJS.AES.encrypt(plaintext, KEY).toString();
}

function decrypt(ciphertext) {
  if (!ciphertext) return null;
  if (!KEY || KEY.length !== 32) {
    console.error('decrypt() called but KEY is invalid — returning null');
    return null;
  }
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, KEY);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };

