#!/usr/bin/env node
/**
 * netcontrol-agent.js v4.0 — Hybrid self-installing agent
 *
 * USAGE:
 *   Run manually:
 *     NC_SERVER_URL=http://server:4000 node netcontrol-agent.js
 *
 *   Install as a permanent service (runs on boot, auto-restarts):
 *     Linux:   sudo NC_SERVER_URL=http://server:4000 node netcontrol-agent.js --install
 *     Windows: (run PowerShell as Administrator)
 *              $env:NC_SERVER_URL="http://server:4000"; node netcontrol-agent.js --install
 *
 *   Uninstall service:
 *     Linux:   sudo node netcontrol-agent.js --uninstall
 *     Windows: node netcontrol-agent.js --uninstall (as Administrator)
 *
 * ENV VARS:
 *   NC_SERVER_URL   — required: http(s)://host:port of your NetControl server
 *   NC_REG_SECRET   — required for first-time registration: must match the
 *                     server's AGENT_REGISTRATION_SECRET (see backend .env).
 *                     Not needed on subsequent runs once credentials are
 *                     cached, unless the agent has to re-register (e.g. the
 *                     credentials file was deleted or the key was rejected).
 *   NC_INTERVAL     — metrics push interval seconds (default 5, min 3)
 *   NC_CRED_FILE    — override credential storage path
 */
'use strict';

const os    = require('os');
const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const { execSync, spawnSync, spawn } = require('child_process');

// ── Config ─────────────────────────────────────────────────────────────────────
const SERVER_URL   = (process.env.NC_SERVER_URL || '').replace(/\/$/, '');
const REG_SECRET    = process.env.NC_REG_SECRET || '';
const INTERVAL_SEC = Math.max(3, parseInt(process.env.NC_INTERVAL || '5', 10));
const IS_WINDOWS   = os.platform() === 'win32';
const AGENT_PATH   = path.resolve(process.argv[1]);

const CRED_FILE = process.env.NC_CRED_FILE || (
  IS_WINDOWS
    ? path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'NetControl', 'agent.json')
    : process.getuid?.() === 0
      ? '/etc/netcontrol-agent.json'
      : path.join(os.homedir(), '.netcontrol-agent.json')
);

// ── Install/Uninstall handlers ─────────────────────────────────────────────────
if (process.argv.includes('--install')) {
  installService();
  process.exit(0);
}
if (process.argv.includes('--uninstall')) {
  uninstallService();
  process.exit(0);
}

