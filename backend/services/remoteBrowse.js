// services/remoteBrowse.js — Remote-device disk enumeration, directory browsing,
// and streaming archive creation for the Backups feature.
//
// This lets a backup source be "device X, disk /dev/sda1 mounted at /home,
// folder /home/labs/reports" instead of only the NetControl server's own
// sanctioned BACKUP_ROOT (see services/backupService.js, which still handles
// the local case). Everything here talks to the *target* device over SSH —
// the same connection style already used by services/ssh.js and
// services/scpPush.js, just without going through their exec-and-buffer or
// buffer-and-write helpers, since browsing needs an interactive SFTP session
// and archiving needs a long-lived stream rather than a fixed buffer.
//
// Security: every path is resolved against the disk's own mount point the
// same way services/backupService.js resolves paths against BACKUP_ROOT —
// normalize, reject '..' segments, and require the resolved path to still
// start with the mount point. A device can only ever be asked to archive
// something under a mount point it itself reported via listDisks().

'use strict';
const { Client } = require('ssh2');
const path = require('path');
const { decrypt } = require('./crypto');

const CONNECT_TIMEOUT = 10000;

// Same algorithm set as services/ssh.js / services/scpPush.js — kept in sync
// so any device reachable by the rest of the app is reachable here too.
const ALGORITHMS = {
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
};

class RemoteBrowseError extends Error {}

function credsFor(device) {
  const password = device._ssh_password !== undefined ? device._ssh_password : decrypt(device.ssh_password);
  const privateKey = device._ssh_key !== undefined ? device._ssh_key : decrypt(device.ssh_key);
  const username = device.ssh_username;
  if (!username) throw new RemoteBrowseError(`${device.name || device.ip_address} has no SSH username configured`);
  if (!password && !privateKey) throw new RemoteBrowseError(`${device.name || device.ip_address} has no SSH credentials configured`);
  return { username, password, privateKey };
}

// ── Connection ─────────────────────────────────────────────────────────────────
function connect(device) {
  const { username, password, privateKey } = credsFor(device);
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const done = (err, result) => {
      if (settled) return;
      settled = true;
      if (err) { try { conn.end(); } catch {} reject(err); }
      else resolve(result);
    };
    const timer = setTimeout(() => done(new Error(`SSH connection to ${device.ip_address} timed out`)), CONNECT_TIMEOUT);

    conn.on('ready', () => { clearTimeout(timer); done(null, conn); });
    conn.on('error', (err) => { clearTimeout(timer); done(new Error(`SSH error on ${device.ip_address}: ${err.message}`)); });

    const cfg = {
      host: device.ip_address,
      port: Number(device.ssh_port) || 22,
      username,
      readyTimeout: CONNECT_TIMEOUT,
      hostVerifier: () => true, // see services/ssh.js — no known_hosts store in this server process
      algorithms: ALGORITHMS,
    };
    if (privateKey) { cfg.privateKey = privateKey; if (password) cfg.passphrase = password; }
    else cfg.password = password;

    conn.connect(cfg);
  });
}

function execOn(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('data', d => { stdout += d.toString(); });
      stream.stderr.on('data', d => { stderr += d.toString(); });
      stream.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr.trim() || `command exited ${code}`));
        else resolve(stdout);
      });
    });
  });
}

function sftpOn(conn) {
  return new Promise((resolve, reject) => conn.sftp((err, sftp) => err ? reject(err) : resolve(sftp)));
}

