// services/sshProxy.js — WebSocket-to-SSH bridge
// Works for both Linux AND Windows (Windows needs OpenSSH server installed).
// For Windows devices: uses winrm_username/winrm_password as SSH credentials
// if no dedicated ssh_username/ssh_password are set.

const { WebSocketServer } = require('ws');
const { Client }          = require('ssh2');
const jwt                 = require('jsonwebtoken');
const { queryOne }        = require('../db');
const { decrypt }         = require('./crypto');
require('dotenv').config();

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractToken(req) {
  const url = new URL(req.url, 'http://localhost');
  const qs  = url.searchParams.get('token');
  if (qs) return qs;
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

function deviceIdFromUrl(req) {
  const url   = new URL(req.url, 'http://localhost');
  const match = url.pathname.match(/^\/ws\/terminal\/([^/?]+)/);
  return match ? match[1] : null;
}

async function loadDevice(id) {
  const d = await queryOne('SELECT * FROM devices WHERE id = ?', [id]);
  if (!d) return null;

  const sshPw   = decrypt(d.ssh_password);
  const sshKey  = decrypt(d.ssh_key);
  const winrmPw = decrypt(d.winrm_password);

  // Windows fallback: use winrm credentials when no dedicated SSH creds exist
  const effectiveUsername = d.ssh_username    || d.winrm_username || null;
  const effectivePassword = sshPw             || winrmPw          || null;

  return {
    ...d,
    _effective_username: effectiveUsername,
    _ssh_password:       effectivePassword,
    _ssh_key:            sshKey,
  };
}

function sshConnect(device, cols, rows) {
  return new Promise((resolve, reject) => {
    const username = device._effective_username;
    if (!username) {
      return reject(new Error(
        device.os_type === 'windows'
          ? 'No credentials configured — set SSH username/password or WinRM username/password'
          : 'No SSH username configured for this device'
      ));
    }
    if (!device._ssh_password && !device._ssh_key) {
      return reject(new Error(
        device.os_type === 'windows'
          ? 'No SSH/WinRM password configured for this device'
          : 'No SSH credentials (password or key) configured for this device'
      ));
    }

    const conn   = new Client();
    const config = {
      host:              device.ip_address,
      port:              device.ssh_port || 22,
      username,
      readyTimeout:      12000,
      keepaliveInterval: 10000,
    };

    if (device._ssh_key) {
      config.privateKey = device._ssh_key;
      if (device._ssh_password) config.passphrase = device._ssh_password;
    } else {
      config.password = device._ssh_password;
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

    conn.on('error', reject);
    conn.connect(config);
  });
}

// ── Attach to http.Server ─────────────────────────────────────────────────────

function attachSSHProxy(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url   = new URL(req.url, 'http://localhost');
    const match = url.pathname.match(/^\/ws\/terminal\//);
    if (!match) return;

    const token = extractToken(req);
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    try {
      verifyToken(token);
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', async (ws, req) => {
    const deviceId = deviceIdFromUrl(req);
    if (!deviceId) {
      ws.send(JSON.stringify({ type: 'error', data: 'Missing device ID in URL' }));
      ws.close(1008);
      return;
    }

    let sshConn   = null;
    let sshStream = null;

    const send = (type, data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, data }));
    };

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'connect') {
        const cols = msg.cols || 80;
        const rows = msg.rows || 24;

        send('status', 'Connecting…');

        let device;
        try {
          device = await loadDevice(deviceId);
        } catch (e) {
          send('error', `DB error: ${e.message}`);
          ws.close(1011);
          return;
        }

        if (!device) {
          send('error', 'Device not found');
          ws.close(1008);
          return;
        }

        // Windows note shown in terminal
        if (device.os_type === 'windows') {
          send('data', '\x1b[90m[Windows device — requires OpenSSH Server to be installed and running]\x1b[0m\r\n');
        }

        try {
          const { conn, stream } = await sshConnect(device, cols, rows);
          sshConn   = conn;
          sshStream = stream;

          send('status', `Connected to ${device.name} (${device.ip_address}) as ${device._effective_username}`);

          stream.on('data',        (d) => send('data', d.toString('binary')));
          stream.stderr.on('data', (d) => send('data', d.toString('binary')));

          stream.on('close', () => {
            send('status', 'Connection closed');
            ws.close(1000);
          });

          conn.on('error', (e) => {
            send('error', `SSH error: ${e.message}`);
            ws.close(1011);
          });

        } catch (e) {
          send('error', `Failed to connect: ${e.message}`);
          ws.close(1011);
        }

      } else if (msg.type === 'data') {
        if (sshStream) sshStream.write(msg.data);

      } else if (msg.type === 'resize') {
        if (sshStream) sshStream.setWindow(msg.rows || 24, msg.cols || 80, 0, 0);
      }
    });

    ws.on('close', () => {
      if (sshStream) { try { sshStream.end(); } catch (_) {} }
      if (sshConn)   { try { sshConn.end();   } catch (_) {} }
    });

    ws.on('error', (e) => {
      console.error('[SSHProxy] WS error:', e.message);
      if (sshConn) { try { sshConn.end(); } catch (_) {} }
    });
  });

  console.log('✅ SSH WebSocket proxy attached at /ws/terminal/:deviceId');
}

module.exports = { attachSSHProxy };
