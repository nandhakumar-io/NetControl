const { execFile } = require('child_process');
const { decrypt } = require('./crypto');   // 👈 ADD THIS

const EXEC_TIMEOUT = 15000; // 15 seconds

function netRpc(args) {
  return new Promise((resolve, reject) => {
    execFile('net', args, { timeout: EXEC_TIMEOUT }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        return reject(new Error(`net rpc failed: ${msg}`));
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/**
 * FIXED credential builder
 */
function credString(device) {
  const user = device.rpc_username || device.ssh_username;

  // 👇 FIX: decrypt password before use
  const pass =
    decrypt(device.rpc_password) ||
    decrypt(device.ssh_password) ||
    '';

  if (!user) throw new Error('No username configured for Windows device');

  return `${user}%${pass}`;
}

async function shutdown(device) {
  const cred = credString(device);
  return netRpc([
    'rpc', 'shutdown',
    '-I', device.ip_address,
    '-U', cred,
    '-f',
    '-t', '0',
  ]);
}

async function restart(device) {
  const cred = credString(device);
  return netRpc([
    'rpc', 'shutdown',
    '-I', device.ip_address,
    '-U', cred,
    '-f',
    '-t', '0',
    '-r',
  ]);
}

async function execCommand(device, command) {
  const parts = command.trim().split(/\s+/);
  const cred  = credString(device);

  const args = parts[0] === 'rpc'
    ? [...parts, '-I', device.ip_address, '-U', cred]
    : ['rpc', ...parts, '-I', device.ip_address, '-U', cred];

  return netRpc(args);
}

module.exports = { shutdown, restart, execCommand };