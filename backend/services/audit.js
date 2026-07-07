// services/audit.js — Structured audit logging (MySQL + Winston file log)
const { execute } = require('../db');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const fs = require('fs');

if (!fs.existsSync('./logs')) fs.mkdirSync('./logs', { recursive: true });

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: './logs/audit.log' }),
    new winston.transports.File({ filename: './logs/error.log', level: 'error' }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({ format: winston.format.simple() }));
}

async function log(opts) {
  const entry = {
    id:          uuidv4(),
    timestamp:   Math.floor(Date.now() / 1000),
    user_id:     opts.userId     || null,
    username:    opts.username   || 'system',
    action:      opts.action,
    target_type: opts.targetType || null,
    target_id:   opts.targetId   || null,
    target_name: opts.targetName || null,
    ip_source:   opts.ipSource   || null,
    // SECURITY FIX: the schema's result column is ENUM('success','failure',
    // 'partial'), but this used to collapse anything not exactly 'failure'
    // into 'success' — so callers logging a partial multi-device outcome
    // (some devices succeeded, some failed) had it recorded as a full
    // success, hiding real failures from the audit trail.
    result: ['failure', 'partial'].includes(opts.result) ? opts.result : 'success',
    details:     opts.details    || null,
  };

  try {
    await execute(
      `INSERT INTO audit_log
         (id, timestamp, user_id, username, action, target_type, target_id, target_name, ip_source, result, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.timestamp, entry.user_id, entry.username, entry.action,
       entry.target_type, entry.target_id, entry.target_name, entry.ip_source,
       entry.result, entry.details]
    );
  } catch (e) {
    logger.error('Failed to write audit to DB', { error: e.message, entry });
  }

  logger.info('AUDIT', entry);

  // Relay to the configured syslog server (if enabled). Intentionally not
  // awaited — syslog delivery (or an unreachable server) must never slow
  // down or fail the action that triggered this audit entry. The
  // audit_log row is updated with the delivery result once it lands.
  try {
    // Lazy require avoids a circular-require edge case at module load time
    // and keeps audit.js usable even if syslogForwarder.js has an issue.
    require('./syslogForwarder').forwardAndMark(entry).catch(() => {});
  } catch { /* syslog module unavailable — audit logging still succeeds */ }
}

module.exports = { log };