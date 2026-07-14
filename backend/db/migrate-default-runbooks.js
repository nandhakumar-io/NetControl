// db/migrate-default-runbooks.js — seeds a handful of ready-to-use runbook
// actions (routes/runbooks.js) for every organization, so the Runbooks page
// isn't a blank slate the first time an admin opens it. These are generic,
// broadly-safe remediation commands that alert rules commonly want to wire
// up (restart a stuck service, clear a full-ish disk, flush caches) — not
// anything destructive or environment-specific like a database failover.
//
// Idempotent per org: keyed on (org_id, name), so re-running this after an
// admin has already renamed/deleted/edited one of the seeded runbooks won't
// resurrect or duplicate it — existence is checked by name before insert.
'use strict';
const path = require('path');
const { v4: uuidv4 } = require('uuid');
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

async function tableExists(conn, table) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1`,
    [table]
  );
  return r.length > 0;
}

// Kept intentionally generic/read-light — these are meant as starting
// points an admin edits to fit their actual service names, not
// fire-and-forget destructive actions. Placeholders like <service> are
// left in the command text on purpose so it's obvious editing is expected
// before wiring one into an alert rule.
const DEFAULT_RUNBOOKS = [
  {
    name: 'Restart service (Linux)',
    description: 'Restarts a systemd service. Replace <service> with the actual unit name before use.',
    os_type: 'linux',
    command: 'sudo systemctl restart <service> && systemctl is-active <service>',
    timeout_sec: 30,
  },
  {
    name: 'Restart service (Windows)',
    description: 'Restarts a Windows service. Replace <ServiceName> with the actual service name before use.',
    os_type: 'windows',
    command: 'Restart-Service -Name "<ServiceName>" -Force; Get-Service -Name "<ServiceName>"',
    timeout_sec: 30,
  },
  {
    name: 'Clear temp files (Linux)',
    description: 'Frees up disk space by clearing /tmp of files older than 7 days. Useful as an auto-action on a disk-usage alert.',
    os_type: 'linux',
    command: 'sudo find /tmp -type f -mtime +7 -delete && df -h /',
    timeout_sec: 60,
  },
  {
    name: 'Clear temp files (Windows)',
    description: 'Frees up disk space by clearing the Windows temp folder. Useful as an auto-action on a disk-usage alert.',
    os_type: 'windows',
    command: 'Remove-Item -Path "$env:TEMP\\*" -Recurse -Force -ErrorAction SilentlyContinue; Get-PSDrive C',
    timeout_sec: 60,
  },
  {
    name: 'Flush DNS cache (Linux)',
    description: 'Restarts systemd-resolved to clear its DNS cache. Skips cleanly if the service isn\'t in use.',
    os_type: 'linux',
    command: 'sudo systemctl restart systemd-resolved 2>/dev/null || echo "systemd-resolved not in use"',
    timeout_sec: 20,
  },
  {
    name: 'Flush DNS cache (Windows)',
    description: 'Clears the Windows DNS resolver cache.',
    os_type: 'windows',
    command: 'ipconfig /flushdns',
    timeout_sec: 15,
  },
  {
    name: 'Clear ARP cache',
    description: 'Flushes the ARP table — useful after a network re-IP or when a device is unreachable due to a stale ARP entry.',
    os_type: 'any',
    command: 'echo "Linux: sudo ip -s -s neigh flush all  |  Windows: arp -d *"',
    timeout_sec: 15,
  },
  {
    name: 'Kill runaway process by name (Linux)',
    description: 'Kills every process matching <process_name>. Replace the placeholder before use — this matches by name, not PID.',
    os_type: 'linux',
    command: 'sudo pkill -f "<process_name>" && echo "killed" || echo "no matching process"',
    timeout_sec: 15,
  },
  {
    name: 'Kill runaway process by name (Windows)',
    description: 'Kills every process matching <ProcessName>. Replace the placeholder before use.',
    os_type: 'windows',
    command: 'Stop-Process -Name "<ProcessName>" -Force -ErrorAction SilentlyContinue; Write-Output "done"',
    timeout_sec: 15,
  },
];

async function migrateDefaultRunbooks() {
  const conn = await getConn();
  try {
    console.log('Running default-runbooks migration...');

    if (!(await tableExists(conn, 'runbook_actions'))) {
      console.log('  ⚠  runbook_actions table not found yet — skipping (run after migrate-orgs)');
      return;
    }
    if (!(await tableExists(conn, 'organizations'))) {
      console.log('  ⚠  organizations table not found yet — skipping (run after migrate-orgs)');
      return;
    }

    const [orgs] = await conn.query('SELECT id FROM organizations');
    let inserted = 0;

    for (const org of orgs) {
      const [existingNames] = await conn.query(
        'SELECT name FROM runbook_actions WHERE org_id = ?',
        [org.id]
      );
      const existing = new Set(existingNames.map(r => r.name));

      for (const rb of DEFAULT_RUNBOOKS) {
        if (existing.has(rb.name)) continue; // don't resurrect a deleted/renamed default
        await conn.query(
          `INSERT INTO runbook_actions (id, org_id, name, description, os_type, command, timeout_sec, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, UNIX_TIMESTAMP())`,
          [uuidv4(), org.id, rb.name, rb.description, rb.os_type, rb.command, rb.timeout_sec]
        );
        inserted++;
      }
    }

    console.log(`  + seeded ${inserted} default runbook(s) across ${orgs.length} org(s)`);
    console.log('✅ Default-runbooks migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateDefaultRunbooks().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateDefaultRunbooks };