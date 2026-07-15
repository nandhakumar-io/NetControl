const { execFile } = require('child_process');
const { decrypt } = require('./crypto');
const nodeWinrm = require('nodejs-winrm');

const RPC_TIMEOUT   = 15000; // 15s — local `net rpc` call over SMB/RPC (port 445/135)
const WINRM_TIMEOUT = 20000; // 20s — WinRM SOAP round-trips are slower, give it more room

// ── RPC (primary) ────────────────────────────────────────────────────────────
// Uses Samba's `net rpc` client tool. Requires samba-client/samba-common-tools
// installed and a (minimal) /etc/samba/smb.conf present in the container.
function netRpc(args) {
  return new Promise((resolve, reject) => {
    execFile('net', args, { timeout: RPC_TIMEOUT }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        return reject(new Error(`net rpc failed: ${msg}`));
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function rpcCredString(device) {
  const user = device.rpc_username || device.ssh_username;
  const pass = decrypt(device.rpc_password) || decrypt(device.ssh_password) || '';
  if (!user) throw new Error('No username configured for Windows device (RPC)');
  return `${user}%${pass}`;
}

// ── WinRM (fallback) ──────────────────────────────────────────────────────────
// Used when `net rpc` fails or is blocked (e.g. RPC/135/445 filtered by firewall
// but WinRM/5985 is open, or the device only has WinRM configured). Pure-JS
// SOAP client, no native/system dependency required.
function winrmCreds(device) {
  const user = device.winrm_username || device.rpc_username || device.ssh_username;
  const pass =
    decrypt(device.winrm_password) ||
    decrypt(device.rpc_password) ||
    decrypt(device.ssh_password) ||
    '';
  const port = device.winrm_port || 5985;
  if (!user) throw new Error('No username configured for Windows device (WinRM)');
  return { user, pass, port };
}

async function winrmExec(device, command) {
  const { user, pass, port } = winrmCreds(device);

  const timeoutGuard = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('WinRM request timed out')), WINRM_TIMEOUT)
  );

  const output = await Promise.race([
    nodeWinrm.runCommand(command, device.ip_address, user, pass, port),
    timeoutGuard,
  ]);

  // nodejs-winrm swallows internal errors (SOAP faults, connection errors) and
  // *returns* an Error instance instead of throwing — normalize that here so
  // callers/fallback logic can treat it like any other rejected promise.
  if (output instanceof Error) throw new Error(`WinRM failed: ${output.message}`);

  return { stdout: String(output || '').trim(), stderr: '' };
}

// ── RPC-first, WinRM-fallback wrapper ────────────────────────────────────────
async function withFallback(device, rpcAttempt, winrmCommand) {
  try {
    return await rpcAttempt();
  } catch (rpcErr) {
    try {
      const result = await winrmExec(device, winrmCommand);
      return { ...result, _via: 'winrm', _rpcError: rpcErr.message };
    } catch (winrmErr) {
      throw new Error(
        `RPC failed (${rpcErr.message}); WinRM fallback also failed (${winrmErr.message})`
      );
    }
  }
}

async function shutdown(device) {
  return withFallback(
    device,
    () => netRpc(['rpc', 'shutdown', '-I', device.ip_address, '-U', rpcCredString(device), '-f', '-t', '0']),
    'shutdown /s /t 0 /f'
  );
}

async function restart(device) {
  return withFallback(
    device,
    () => netRpc(['rpc', 'shutdown', '-I', device.ip_address, '-U', rpcCredString(device), '-f', '-t', '0', '-r']),
    'shutdown /r /t 0 /f'
  );
}

async function execCommand(device, command) {
  // BUG FIX: this used to go through withFallback() the same as
  // shutdown/restart — try `net rpc <command>` first, fall back to WinRM.
  // That's correct for shutdown/restart, which really are `net rpc`
  // subcommands (rpc "shutdown" is a real Samba RPC pipe operation) — but
  // it's wrong for execCommand, which runs an arbitrary shell/PowerShell
  // string. `net rpc` only understands a fixed set of RPC verbs (shutdown,
  // registry, rap, ...), not general command execution, so prefixing an
  // arbitrary command with "rpc" was guaranteed to fail every time. Worse,
  // that guaranteed failure still cost up to RPC_TIMEOUT (15s) before
  // falling back to WinRM (up to another WINRM_TIMEOUT, 20s) — up to 35s
  // total before the real error was even available. That's longer than
  // bulkCommand.js's own default 30s per-device timeout, so its outer race
  // almost always won first and reported its own generic "timed out after
  // 30s" instead of ever surfacing the actual RPC/WinRM failure reason.
  // Going straight to WinRM fixes both problems: no wasted attempt against
  // a command syntax that could never have worked, and the real error
  // (auth failure, WinRM not enabled, unreachable, etc.) now returns well
  // within any reasonable timeout instead of being masked by it.
  return winrmExec(device, command);
}

module.exports = { shutdown, restart, execCommand };