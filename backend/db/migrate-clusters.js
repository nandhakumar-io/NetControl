// db/migrate-clusters.js — Groups Clusters / Batches & Operator Assignment
//
// Allows forming clusters / batches of devices inside a group (e.g. "Batch A", "Row 1-20")
// and assigning specific clusters to staff admins (operators) for strict batch isolation.
'use strict';
const path  = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

async function getConn() {
  return mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || 'netcontrol',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME     || 'netcontrol',
    timezone: '+00:00',
  });
}

async function migrateClusters() {
  const conn = await getConn();
  try {
    console.log('Running clusters migration...');

    // 1. Create clusters table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS clusters (
        id          CHAR(36)     PRIMARY KEY,
        group_id    CHAR(36)     NOT NULL,
        org_id      CHAR(36)     NOT NULL,
        name        VARCHAR(100) NOT NULL,
        description TEXT,
        color       VARCHAR(20)  DEFAULT '#a855f7',
        created_at  INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        INDEX idx_clusters_group (group_id),
        INDEX idx_clusters_org   (org_id),
        CONSTRAINT fk_cluster_group FOREIGN KEY (group_id)
          REFERENCES \`groups\`(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('  ✓ clusters table ready');

    // 2. Add cluster_id to devices
    const [c] = await conn.query(
      `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='devices' AND COLUMN_NAME='cluster_id' LIMIT 1`
    );
    if (!c.length) {
      await conn.query(`ALTER TABLE devices ADD COLUMN cluster_id CHAR(36) DEFAULT NULL`);
      console.log('  + devices.cluster_id');
    }
    const [i] = await conn.query(
      `SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='devices' AND INDEX_NAME='idx_devices_cluster' LIMIT 1`
    );
    if (!i.length) {
      await conn.query(`ALTER TABLE devices ADD INDEX idx_devices_cluster (cluster_id)`);
      console.log('  + idx_devices_cluster');
    }

    // 3. Create user_cluster_access table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_cluster_access (
        user_id     CHAR(36)     NOT NULL,
        cluster_id  CHAR(36)     NOT NULL,
        group_id    CHAR(36)     NOT NULL,
        granted_by  CHAR(36)     DEFAULT NULL,
        granted_at  INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        PRIMARY KEY (user_id, cluster_id),
        INDEX idx_uca_user    (user_id),
        INDEX idx_uca_cluster (cluster_id),
        INDEX idx_uca_group   (group_id),
        CONSTRAINT fk_uca_user FOREIGN KEY (user_id)
          REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_uca_cluster FOREIGN KEY (cluster_id)
          REFERENCES clusters(id) ON DELETE CASCADE,
        CONSTRAINT fk_uca_group FOREIGN KEY (group_id)
          REFERENCES \`groups\`(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('  ✓ user_cluster_access table ready');

    console.log('✅ Clusters migration complete.');
  } finally {
    await conn.end();
  }
}

module.exports = { migrateClusters };

if (require.main === module) {
  migrateClusters()
    .then(() => process.exit(0))
    .catch(err => { console.error('Migration failed:', err); process.exit(1); });
}
