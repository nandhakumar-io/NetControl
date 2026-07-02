// db/setup.js — Run once to create all tables and seed default admin
// Usage: node db/setup.js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

async function setup() {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || 'netcontrol',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME     || 'netcontrol',
    multipleStatements: true,
    timezone: '+00:00',
  });

  console.log('Connected to MySQL. Creating schema...');

  await conn.query(`
    SET FOREIGN_KEY_CHECKS = 0;

    -- Users
    CREATE TABLE IF NOT EXISTS users (
      id          CHAR(36)     PRIMARY KEY,
      username    VARCHAR(100) UNIQUE NOT NULL,
      password    VARCHAR(255) NOT NULL,
      role        VARCHAR(50)  NOT NULL DEFAULT 'admin',
      created_at  INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
      last_login  INT UNSIGNED
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    -- Groups
    CREATE TABLE IF NOT EXISTS \`groups\` (
      id          CHAR(36)     PRIMARY KEY,
      name        VARCHAR(100) UNIQUE NOT NULL,
      description TEXT,
      created_at  INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    -- Devices
    CREATE TABLE IF NOT EXISTS devices (
      id              CHAR(36)     PRIMARY KEY,
      name            VARCHAR(100) NOT NULL,
      ip_address      VARCHAR(45)  NOT NULL,
      mac_address     VARCHAR(17)  NOT NULL,
      os_type         ENUM('windows','linux') NOT NULL,
      group_id        CHAR(36),
      ssh_username    VARCHAR(100),
      ssh_password    TEXT,
      ssh_key         MEDIUMTEXT,
      rpc_username    VARCHAR(100),
      rpc_password    TEXT,
      status          VARCHAR(20) DEFAULT 'unknown',
      last_seen       INT UNSIGNED,
      created_at      INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
      CONSTRAINT fk_device_group FOREIGN KEY (group_id)
        REFERENCES \`groups\`(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    -- Schedules
    CREATE TABLE IF NOT EXISTS schedules (
      id          CHAR(36)    PRIMARY KEY,
      name        VARCHAR(100) NOT NULL,
      action      ENUM('wake','shutdown','restart') NOT NULL,
      cron_expr   VARCHAR(100) NOT NULL,
      target_type ENUM('device','group') NOT NULL,
      target_id   CHAR(36)    NOT NULL,
      enabled     TINYINT(1)  NOT NULL DEFAULT 1,
      created_by  CHAR(36),
      created_at  INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
      last_run    INT UNSIGNED,
      next_run    INT UNSIGNED,
      CONSTRAINT fk_schedule_user FOREIGN KEY (created_by)
        REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    -- Audit log
    CREATE TABLE IF NOT EXISTS audit_log (
      id          CHAR(36)    PRIMARY KEY,
      timestamp   INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
      user_id     CHAR(36),
      username    VARCHAR(100) NOT NULL,
      action      VARCHAR(100) NOT NULL,
      target_type VARCHAR(50),
      target_id   CHAR(36),
      target_name VARCHAR(100),
      ip_source   VARCHAR(45),
      result      ENUM('success','failure','partial') NOT NULL,
      details     TEXT,
      INDEX idx_audit_timestamp (timestamp),
      INDEX idx_audit_action    (action),
      INDEX idx_audit_user      (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    -- Refresh tokens
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id          CHAR(36)    PRIMARY KEY,
      user_id     CHAR(36)    NOT NULL,
      token_hash  CHAR(64)    NOT NULL,
      expires_at  INT UNSIGNED NOT NULL,
      created_at  INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
      revoked     TINYINT(1)  NOT NULL DEFAULT 0,
      INDEX idx_refresh_hash (token_hash),
      CONSTRAINT fk_refresh_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    SET FOREIGN_KEY_CHECKS = 1;
  `);

  console.log('✅ Schema created.');

  // Ensure must_change_password exists even for databases created before
  // this fix (base schema in migrate.js also has it now, for fresh installs).
  const [cols] = await conn.query("SHOW COLUMNS FROM users LIKE 'must_change_password'");
  if (cols.length === 0) {
    await conn.query('ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0');
  }

  // Seed default admin if no users exist
  // SECURITY FIX: the old hardcoded "admin123" password is a well-known
  // default that would let anyone who can reach the login page take over
  // the instance before the operator ever logs in. We now generate a
  // strong random one-time password, print it once, and require it be
  // changed on first login (must_change_password).
  const [rows] = await conn.query('SELECT COUNT(*) as c FROM users');
  if (rows[0].c === 0) {
    const tempPassword = crypto.randomBytes(18).toString('base64url'); // ~24 chars, high entropy
    const hash = await bcrypt.hash(tempPassword, 12);
    await conn.query(
      'INSERT INTO users (id, username, password, role, must_change_password) VALUES (?, ?, ?, ?, 1)',
      [uuidv4(), 'admin', hash, 'admin']
    );
    console.log('✅ Default admin created: username=admin');
    console.log(`✅ Temporary password: ${tempPassword}`);
    console.log('⚠  This password is shown only once. Log in and change it immediately.');
    console.log('⚠  (must_change_password is set — enforce this in the login/auth flow.)');
  }

  await conn.end();
  console.log('✅ Database setup complete.');
}

setup().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});