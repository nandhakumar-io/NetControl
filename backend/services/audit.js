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
    result: opts.result === 'failure' ? 'failure' : 'success',
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
}

module.exports = { log };

