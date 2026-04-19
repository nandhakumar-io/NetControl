// db/migrate-users.js — adds user_group_access table + indexes for scale
'use strict';
const { getPool } = require('./index');

async function migrateUsers() {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    // user_group_access: maps operator users to specific groups
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_group_access (
        user_id   CHAR(36) NOT NULL,
        group_id  CHAR(36) NOT NULL,
        granted_by CHAR(36) DEFAULT NULL,
        granted_at INT UNSIGNED NOT NULL,
        PRIMARY KEY (user_id, group_id),
        INDEX idx_uga_user  (user_id),
        INDEX idx_uga_group (group_id),
        CONSTRAINT fk_uga_user  FOREIGN KEY (user_id)  REFERENCES users(id)    ON DELETE CASCADE,
        CONSTRAINT fk_uga_group FOREIGN KEY (group_id) REFERENCES \`groups\`(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] user_group_access table ready');
  } finally {
    conn.release();
  }
}

module.exports = { migrateUsers };