if (!SERVER_URL) {
  console.error('[Agent] NC_SERVER_URL is required.\n  Example: NC_SERVER_URL=http://192.168.1.100:4000 node netcontrol-agent.js');
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────────────
// SERVICE INSTALLATION
// ──────────────────────────────────────────────────────────────────────────────

function installService() {
  if (!SERVER_URL) {
    console.error('[Install] NC_SERVER_URL must be set when running --install');
    process.exit(1);
  }

  if (IS_WINDOWS) {
    installWindows();
  } else {
    installLinux();
  }
}

function installLinux() {
  const nodeBin = process.execPath; // full path to node binary
  const serviceFile = `/etc/systemd/system/netcontrol-agent.service`;

  const unit = `[Unit]
Description=NetControl Agent
Documentation=https://github.com/your-org/netcontrol
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodeBin} ${AGENT_PATH}
WorkingDirectory=${path.dirname(AGENT_PATH)}
Environment=NC_SERVER_URL=${SERVER_URL}
Environment=NC_INTERVAL=${INTERVAL_SEC}
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
# Run as root so it can access /etc/netcontrol-agent.json
# Change User= to a dedicated service account if preferred

[Install]
WantedBy=multi-user.target
`;

  try {
    fs.writeFileSync(serviceFile, unit, { mode: 0o644 });
    execSync('systemctl daemon-reload');
    execSync('systemctl enable netcontrol-agent');
    execSync('systemctl restart netcontrol-agent');
    console.log('✅ NetControl agent installed and started as systemd service.');
    console.log('   Status:  sudo systemctl status netcontrol-agent');
    console.log('   Logs:    sudo journalctl -u netcontrol-agent -f');
    console.log('   Stop:    sudo systemctl stop netcontrol-agent');
  } catch (e) {
    console.error('[Install] Failed:', e.message);
    console.error('Tip: run with sudo');
    process.exit(1);
  }
}

function installWindows() {
  const nodeBin  = process.execPath;
  const dataDir  = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'NetControl');
  const logFile  = path.join(dataDir, 'agent.log');
  const wrapperPath = path.join(dataDir, 'start-agent.cmd');

  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {}

  // Write a wrapper .cmd that sets env vars and launches node
  const wrapper = `@echo off
set NC_SERVER_URL=${SERVER_URL}
set NC_INTERVAL=${INTERVAL_SEC}
"${nodeBin}" "${AGENT_PATH}" >> "${logFile}" 2>&1
`;
  fs.writeFileSync(wrapperPath, wrapper);

  // Use schtasks (built into all Windows versions) — no NSSM needed
  const taskName = 'NetControlAgent';

  // Delete existing task if present
  spawnSync('schtasks', ['/Delete', '/TN', taskName, '/F'], { stdio: 'ignore' });

  // Create new task: runs at system startup, as SYSTEM account, restarts on failure
  const result = spawnSync('schtasks', [
    '/Create',
    '/TN', taskName,
    '/TR', `"${wrapperPath}"`,
    '/SC', 'ONSTART',
    '/RU', 'SYSTEM',
    '/RL', 'HIGHEST',
    '/F',                // force overwrite
  ], { stdio: 'pipe' });

  if (result.status !== 0) {
    console.error('[Install] schtasks failed:', result.stderr?.toString());
    console.error('Make sure you are running PowerShell as Administrator.');
    process.exit(1);
  }

  // Start it immediately without rebooting
  spawnSync('schtasks', ['/Run', '/TN', taskName], { stdio: 'ignore' });

  console.log('✅ NetControl agent installed as Windows Scheduled Task.');
  console.log(`   Task name: ${taskName}`);
  console.log(`   Log file:  ${logFile}`);
  console.log('   To stop:   schtasks /End /TN NetControlAgent');
  console.log('   To remove: node netcontrol-agent.js --uninstall  (as Administrator)');
}