// ── Disk enumeration ───────────────────────────────────────────────────────────
// `df -PB1` gives POSIX-format, byte-exact sizes on one line per mount —
// stable to parse without locale/column-width surprises.
const SKIP_FS_TYPES = new Set(['tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'proc', 'sysfs', 'cgroup', 'cgroup2']);

async function listDisks(device) {
  const conn = await connect(device);
  try {
    const out = await execOn(conn, 'df -PB1 2>/dev/null');
    const lines = out.trim().split('\n').slice(1); // drop header row
    const disks = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const [filesystem, sizeStr, usedStr, availStr, pctStr, ...mountParts] = parts;
      const mount = mountParts.join(' ');
      if (filesystem.startsWith('tmpfs') || filesystem === 'overlay' || filesystem === 'none') continue;
      if (mount.startsWith('/snap') || mount.startsWith('/boot/efi')) continue;
      disks.push({
        filesystem,
        mount,
        sizeBytes: parseInt(sizeStr, 10) || 0,
        usedBytes: parseInt(usedStr, 10) || 0,
        availBytes: parseInt(availStr, 10) || 0,
        usedPct: parseInt(pctStr, 10) || 0,
      });
    }
    return disks;
  } finally {
    conn.end();
  }
}

// ── Path safety — same normalize/'..'-reject/prefix-check pattern used
// throughout this app (filePush.js, backupService.js) applied to a mount root ──
function resolveSafe(mount, relPath) {
  const cleanMount = path.posix.normalize(mount || '/');
  const clean = path.posix.normalize('/' + String(relPath || '').replace(/\\/g, '/')).replace(/^\/+/, '');
  if (clean.split('/').includes('..')) throw new RemoteBrowseError('Path traversal not allowed');
  const abs = clean ? path.posix.join(cleanMount, clean) : cleanMount;
  if (abs !== cleanMount && !abs.startsWith(cleanMount.replace(/\/$/, '') + '/')) {
    throw new RemoteBrowseError('Path escapes the selected disk');
  }
  return { abs, rel: clean };
}

// ── Directory browsing ─────────────────────────────────────────────────────────
async function browse(device, mount, relPath) {
  const { abs, rel } = resolveSafe(mount, relPath);
  const conn = await connect(device);
  try {
    const sftp = await sftpOn(conn);
    const entries = await new Promise((resolve, reject) =>
      sftp.readdir(abs, (err, list) => err ? reject(new RemoteBrowseError(`Cannot read ${abs}: ${err.message}`)) : resolve(list))
    );
    const items = entries
      .filter(e => !e.filename.startsWith('.'))
      .map(e => {
        const isDir = (e.attrs.mode & 0o170000) === 0o040000; // S_IFDIR
        return {
          name: e.filename,
          path: rel ? `${rel}/${e.filename}` : e.filename,
          type: isDir ? 'folder' : 'file',
          size: isDir ? null : e.attrs.size,
        };
      });
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
    return { path: rel, parent: rel ? path.posix.dirname(rel).replace(/^\.$/, '') : null, items };
  } finally {
    conn.end();
  }
}

async function statAbs(device, mount, relPath) {
  const { abs, rel } = resolveSafe(mount, relPath);
  const conn = await connect(device);
  try {
    const sftp = await sftpOn(conn);
    const stat = await new Promise((resolve, reject) =>
      sftp.stat(abs, (err, s) => err ? reject(new RemoteBrowseError('Source path does not exist')) : resolve(s))
    );
    const isDir = (stat.mode & 0o170000) === 0o040000;
    return { abs, rel, isDirectory: isDir };
  } finally {
    conn.end();
  }
}

// ── Streaming archive creation ─────────────────────────────────────────────────
// Runs the right archiving command on the *remote* device and hands back its
// stdout as a readable stream, so the archive is built where the data lives
// instead of pulling every file back over SFTP first. Supports the same
// zip/tar/tar.gz choices as local sources (see backupService.FORMAT_CONFIG) —
// tar and gzip are on essentially every Linux box already; zip needs the
// `zip` package installed, and a missing binary surfaces as a normal error
// below rather than a silently empty/truncated archive.
const REMOTE_ARCHIVE_COMMANDS = {
  'tar.gz': (parentDir, baseName) => `tar -czf - -C "${parentDir}" "${baseName}"`,
  tar:      (parentDir, baseName) => `tar -cf - -C "${parentDir}" "${baseName}"`,
  zip:      (parentDir, baseName) => `cd "${parentDir}" && zip -qr - "${baseName}"`,
};

async function archiveStream(device, mount, relPath, format = 'tar.gz') {
  const buildCommand = REMOTE_ARCHIVE_COMMANDS[format];
  if (!buildCommand) throw new RemoteBrowseError(`Unsupported remote archive format: ${format}`);

  const { abs, rel } = resolveSafe(mount, relPath);
  const conn = await connect(device);
  const parentDir = path.posix.dirname(abs);
  const baseName = path.posix.basename(abs);
  const stream = await new Promise((resolve, reject) => {
    conn.exec(buildCommand(parentDir, baseName), (err, s) => err ? reject(err) : resolve(s));
  });

  // Neither tar nor zip's stdout stream tells the caller anything about
  // whether the command actually succeeded — only the exec channel's exit
  // code does. Capture stderr and surface non-zero exits as a real error
  // (>= 2 for tar/zip conventionally means fatal; 1 is often just a benign
  // "file changed while reading" warning on an actively-written directory,
  // which still produces a perfectly usable archive) instead of silently
  // handing the destination writer a truncated or empty stream.
  let stderr = '';
  stream.stderr?.on('data', (d) => { stderr += d.toString(); });
  stream.once('close', (code) => {
    if (code >= 2) {
      stream.emit('error', new RemoteBrowseError(stderr.trim() || `Remote archive command exited ${code}`));
    }
    conn.end();
  });
  stream.on('error', () => { try { conn.end(); } catch {} });
  return { stream, sourceRel: rel, baseName };
}

module.exports = {
  RemoteBrowseError,
  connect, listDisks, browse, statAbs, archiveStream,
};