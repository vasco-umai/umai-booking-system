const { Router } = require('express');
const { pool } = require('../../config/db');
const { AppError, ErrorCodes } = require('../../lib/errors');
const { isValidISODate } = require('../../middleware/validate');
const { getAvailableSlots } = require('../../services/availabilityService');
const { isValidTimezone } = require('../../services/staffService');

const router = Router();

// GET /api/public/availability?meeting_type_id=1&date=YYYY-MM-DD&tz=Europe/Lisbon
router.get('/', async (req, res, next) => {
  try {
    const { meeting_type_id, date, tz } = req.query;
    const teamId = req.apiKey.teamId;

    if (!meeting_type_id) {
      throw new AppError('meeting_type_id is required.', 400, ErrorCodes.MISSING_FIELDS);
    }
    if (!date || !isValidISODate(date)) {
      throw new AppError('date is required (YYYY-MM-DD).', 400, ErrorCodes.INVALID_DATE);
    }
    if (!tz || !isValidTimezone(tz)) {
      throw new AppError('tz is required (IANA timezone).', 400, ErrorCodes.UNSUPPORTED_TIMEZONE);
    }

    const mtId = parseInt(meeting_type_id, 10);
    if (!Number.isInteger(mtId) || mtId <= 0) {
      throw new AppError('meeting_type_id must be a positive integer.', 400, ErrorCodes.INVALID_INPUT);
    }

    // Team-scope guard: meeting type must belong to the API key's team
    const { rows: mtRows } = await pool.query(
      'SELECT id, duration_minutes FROM meeting_types WHERE id = $1 AND team_id = $2 AND is_active = true',
      [mtId, teamId]
    );
    if (mtRows.length === 0) {
      throw new AppError('Meeting type not found for this team.', 404, ErrorCodes.MEETING_TYPE_NOT_FOUND);
    }

    const slots = await getAvailableSlots(date, tz, undefined, mtId, undefined, undefined, teamId);

    // Re-shape to a stable public envelope: drop the `display` helper (timezone-dependent)
    // and expose ISO strings only.
    const publicSlots = slots.map((s) => ({
      slot_start: s.start,
      slot_end: s.end,
    }));

    res.json({
      date,
      timezone: tz,
      meeting_type_id: mtId,
      duration_minutes: mtRows[0].duration_minutes,
      slots: publicSlots,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/public/availability/meeting-types
// Lists all active meeting types for the API key's team.
router.get('/meeting-types', async (req, res, next) => {
  try {
    const teamId = req.apiKey.teamId;

    const { rows } = await pool.query(
      `SELECT mt.id, mt.name, mt.label, mt.duration_minutes, mt.buffer_minutes, mt.min_advance_minutes,
              COALESCE(
                (SELECT array_agg(pmt.plan_name ORDER BY pmt.plan_name)
                   FROM plan_meeting_types pmt
                  WHERE pmt.meeting_type_id = mt.id),
                ARRAY[]::text[]
              ) AS plans
         FROM meeting_types mt
        WHERE mt.team_id = $1 AND mt.is_active = true
        ORDER BY mt.id`,
      [teamId]
    );

    res.json({
      meeting_types: rows.map((r) => ({
        id: r.id,
        name: r.name,
        label: r.label,
        duration_minutes: r.duration_minutes,
        buffer_minutes: r.buffer_minutes,
        min_advance_minutes: r.min_advance_minutes,
        plans: r.plans,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
