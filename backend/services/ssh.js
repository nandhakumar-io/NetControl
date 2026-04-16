// services/ssh.js — SSH command execution for Linux machines
const { Client } = require('ssh2');
const { decrypt } = require('./crypto'); // ✅ ADDED

const SSH_TIMEOUT = 10000; // 10 second connection timeout

/**
 * Execute a command on a remote Linux host via SSH.
 * Supports both password and private key auth.
 */
function sshExec(host, username, { password, privateKey }, command) {
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
      port: 22,
      username,
      readyTimeout: SSH_TIMEOUT,
      algorithms: {
        kex: [
          'ecdh-sha2-nistp256',
          'ecdh-sha2-nistp384',
          'ecdh-sha2-nistp521',
          'diffie-hellman-group-exchange-sha256',
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
 * Helper to build decrypted credentials
 */
function getCred(device) {
  return {
    password: device.ssh_password ? decrypt(device.ssh_password).trim() : null,
    privateKey: device.ssh_key ? decrypt(device.ssh_key) : null
  };
}

async function shutdown(device) {
  const cred = getCred(device);
  return sshExec(device.ip_address, device.ssh_username, cred, 'shutdown -h now');
}

async function restart(device) {
  const cred = getCred(device);
  return sshExec(device.ip_address, device.ssh_username, cred, 'shutdown -r now');
}

async function execCommand(device, command) {
  const cred = getCred(device);
  return sshExec(device.ip_address, device.ssh_username, cred, command);
}

async function checkOnline(device) {
  try {
    const cred = getCred(device);
    await sshExec(device.ip_address, device.ssh_username, cred, 'echo ok');
    return true;
  } catch {
    return false;
  }
}

module.exports = { shutdown, restart, execCommand, checkOnline };