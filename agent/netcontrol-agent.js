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
 *   Self-test (used internally by the self-update path — see checkForUpdate()
 *   below — to verify a newly-downloaded build actually boots before it's
 *   promoted to the running service; safe to run manually too):
 *     node netcontrol-agent.js --self-test
 *     Exits 0 if the build can load its dependencies, read the existing
 *     credentials file (if any), and reach NC_SERVER_URL. Exits 1 otherwise.
 *     Does NOT register, run the metrics loop, or touch the installed
 *     service/scheduled task.
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
 *   NC_AUTO_UPDATE  — set to "true" to let the agent replace itself with a
 *                     newer build the server advertises (checksum-verified,
 *                     off by default). See checkForUpdate() below.
 */
'use strict';

const os    = require('os');
const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const { execSync, spawnSync, spawn } = require('child_process');
const crypto = require('crypto');

// ── Config ─────────────────────────────────────────────────────────────────────
const SERVER_URL   = (process.env.NC_SERVER_URL || '').replace(/\/$/, '');
const REG_SECRET    = process.env.NC_REG_SECRET || '';
const INTERVAL_SEC = Math.max(3, parseInt(process.env.NC_INTERVAL || '5', 10));
const IS_WINDOWS   = os.platform() === 'win32';
const AGENT_PATH   = path.resolve(process.argv[1]);
// AUTO_UPDATE: opt-in (default off) — when the server reports a newer
// version (see checkForUpdate() below), the agent downloads the new
// netcontrol-agent.js from the server, verifies it against the sha256 the
// server also reports, and atomically replaces itself before triggering a
// restart through whichever service manager installed it. Off by default
// because self-modifying a running production agent is exactly the kind of
// thing an operator should consciously opt into per-fleet, not something
// that silently turns on.
const AUTO_UPDATE  = /^(1|true|yes)$/i.test(process.env.NC_AUTO_UPDATE || '');
// AGENT_VERSION — the version this build reports to the server (see the
// agent_version field sent on every registration/metrics POST below), which
// drives the Devices page's agent-version badge and the update-available
// check in services/agentRelease.js.
//
// BUG FIX: this used to come exclusively from `require('./package.json').version`,
// silently falling back to '0.0.0' whenever package.json wasn't sitting
// right next to the script. That's not an edge case — it's the NORMAL
// deployment path documented at the top of this file ("download
// netcontrol-agent.js and run it standalone", no npm install). Every such
// install therefore reported v0.0.0 forever regardless of which build was
// actually running, which is why the version looked permanently "stuck"
// and permanently flagged as outdated against whatever the admin published.
//
// Fixed by making this literal constant — bumped alongside agent/package.json's
// "version" field whenever a new build is cut — the primary source of truth.
// It's baked into the script text itself, so it travels correctly with the
// file no matter how it's copied around (curl download, self-update's
// versioned install directories, etc.) without depending on any sidecar
// file being present. package.json is still consulted as a secondary check
// for npm-installed setups, but never allowed to silently downgrade this to
// 0.0.0 the way the old try/catch did.
const AGENT_VERSION_BUILD = '1.1.2';
let AGENT_VERSION = AGENT_VERSION_BUILD;
try {
  const pkgVersion = require('./package.json').version;
  if (pkgVersion) AGENT_VERSION = pkgVersion;
} catch { /* no package.json alongside the script (standalone deploy) — use AGENT_VERSION_BUILD above */ }

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

// --self-test: run by checkForUpdate() against a freshly-downloaded,
// not-yet-promoted build (see "Self-update (blue-green via versioned
// installs)" further down). Deliberately does the absolute minimum needed
// to prove "this file can actually run" — no registration, no metrics
// loop, no writes to the credentials file, no touching the installed
// service/task. A false-positive here (exiting 0 when the build is
// actually broken) is far worse than a false-negative, so every check
// inside runSelfTest() fails closed: any unexpected error/timeout is a
// FAIL, not a skip. `SELF_TEST` is checked again at the bottom of the file
// to skip the normal startup loop (see startWithRestart() call at EOF).
const SELF_TEST = process.argv.includes('--self-test');
if (SELF_TEST) {
  // runSelfTest() is defined further down as a hoisted `async function`,
  // safe to call here.
  runSelfTest().then(ok => process.exit(ok ? 0 : 1));
}