function uninstallService() {
  if (IS_WINDOWS) {
    const result = spawnSync('schtasks', ['/Delete', '/TN', 'NetControlAgent', '/F'], { stdio: 'pipe' });
    if (result.status === 0) {
      console.log('✅ NetControl agent task removed.');
    } else {
      console.error('Failed to remove task:', result.stderr?.toString());
    }
  } else {
    try {
      execSync('systemctl stop netcontrol-agent 2>/dev/null || true');
      execSync('systemctl disable netcontrol-agent 2>/dev/null || true');
      try { fs.unlinkSync('/etc/systemd/system/netcontrol-agent.service'); } catch {}
      execSync('systemctl daemon-reload');
      console.log('✅ NetControl agent service removed.');
    } catch (e) {
      console.error('Failed to remove service:', e.message);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// AGENT RUNTIME
// ──────────────────────────────────────────────────────────────────────────────

async function ensureDeps() {
  try { require('systeminformation'); return; } catch {}
  console.log('[Agent] Installing systeminformation…');
  execSync('npm install systeminformation --save --loglevel=error', {
    cwd: path.dirname(AGENT_PATH),
    stdio: 'inherit',
  });
}

function httpReq(urlStr, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url  = new URL(urlStr);
    const lib  = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const req  = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: opts.method || 'GET',
      timeout: opts.timeout || 10000,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function longPoll(urlStr, headers = {}) {
  return httpReq(urlStr, { timeout: 25000, headers });
}

// ── Credentials ────────────────────────────────────────────────────────────────
function loadCreds() {
  try {
    const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    if (c.device_id && c.api_key) return c;
  } catch {}
  return null;
}

function saveCreds(c) {
  const dir = path.dirname(CRED_FILE);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  try {
    fs.writeFileSync(CRED_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
  } catch {
    try {
      const fallback = path.join(os.homedir(), '.netcontrol-agent.json');
      fs.writeFileSync(fallback, JSON.stringify(c, null, 2), { mode: 0o600 });
    } catch (e) {
      console.warn('[Agent] Could not save credentials:', e.message);
    }
  }
}

// ── Shared, de-duplicated re-registration ───────────────────────────────────────
// BUG FIX: the main metrics loop and relayLoop() each used to call register()
// independently whenever they saw a 403. The server issues a brand-new random
// API key and overwrites the device's stored key hash on EVERY /register call
// (even for an already-valid existing device). That meant: whichever loop's
// register() finished last invalidated the key the OTHER loop had just been
// handed — so that loop's next request 403'd too, triggering IT to
// re-register, invalidating the first loop's key right back. Once triggered
// by any transient blip, this ping-pongs forever: metrics never land because
// by the time a POST goes out, its key has already been rotated out from
// under it by the other loop.
//
// Fix: at most ONE real /register call is ever in flight at a time. Every
// caller that sees a 403 awaits the SAME promise and gets the SAME result,
// so a single rejection event causes exactly one key rotation, not two
// racing ones.
let reRegisterPromise = null;
async function reRegister(creds) {
  if (!reRegisterPromise) {
    reRegisterPromise = register().finally(() => { reRegisterPromise = null; });
  }
  const fresh = await reRegisterPromise;
  Object.assign(creds, fresh); // mutate in place — all holders of this object see it
  return creds;
}

// ── Registration ───────────────────────────────────────────────────────────────
function getPrimaryIface() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    if (/loopback|^lo$/i.test(name)) continue;
    for (const iface of nets[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.mac !== '00:00:00:00:00:00')
        return iface;
    }
  }
  return null;
}

async function register() {
  if (!REG_SECRET) {
    throw new Error(
      'NC_REG_SECRET is not set. The server requires a registration secret ' +
      '(x-registration-secret header) matching AGENT_REGISTRATION_SECRET in ' +
      'its .env. Run with: NC_SERVER_URL=... NC_REG_SECRET=... node netcontrol-agent.js'
    );
  }
  const net = getPrimaryIface();
  const payload = {
    hostname:   os.hostname(),
    ip:         net?.address || '0.0.0.0',
    mac:        net?.mac     || '',
    os_type:    IS_WINDOWS ? 'windows' : 'linux',
    os_version: `${os.type()} ${os.release()}`,
    arch:       os.arch(),
  };
  console.log(`[Agent] Registering: ${payload.hostname} (${payload.ip})`);
  const res = await httpReq(
    `${SERVER_URL}/api/metrics/register`,
    { method: 'POST', headers: { 'x-registration-secret': REG_SECRET } },
    payload
  );
  if (res.status !== 200 && res.status !== 201)
    throw new Error(`Registration failed (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
  const creds = {
    device_id:   res.body.device_id,
    device_name: res.body.device_name,
    api_key:     res.body.api_key,
    server_url:  SERVER_URL,
  };
  saveCreds(creds);
  console.log(`[Agent] Registered as "${creds.device_name}" (${creds.device_id})`);
  return creds;
}

// ── Metrics ────────────────────────────────────────────────────────────────────
let si = null;

async function collectMetrics() {
  const [cpu, mem, disk, net, time, procs, osInfo] = await Promise.all([
    si.currentLoad(), si.mem(), si.fsSize(), si.networkStats(),
    si.time(), si.processes(), si.osInfo(),
  ]);
  const primary = (net || []).find(n => !n.iface?.startsWith('lo')) || net?.[0];
  return {
    cpu: parseFloat((cpu.currentLoad || 0).toFixed(1)),
    ram: {
      total: Math.round(mem.total  / 1048576),
      used:  Math.round(mem.active / 1048576),
      free:  Math.round(mem.free   / 1048576),
    },
    disk: (disk || [])
      .filter(d => d.size > 0 && !/squash|tmpfs|devtmpfs/i.test(d.fs || ''))
      .map(d => ({
        fs: d.fs, mount: d.mount,
        total: +((d.size / 1073741824).toFixed(2)),
        used:  +((d.used / 1073741824).toFixed(2)),
        use:   +((d.use  || 0).toFixed(1)),
      })),
    network: primary ? {
      iface: primary.iface,
      rxSec: Math.max(0, Math.round(primary.rx_sec || 0)),
      txSec: Math.max(0, Math.round(primary.tx_sec || 0)),
    } : null,
    processes: (procs?.list || [])
      .sort((a, b) => (b.cpu || 0) - (a.cpu || 0))
      .slice(0, 10)
      .map(p => ({ pid: p.pid, name: p.name, cpu: +((p.cpu||0).toFixed(2)), mem: +((p.mem||0).toFixed(2)) })),
    uptime:   Math.floor(time.uptime || 0),
    os:       `${osInfo?.distro || os.type()} ${osInfo?.release || os.release()}`.trim(),
    hostname: os.hostname(),
    // Full process list (not just top-10-by-CPU) — used locally for
    // restricted-program enforcement, then stripped before the metrics
    // POST so the server payload contract doesn't change.
    _allProcesses: (procs?.list || []).map(p => ({ pid: p.pid, name: p.name })),
  };
}

// ── Restricted process policies ─────────────────────────────────────────────────
// The agent polls the server for its effective rule set (global + group +
// device-specific) every POLICY_REFRESH_SEC, then checks every running
// process against it on every metrics tick. Matches are either just
// reported ("alert") or killed and then reported ("kill"). A per-pid+policy
// cooldown keeps a persistent "alert"-only violation from spamming a
// notification every single tick while the process keeps running.
const POLICY_REFRESH_SEC = 60;
const VIOLATION_COOLDOWN_SEC = 300;
let policyCache = [];
let lastPolicyFetch = 0;
const violationCooldowns = new Map(); // `${pid}:${policyId}` -> last reported ts

async function refreshPolicies(creds) {
  try {
    const res = await httpReq(`${SERVER_URL}/api/metrics/policies`, {
      method: 'GET', headers: { 'x-api-key': creds.api_key },
    });
    if (res.status === 200 && Array.isArray(res.body)) {
      policyCache = res.body;
      lastPolicyFetch = Date.now();
    }
  } catch (e) {
    // Non-fatal — keep using the last known policy set until this succeeds.
    console.warn('[Agent] Policy refresh failed:', e.message);
  }
}

function matchesPolicy(procName, policy) {
  if (!procName) return false;
  const a = procName.toLowerCase();
  const b = (policy.process_name || '').toLowerCase();
  if (!b) return false;
  return policy.match_type === 'exact' ? a === b : a.includes(b);
}

function killProcess(pid) {
  try {
    if (IS_WINDOWS) {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
      return r.status === 0 ? 'killed' : 'failed';
    }
    process.kill(pid, 'SIGKILL');
    return 'killed';
  } catch {
    return 'failed';
  }
}

async function reportViolation(creds, { policy_id, process_name, pid, action_taken, kill_result }) {
  try {
    await httpReq(
      `${SERVER_URL}/api/metrics/violation`,
      { method: 'POST', headers: { 'x-api-key': creds.api_key } },
      { policy_id, process_name, pid, action_taken, kill_result }
    );
  } catch (e) {
    console.warn('[Agent] Violation report failed:', e.message);
  }
}

async function enforcePolicies(allProcesses, creds) {
  if (!policyCache.length || !allProcesses?.length) return;
  const now = Date.now();

  for (const proc of allProcesses) {
    for (const policy of policyCache) {
      if (!matchesPolicy(proc.name, policy)) continue;

      const ck = `${proc.pid}:${policy.id}`;
      const isKill = policy.action === 'kill';
      // Kill actions always get retried (a still-running matched process
      // means the previous kill attempt either hasn't happened yet or
      // failed); alert-only actions are cooled down to avoid spamming the
      // same long-running violation every 5s.
      if (!isKill && (now - (violationCooldowns.get(ck) || 0)) < VIOLATION_COOLDOWN_SEC * 1000) {
        continue;
      }

      let killResult = 'not_attempted';
      if (isKill) {
        killResult = killProcess(proc.pid);
        console.warn(`[Agent] Restricted process "${proc.name}" (PID ${proc.pid}) — kill ${killResult}`);
      } else {
        console.warn(`[Agent] Restricted process detected: "${proc.name}" (PID ${proc.pid})`);
      }

      violationCooldowns.set(ck, now);
      await reportViolation(creds, {
        policy_id: policy.id, process_name: proc.name, pid: proc.pid,
        action_taken: policy.action, kill_result: killResult,
      });

      break; // one match is enough per process per tick
    }
  }

  // Trim the cooldown map occasionally so it doesn't grow unbounded on
  // long-running agents watching many short-lived processes.
  if (violationCooldowns.size > 2000) {
    const cutoff = now - VIOLATION_COOLDOWN_SEC * 1000 * 2;
    for (const [k, ts] of violationCooldowns) if (ts < cutoff) violationCooldowns.delete(k);
  }
}

// ── HTTP relay terminal ────────────────────────────────────────────────────────
async function runRelaySession(creds, sessionId) {
  console.log(`\n[Agent] Terminal session: ${sessionId}`);
  const hdrs = { 'x-api-key': creds.api_key };
  const base = `${SERVER_URL}/api/terminal`;
  let proc;
  try {
    proc = spawn(
      IS_WINDOWS ? 'cmd.exe' : (process.env.SHELL || '/bin/bash'),
      IS_WINDOWS ? [] : ['-i'],
      { env: { ...process.env, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
  } catch (e) {
    await httpReq(`${base}/session/${sessionId}/output`, { method: 'POST', headers: hdrs },
      { data: `\r\n\x1b[31m[Shell spawn failed: ${e.message}]\x1b[0m\r\n`, closed: true });
    return;
  }
  let closed = false;
  const close = () => { if (!closed) { closed = true; try { proc.kill(); } catch {} } };
  const sendOut = async (chunk) => {
    try {
      const r = await httpReq(`${base}/session/${sessionId}/output`, { method: 'POST', headers: hdrs }, { data: chunk.toString('binary') });
      if (r.body?.closed) close();
    } catch { close(); }
  };
  proc.stdout.on('data', sendOut);
  proc.stderr.on('data', sendOut);
  proc.on('close', async () => {
    closed = true;
    await httpReq(`${base}/session/${sessionId}/output`, { method: 'POST', headers: hdrs }, { data: '', closed: true }).catch(() => {});
    console.log(`[Agent] Session ended: ${sessionId}`);
  });
  (async () => {
    while (!closed) {
      try {
        const r = await longPoll(`${base}/session/${sessionId}/agent-input`, hdrs);
        if (r.body?.closed) { close(); break; }
        if (r.body?.data && !proc.stdin.destroyed) proc.stdin.write(r.body.data, 'binary');
      } catch { if (!closed) await new Promise(r => setTimeout(r, 1000)); }
    }
  })();
  await new Promise(r => proc.on('close', r));
}

async function relayLoop(getCredsFn) {
  while (running) {
    const creds = getCredsFn();
    const hdrs  = { 'x-api-key': creds.api_key };
    try {
      const res = await longPoll(`${SERVER_URL}/api/terminal/device/${creds.device_id}/pending`, hdrs);
      if (res.status === 403) {
        console.warn('[Agent] Relay: key rejected — re-registering…');
        try {
          await reRegister(creds);
        } catch (e) {
          console.error('[Agent] Re-register failed:', e.message);
          await new Promise(r => setTimeout(r, 5000));
        }
        continue;
      }
      if (res.body?.session?.sessionId)
        runRelaySession(creds, res.body.session.sessionId).catch(e => console.error('[Agent] Session error:', e.message));
    } catch { await new Promise(r => setTimeout(r, 3000)); }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
let running = true;
process.on('SIGINT',  () => { running = false; process.exit(0); });
process.on('SIGTERM', () => { running = false; process.exit(0); });

async function main() {
  await ensureDeps();
  si = require('systeminformation');

  let creds = loadCreds();
  if (creds?.server_url && creds.server_url !== SERVER_URL) {
    console.log('[Agent] Server URL changed — re-registering');
    creds = null;
  }
  if (!creds) {
    creds = await register();
  } else {
    console.log(`[Agent] Credentials loaded for "${creds.device_name}"`);
  }

  console.log(`[Agent] Running — metrics every ${INTERVAL_SEC}s + HTTP terminal relay`);

  const startRelay = () => {
    relayLoop(() => creds).catch(e => {
      console.error('[Agent] Relay crashed:', e.message);
      if (running) setTimeout(startRelay, 5000);
    });
  };
  startRelay();

  let fails = 0, backoff = 2000;
  while (running) {
    try {
      const metrics = await collectMetrics();
      const allProcesses = metrics._allProcesses;
      delete metrics._allProcesses; // internal-only — not part of the metrics payload

      // Refresh the restricted-process rule set periodically (non-fatal —
      // enforcement just keeps using whatever it last successfully fetched).
      if (Date.now() - lastPolicyFetch > POLICY_REFRESH_SEC * 1000) {
        await refreshPolicies(creds);
      }
      if (policyCache.length) {
        enforcePolicies(allProcesses, creds).catch(e =>
          console.warn('[Agent] Policy enforcement error:', e.message));
      }

      const res = await httpReq(
        `${SERVER_URL}/api/metrics`,
        { method: 'POST', headers: { 'x-api-key': creds.api_key } },
        metrics
      );
      if (res.status === 403) {
        console.warn('[Agent] Key rejected — re-registering…');
        await reRegister(creds);
        continue;
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      if (fails > 0) console.log('\n[Agent] Reconnected ✓');
      fails = 0; backoff = 2000;
      process.stdout.write(`\r[Agent] ✓ ${new Date().toLocaleTimeString()}  CPU:${metrics.cpu}%  RAM:${metrics.ram.used}/${metrics.ram.total}MB  `);
    } catch (e) {
      fails++;
      backoff = Math.min(backoff * 2, 60000);
      if (fails === 1 || fails % 10 === 0)
        console.error(`\n[Agent] Error #${fails}: ${e.message} (retry in ${backoff/1000}s)`);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }
    await new Promise(r => setTimeout(r, INTERVAL_SEC * 1000));
  }
}

// ── Resilient top-level restart loop ─────────────────────────────────────────
// The agent should NEVER fully die as long as the process is running.
// Any fatal error gets a delay then retries main() forever.
let _restartCount = 0;

async function startWithRestart() {
  while (running) {
    try {
      await main();
      // main() only returns if running===false (SIGINT/SIGTERM)
    } catch (e) {
      _restartCount++;
      const delayS = Math.min(10 * _restartCount, 120); // 10s → 20s → ... → 120s cap
      console.error(`\n[Agent] Unhandled error (restart #${_restartCount}): ${e.message}`);
      console.error(`[Agent] Restarting in ${delayS}s…`);
      await new Promise(r => setTimeout(r, delayS * 1000));
    }
  }
  console.log('[Agent] Stopped cleanly.');
}

startWithRestart();