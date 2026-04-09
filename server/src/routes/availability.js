const { Router } = require('express');
const { pool } = require('../config/db');
const logger = require('../lib/logger');
const { availabilityCache } = require('../lib/cache');
const { getAvailableSlots, getMonthAvailability, getNextAvailableDate } = require('../services/availabilityService');
const { isValidISODate } = require('../middleware/validate');

const router = Router();

// GET /api/availability?date=YYYY-MM-DD&tz=America/New_York&meeting_type_id=1
router.get('/', async (req, res, next) => {
  try {
    const { date, tz, duration, meeting_type_id, staff_id } = req.query;
    if (!date) {
      return res.status(400).json({ error: 'date parameter is required (YYYY-MM-DD)', code: 'MISSING_FIELDS' });
    }
    if (!isValidISODate(date)) {
      return res.status(400).json({ error: 'date must be in YYYY-MM-DD format', code: 'INVALID_DATE' });
    }
    const timezone = tz || 'UTC';
    const durationOverride = duration ? parseInt(duration, 10) : undefined;
    const mtId = meeting_type_id ? parseInt(meeting_type_id, 10) : undefined;
    const staffId = staff_id ? parseInt(staff_id, 10) : undefined;
    const slots = await getAvailableSlots(date, timezone, durationOverride, mtId, staffId);
    res.json({ date, timezone, slots });
  } catch (err) {
    next(err);
  }
});

// GET /api/availability/month?year=2024&month=3&tz=America/New_York&meeting_type_id=1
router.get('/month', async (req, res, next) => {
  try {
    const { year, month, tz, meeting_type_id, staff_id } = req.query;
    if (!year || !month) {
      return res.status(400).json({ error: 'year and month parameters are required', code: 'MISSING_FIELDS' });
    }
    const timezone = tz || 'UTC';
    const mtId = meeting_type_id ? parseInt(meeting_type_id, 10) : undefined;
    const staffId = staff_id ? parseInt(staff_id, 10) : undefined;

    // Check cache first (include staff_id in cache key)
    const cacheKey = `month:${year}-${month}-${timezone}-${mtId || 'all'}-staff${staffId || 'all'}`;
    const cached = availabilityCache.get(cacheKey);
    if (cached) {
      logger.debug({ cacheKey }, 'Month availability cache hit');
      return res.json(cached);
    }

    const dates = await getMonthAvailability(parseInt(year), parseInt(month), timezone, mtId, staffId);
    const result = { year: parseInt(year), month: parseInt(month), timezone, dates };

    // Cache the result
    availabilityCache.set(cacheKey, result);

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/availability/next-available?from=YYYY-MM-DD&tz=...&meeting_type_id=1&staff_id=1
router.get('/next-available', async (req, res, next) => {
  try {
    const { from, tz, duration, meeting_type_id, staff_id } = req.query;
    if (!from) {
      return res.status(400).json({ error: 'from parameter is required (YYYY-MM-DD)', code: 'MISSING_FIELDS' });
    }
    if (!isValidISODate(from)) {
      return res.status(400).json({ error: 'from must be in YYYY-MM-DD format', code: 'INVALID_DATE' });
    }
    const timezone = tz || 'UTC';
    const durationOverride = duration ? parseInt(duration, 10) : undefined;
    const mtId = meeting_type_id ? parseInt(meeting_type_id, 10) : undefined;
    const staffId = staff_id ? parseInt(staff_id, 10) : undefined;

    const date = await getNextAvailableDate(from, timezone, durationOverride, mtId, staffId);
    res.json({ date });
  } catch (err) {
    next(err);
  }
});

// GET /api/availability/meeting-types?plan=pro&staff_id=1  — public endpoint
router.get('/meeting-types', async (req, res, next) => {
  try {
    const { plan, staff_id } = req.query;
    if (!plan) {
      return res.status(400).json({ error: 'plan parameter is required' });
    }
    const { rows } = await pool.query(
      `SELECT mt.id, mt.name, mt.label, mt.duration_minutes, mt.buffer_minutes, mt.min_advance_minutes
       FROM meeting_types mt
       JOIN plan_meeting_types pmt ON pmt.meeting_type_id = mt.id
       WHERE pmt.plan_name = $1 AND mt.is_active = true
       ORDER BY mt.id`,
      [plan]
    );

    // If staff_id is provided, overlay staff-specific duration overrides
    if (staff_id) {
      const staffId = parseInt(staff_id, 10);
      const { rows: overrides } = await pool.query(
        `SELECT meeting_type_id, duration_minutes FROM staff_duration_overrides WHERE staff_member_id = $1`,
        [staffId]
      );
      const overrideMap = {};
      for (const o of overrides) overrideMap[o.meeting_type_id] = o.duration_minutes;
      for (const mt of rows) {
        if (overrideMap[mt.id]) {
          mt.duration_minutes = overrideMap[mt.id];
        }
      }
    }

    res.json({ plan, meeting_types: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
