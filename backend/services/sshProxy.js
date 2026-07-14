// services/sshProxy.js — WebSocket-to-SSH bridge
//
// STRUCTURAL FIX (this revision): the SSH shell used to live and die with
// the single WebSocket that opened it — services/webTerminal.js's own
// comment already names this class of bug ("session state lived in a
// plain in-memory Map, scoped to one cluster worker") and so does
// services/bulkCommand.js. This file had the same gap, just one layer
// further down: even on a SINGLE worker, `cleanup()` ran ssh2's
// conn.end()/stream.end() the instant the WebSocket closed — so navigating
// away from a device's terminal (React unmount -> ws.close()) killed the
// actual remote shell. Clicking back into that device didn't resume
// anything; it opened a brand new SSH session with a blank screen, which
// is exactly the "why did it forget my session" complaint this fixes.
//
// Fix: the SSH connection + shell stream now outlive any individual
// WebSocket. A session is keyed by (userId, deviceId) — not by
// WebSocket — and durable session metadata + a scrollback replay buffer
// live in Redis (shared across cluster workers), with live output/input
// relayed through services/bus.js's existing pub/sub. Whichever worker's
// WebSocket happens to trigger the initial 'connect' owns the actual
// ssh2.Client (a live TCP socket can't be handed to another process), but
// every other worker can attach a browser to that same session — replay
// its buffered scrollback, then relay live output/input over the bus —
// without ever knowing which process is the real owner. Falls back to a
// plain in-process Map when REDIS_URL isn't set, same single-process
// caveat this codebase already accepts everywhere else.
//
// Net effect: open device A's terminal, switch to device B, come back to
// A — same shell, same scrollback, no reconnect. A session is only ever
// actually torn down by explicit user action (the terminal's close
// button) or IDLE_TTL_SEC of nobody attached and nothing happening.

'use strict';

const { WebSocketServer } = require('ws');
const { Client }          = require('ssh2');
const jwt                 = require('jsonwebtoken');
const { queryOne }        = require('../db');
const { verifyDeviceOrgAccess } = require('../middleware/tenant');
const { decrypt }         = require('./crypto');
const { tofuVerifier }    = require('./sshHostKeys');
const bus                 = require('./bus');
require('dotenv').config();

const IDLE_TTL_SEC   = 10 * 60; // no attached client + no activity for this long -> reaped
const CLOSED_TTL_SEC = 30;      // grace period so a browser mid-reconnect still sees "closed" not 404
const BUFFER_MAX_CHUNKS = 500;  // capped scrollback replay log, mirrors bulkCommand.js's event log approach
const LOCK_TTL_MS    = 5000;    // ownership race guard while two workers' 'connect' race each other

const redis = bus.getClient(); // null in single-process fallback mode

// ── Local (per-worker) state ────────────────────────────────────────────────
// Only the worker that actually owns the ssh2.Client for a session has an
// entry here. Every worker (owner or not) that has at least one attached
// browser also tracks a bus-unsubscribe handle per (key, ws) so it can
// clean up on ws close.
const owned = new Map();          // key -> { conn, stream, device, sweepTimer }
const localSessions = new Map();  // key -> { device, cols, rows, buffer:[], lastActive, status } — Redis-less fallback only

function sessKey(userId, deviceId) { return `${userId}:${deviceId}`; }
function mKey(key) { return `sshterm:meta:${key}`; }
function bKey(key) { return `sshterm:buf:${key}`; }
function lKey(key) { return `sshterm:lock:${key}`; }
function outChan(key) { return `sshterm:output:${key}`; }
function inChan(key)  { return `sshterm:input:${key}`; }
function ctlChan(key) { return `sshterm:control:${key}`; }

// ── Durable session metadata ────────────────────────────────────────────────
async function getMeta(key) {
  if (redis) {
    const h = await redis.hgetall(mKey(key));
    if (!h || !h.status) return null;
    return { ...h, cols: Number(h.cols) || 80, rows: Number(h.rows) || 24, lastActive: Number(h.lastActive) };
  }
  const s = localSessions.get(key);
  if (!s) return null;
  return { deviceId: s.device.id, deviceName: s.device.name, cols: s.cols, rows: s.rows, status: s.status, lastActive: s.lastActive };
}

async function setMeta(key, fields) {
  if (redis) {
    await redis.hset(mKey(key), fields);
    await redis.expire(mKey(key), IDLE_TTL_SEC);
  } else {
    const s = localSessions.get(key);
    if (s) Object.assign(s, fields);
  }
}

