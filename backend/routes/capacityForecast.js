// routes/capacityForecast.js — GET endpoint(s) for CapacityForecastPage.jsx.
// The forecasting math itself lives in services/capacityForecast.js
// (OLS trend fit + periodic warning notifier); this file is just the thin
// HTTP layer over computeAllForecasts/computeForecast, scoped to the
// caller's org the same way every other list endpoint in this app is.
'use strict';
const express = require('express');
const { param, query: queryValidator, validationResult } = require('express-validator');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const capacityForecast = require('../services/capacityForecast');

// Same permission bit CapacityForecastPage.jsx's route is gated behind in
// App.jsx (RequirePermission bit={1}) and Layout.jsx's nav entry (can(1)).
const VIEW_CAPACITY_FORECAST = 1;

const router = express.Router();
router.use(requireAuth, requireOrgContext, requirePermission(VIEW_CAPACITY_FORECAST));

// ── GET /api/capacity-forecast — list view: every device in the org,
// soonest-to-fill first, for whichever metric (disk|ram) is selected ──────
router.get('/',
  [
    queryValidator('metric').optional().isIn(['disk', 'ram']),
    queryValidator('lookbackDays').optional().isInt({ min: 1, max: 90 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const metric = req.query.metric || 'disk';
    const lookbackDays = req.query.lookbackDays ? parseInt(req.query.lookbackDays) : 14;

    try {
      const results = await capacityForecast.computeAllForecasts(metric, lookbackDays, req.orgId);
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ── GET /api/capacity-forecast/:deviceId — single-device detail, in case
// a future device detail view wants just one row without refetching all ──
router.get('/:deviceId',
  [
    param('deviceId').isUUID(),
    queryValidator('metric').optional().isIn(['disk', 'ram']),
    queryValidator('lookbackDays').optional().isInt({ min: 1, max: 90 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const metric = req.query.metric || 'disk';
    const lookbackDays = req.query.lookbackDays ? parseInt(req.query.lookbackDays) : 14;

    try {
      const forecast = await capacityForecast.computeForecast(req.params.deviceId, metric, lookbackDays);
      res.json(forecast);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

module.exports = router;