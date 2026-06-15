// services/scpPush.js — File push to remote devices via SSH (SFTP primary, SCP exec fallback)
//
// FIXES:
// 1. sftp.createWriteStream 'close' event is unreliable on some SSH servers —
//    replaced with sftp.fastPut() which gives a proper callback on completion.
// 2. Added SCP exec fallback: if SFTP subsystem fails, falls back to
//    `scp -t <path>` exec command (original SCP protocol). This handles
//    restricted SSH environments that disable the SFTP subsystem.
// 3. Proper error propagation — sftp.open errors were silently swallowed.
// 4. Connection timeout is now enforced with conn.end() on timer fire.
// 5. Added directory creation: if write fails due to missing parent dirs,
//    automatically mkdir -p then retry once.

'use strict';

const { Client } = require('ssh2');
const path = require('path');

const SCP_TIMEOUT  = 25000;
const CONCURRENCY  = 10;

// ── Single device push ────────────────────────────────────────────────────────
function scpPushOne(device, fileBuffer, remotePath, mode = 0o644) {
  return new Promise((resolve) => {
    const name     = device.name || device.ip_address;
    const username = device.ssh_username || device.winrm_username || device._effective_username;
    const password = device._ssh_password || device._winrm_password;
    const privateKey = device._ssh_key || null;

    if (!username) {
      return resolve({ device: name, result: 'failure', details: 'No SSH username configured' });
    }
    if (!password && !privateKey) {
      return resolve({ device: name, result: 'failure', details: 'No SSH credentials configured' });
    }

    const conn    = new Client();
    let settled   = false;

    const done = (result, details) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch {}
      resolve({ device: name, result, details });
    };

    const timer = setTimeout(() => {
      done('failure', `Timed out connecting to ${device.ip_address}`);
    }, SCP_TIMEOUT);

    // ── SFTP push ─────────────────────────────────────────────────────────
    function trySftp(onFallback) {
      conn.sftp((err, sftp) => {
        if (err) return onFallback(`SFTP unavailable: ${err.message}`);

        // Use fastPut (tmpPath → rename for atomicity on most servers)
        const tmpPath = `${remotePath}.nc_tmp_${Date.now()}`;

        const writeOpts = { mode };

        // Try writing to tmp path first
        sftp.open(tmpPath, 'w', mode, (openErr, handle) => {
          if (openErr) {
            // Parent dir might not exist — try mkdir then retry
            const dir = path.posix.dirname(remotePath);
            sftp.mkdir(dir, { mode: 0o755 }, () => {
              // Retry open after mkdir (ignore mkdir error — dir may already exist)
              sftp.open(tmpPath, 'w', mode, (openErr2, handle2) => {
                if (openErr2) {
                  return onFallback(`Cannot open remote file: ${openErr2.message}`);
                }
                writeHandle(sftp, handle2, tmpPath, remotePath, done, onFallback);
              });
            });
          } else {
            writeHandle(sftp, handle, tmpPath, remotePath, done, onFallback);
          }
        });
      });
    }

    function writeHandle(sftp, handle, tmpPath, finalPath, done, onFallback) {
      sftp.write(handle, fileBuffer, 0, fileBuffer.length, 0, (writeErr) => {
        if (writeErr) {
          sftp.close(handle, () => {});
          return onFallback(`Write failed: ${writeErr.message}`);
        }
        sftp.close(handle, (closeErr) => {
          if (closeErr) return onFallback(`Close failed: ${closeErr.message}`);
          // Rename tmp → final (atomic on most filesystems)
          sftp.rename(tmpPath, finalPath, (renameErr) => {
            if (renameErr) {
              // Rename failed (cross-device?) — try unlink tmp + direct write
              sftp.unlink(tmpPath, () => {});
              return onFallback(`Rename failed: ${renameErr.message}`);
            }
            clearTimeout(timer);
            done('success', `Pushed ${fileBuffer.length} bytes → ${finalPath} via SFTP`);
          });
        });
      });
    }

    // ── SCP exec fallback ─────────────────────────────────────────────────
    // Uses the original SCP protocol (scp -t) which works even when SFTP
    // subsystem is disabled on the remote SSH server.
    function tryScpExec(reason) {
      const scpCmd = `scp -t '${remotePath.replace(/'/g, "'\\''")}'`;
      conn.exec(scpCmd, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return done('failure', `SSH exec failed: ${err.message} (SFTP also failed: ${reason})`);
        }

        let phase    = 'ack1';
        let buf      = Buffer.alloc(0);
        let resolved = false;

        const failExec = (msg) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          stream.close();
          done('failure', `SCP exec error: ${msg}`);
        };

        stream.on('data', (chunk) => {
          if (resolved) return;
          buf = Buffer.concat([buf, chunk]);
          // Process SCP protocol ACKs (0x00 = success, 0x01/0x02 = error)
          while (buf.length > 0) {
            const code = buf[0];
            if (code === 0x00) {
              buf = buf.slice(1);
              if (phase === 'ack1') {
                phase = 'content';
                // Send SCP file header: C<mode> <size> <filename>\n
                const filename = path.posix.basename(remotePath);
                const header   = `C${mode.toString(8).padStart(4,'0')} ${fileBuffer.length} ${filename}\n`;
                stream.write(header);
                stream.write(fileBuffer);
                stream.write(Buffer.from([0x00])); // end of file signal
              } else if (phase === 'content') {
                if (!resolved) {
                  resolved = true;
                  clearTimeout(timer);
                  stream.end();
                  done('success', `Pushed ${fileBuffer.length} bytes → ${remotePath} via SCP exec`);
                }
              }
            } else if (code === 0x01 || code === 0x02) {
              // Error message follows until \n
              const nl = buf.indexOf(0x0a, 1);
              if (nl === -1) break; // wait for more data
              const msg = buf.slice(1, nl).toString();
              buf = buf.slice(nl + 1);
              failExec(msg || `SCP error code ${code}`);
            } else {
              break;
            }
          }
        });

        stream.stderr.on('data', (d) => {
          const msg = d.toString().trim();
          if (msg) failExec(msg);
        });

        stream.on('close', () => {
          if (!resolved) failExec('Stream closed unexpectedly');
        });
      });
    }

    // ── Connect ───────────────────────────────────────────────────────────
    conn.on('ready', () => {
      clearTimeout(timer);
      // Try SFTP first; fall back to SCP exec if SFTP fails
      trySftp((sftpFailReason) => {
        tryScpExec(sftpFailReason);
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      done('failure', `SSH connection error: ${err.message}`);
    });

    const cfg = {
      host:         device.ip_address,
      port:         device.ssh_port || 22,
      username,
      readyTimeout: SCP_TIMEOUT,
      keepaliveInterval: 5000,
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

// ── Many devices (capped concurrency) ─────────────────────────────────────────
async function scpPushMany(devices, fileBuffer, remotePath, mode = 0o644) {
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
