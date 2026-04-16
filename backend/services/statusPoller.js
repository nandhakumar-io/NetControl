// services/statusPoller.js
// Polls every device every 60 seconds using TCP port checks.
// Updates devices.status and devices.last_seen in MySQL.
// No external ping binary needed — pure Node.js TCP sockets.

const net = require('net');
const { query, execute } = require('../db');

const POLL_INTERVAL_MS  = 20 * 1000;  // how often to poll all devices
const TCP_TIMEOUT_MS    = 3000;        // per-device connection timeout
const CONCURRENCY       = 10;          // max simultaneous probes

// Ports probed per OS type (first one that connects = online)
const PROBE_PORTS = {
  linux:   [22, 80, 443],   // SSH first, then web
  windows: [5985, 3389, 80], // WinRM first, then RDP, then web
};

/**
 * Attempt a TCP connection to host:port within timeout ms.
 * Resolves true if connected, false otherwise.
 */
function tcpProbe(host, port, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error',   () => done(false));

    socket.connect(port, host);
  });
}

/**
 * Check if a device is online by trying its probe ports in order.
 * Returns true as soon as any port responds.
 */
async function isOnline(device) {
  const ports = PROBE_PORTS[device.os_type] || PROBE_PORTS.linux;
  for (const port of ports) {
    const up = await tcpProbe(device.ip_address, port);
    if (up) return true;
  }
  return false;
}

/**
 * Poll a single device and update its DB row.
 */
async function pollDevice(device) {
  const online = await isOnline(device);
  const now    = Math.floor(Date.now() / 1000);

  const newStatus = online ? 'online' : 'offline';

  // Only write if status changed or last_seen needs refresh (online devices)
  if (device.status !== newStatus || online) {
    await execute(
      `UPDATE devices
          SET status    = ?,
              last_seen = CASE WHEN ? = 'online' THEN ? ELSE last_seen END
        WHERE id = ?`,
      [newStatus, newStatus, now, device.id]
    );
  }

  return { id: device.id, name: device.name, status: newStatus };
}

/**
 * Run one full polling cycle across all devices with concurrency limit.
 */
async function pollAll() {
  let devices;
  try {
    devices = await query('SELECT id, name, ip_address, os_type, status FROM devices');
  } catch (e) {
    console.error('[StatusPoller] DB error fetching devices:', e.message);
    return;
  }

  if (!devices.length) return;

  // Process in chunks of CONCURRENCY
  const results = { online: 0, offline: 0, errors: 0 };

  for (let i = 0; i < devices.length; i += CONCURRENCY) {
    const chunk = devices.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map(pollDevice));

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results[s.value.status]++;
      } else {
        results.errors++;
        console.error('[StatusPoller] Poll error:', s.reason?.message);
      }
    }
  }

  console.log(
    `[StatusPoller] ${new Date().toISOString()} — ` +
    `${devices.length} devices | ` +
    `online: ${results.online} | offline: ${results.offline} | errors: ${results.errors}`
  );
}

let _timer = null;

/**
 * Start the poller. Call once from server.js on boot.
 */
function start() {
  if (_timer) return; // already running

  console.log(`[StatusPoller] Starting — polling every ${POLL_INTERVAL_MS / 1000}s`);

  // Run immediately on start, then on interval
  pollAll().catch(console.error);
  _timer = setInterval(() => pollAll().catch(console.error), POLL_INTERVAL_MS);

  // Allow Node process to exit even if timer is active
  if (_timer.unref) _timer.unref();
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { start, stop, pollAll, pollDevice };