async function touchMeta(key) {
  const now = Date.now();
  if (redis) {
    if (await redis.exists(mKey(key))) {
      await redis.hset(mKey(key), 'lastActive', now);
      await redis.expire(mKey(key), IDLE_TTL_SEC);
      await redis.expire(bKey(key), IDLE_TTL_SEC);
    }
  } else {
    const s = localSessions.get(key);
    if (s) s.lastActive = now;
  }
}

async function appendBuffer(key, chunk) {
  if (redis) {
    await redis.rpush(bKey(key), chunk);
    await redis.ltrim(bKey(key), -BUFFER_MAX_CHUNKS, -1);
    await redis.expire(bKey(key), IDLE_TTL_SEC);
  } else {
    const s = localSessions.get(key);
    if (s) {
      s.buffer.push(chunk);
      if (s.buffer.length > BUFFER_MAX_CHUNKS) s.buffer.splice(0, s.buffer.length - BUFFER_MAX_CHUNKS);
    }
  }
}

async function getBuffer(key) {
  if (redis) return (await redis.lrange(bKey(key), 0, -1)).join('');
  return (localSessions.get(key)?.buffer || []).join('');
}

async function clearSession(key) {
  if (redis) {
    await redis.hset(mKey(key), 'status', 'closed');
    await redis.expire(mKey(key), CLOSED_TTL_SEC);
    await redis.del(bKey(key));
  } else {
    localSessions.delete(key);
  }
}

// Cheap mutual-exclusion so two WebSockets connecting to the same
// (userId, deviceId) within the same instant — e.g. two browser tabs
// opened together, or the round-robin cluster scheduler handing near-
// simultaneous requests to different workers — don't both decide "no
// session exists yet" and each open a duplicate SSH connection. Loses the
// race gracefully: the loser just attaches as a relay client instead.
async function acquireOwnerLock(key) {
  if (!redis) return true; // single-process: local Map access is already synchronous/atomic enough
  const ok = await redis.set(lKey(key), '1', 'NX', 'PX', LOCK_TTL_MS);
  return ok === 'OK';
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function extractToken(req) {
  const url = new URL(req.url, 'http://localhost');
  const qs  = url.searchParams.get('token');
  if (qs) return qs;
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function deviceIdFromUrl(req) {
  const url   = new URL(req.url, 'http://localhost');
  const match = url.pathname.match(/^\/ws\/terminal\/([^/?]+)/);
  return match ? match[1] : null;
}

async function verifyUserAndAccess(token, deviceId, upgradeReq) {
  if (!token) throw new Error('No token');
  const payload = jwt.verify(token, process.env.JWT_SECRET);

  const user = await queryOne('SELECT id, role, enabled, active_org_id FROM users WHERE id = ?', [payload.id]);
  if (!user || !user.enabled) throw new Error('Account disabled');

  if (user.role !== 'admin') {
    const access = await queryOne(
      'SELECT 1 FROM devices d ' +
      'INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ? ' +
      'WHERE d.id = ?',
      [user.id, deviceId]
    );
    if (!access) throw new Error('Access denied to this device');
  }

  const device = await queryOne('SELECT id, org_id FROM devices WHERE id = ?', [deviceId]);
  if (!device) throw new Error('Device not found');
  await verifyDeviceOrgAccess(
    { headers: upgradeReq?.headers || {}, user: { id: user.id, activeOrgId: user.active_org_id } },
    device
  );

  return { id: user.id, role: user.role };
}

// ── Device + credentials ──────────────────────────────────────────────────────
async function loadDevice(id) {
  const d = await queryOne('SELECT * FROM devices WHERE id = ?', [id]);
  if (!d) return null;

  const sshPw   = d.ssh_password   ? decrypt(d.ssh_password)   : null;
  const sshKey  = d.ssh_key        ? decrypt(d.ssh_key)        : null;
  const winrmPw = d.winrm_password ? decrypt(d.winrm_password) : null;

  return {
    ...d,
    _username: d.ssh_username || d.winrm_username || null,
    _password: sshPw || winrmPw || null,
    _key:      sshKey || null,
  };
}

// ── SSH session (owner side only) ───────────────────────────────────────────
function sshConnect(device, cols, rows) {
  return new Promise((resolve, reject) => {
    const { _username, _password, _key } = device;

    if (!_username) {
      return reject(new Error(
        device.os_type === 'windows'
          ? 'No credentials set — add SSH or WinRM username/password in device settings'
          : 'No SSH username configured for this device'
      ));
    }
    if (!_password && !_key) {
      return reject(new Error('No SSH credentials configured (need password or private key)'));
    }

    const conn   = new Client();
    const config = {
      host:               device.ip_address,
      port:               Number(device.ssh_port) || 22,
      username:           _username,
      readyTimeout:       15000,
      keepaliveInterval:  10000,
      keepaliveCountMax:  3,
      hostVerifier: tofuVerifier(device),
      algorithms: {
        kex: [
          'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
          'diffie-hellman-group14-sha256', 'diffie-hellman-group-exchange-sha256',
          'diffie-hellman-group14-sha1',
        ],
        serverHostKey: [
          'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
          'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa',
        ],
        cipher: [
          'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com',
          'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
        ],
      },
    };

    if (_key) {
      config.privateKey = _key;
      if (_password) config.passphrase = _password;
    } else {
      config.password = _password;
    }

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        resolve({ conn, stream });
      });
    });

    conn.on('error', (err) => reject(err));
    conn.connect(config);
  });
}

// Becomes the owner of `key`: opens the real ssh2 connection, wires its
// output into the durable buffer + bus.publish(outChan) so every attached
// worker (including this one) receives it identically, and subscribes to
// the input/control channels so ANY attached browser — on any worker — can
// drive this one real shell.
async function becomeOwner(key, device, cols, rows) {
  await setMeta(key, {
    deviceId: device.id, deviceName: device.name, cols, rows,
    status: 'connecting', lastActive: Date.now(),
  });
  if (!redis) localSessions.set(key, { device, cols, rows, buffer: [], lastActive: Date.now(), status: 'connecting' });

  bus.publish(outChan(key), { type: 'status', data: `Connecting to ${device.ip_address}…` });

  let conn, stream;
  try {
    ({ conn, stream } = await sshConnect(device, cols, rows));
  } catch (e) {
    await setMeta(key, { status: 'closed' });
    bus.publish(outChan(key), { type: 'error', data: `Failed to connect: ${e.message}` });
    require('./webhook').fire('ssh.failure', {
      device_id: device.id, device_name: device.name, error: e.message,
      severity: 'critical', message: `SSH terminal connection failed for ${device.name}: ${e.message}`,
    }).catch(() => {});
    throw e;
  }

  await setMeta(key, { status: 'connected', lastActive: Date.now() });
  const readyMsg = `Connected to ${device.name} (${device.ip_address}) as ${device._username}`;
  await appendBuffer(key, ''); // no-op keeps buffer key alive with a TTL even before first output chunk
  bus.publish(outChan(key), { type: 'status', data: readyMsg });

  const onData = async (chunk) => {
    const str = chunk.toString('binary');
    await appendBuffer(key, str);
    await touchMeta(key);
    bus.publish(outChan(key), { type: 'data', data: str });
  };
  stream.on('data', onData);
  stream.stderr.on('data', onData);

  const endSession = async (reason) => {
    bus.publish(outChan(key), { type: 'closed', data: reason });
    await clearSession(key);
    unsubInput();
    unsubControl();
    if (owned.get(key)?.sweepTimer) clearInterval(owned.get(key).sweepTimer);
    owned.delete(key);
    try { stream.end(); } catch {}
    try { conn.end(); } catch {}
  };

  stream.on('close', () => endSession('\r\n[Session ended]\r\n'));
  conn.on('error', (e) => endSession(`\r\n[SSH error: ${e.message}]\r\n`));
  conn.on('end',   () => endSession('\r\n[Session ended]\r\n'));

  const unsubInput = bus.subscribe(inChan(key), ({ data }) => {
    if (data != null) { try { stream.write(data); } catch {} }
  });
  const unsubControl = bus.subscribe(ctlChan(key), async (msg) => {
    if (msg.type === 'resize') {
      const rows = Math.max(1, Number(msg.rows) || 24);
      const cols = Math.max(1, Number(msg.cols) || 80);
      try { stream.setWindow(rows, cols, 0, 0); } catch {}
      await setMeta(key, { cols, rows });
    } else if (msg.type === 'activity') {
      await touchMeta(key);
    } else if (msg.type === 'terminate') {
      await endSession('\r\n[Session closed]\r\n');
    }
  });

  // Idle reaper — only the owner can actually tear down the ssh2 objects,
  // so only the owner sweeps. touchMeta() (driven by output, input, resize,
  // or an attached client's periodic 'activity' ping) keeps lastActive
  // fresh while the session is genuinely in use; this just catches the
  // fully-abandoned case.
  const sweepTimer = setInterval(async () => {
    const meta = await getMeta(key);
    if (!meta || meta.status === 'closed') { clearInterval(sweepTimer); return; }
    if (Date.now() - meta.lastActive > IDLE_TTL_SEC * 1000) {
      await endSession('\r\n[Session expired — idle too long]\r\n');
    }
  }, 60000);

  owned.set(key, { conn, stream, device, sweepTimer });
}

