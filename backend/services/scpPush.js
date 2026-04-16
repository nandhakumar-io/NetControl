// services/scpPush.js — SCP file push to one device via ssh2
const { Client } = require('ssh2');

const SCP_TIMEOUT = 20000;

/**
 * Push a single file buffer to a remote path via SCP.
 *
 * @param {object} device   - must have: ip_address, ssh_port, ssh_username,
 *                            _ssh_password, _ssh_key  (already decrypted)
 *                            OR winrm_username / _winrm_password as fallback
 * @param {Buffer} fileBuffer
 * @param {string} remotePath   e.g. '/tmp/deploy.sh'
 * @param {number} [mode=0o644] unix permissions
 * @returns {Promise<{ device: string, result: 'success'|'failure', details: string }>}
 */
function scpPushOne(device, fileBuffer, remotePath, mode = 0o644) {
  return new Promise((resolve) => {
    const name    = device.name || device.ip_address;
    const username = device.ssh_username || device.winrm_username;
    const password = device._ssh_password || device._winrm_password;
    const privateKey = device._ssh_key || null;

    if (!username) {
      return resolve({ device: name, result: 'failure', details: 'No SSH username configured' });
    }
    if (!password && !privateKey) {
      return resolve({ device: name, result: 'failure', details: 'No SSH credentials configured' });
    }

    const conn = new Client();
    let settled = false;

    const done = (result, details) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      resolve({ device: name, result, details });
    };

    const timer = setTimeout(() => {
      done('failure', `Connection to ${device.ip_address} timed out`);
    }, SCP_TIMEOUT);

    conn.on('ready', () => {
      clearTimeout(timer);

      // Use sftp subsystem (widely supported, no need for scp binary on remote)
      conn.sftp((err, sftp) => {
        if (err) return done('failure', `SFTP init failed: ${err.message}`);

        const writeStream = sftp.createWriteStream(remotePath, { mode });

        writeStream.on('error', (e) => {
          done('failure', `Write failed: ${e.message}`);
        });

        writeStream.on('close', () => {
          done('success', `Pushed to ${remotePath} (${fileBuffer.length} bytes)`);
        });

        writeStream.end(fileBuffer);
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      done('failure', `SSH error: ${err.message}`);
    });

    const cfg = {
      host:         device.ip_address,
      port:         device.ssh_port || 22,
      username,
      readyTimeout: SCP_TIMEOUT,
    };

    if (privateKey) {
      cfg.privateKey = privateKey;
      if (password) cfg.passphrase = password;
    } else {
      cfg.password = password;
    }

    conn.connect(cfg);
  });
}

/**
 * Push a file to many devices concurrently (capped at 10 parallel).
 * Returns array of per-device results.
 */
async function scpPushMany(devices, fileBuffer, remotePath, mode = 0o644) {
  const CONCURRENCY = 10;
  const results = [];
  for (let i = 0; i < devices.length; i += CONCURRENCY) {
    const batch = devices.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(d => scpPushOne(d, fileBuffer, remotePath, mode))
    );
    results.push(...batchResults);
  }
  return results;
}

module.exports = { scpPushOne, scpPushMany };