if (!SELF_TEST && !SERVER_URL) {
  console.error('[Agent] NC_SERVER_URL is required.\n  Example: NC_SERVER_URL=http://192.168.1.100:4000 node netcontrol-agent.js');
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────────────
// SERVICE INSTALLATION
// ──────────────────────────────────────────────────────────────────────────────

// `execPath` is optional — defaults to AGENT_PATH (the file currently
// running), which is the normal --install behavior. The self-update
// promotion path (promoteVersion() below) passes the versioned candidate
// path instead, so the SAME systemd unit / scheduled task is rewritten to
// point at the new build and restarted — no second process, no pm2, no
// dual-registration window. installService() itself is otherwise
// unchanged and remains fully idempotent (safe to call repeatedly).
function installService(execPath = AGENT_PATH) {
  if (!SERVER_URL) {
    console.error('[Install] NC_SERVER_URL must be set when running --install');
    process.exit(1);
  }

  if (IS_WINDOWS) {
    installWindows(execPath);
  } else {
    installLinux(execPath);
  }
}

function installLinux(execPath = AGENT_PATH) {
  const nodeBin = process.execPath; // full path to node binary
  const serviceFile = `/etc/systemd/system/netcontrol-agent.service`;

  const unit = `[Unit]
Description=NetControl Agent
Documentation=https://github.com/your-org/netcontrol
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodeBin} ${execPath}
WorkingDirectory=${path.dirname(execPath)}
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
    console.log(`✅ NetControl agent installed and started as systemd service (${execPath}).`);
    console.log('   Status:  sudo systemctl status netcontrol-agent');
    console.log('   Logs:    sudo journalctl -u netcontrol-agent -f');
    console.log('   Stop:    sudo systemctl stop netcontrol-agent');
  } catch (e) {
    console.error('[Install] Failed:', e.message);
    console.error('Tip: run with sudo');
    process.exit(1);
  }
}

function installWindows(execPath = AGENT_PATH) {
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
"${nodeBin}" "${execPath}" >> "${logFile}" 2>&1
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

// Like httpReq, but returns the raw Buffer + response headers instead of
// JSON-parsing the body — needed for downloading the agent's own updated
// script (binary-safe, and we need the X-Agent-Sha256/X-Agent-Version
// headers httpReq's JSON-only contract throws away).
function downloadBuffer(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      timeout: 20000,
      headers,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function longPoll(urlStr, headers = {}) {
  // +3s over the backend's own 25s/20s poll timeouts (routes rely on
  // services/webTerminal.js's setTimeout(...,25000)/(...,20000)) so the
  // server always gets to respond with a clean { session: null } / { data:
  // null } first, instead of this socket getting destroyed by our own
  // timeout at nearly the same instant and surfacing as a spurious
  // "Request timeout" error that then costs relayLoop() an extra retry delay.
  return httpReq(urlStr, { timeout: 28000, headers });
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
    agent_version: AGENT_VERSION,
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

// ── Self-test ──────────────────────────────────────────────────────────────────
// Run via `node <candidate-path> --self-test` against a freshly-downloaded
// build that has NOT been promoted yet (see checkForUpdate()'s versioned
// download below). Proves the new file can actually boot before the
// currently-running agent trusts it enough to hand over the service.
//
// Deliberately conservative in the opposite direction from checkForUpdate():
// every check here should fail (return false) rather than throw or hang,
// so the caller always gets a clean true/false rather than having to
// separately handle a crash vs. a timeout vs. a real failure.
async function runSelfTest() {
  const result = { deps: false, creds: false, server: false };
  try {
    console.log(`[SelfTest] Checking build at ${AGENT_PATH} (v${AGENT_VERSION})…`);

    // 1. Dependencies actually resolve. This is the single most common way
    //    a "successfully downloaded" build is still broken — e.g. npm
    //    install failed silently, or node_modules wasn't carried over into
    //    the new versioned directory.
    try {
      require('systeminformation');
      result.deps = true;
    } catch (e) {
      console.warn('[SelfTest] FAIL — could not load systeminformation:', e.message);
    }

    // 2. Credentials file is readable (if one exists — a brand new install
    //    with no creds yet is not itself a failure, just means this check
    //    is a no-op rather than a pass/fail).
    const creds = loadCreds();
    result.creds = creds ? !!(creds.device_id && creds.api_key) : true;
    if (creds && !result.creds) console.warn('[SelfTest] FAIL — credentials file exists but is malformed.');

    // 3. The server is actually reachable with the current build's HTTP
    //    stack. Doesn't need to authenticate — just needs SERVER_URL to
    //    respond at all, since a build with a broken http/https wrapper
    //    (e.g. a bad edit to httpReq()) would otherwise pass 1 and 2 and
    //    still be useless in production.
    if (!SERVER_URL) {
      console.warn('[SelfTest] FAIL — NC_SERVER_URL is not set.');
    } else {
      try {
        const res = await httpReq(`${SERVER_URL}/api/health`, { timeout: 8000 }).catch(() =>
          httpReq(SERVER_URL, { timeout: 8000 }));
        // Any HTTP response at all (even a 404 if /api/health doesn't
        // exist on this server version) proves the network stack and TLS
        // handshake work — we're testing "can this build talk to the
        // server", not "does this exact endpoint exist".
        result.server = !!res && typeof res.status === 'number';
      } catch (e) {
        console.warn('[SelfTest] FAIL — could not reach NC_SERVER_URL:', e.message);
      }
    }

    const ok = result.deps && result.creds && result.server;
    console.log(`[SelfTest] deps=${result.deps} creds=${result.creds} server=${result.server} → ${ok ? 'PASS' : 'FAIL'}`);
    return ok;
  } catch (e) {
    // Anything unexpected (a syntax error surfacing only at require-time
    // elsewhere in this file, an uncaught throw, etc.) is a FAIL — never
    // let an unknown exception be mistaken for a pass.
    console.error('[SelfTest] FAIL — unexpected error:', e.message);
    return false;
  }
}

// ── Self-update (blue-green via versioned installs) ─────────────────────────
// Triggered from the main loop whenever a metrics POST response says
// update_available: true (see routes/metrics.js + services/agentRelease.js
// on the server). Two modes:
//   - AUTO_UPDATE off (default): log it once per process lifetime so an
//     operator watching the console/journal sees it, and stop — no file
//     touched, no restart.
//   - AUTO_UPDATE on: download the new netcontrol-agent.js from the server
//     (authenticated the same way metrics POSTs are, via x-api-key),
//     verify it against the sha256 the server reports in the response
//     headers, atomically replace this script on disk, then trigger a
//     restart through whichever service manager installed it.
//
// Deliberately conservative: any failure at any step just logs and leaves
// the currently-running agent untouched — a bad update should never be
// able to leave a fleet of devices with no agent running at all.
//
// CHANGED (blue-green): updates used to overwrite AGENT_PATH in place and
// restart on faith that the bytes were intact (checksum-only). Now each
// version is downloaded into its own directory under VERSIONS_DIR, proven
// to actually boot via a `--self-test` child process, and only THEN
// promoted by rewriting the systemd unit / scheduled task to point at the
// new path (see installService(execPath) above) and restarting through
// the same service manager as before. If self-test fails, the versioned
// directory is left on disk for inspection (not cleaned up automatically)
// and the currently-running agent is completely untouched — no file
// swapped, no restart triggered.
const VERSIONS_DIR = path.join(path.dirname(AGENT_PATH), 'versions');
const SELF_TEST_TIMEOUT_MS = 20000;

let updateNoticeLogged = false;
let lastUpdateAttempt = 0;
const UPDATE_RETRY_COOLDOWN_MS = 30 * 60 * 1000; // don't hammer the server if something's wrong

async function checkForUpdate(creds, latestVersion, force = false) {
  if (!latestVersion) return; // force_update with no manifest configured — nothing to fetch
  if (!force) {
    if (!AUTO_UPDATE) {
      if (!updateNoticeLogged) {
        updateNoticeLogged = true;
        console.log(`\n[Agent] Update available: v${latestVersion} (running v${AGENT_VERSION}). Set NC_AUTO_UPDATE=true to update automatically, or download the new build yourself.`);
      }
      return;
    }
    if (Date.now() - lastUpdateAttempt < UPDATE_RETRY_COOLDOWN_MS) return;
  } else {
    // Admin explicitly queued this from the Devices page (POST
    // /api/devices/bulk-agent-update) — that's a deliberate one-shot
    // action, not the agent's own silent background updater, so it applies
    // regardless of AUTO_UPDATE and isn't subject to the routine retry
    // cooldown. It still goes through the same checksum + self-test
    // validation below before anything about the running service changes.
    console.log(`\n[Agent] Update requested by administrator (v${AGENT_VERSION} → v${latestVersion})…`);
  }
  lastUpdateAttempt = Date.now();

  console.log(`\n[Agent] Downloading update v${latestVersion}…`);
  const res = await downloadBuffer(`${SERVER_URL}/api/agent-release/download`, { 'x-api-key': creds.api_key });
  if (res.status !== 200) {
    console.warn(`[Agent] Update download failed: HTTP ${res.status}`);
    return;
  }

  const expectedSha = res.headers['x-agent-sha256'];
  const actualSha = crypto.createHash('sha256').update(res.body).digest('hex');
  if (!expectedSha || actualSha !== expectedSha) {
    console.warn(`[Agent] Update REJECTED — checksum mismatch (expected ${expectedSha || 'none'}, got ${actualSha}). Not applying.`);
    return;
  }
  if (res.body.length < 1000) {
    // Sanity floor — a real agent script is tens of KB; anything this
    // small is almost certainly a truncated download or an error page
    // that somehow got a 200, not a real update. Refuse rather than risk
    // promoting garbage.
    console.warn('[Agent] Update REJECTED — downloaded file suspiciously small, refusing to apply.');
    return;
  }

  // ── Land the new build in its own versioned directory ──────────────────
  // Never touches AGENT_PATH — a failed/rejected update here has made
  // zero changes to anything the running service depends on.
  const versionDir = path.join(VERSIONS_DIR, latestVersion);
  const candidatePath = path.join(versionDir, 'netcontrol-agent.js');
  try {
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(candidatePath, res.body);
    // The candidate needs its own package.json so `require('./package.json')`
    // (AGENT_VERSION above) and dependency resolution work when it's later
    // run as the promoted service. Copy the currently-running one's deps
    // list — systeminformation's version doesn't change on most releases
    // (see the top-of-file note on why the agent ships as a single script).
    const pkgSrc = path.join(path.dirname(AGENT_PATH), 'package.json');
    if (fs.existsSync(pkgSrc)) {
      const pkg = JSON.parse(fs.readFileSync(pkgSrc, 'utf8'));
      pkg.version = latestVersion;
      fs.writeFileSync(path.join(versionDir, 'package.json'), JSON.stringify(pkg, null, 2));
    }
    // node_modules (systeminformation) — symlink rather than copy so this
    // doesn't reinstall/duplicate ~50MB per version. If the currently
    // running install doesn't have node_modules alongside it either (e.g.
    // global install), self-test's require() below will just fail closed
    // and the update is correctly rejected rather than silently skipping
    // the dependency check.
    const modulesSrc = path.join(path.dirname(AGENT_PATH), 'node_modules');
    const modulesDst = path.join(versionDir, 'node_modules');
    if (fs.existsSync(modulesSrc) && !fs.existsSync(modulesDst)) {
      try { fs.symlinkSync(modulesSrc, modulesDst, 'junction'); } catch (e) {
        console.warn('[Agent] Could not link node_modules for candidate build:', e.message);
      }
    }
  } catch (e) {
    console.error('[Agent] Update FAILED to write candidate build to disk:', e.message);
    return;
  }

  // ── Prove it boots before trusting it with the live service ─────────────
  console.log(`[Agent] Running self-test against candidate build v${latestVersion}…`);
  const passed = await runCandidateSelfTest(candidatePath);
  if (!passed) {
    console.warn(`[Agent] Self-test FAILED for v${latestVersion} — leaving running agent (v${AGENT_VERSION}) untouched.`);
    console.warn(`[Agent] Candidate left on disk for inspection: ${candidatePath}`);
    return;
  }

  // ── Promote: same systemd unit / scheduled task, new ExecStart target ───
  // This is the entire "cutover" — no second process is ever left running,
  // no pm2 or other process manager is required, and it reuses the exact
  // install logic that already ran during --install (fully idempotent).
  console.log(`[Agent] Self-test passed. Promoting v${latestVersion} and restarting…`);
  try {
    installService(candidatePath);
  } catch (e) {
    console.error('[Agent] Promotion FAILED:', e.message, '— running agent left in place; you may need to promote manually:');
    console.error(`  sudo node ${candidatePath} --install`);
    return;
  }
  setTimeout(() => process.exit(0), 500); // installService()'s restart already brought the new version up
}

// Spawns the candidate build with --self-test and resolves true/false
// based on its exit code. Runs as a genuinely separate process (not just
// require()'d in-process) so a candidate with e.g. a top-level infinite
// loop or a crash-on-load bug can't take down the currently-running agent
// that's evaluating it — the worst case is this promise times out.
function runCandidateSelfTest(candidatePath) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(process.execPath, [candidatePath, '--self-test'], {
      env: { ...process.env, NC_SERVER_URL: SERVER_URL },
      stdio: 'inherit',
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(`[Agent] Self-test timed out after ${SELF_TEST_TIMEOUT_MS / 1000}s — treating as FAIL.`);
      try { child.kill('SIGKILL'); } catch {}
      resolve(false);
    }, SELF_TEST_TIMEOUT_MS);

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.warn('[Agent] Self-test process failed to spawn:', e.message);
      resolve(false);
    });
  });
}

// Ask whichever service manager installed this agent to relaunch it with
// the freshly-written file, then exit this process. On Linux, systemd's
// Restart=always (see installLinux()) means we could just exit and it
// would come back anyway — calling systemctl restart explicitly first is
// just belt-and-suspenders for the case where the agent is running
// standalone under some other supervisor. On Windows, the scheduled task
// has no restart-on-exit trigger at all (see installWindows()), so an
// explicit `schtasks /Run` is the only thing that brings it back — without
// it, exiting here would just leave the device with no agent until next
// reboot.
// NOTE: no longer called by checkForUpdate() — promotion now goes through
// installService(candidatePath), which does its own systemctl/schtasks
// restart as part of rewriting the unit/task. Left in place in case
// anything else wants a "just restart whatever's currently installed"
// helper in the future.
function restartSelf() {
  try {
    if (IS_WINDOWS) {
      const child = spawn('schtasks', ['/Run', '/TN', 'NetControlAgent'], { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      spawnSync('systemctl', ['restart', 'netcontrol-agent'], { stdio: 'ignore' });
    }
  } catch (e) {
    console.warn('[Agent] Could not trigger a managed restart:', e.message, '— you may need to restart the agent manually to pick up the update.');
  }
  setTimeout(() => process.exit(0), 500); // give the spawn/systemctl call a moment to actually fire before we disappear
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

// ── Wake-on-LAN relay ──────────────────────────────────────────────────────────
// Broadcast frames never cross subnets, so a wake request from the central
// server only reaches devices on the server's own L2 segment. This agent
// runs ON the target's subnet, so it sends the magic packet locally instead
// — built with plain `dgram` (no extra npm dependency needed).
const dgram = require('dgram');

// Send one magic packet from a specific local IPv4 address. Binding to
// 0.0.0.0 and letting the OS pick the outbound interface is NOT safe on
// multi-homed Windows machines (Ethernet + Wi-Fi, VPN adapters, Docker
// Desktop's Hyper-V vEthernet, etc.) — the OS routing table can send the
// broadcast out an interface other than the one actually sitting on the
// target's LAN segment, and dgram.send()'s callback still reports success
// even though the packet never touches the intended wire. Binding
// explicitly to the local interface removes that ambiguity.
function sendFrom(localAddr, packet, broadcastAddr, port) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', (err) => { try { sock.close(); } catch {} reject(err); });
    sock.bind(0, localAddr, () => {
      sock.setBroadcast(true);
      sock.send(packet, 0, packet.length, port, broadcastAddr, (err) => {
        sock.close();
        if (err) reject(err); else resolve();
      });
    });
  });
}

function localIPv4Addresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

// Fires the magic packet from EVERY active local IPv4 interface rather than
// trusting OS routing to pick the right one for a link-local broadcast
// address. Broadcasts sent from an interface that isn't on the target's
// segment simply go nowhere useful — harmless — so this is safe to do
// unconditionally, and it guarantees the packet actually reaches the wire
// the target is on regardless of adapter count/order/VPN state.
async function sendMagicPacket(mac, broadcastAddr, port = 9) {
  const macBytes = mac.split(/[:-]/).map((h) => parseInt(h, 16));
  if (macBytes.length !== 6 || macBytes.some((b) => Number.isNaN(b))) {
    throw new Error(`Invalid MAC address: ${mac}`);
  }
  const packet = Buffer.alloc(102);
  packet.fill(0xff, 0, 6);
  for (let i = 6; i < 102; i += 6) Buffer.from(macBytes).copy(packet, i);

  const addrs = localIPv4Addresses();
  if (!addrs.length) throw new Error('No active IPv4 interface found on relay agent host');

  const results = await Promise.allSettled(
    addrs.map((a) => sendFrom(a, packet, broadcastAddr, port))
  );
  const anyOk = results.some((r) => r.status === 'fulfilled');
  if (!anyOk) {
    const firstErr = results.find((r) => r.status === 'rejected');
    throw new Error(firstErr?.reason?.message || 'Failed to send from any local interface');
  }
}

async function wolRelayLoop(getCredsFn) {
  while (running) {
    const creds = getCredsFn();
    const hdrs  = { 'x-api-key': creds.api_key };
    try {
      const res = await longPoll(`${SERVER_URL}/api/wol-relay/device/${creds.device_id}/pending`, hdrs);
      if (res.status === 403) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      const job = res.body?.job;
      if (job) {
        console.log(`\n[Agent] WoL relay: waking ${job.targetName || job.mac} on local subnet…`);
        let ok = true, error = null;
        try {
          await sendMagicPacket(job.mac, job.broadcastAddr || '255.255.255.255');
        } catch (e) {
          ok = false; error = e.message;
          console.warn(`[Agent] WoL relay failed: ${e.message}`);
        }
        await httpReq(
          `${SERVER_URL}/api/wol-relay/device/${creds.device_id}/result`,
          { method: 'POST', headers: hdrs },
          { targetDeviceId: job.targetDeviceId, targetName: job.targetName, ok, error }
        ).catch(() => {});
      }
    } catch { await new Promise((r) => setTimeout(r, 3000)); }
  }
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

  console.log(`[Agent] Running — metrics every ${INTERVAL_SEC}s + HTTP terminal relay + WoL relay`);

  const startRelay = () => {
    relayLoop(() => creds).catch(e => {
      console.error('[Agent] Relay crashed:', e.message);
      if (running) setTimeout(startRelay, 5000);
    });
  };
  startRelay();

  const startWolRelay = () => {
    wolRelayLoop(() => creds).catch(e => {
      console.error('[Agent] WoL relay crashed:', e.message);
      if (running) setTimeout(startWolRelay, 5000);
    });
  };
  startWolRelay();

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
        { ...metrics, agent_version: AGENT_VERSION }
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

      if (res.body?.update_available || res.body?.force_update) {
        checkForUpdate(creds, res.body.latest_version, res.body.force_update).catch(e =>
          console.warn('\n[Agent] Update check failed:', e.message));
      }
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

// SELF_TEST short-circuits here: runSelfTest() above already handles its
// own process.exit(), so the real agent loop must never start alongside it.
if (!SELF_TEST) {
  startWithRestart();
}