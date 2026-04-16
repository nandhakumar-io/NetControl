// routes/audit.js
const express = require('express');
const { getPool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/audit?page=1&limit=25&action=wake&search=admin&result=success
router.get('/', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    const where  = [];
    const params = [];

    // Filter by action
    if (req.query.action) {
      where.push('action = ?');
      params.push(req.query.action);
    }

    // Filter by result (success / failure / partial)
    if (req.query.result) {
      where.push('result = ?');
      params.push(req.query.result);
    }

    // Full-text search across username and target_name
    if (req.query.search) {
      where.push('(username LIKE ? OR target_name LIKE ?)');
      params.push(`%${req.query.search}%`, `%${req.query.search}%`);
    }

    // Optional time range filters
    if (req.query.from) {
      where.push('timestamp >= ?');
      params.push(parseInt(req.query.from));
    }
    if (req.query.to) {
      where.push('timestamp <= ?');
      params.push(parseInt(req.query.to));
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const pool = getPool();

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM audit_log ${whereClause}`,
      params
    );

    const [rows] = await pool.execute(
      `SELECT * FROM audit_log ${whereClause} ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    res.json({ total, page, limit, logs: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
