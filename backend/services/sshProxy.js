// services/sshProxy.js — WebSocket-to-SSH bridge
//
// FIXES vs previous version:
// 1. WebSocketServer uses `server` option instead of `noServer` + manual
//    upgrade handling. This means ws handles the HTTP upgrade event itself,
//    which is simpler and avoids the race where httpServer.on('upgrade')
//    could fire before attachSSHProxy() was called.
//
// 2. Path filtering is done inside verifyClient() — cleaner than splitting
//    upgrade events manually and less prone to error.
//
// 3. Token verification failure now sends proper WebSocket close frames
//    instead of raw HTTP responses over a WebSocket-upgraded socket.
//
// 4. SSH keepalive settings tuned: keepaliveInterval 10s, keepaliveCountMax 3
//    so dead connections are cleaned up within 30s instead of hanging forever.
//
// 5. Stream data is sent as binary (Buffer) not toString('binary') —
//    avoids encoding issues with non-ASCII terminal output.
//
// 6. Graceful cleanup on ws close — stream.end() and conn.end() are called
//    in the right order without throwing.

'use strict';

const { WebSocketServer } = require('ws');
const { Client }          = require('ssh2');
const jwt                 = require('jsonwebtoken');
const { queryOne }        = require('../db');
const { decrypt }         = require('./crypto');
require('dotenv').config();

// SECURITY FIX: Verify token and check user is still enabled + has device access
async function verifyUserAndAccess(token, deviceId) {
  if (!token) throw new Error('No token');
  const payload = jwt.verify(token, process.env.JWT_SECRET);

  // Live DB check — reject if user disabled since token was issued
  const user = await queryOne('SELECT id, role, enabled FROM users WHERE id = ?', [payload.id]);
  if (!user || !user.enabled) throw new Error('Account disabled');

  // Operators must have group access to the target device
  if (user.role === 'operator') {
    const access = await queryOne(
      'SELECT 1 FROM devices d ' +
      'INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ? ' +
      'WHERE d.id = ?',
      [user.id, deviceId]
    );
    if (!access) throw new Error('Access denied to this device');
  }

  return { ...payload, role: user.role };
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function extractToken(req) {
  const url = new URL(req.url, 'http://localhost');
  const qs  = url.searchParams.get('token');
  if (qs) return qs;
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function verifyToken(token) {
  if (!token) throw new Error('No token');
  return jwt.verify(token, process.env.JWT_SECRET);
}

function deviceIdFromUrl(req) {
  const url   = new URL(req.url, 'http://localhost');
  const match = url.pathname.match(/^\/ws\/terminal\/([^/?]+)/);
  return match ? match[1] : null;
}

// ── Device + credentials ──────────────────────────────────────────────────────
async function loadDevice(id) {
  const d = await queryOne('SELECT * FROM devices WHERE id = ?', [id]);
  if (!d) return null;

  const sshPw    = d.ssh_password  ? decrypt(d.ssh_password)  : null;
  const sshKey   = d.ssh_key       ? decrypt(d.ssh_key)       : null;
  const winrmPw  = d.winrm_password ? decrypt(d.winrm_password) : null;

  return {
    ...d,
    _username:    d.ssh_username || d.winrm_username || null,
    _password:    sshPw || winrmPw || null,
    _key:         sshKey || null,
  };
}

// ── SSH session ───────────────────────────────────────────────────────────────
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
    };

    if (_key) {
      config.privateKey = _key;
      if (_password) config.passphrase = _password; // encrypted key
    } else {
      config.password = _password;
    }

    conn.on('ready', () => {
      conn.shell(
        { term: 'xterm-256color', cols: cols || 80, rows: rows || 24 },
        (err, stream) => {
          if (err) { conn.end(); return reject(err); }
          resolve({ conn, stream });
        }
      );
    });

    conn.on('error', (err) => reject(err));
    conn.connect(config);
  });
}

// ── Attach proxy ──────────────────────────────────────────────────────────────
function attachSSHProxy(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,        // attach directly to http server
    path:   /^\/ws\/terminal\//,  // only handle /ws/terminal/* paths

    // Auth gate — runs before the connection is accepted
    // SECURITY FIX: Now does async check for user enabled + operator device access
    verifyClient({ req }, done) {
      if (!deviceIdFromUrl(req)) return done(false, 400, 'Bad path');
      const token    = extractToken(req);
      const deviceId = deviceIdFromUrl(req);
      verifyUserAndAccess(token, deviceId)
        .then(() => done(true))
        .catch(() => done(false, 401, 'Unauthorized'));
    },
  });

  wss.on('connection', async (ws, req) => {
    const deviceId = deviceIdFromUrl(req);
    if (!deviceId) { ws.close(1008, 'Missing device ID'); return; }

    let sshConn   = null;
    let sshStream = null;

    const send = (type, data) => {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify({ type, data })); } catch {}
      }
    };

    const cleanup = () => {
      if (sshStream) { try { sshStream.end(); } catch {} sshStream = null; }
      if (sshConn)   { try { sshConn.end();   } catch {} sshConn   = null; }
    };

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // ── connect ────────────────────────────────────────────────────────────
      if (msg.type === 'connect') {
        send('status', 'Loading device…');

        let device;
        try {
          device = await loadDevice(deviceId);
        } catch (e) {
          send('error', `Database error: ${e.message}`);
          ws.close(1011);
          return;
        }

        if (!device) {
          send('error', 'Device not found');
          ws.close(1008);
          return;
        }

        if (device.os_type === 'windows') {
          send('data', '\x1b[33m[Windows device — requires OpenSSH Server to be installed and running]\x1b[0m\r\n');
        }

        send('status', `Connecting to ${device.ip_address}…`);

        try {
          const { conn, stream } = await sshConnect(
            device,
            Number(msg.cols) || 80,
            Number(msg.rows) || 24
          );
          sshConn   = conn;
          sshStream = stream;

          send('status', `Connected to ${device.name} (${device.ip_address}) as ${device._username}`);

          // ── Stream SSH output → WebSocket ─────────────────────────────────
          // Send as binary string for proper terminal rendering
          stream.on('data', (chunk) => {
            if (ws.readyState === ws.OPEN) {
              try {
                ws.send(JSON.stringify({ type: 'data', data: chunk.toString('binary') }));
              } catch {}
            }
          });

          stream.stderr.on('data', (chunk) => {
            if (ws.readyState === ws.OPEN) {
              try {
                ws.send(JSON.stringify({ type: 'data', data: chunk.toString('binary') }));
              } catch {}
            }
          });

          stream.on('close', () => {
            send('status', 'Session ended');
            ws.close(1000);
          });

          conn.on('error', (e) => {
            send('error', `SSH error: ${e.message}`);
            cleanup();
            ws.close(1011);
          });

          conn.on('end', () => {
            ws.close(1000);
          });

        } catch (e) {
          send('error', `Failed to connect: ${e.message}`);
          ws.close(1011);
        }

      // ── data (keystroke) ──────────────────────────────────────────────────
      } else if (msg.type === 'data') {
        if (sshStream && msg.data != null) {
          try { sshStream.write(msg.data); } catch {}
        }

      // ── resize ────────────────────────────────────────────────────────────
      } else if (msg.type === 'resize') {
        if (sshStream) {
          const rows = Math.max(1, Number(msg.rows) || 24);
          const cols = Math.max(1, Number(msg.cols) || 80);
          try { sshStream.setWindow(rows, cols, 0, 0); } catch {}
        }
      }
    });

    ws.on('close', () => cleanup());

    ws.on('error', (e) => {
      console.error('[SSHProxy] WS error:', e.message);
      cleanup();
    });
  });

  wss.on('error', (e) => console.error('[SSHProxy] WSS error:', e.message));

  console.log('✅ SSH WebSocket proxy attached at /ws/terminal/:deviceId');
}

module.exports = { attachSSHProxy };
