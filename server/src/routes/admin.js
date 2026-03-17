const { Router } = require('express');
const { pool } = require('../config/db');
const logger = require('../lib/logger');
const { availabilityCache } = require('../lib/cache');
const { requireAdmin, requireRole } = require('../middleware/auth');
const calendarService = require('../services/calendarService');
const emailService = require('../services/emailService');
const staffService = require('../services/staffService');

const router = Router();

// All admin routes require auth
router.use(requireAdmin);

// ── Schedules ──────────────────────────────────────

// GET /api/admin/schedules?staff_member_id=1 (optional filter)
router.get('/schedules', async (req, res, next) => {
  try {
    const { staff_member_id } = req.query;
    let query = `SELECT s.*, sm.name as staff_name
                 FROM schedules s
                 LEFT JOIN staff_members sm ON s.staff_member_id = sm.id`;
    const params = [];

    if (staff_member_id === 'global') {
      query += ' WHERE s.staff_member_id IS NULL';
    } else if (staff_member_id) {
      params.push(parseInt(staff_member_id));
      query += ' WHERE s.staff_member_id = $1';
    }

    query += ' ORDER BY s.staff_member_id NULLS FIRST, s.day_of_week, s.start_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/admin/schedules
router.post('/schedules', async (req, res, next) => {
  try {
    const { day_of_week, start_time, end_time, slot_duration, timezone, is_active, staff_member_id } = req.body;

    if (day_of_week == null || !start_time || !end_time) {
      return res.status(400).json({ error: 'day_of_week, start_time, and end_time are required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO schedules (day_of_week, start_time, end_time, slot_duration, timezone, is_active, staff_member_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [day_of_week, start_time, end_time, slot_duration || 60, timezone || 'Europe/Lisbon', is_active !== false, staff_member_id || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/admin/schedules/:id
router.put('/schedules/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { day_of_week, start_time, end_time, slot_duration, timezone, is_active, staff_member_id } = req.body;

    const { rows } = await pool.query(
      `UPDATE schedules SET
        day_of_week = COALESCE($1, day_of_week),
        start_time = COALESCE($2, start_time),
        end_time = COALESCE($3, end_time),
        slot_duration = COALESCE($4, slot_duration),
        timezone = COALESCE($5, timezone),
        is_active = COALESCE($6, is_active),
        staff_member_id = $8,
        updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [day_of_week, start_time, end_time, slot_duration, timezone, is_active, id, staff_member_id !== undefined ? staff_member_id : null]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Schedule not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/admin/schedules/:id
router.delete('/schedules/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM schedules WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ message: 'Schedule deleted' });
  } catch (err) { next(err); }
});

// ── Blocked Times ──────────────────────────────────

// GET /api/admin/blocked-times
router.get('/blocked-times', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM blocked_times ORDER BY start_at DESC');
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/admin/blocked-times
router.post('/blocked-times', async (req, res, next) => {
  try {
    const { start_at, end_at, reason } = req.body;
    if (!start_at || !end_at) {
      return res.status(400).json({ error: 'start_at and end_at are required' });
    }
    const { rows } = await pool.query(
      'INSERT INTO blocked_times (start_at, end_at, reason) VALUES ($1, $2, $3) RETURNING *',
      [start_at, end_at, reason || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/admin/blocked-times/:id
router.delete('/blocked-times/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM blocked_times WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Blocked time not found' });
    res.json({ message: 'Blocked time deleted' });
  } catch (err) { next(err); }
});

// ── Staff Members (admin only) ─────────────────────

// GET /api/admin/staff
router.get('/staff', requireRole('admin'), async (req, res, next) => {
  try {
    const staff = await staffService.getAllStaff();

    // Fetch invite/onboarding info from admin_users for all staff emails
    const emails = staff.map(s => s.email);
    const { rows: adminRows } = await pool.query(
      `SELECT email, must_set_password, password_hash, invite_token, invite_token_expires
       FROM admin_users WHERE email = ANY($1)`,
      [emails]
    );
    const adminByEmail = {};
    for (const a of adminRows) adminByEmail[a.email] = a;

    const sanitized = staff.map(s => {
      const admin = adminByEmail[s.email];
      const hasCalendar = !!s.google_refresh_token;
      const hasPassword = admin && !admin.must_set_password && !!admin.password_hash;

      let onboarding_status = 'pending';
      if (hasPassword && hasCalendar) onboarding_status = 'completed';
      else if (hasPassword) onboarding_status = 'partial';

      return {
        ...s,
        google_refresh_token: hasCalendar,
        onboarding_status,
        invite_token: admin?.invite_token || null,
        invite_token_expired: admin?.invite_token_expires
          ? new Date(admin.invite_token_expires) < new Date()
          : true,
      };
    });
    res.json(sanitized);
  } catch (err) { next(err); }
});

// POST /api/admin/staff
router.post('/staff', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, email, meeting_pct, google_calendar_id, is_active } = req.body;
    if (!name || !email) {
      return res.status(400).json({ error: 'name and email are required' });
    }
    const staff = await staffService.createStaff({
      name,
      email,
      meetingPct: meeting_pct != null ? meeting_pct : 100,
      googleCalendarId: google_calendar_id || null,
      isActive: is_active !== false,
    });
    res.status(201).json(staff);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A staff member with this email already exists' });
    }
    next(err);
  }
});

// POST /api/admin/staff/:id/invite — regenerate invite token
router.post('/staff/:id/invite', requireRole('admin'), async (req, res, next) => {
  try {
    const token = await staffService.regenerateInviteToken(req.params.id);
    if (!token) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ invite_token: token });
  } catch (err) { next(err); }
});

// PUT /api/admin/staff/:id
router.put('/staff/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, email, meeting_pct, google_calendar_id, is_active } = req.body;
    const staff = await staffService.updateStaff(req.params.id, {
      name,
      email,
      meetingPct: meeting_pct,
      googleCalendarId: google_calendar_id,
      isActive: is_active,
    });
    if (!staff) return res.status(404).json({ error: 'Staff member not found' });
    res.json(staff);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A staff member with this email already exists' });
    }
    next(err);
  }
});

// DELETE /api/admin/staff/:id
router.delete('/staff/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const deleted = await staffService.deleteStaff(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ message: 'Staff member deleted' });
  } catch (err) { next(err); }
});

// ── Bookings ──────────────────────────────────────

// GET /api/admin/bookings?status=confirmed&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/bookings', async (req, res, next) => {
  try {
    const { status, from, to } = req.query;
    let query = `SELECT b.*, s.name as staff_name, mt.label as meeting_type_label
                 FROM bookings b
                 LEFT JOIN staff_members s ON b.staff_member_id = s.id
                 LEFT JOIN meeting_types mt ON b.meeting_type_id = mt.id
                 WHERE 1=1`;
    const params = [];

    if (status) {
      params.push(status);
      query += ` AND b.status = $${params.length}`;
    }
    if (from) {
      params.push(from);
      query += ` AND b.slot_start >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      query += ` AND b.slot_start <= $${params.length}`;
    }

    query += ' ORDER BY b.slot_start DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// PUT /api/admin/bookings/:id/cancel
router.put('/bookings/:id/cancel', async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `UPDATE bookings SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND status = 'confirmed' RETURNING *`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found or already cancelled' });
    }

    const booking = rows[0];

    // Delete Google Calendar event — use staff's OAuth token if available
    if (booking.gcal_event_id) {
      let staffRefreshToken;
      if (booking.staff_member_id) {
        const staff = await staffService.getStaffById(booking.staff_member_id);
        if (staff) staffRefreshToken = staff.google_refresh_token;
      }
      calendarService.deleteEvent(booking.gcal_event_id, undefined, staffRefreshToken).catch(() => {});
    }

    // Invalidate availability cache
    availabilityCache.clear();

    // Send cancellation email
    emailService.sendCancellation({
      guestName: booking.guest_name,
      guestEmail: booking.guest_email,
      slotStart: booking.slot_start.toISOString(),
      guestTz: booking.guest_tz,
    }).catch(() => {});

    logger.info({ bookingId: booking.id, adminId: req.admin.id }, 'Booking cancelled');
    res.json({ message: 'Booking cancelled', booking });
  } catch (err) { next(err); }
});

// POST /api/admin/bookings/:id/resend-confirmation
router.post('/bookings/:id/resend-confirmation', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = rows[0];
    const sent = await emailService.sendConfirmation({
      guestName: booking.guest_name,
      guestEmail: booking.guest_email,
      slotStart: booking.slot_start.toISOString(),
      slotEnd: booking.slot_end.toISOString(),
      guestTz: booking.guest_tz,
      venueName: booking.venue_name,
    });

    await pool.query('UPDATE bookings SET confirmation_email_sent = $1 WHERE id = $2', [sent, id]);

    if (sent) {
      logger.info({ bookingId: id, adminId: req.admin.id }, 'Confirmation email resent');
      res.json({ message: 'Confirmation email resent' });
    } else {
      res.status(500).json({ error: 'Failed to send confirmation email', code: 'EMAIL_FAILED' });
    }
  } catch (err) { next(err); }
});

// ── Meeting Types ──────────────────────────────────

// GET /api/admin/meeting-types  — list all with plan mappings + day schedules
router.get('/meeting-types', async (req, res, next) => {
  try {
    const { rows: types } = await pool.query(
      'SELECT * FROM meeting_types ORDER BY id'
    );
    const { rows: planMappings } = await pool.query(
      'SELECT * FROM plan_meeting_types ORDER BY meeting_type_id, plan_name'
    );
    const { rows: schedules } = await pool.query(
      'SELECT * FROM meeting_type_schedules ORDER BY meeting_type_id, day_of_week'
    );

    const result = types.map(t => {
      const plans = planMappings
        .filter(pm => pm.meeting_type_id === t.id)
        .map(pm => pm.plan_name);
      const schedule = {};
      schedules
        .filter(s => s.meeting_type_id === t.id)
        .forEach(s => { schedule[s.day_of_week] = s.is_available; });
      return { ...t, plans, schedule };
    });

    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/meeting-types
router.post('/meeting-types', async (req, res, next) => {
  try {
    const { name, label, duration_minutes, is_active } = req.body;
    if (!name || !label || !duration_minutes) {
      return res.status(400).json({ error: 'name, label, and duration_minutes are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO meeting_types (name, label, duration_minutes, is_active)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, label, duration_minutes, is_active !== false]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A meeting type with this name already exists' });
    }
    next(err);
  }
});

// PUT /api/admin/meeting-types/:id
router.put('/meeting-types/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, label, duration_minutes, is_active } = req.body;
    const { rows } = await pool.query(
      `UPDATE meeting_types SET
        name = COALESCE($1, name),
        label = COALESCE($2, label),
        duration_minutes = COALESCE($3, duration_minutes),
        is_active = COALESCE($4, is_active),
        updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [name, label, duration_minutes, is_active, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Meeting type not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A meeting type with this name already exists' });
    }
    next(err);
  }
});

// DELETE /api/admin/meeting-types/:id
router.delete('/meeting-types/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM meeting_types WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Meeting type not found' });
    res.json({ message: 'Meeting type deleted' });
  } catch (err) { next(err); }
});

// PUT /api/admin/meeting-types/:id/plans  — set plan mappings
router.put('/meeting-types/:id/plans', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { plans } = req.body; // e.g. ['mini', 'pro', 'proplus']
    if (!Array.isArray(plans)) {
      return res.status(400).json({ error: 'plans must be an array' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM plan_meeting_types WHERE meeting_type_id = $1', [id]);
      for (const plan of plans) {
        await client.query(
          'INSERT INTO plan_meeting_types (plan_name, meeting_type_id) VALUES ($1, $2)',
          [plan, id]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ message: 'Plan mappings updated' });
  } catch (err) { next(err); }
});

// PUT /api/admin/meeting-types/:id/schedule  — set day-of-week availability
router.put('/meeting-types/:id/schedule', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { days } = req.body; // e.g. { "0": true, "1": true, "2": false, ... }
    if (!days || typeof days !== 'object') {
      return res.status(400).json({ error: 'days must be an object mapping day_of_week to boolean' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [day, available] of Object.entries(days)) {
        await client.query(
          `INSERT INTO meeting_type_schedules (meeting_type_id, day_of_week, is_available)
           VALUES ($1, $2, $3)
           ON CONFLICT (meeting_type_id, day_of_week)
           DO UPDATE SET is_available = $3`,
          [id, parseInt(day), available]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ message: 'Schedule updated' });
  } catch (err) { next(err); }
});

module.exports = router;
