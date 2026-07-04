// db/seed-test-admin.js — creates/updates a local "admin" user with a known
// password for TESTING ONLY. Run manually: node db/seed-test-admin.js
//
// ⚠  "1234" is a trivially guessable password. This script is meant for a
// local/dev/testing environment, not for anything reachable from the
// internet. If this instance is public (e.g. behind netcontrol.notoriousdev.in),
// change this password immediately after confirming login works, or better,
// restrict access via the IP allowlist / take it off the public internet
// until you do.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const USERNAME = 'admin';
const PASSWORD = '1234';

async function seed() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'netcontrol',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'netcontrol',
    timezone: '+00:00',
  });

  const hash = await bcrypt.hash(PASSWORD, 12);

  const [cols] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
       AND COLUMN_NAME IN ('enabled','permissions','must_change_password','has_password')`
  );
  const have = new Set(cols.map(c => c.COLUMN_NAME));
  const missing = ['enabled', 'permissions', 'must_change_password', 'has_password'].filter(c => !have.has(c));
  if (missing.length) {
    console.error(`❌ users table is missing column(s): ${missing.join(', ')}.`);
    console.error('   Run "node db/migrate.js" first, then re-run this script.');
    await conn.end();
    process.exit(1);
  }

  const [existing] = await conn.query('SELECT id FROM users WHERE username = ?', [USERNAME]);

  if (existing.length) {
    await conn.query(
      `UPDATE users
         SET password = ?, role = 'admin', enabled = 1, permissions = 255,
             must_change_password = 0, has_password = 1
       WHERE username = ?`,
      [hash, USERNAME]
    );
    console.log(`✅ Updated existing "${USERNAME}" user — password reset to "${PASSWORD}".`);
  } else {
    await conn.query(
      `INSERT INTO users (id, username, password, role, enabled, permissions, must_change_password, has_password, created_at)
       VALUES (?, ?, ?, 'admin', 1, 255, 0, 1, ?)`,
      [uuidv4(), USERNAME, hash, Math.floor(Date.now() / 1000)]
    );
    console.log(`✅ Created "${USERNAME}" user with password "${PASSWORD}".`);
  }

  console.log('⚠  Testing credentials only — change this before exposing the instance publicly.');
  await conn.end();
}

seed().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});