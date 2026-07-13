// db/migrate-capacity-forecast.js — disk/RAM-fill trend forecasting
//
// services/capacityForecast.js projects metrics_history forward with a
// linear trend ("this disk will hit 100% in ~9 days") and pages admins via
// the same bell + web-push pipeline as regular alerts (routes/alerts.js).
// This migration adds the one table that pipeline needs — a dedupe/cooldown
// record per device+metric so a slowly-filling disk doesn't re-page on
// every 6h tick — and seeds a handful of ready-to-run disk-cleanup runbooks
// so the forecast alert has something obvious to attach as a fix, instead
// of just telling an admin "good luck."
'use strict';
const path  = require('path');
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
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

async function migrateCapacityForecast() {
  const conn = await getConn();
  try {
    // (device_id, metric) is the PRIMARY KEY (not just an index) because
    // capacityForecast.js's checkAndNotify() upserts against it with
    // ON DUPLICATE KEY UPDATE — that requires a real unique/primary key on
    // exactly those two columns to know which row to update.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS capacity_forecast_notices (
        device_id       CHAR(36)     NOT NULL,
        metric          VARCHAR(10)  NOT NULL,
        last_notified_at INT UNSIGNED NOT NULL,
        days_to_full    DOUBLE       NOT NULL,
        PRIMARY KEY (device_id, metric),
        CONSTRAINT fk_capforecast_device FOREIGN KEY (device_id)
          REFERENCES devices(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Seed a handful of generic, safe-by-default disk-cleanup runbooks
    // (global — org_id NULL) so a capacity warning has an obvious one-click
    // fix to attach, instead of shipping the forecast feature with an empty
    // Runbooks page. Idempotent the same way migrate-drift-patterns.js
    // seeds its defaults: only insert if runbook_actions is completely
    // empty, so re-running migrate.js never resurrects a default an admin
    // deliberately deleted or edited.
    const [[{ c }]] = await conn.query(`SELECT COUNT(*) AS c FROM runbook_actions`);
    if (c === 0) {
      const now = Math.floor(Date.now() / 1000);
      const defaults = [
        [
          'Clear apt package cache',
          'Removes downloaded .deb archives from /var/cache/apt/archives. Safe, reclaims space with no functional impact — a classic first fix for a slowly-filling / on Debian/Ubuntu boxes.',
          'linux',
          'sudo apt-get clean -y',
          60,
        ],
        [
          'Vacuum systemd journal logs (>7d)',
          'Truncates systemd-journald logs older than 7 days via journalctl --vacuum-time. Journals with no size cap are one of the most common silent disk-fill causes on long-lived Linux hosts.',
          'linux',
          'sudo journalctl --vacuum-time=7d',
          60,
        ],
        [
          'Clear /tmp files older than 7 days',
          'Deletes files under /tmp not accessed in 7+ days. Leaves anything actively in use alone; run during a maintenance window on hosts with long-running jobs that stage large temp files.',
          'linux',
          'sudo find /tmp -type f -atime +7 -delete',
          120,
        ],
        [
          'Docker prune (dangling images, stopped containers, build cache)',
          'Runs docker system prune -f — removes stopped containers, dangling images, unused networks, and build cache. Does NOT touch running containers or named volumes. Common fix on Docker hosts where forecasted growth is really image/layer churn.',
          'linux',
          'sudo docker system prune -f',
          120,
        ],
        [
          'Clear Windows Temp folders',
          'Deletes files in C:\\Windows\\Temp and the current user Temp folder. Equivalent to the "Temporary files" category in Disk Cleanup — safe, no reboot required.',
          'windows',
          'Remove-Item -Path "$env:WINDIR\\Temp\\*","$env:TEMP\\*" -Recurse -Force -ErrorAction SilentlyContinue',
          120,
        ],
        [
          'Clear Windows Update cache (SoftwareDistribution)',
          'Stops the Windows Update service, clears C:\\Windows\\SoftwareDistribution\\Download (accumulated update installers, often several GB on hosts that have been up a while), then restarts the service.',
          'windows',
          'Stop-Service wuauserv -Force; Remove-Item -Path "$env:WINDIR\\SoftwareDistribution\\Download\\*" -Recurse -Force -ErrorAction SilentlyContinue; Start-Service wuauserv',
          180,
        ],
        [
          'Empty Recycle Bin (all drives)',
          'Clears the Recycle Bin on every local drive. Low-impact, high-frequency fix on file-server / workstation-style devices where deleted files quietly pile up.',
          'windows',
          'Clear-RecycleBin -Force -ErrorAction SilentlyContinue',
          60,
        ],
      ];
      for (const [name, description, os_type, command, timeout_sec] of defaults) {
        await conn.query(
          `INSERT INTO runbook_actions
             (id, org_id, name, description, os_type, command, timeout_sec, created_by, created_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, ?)`,
          [uuidv4(), name, description, os_type, command, timeout_sec, now]
        );
      }
      console.log(`  + seeded ${defaults.length} default disk-cleanup runbooks`);
    }
  } finally {
    await conn.end();
  }
}

module.exports = { migrateCapacityForecast };

if (require.main === module) {
  migrateCapacityForecast()
    .then(() => { console.log('✅ capacity_forecast_notices ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}