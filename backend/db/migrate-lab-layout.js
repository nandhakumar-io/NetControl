// db/migrate-lab-layout.js — theater-style seating layout for "lab" groups.
//
// Adds:
//   groups.is_lab        — marks a group as a lab (renders the seat-layout
//                           editor instead of the plain device list when
//                           expanded on the Groups page)
//   groups.layout_config — JSON: { rowGap, rows: [{ cols, gap }, ...] }
//                           one entry per row, each with its own seat
//                           (column) count and horizontal gap — same idea
//                           as a theater's per-section seating chart.
//   devices.seat_row / devices.seat_col — which seat (if any) a device in
//                           a lab group is currently assigned to. NULL for
//                           devices not placed in the layout yet, and for
//                           devices in non-lab groups.
//
// Safe to run repeatedly — every step checks for existence first.
'use strict';
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

async function getConn() {
  return mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || 'netcontrol',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME     || 'netcontrol',
    multipleStatements: true,
    timezone: '+00:00',
  });
}

async function colExists(conn, table, col) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1`,
    [table, col]
  );
  return r.length > 0;
}

async function addColumnIfMissing(conn, table, col, ddl) {
  if (!(await colExists(conn, table, col))) {
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
    console.log(`  + ${table}.${col}`);
  }
}

async function migrateLabLayout() {
  const conn = await getConn();
  try {
    console.log('Running lab-layout migration...');

    await addColumnIfMissing(conn, 'groups', 'is_lab', 'is_lab TINYINT(1) NOT NULL DEFAULT 0');
    await addColumnIfMissing(conn, 'groups', 'layout_config', 'layout_config JSON DEFAULT NULL');

    await addColumnIfMissing(conn, 'devices', 'seat_row',
      'seat_row SMALLINT DEFAULT NULL, ADD INDEX idx_devices_seat_row (seat_row)');
    await addColumnIfMissing(conn, 'devices', 'seat_col', 'seat_col SMALLINT DEFAULT NULL');

    console.log('✅ Lab-layout migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateLabLayout().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateLabLayout };