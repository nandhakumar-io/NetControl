// services/ssh.js — SSH command execution for Linux machines
const { Client } = require('ssh2');
const { decrypt } = require('./crypto'); // ✅ ADDED
const { tofuVerifier } = require('./sshHostKeys');

const SSH_TIMEOUT = 10000; // 10 second connection timeout

/**
 * Execute a command on a remote Linux host via SSH.
 * Supports both password and private key auth.
 */
function sshExec(device, host, port, username, { password, privateKey }, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const done = (err, result) => {
      if (settled) return;
      settled = true;
      conn.end();
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      done(new Error(`SSH connection to ${host} timed out`));
    }, SSH_TIMEOUT);

    conn.on('ready', () => {
      clearTimeout(timer);
      conn.exec(command, (err, stream) => {
        if (err) return done(new Error(`SSH exec failed: ${err.message}`));

        stream.on('data', (d) => { stdout += d.toString(); });
        stream.stderr.on('data', (d) => { stderr += d.toString(); });

        stream.on('close', (code) => {
          if (code !== 0) {
            done(new Error(`Command exited with code ${code}. stderr: ${stderr.trim()}`));
          } else {
            done(null, { stdout: stdout.trim(), stderr: stderr.trim() });
          }
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      done(new Error(`SSH error on ${host}: ${err.message}`));
    });

    const connectConfig = {
      host,
      // BUG FIX: this was hardcoded to 22, ignoring the device's configured
      // ssh_port column entirely. services/sshProxy.js and services/scpPush.js
      // both already read device.ssh_port — this file was the one place that
      // didn't, so any device with a non-default SSH port would fail every
      // shutdown/restart/exec action while the web terminal worked fine for
      // the same device. Falls back to 22 when unset, same as the others.
      port: Number(port) || 22,
      username,
      readyTimeout: SSH_TIMEOUT,
      // SECURITY FIX: was `hostVerifier: () => true`, accepting ANY host
      // key unconditionally — a silent man-in-the-middle opportunity with
      // no known_hosts equivalent to ever catch it. Pin-on-first-connect
      // instead (see services/sshHostKeys.js): trusts the key the first
      // time, then requires it to match on every connection after that.
      hostVerifier: tofuVerifier(device),
      algorithms: {
        kex: [
          'ecdh-sha2-nistp256',
          'ecdh-sha2-nistp384',
          'ecdh-sha2-nistp521',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group-exchange-sha256',
          'diffie-hellman-group14-sha1',   // older servers (e.g. Ubuntu 18/CentOS 7)
        ],
        serverHostKey: [
          'ssh-ed25519',
          'ecdsa-sha2-nistp256',
          'ecdsa-sha2-nistp384',
          'ecdsa-sha2-nistp521',
          'rsa-sha2-512',
          'rsa-sha2-256',
          'ssh-rsa',                       // legacy — still common on older distros
        ],
        cipher: [
          'aes128-gcm@openssh.com',
          'aes256-gcm@openssh.com',
          'aes128-ctr',
          'aes192-ctr',
          'aes256-ctr',
        ],
      },
    };

    if (privateKey) {
      connectConfig.privateKey = privateKey;
      if (password) connectConfig.passphrase = password;
    } else if (password) {
      connectConfig.password = password;
    } else {
      return done(new Error('No SSH credential provided'));
    }

    conn.connect(connectConfig);
  });
}

/**
 * Build credentials for sshExec.
 *
 * BUG FIX — double-decrypt: actions.js loadDevice() already decrypts
 * ssh_password → _ssh_password and ssh_key → _ssh_key before passing the
 * device object here. getCred() was then calling decrypt(device.ssh_password)
 * again on the already-encrypted raw field, producing garbage and causing
 * every SSH action (shutdown, restart, exec) to fail with an auth error.
 *
 * Fix: prefer the pre-decrypted underscore fields when present; only decrypt
 * raw fields as a fallback so getCred() works correctly whether called from
 * actions.js (pre-decrypted) or any future caller that passes a raw DB row.
 */
function getCred(device) {
  const password   = device._ssh_password  !== undefined ? (device._ssh_password  ? device._ssh_password.trim()  : device._ssh_password)
                   : (device.ssh_password  ? decrypt(device.ssh_password).trim()  : null);
  const privateKey = device._ssh_key       !== undefined ? device._ssh_key
                   : (device.ssh_key       ? decrypt(device.ssh_key)              : null);
  return { password, privateKey };
}

async function shutdown(device) {
  const cred = getCred(device);
  return sshExec(device, device.ip_address, device.ssh_port, device.ssh_username, cred, 'shutdown -h now');
}

async function restart(device) {
  const cred = getCred(device);
  return sshExec(device, device.ip_address, device.ssh_port, device.ssh_username, cred, 'shutdown -r now');
}

async function execCommand(device, command) {
  const cred = getCred(device);
  return sshExec(device, device.ip_address, device.ssh_port, device.ssh_username, cred, command);
}

async function checkOnline(device) {
  try {
    const cred = getCred(device);
    await sshExec(device, device.ip_address, device.ssh_port, device.ssh_username, cred, 'echo ok');
    return true;
  } catch {
    return false;
  }
}

module.exports = { shutdown, restart, execCommand, checkOnline };