// ── Attach proxy ──────────────────────────────────────────────────────────────
function attachSSHProxy(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient({ req }, done) {
      if (!deviceIdFromUrl(req)) return done(false, 400, 'Bad path');
      const token    = extractToken(req);
      const deviceId = deviceIdFromUrl(req);
      verifyUserAndAccess(token, deviceId, req)
        .then((user) => { req.ncUser = user; done(true); })
        .catch((err) => {
          console.error('[SSHProxy] Auth rejected:', err.message);
          done(false, 401, 'Unauthorized');
        });
    },
  });

  wss.on('connection', async (ws, req) => {
    const deviceId = deviceIdFromUrl(req);
    const userId   = req.ncUser?.id;
    if (!deviceId || !userId) { ws.close(1008, 'Missing device/user'); return; }

    const key = sessKey(userId, deviceId);
    let subscribed = false;
    let unsubOutput = null;
    let activityTimer = null;

    const send = (type, data) => {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify({ type, data })); } catch {}
      }
    };

    const attach = () => {
      if (subscribed) return;
      subscribed = true;
      unsubOutput = bus.subscribe(outChan(key), (payload) => {
        if (ws.readyState === ws.OPEN) {
          try { ws.send(JSON.stringify(payload)); } catch {}
        }
      });
      // Lets the owner's idle reaper know a live browser is genuinely
      // watching this session, even during long stretches with no shell
      // output/input (e.g. sitting at a prompt) — mirrors the ping
      // keepalive pattern used by the metrics/bulk-command SSE streams,
      // just travelling over an already-open WebSocket instead of SSE.
      activityTimer = setInterval(() => bus.publish(ctlChan(key), { type: 'activity' }), 60000);
    };

    const detach = () => {
      if (unsubOutput) bus.unsubscribe(outChan(key), unsubOutput);
      if (activityTimer) clearInterval(activityTimer);
      subscribed = false;
    };

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'connect') {
        const cols = Number(msg.cols) || 80;
        const rows = Number(msg.rows) || 24;

        const device = await loadDevice(deviceId).catch(() => null);
        if (!device) { send('error', 'Device not found'); ws.close(1008); return; }
        if (device.os_type === 'windows') {
          send('data', '\x1b[33m[Windows device — requires OpenSSH Server to be installed and running]\x1b[0m\r\n');
        }

        const existing = await getMeta(key).catch(() => null);
        const alive = existing && (existing.status === 'connected' || existing.status === 'connecting');

        attach();

        if (alive) {
          // Reattach: replay scrollback, then let the live subscription
          // (already set up by attach()) carry everything from here.
          const backlog = await getBuffer(key).catch(() => '');
          if (backlog) send('data', backlog);
          send('status', `Connected to ${device.name} (${device.ip_address}) — reattached to existing session`);
          bus.publish(ctlChan(key), { type: 'resize', cols, rows }); // sync terminal size to this (possibly different) browser window
          return;
        }

        const gotLock = await acquireOwnerLock(key).catch(() => true);
        if (!gotLock) {
          // Lost the race to another worker handling a near-simultaneous
          // connect for the same session — brief pause then attach as a
          // relay client instead of also opening a duplicate SSH connection.
          await new Promise(r => setTimeout(r, 250));
          const backlog = await getBuffer(key).catch(() => '');
          if (backlog) send('data', backlog);
          return;
        }

        try {
          await becomeOwner(key, device, cols, rows);
        } catch {
          // becomeOwner already published the error over outChan, which
          // this ws is subscribed to via attach() — nothing further to do.
        }

      } else if (msg.type === 'data') {
        if (msg.data != null) bus.publish(inChan(key), { data: msg.data });

      } else if (msg.type === 'resize') {
        bus.publish(ctlChan(key), { type: 'resize', cols: msg.cols, rows: msg.rows });

      } else if (msg.type === 'terminate') {
        // Explicit "end this session" — distinct from just closing the tab/
        // navigating away, which only detaches (see ws.on('close') below).
        bus.publish(ctlChan(key), { type: 'terminate' });
      }
    });

    ws.on('close', () => {
      // Navigating away / closing the tab detaches this browser only — the
      // shell itself (owned by whichever worker created it) keeps running
      // so switching back to this device reattaches instead of starting
      // over. It's reaped by IDLE_TTL_SEC of no attached client + no
      // activity, or by an explicit 'terminate' message.
      detach();
    });

    ws.on('error', (e) => {
      console.error('[SSHProxy] WS error:', e.message);
      detach();
    });
  });

  wss.on('error', (e) => console.error('[SSHProxy] WSS error:', e.message));

  console.log('✅ SSH WebSocket proxy attached at /ws/terminal/:deviceId (persistent, reattachable sessions)');
}

module.exports = { attachSSHProxy };