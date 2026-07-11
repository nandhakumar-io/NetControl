// services/audit.js — Structured audit logging (MySQL + Winston file log)
const { execute, queryOne } = require('../db');
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
  // BUG FIX: audit_log has carried an org_id column since the multi-tenant
  // migration (db/migrate-orgs.js), and routes/audit.js's list/export/tally
  // queries now hard-filter on `WHERE org_id = ?` (a necessary security fix —
  // see routes/audit.js — so one tenant can't read another's audit trail).
  // But this function never read or inserted org_id, so every entry written
  // by any of the ~90 call sites across the app landed with org_id = NULL,
  // which never matches req.orgId and is therefore invisible to every
  // caller of the audit log page/export, even though rows were being
  // written correctly to the table the whole time.
  //
  // Rather than touching every call site, resolve org_id here: use an
  // explicit opts.orgId if the caller has one to hand (e.g. a route that
  // already ran requireOrgContext), otherwise fall back to looking up the
  // acting user's active_org_id. Events with no user (e.g. a failed login
  // for a username that doesn't exist) genuinely have no org to attribute
  // to and are left NULL — they simply won't show up in a tenant-scoped
  // view, which is correct.
  let orgId = opts.orgId || null;
  if (!orgId && opts.userId) {
    try {
      const user = await queryOne('SELECT active_org_id FROM users WHERE id = ?', [opts.userId]);
      orgId = user?.active_org_id || null;
    } catch (e) {
      logger.error('Failed to resolve org_id for audit entry', { error: e.message, userId: opts.userId });
    }
  }

  const entry = {
    id:          uuidv4(),
    timestamp:   Math.floor(Date.now() / 1000),
    org_id:      orgId,
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
         (id, timestamp, org_id, user_id, username, action, target_type, target_id, target_name, ip_source, result, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.timestamp, entry.org_id, entry.user_id, entry.username, entry.action,
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