// services/syntheticCheckRunner.js — executes HTTP/TCP/SSH health checks
// and records the result. Runs on an interval in poller.js (the one
// dedicated background process — see poller.js's header comment for why
// recurring work lives there and not in the clustered web tier), and is
// also called directly by routes/syntheticChecks.js for "Run Now".
'use strict';
const http   = require('http');
const https  = require('https');
const net    = require('net');
const { URL } = require('url');
const { v4: uuidv4 } = require('uuid');
const { query, execute } = require('../db');
const ssh = require('./ssh');

const TICK_MS = 10000; // check every 10s which configured checks are due

function parseConfig(raw) {
  if (raw == null) return {};
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ── Individual check dispatch ───────────────────────────────────────────────
// Each resolves with a short human-readable success message, or throws with
// a message describing what failed.

function runHttp(device, config, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = config.url || `http://${device.ip_address}/`;
    let parsed;
    try { parsed = new URL(target); } catch { return reject(new Error(`Invalid URL: ${target}`)); }
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.request(parsed, { method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      const needBody = !!config.expect_body_contains;
      res.on('data', (chunk) => { if (needBody && body.length < 65536) body += chunk; });
      res.on('end', () => {
        const expectStatus = config.expect_status || 200;
        if (res.statusCode !== expectStatus) {
          return reject(new Error(`Expected status ${expectStatus}, got ${res.statusCode}`));
        }
        if (needBody && !body.includes(config.expect_body_contains)) {
          return reject(new Error(`Response body did not contain "${config.expect_body_contains}"`));
        }
        resolve(`HTTP ${res.statusCode}`);
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`Timed out after ${timeoutMs}ms`)); });
    req.on('error', (err) => reject(new Error(err.message)));
    req.end();
  });
}

function runTcp(device, config, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!config.port) return reject(new Error('No port configured'));
    const sock = net.createConnection({ host: device.ip_address, port: Number(config.port), timeout: timeoutMs });
    sock.once('connect', () => { sock.destroy(); resolve(`Connected to port ${config.port}`); });
    sock.once('timeout', () => { sock.destroy(); reject(new Error(`Timed out connecting to port ${config.port}`)); });
    sock.once('error', (err) => { sock.destroy(); reject(new Error(err.message)); });
  });
}

async function runSshCommand(device, config) {
  if (!config.command) throw new Error('No command configured');
  const { stdout } = await ssh.execCommand(device, config.command); // rejects on non-zero exit already
  if (config.expect_output_contains && !stdout.includes(config.expect_output_contains)) {
    throw new Error(`Output did not contain "${config.expect_output_contains}" (got: ${stdout.slice(0, 200)})`);
  }
  return stdout ? `OK — ${stdout.slice(0, 120)}` : 'OK';
}

async function dispatch(check, device, config, timeoutMs) {
  switch (check.check_type) {
    case 'http':        return runHttp(device, config, timeoutMs);
    case 'tcp':          return runTcp(device, config, timeoutMs);
    case 'ssh_command':  return runSshCommand(device, config);
    default: throw new Error(`Unknown check type: ${check.check_type}`);
  }
}

// ── Run one check and persist the result + updated status ──────────────────
// Shared by the manual "Run Now" endpoint and the scheduled tick below.
async function executeAndRecord(check, device) {
  const config = parseConfig(check.config);
  const startedAt = Date.now();
  let success, message;
  try {
    message = await dispatch(check, device, config, check.timeout_ms || 5000);
    success = true;
  } catch (e) {
    success = false;
    message = e.message || 'Check failed';
  }
  const latencyMs = Date.now() - startedAt;
  const ts = Math.floor(Date.now() / 1000);

  await execute(
    `INSERT INTO synthetic_check_results (id, check_id, ts, success, latency_ms, message) VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), check.id, ts, success ? 1 : 0, latencyMs, message]
  );

  const consecutiveFailures = success ? 0 : (check.consecutive_failures || 0) + 1;
  // Only flip to 'unhealthy' once the failure streak crosses the
  // configured threshold — a single blip shouldn't trip the status (that's
  // the whole point of failure_threshold), it just gets recorded in the
  // consecutive_failures counter the UI already surfaces.
  const status = success
    ? 'healthy'
    : (consecutiveFailures >= (check.failure_threshold || 2) ? 'unhealthy' : check.status);

  await execute(
    `UPDATE synthetic_checks SET last_run_at = ?, last_message = ?, consecutive_failures = ?, status = ? WHERE id = ?`,
    [ts, message, consecutiveFailures, status, check.id]
  );

  return { success, message, latencyMs, ts, status, consecutiveFailures };
}

// ── Scheduled loop ──────────────────────────────────────────────────────────
let timer = null;
let ticking = false;

async function tick() {
  if (ticking) return; // don't overlap ticks if a prior batch is still running
  ticking = true;
  try {
    const due = await query(
      `SELECT sc.*, d.ip_address, d.os_type, d.ssh_port, d.ssh_username, d.ssh_password, d.ssh_key
       FROM synthetic_checks sc
       JOIN devices d ON d.id = sc.device_id
       WHERE sc.enabled = 1
         AND (sc.last_run_at IS NULL OR UNIX_TIMESTAMP() - sc.last_run_at >= sc.interval_seconds)`
    );
    for (const row of due) {
      const check = {
        id: row.id, check_type: row.check_type, config: row.config,
        timeout_ms: row.timeout_ms, failure_threshold: row.failure_threshold,
        consecutive_failures: row.consecutive_failures, status: row.status,
      };
      const device = {
        ip_address: row.ip_address, os_type: row.os_type, ssh_port: row.ssh_port,
        ssh_username: row.ssh_username, ssh_password: row.ssh_password, ssh_key: row.ssh_key,
      };
      // Fire-and-continue — one slow/stuck check (e.g. an SSH connection
      // hanging) must not delay the rest of this batch or the next tick.
      executeAndRecord(check, device).catch((e) => {
        console.error(`[SyntheticCheck] ${row.name} (${row.id}) errored unexpectedly:`, e.message);
      });
    }
  } catch (e) {
    console.error('[SyntheticCheck] tick query failed:', e.message);
  } finally {
    ticking = false;
  }
}

function start() {
  if (timer) return;
  tick();
  timer = setInterval(tick, TICK_MS);
  console.log(`[SyntheticCheck] runner started (checking for due health checks every ${TICK_MS / 1000}s)`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, executeAndRecord };