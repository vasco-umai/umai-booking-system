const { Router } = require('express');
const { DateTime } = require('luxon');
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
    const emails = staff.map(s => s.email.toLowerCase());
    const { rows: adminRows } = await pool.query(
      `SELECT email, must_set_password, password_hash, invite_token, invite_token_expires, role
       FROM admin_users WHERE LOWER(email) = ANY($1)`,
      [emails]
    );
    const adminByEmail = {};
    for (const a of adminRows) adminByEmail[a.email.toLowerCase()] = a;

    const sanitized = staff.map(s => {
      const admin = adminByEmail[s.email.toLowerCase()];
      const hasCalendar = !!s.google_refresh_token;
      const hasPassword = admin && !admin.must_set_password && !!admin.password_hash;

      let onboarding_status = 'pending';
      if (hasPassword && hasCalendar) onboarding_status = 'completed';
      else if (hasPassword) onboarding_status = 'partial';

      return {
        ...s,
        google_refresh_token: hasCalendar,
        onboarding_status,
        role: admin?.role || 'restricted',
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

// ── Staff Duration Overrides ──────────────────────

// GET /api/admin/staff/:id/duration-overrides
router.get('/staff/:id/duration-overrides', requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT sdo.*, mt.name as meeting_type_name, mt.label as meeting_type_label, mt.duration_minutes as default_duration
       FROM staff_duration_overrides sdo
       JOIN meeting_types mt ON mt.id = sdo.meeting_type_id
       WHERE sdo.staff_member_id = $1
       ORDER BY sdo.meeting_type_id`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// PUT /api/admin/staff/:id/duration-overrides
router.put('/staff/:id/duration-overrides', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const staffId = parseInt(req.params.id, 10);
    const { overrides } = req.body; // [{ meeting_type_id, duration_minutes }]

    if (!Array.isArray(overrides)) {
      return res.status(400).json({ error: 'overrides must be an array of { meeting_type_id, duration_minutes }' });
    }

    await client.query('BEGIN');

    // Delete existing overrides for this staff member
    await client.query('DELETE FROM staff_duration_overrides WHERE staff_member_id = $1', [staffId]);

    // Insert new overrides (skip entries with no duration)
    for (const o of overrides) {
      if (o.meeting_type_id && o.duration_minutes > 0) {
        await client.query(
          `INSERT INTO staff_duration_overrides (staff_member_id, meeting_type_id, duration_minutes)
           VALUES ($1, $2, $3)`,
          [staffId, o.meeting_type_id, o.duration_minutes]
        );
      }
    }

    await client.query('COMMIT');

    // Return updated overrides
    const { rows } = await pool.query(
      `SELECT sdo.*, mt.name as meeting_type_name, mt.label as meeting_type_label
       FROM staff_duration_overrides sdo
       JOIN meeting_types mt ON mt.id = sdo.meeting_type_id
       WHERE sdo.staff_member_id = $1
       ORDER BY sdo.meeting_type_id`,
      [staffId]
    );
    res.json(rows);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
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
    let staffEmail;
    if (booking.gcal_event_id) {
      let staffRefreshToken;
      if (booking.staff_member_id) {
        const staff = await staffService.getStaffById(booking.staff_member_id);
        if (staff) {
          staffRefreshToken = staff.google_refresh_token;
          staffEmail = staff.email;
        }
      }
      calendarService.deleteEvent(booking.gcal_event_id, undefined, staffRefreshToken).catch(() => {});
    } else if (booking.staff_member_id) {
      const staff = await staffService.getStaffById(booking.staff_member_id);
      if (staff) staffEmail = staff.email;
    }

    // Invalidate availability cache
    availabilityCache.clear();

    // Send cancellation email
    emailService.sendCancellation({
      guestName: booking.guest_name,
      guestEmail: booking.guest_email,
      slotStart: booking.slot_start.toISOString(),
      guestTz: booking.guest_tz,
      replyTo: staffEmail || undefined,
    }).catch(() => {});

    logger.info({ bookingId: booking.id, adminId: req.admin.id }, 'Booking cancelled');
    res.json({ message: 'Booking cancelled', booking });
  } catch (err) { next(err); }
});

// PUT /api/admin/bookings/:id/reassign
router.put('/bookings/:id/reassign', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { staff_member_id } = req.body;

    if (!staff_member_id) {
      return res.status(400).json({ error: 'staff_member_id is required', code: 'MISSING_FIELDS' });
    }

    // Get the booking
    const { rows: bookingRows } = await pool.query(
      `SELECT b.*, mt.label as meeting_type_label, mt.name as meeting_type_name
       FROM bookings b
       LEFT JOIN meeting_types mt ON b.meeting_type_id = mt.id
       WHERE b.id = $1 AND b.status = 'confirmed'`,
      [id]
    );

    if (bookingRows.length === 0) {
      return res.status(404).json({ error: 'Booking not found or not confirmed' });
    }

    const booking = bookingRows[0];
    const oldStaffId = booking.staff_member_id;

    // Validate new staff member
    const newStaff = await staffService.getStaffById(parseInt(staff_member_id, 10));
    if (!newStaff || !newStaff.is_active) {
      return res.status(400).json({ error: 'Staff member not found or inactive', code: 'INVALID_STAFF' });
    }

    if (newStaff.id === oldStaffId) {
      return res.status(400).json({ error: 'Booking is already assigned to this staff member' });
    }

    // Update the booking
    await pool.query(
      'UPDATE bookings SET staff_member_id = $1, updated_at = NOW() WHERE id = $2',
      [newStaff.id, id]
    );

    // Delete old calendar event if exists
    if (booking.gcal_event_id) {
      let oldStaffToken;
      if (oldStaffId) {
        const oldStaff = await staffService.getStaffById(oldStaffId);
        if (oldStaff) oldStaffToken = oldStaff.google_refresh_token;
      }
      calendarService.deleteEvent(booking.gcal_event_id, undefined, oldStaffToken).catch(() => {});
    }

    // Build calendar description for new event
    const isMini = booking.plan === 'mini';
    const isOnline = booking.meeting_type_label === 'Online' || booking.meeting_type_label === 'Freemium' || isMini;
    const guestTz = booking.guest_tz || 'UTC';
    const guestDt = DateTime.fromJSDate(booking.slot_start, { zone: guestTz });
    const formattedDay = guestDt.toFormat('MMMM d');
    const formattedTime = guestDt.toFormat('HH:mm');

    let calendarDescription;
    if (isMini) {
      calendarDescription = `We confirm our training session on day ${formattedDay}, online, at ${formattedTime}.\n\nThe setup and training session will last approximately 1 hour, divided as follows:\n- 30 to 40 minutes: UMAI account setup\n- 15 to 20 minutes: team training`;
    } else if (isOnline) {
      calendarDescription = `We confirm our training session on day ${formattedDay}, online, at ${formattedTime}.\n\nThe setup and training session will last approximately 2 hours, divided as follows:\n- 1h15 to 1h30: UMAI account setup\n- 30 to 45 minutes: team training`;
    } else {
      calendarDescription = `We confirm our training session on day ${formattedDay}, at ${booking.venue_address || booking.venue_name || 'the venue'}, at ${formattedTime}.\n\nThe setup and training session will last approximately 2 hours, divided as follows:\n- 1h15 to 1h30: UMAI account setup\n- 30 to 45 minutes: team training`;
    }

    // Create new calendar event on new staff's calendar, then send update email
    calendarService.createEvent({
      summary: `UMAI x ${booking.venue_name || booking.guest_name} - Setup and Settings Adjustments`,
      description: calendarDescription,
      startTime: booking.slot_start.toISOString(),
      endTime: booking.slot_end.toISOString(),
      attendeeEmail: booking.guest_email,
      timeZone: guestTz,
      staffRefreshToken: newStaff.google_refresh_token,
      addConference: isOnline,
    }).then(({ eventId, hangoutLink, failed }) => {
      if (eventId) {
        pool.query('UPDATE bookings SET gcal_event_id = $1, gcal_sync_failed = false, meeting_link = $2 WHERE id = $3', [eventId, hangoutLink, id]);
      } else if (failed) {
        pool.query('UPDATE bookings SET gcal_event_id = NULL, gcal_sync_failed = true, meeting_link = NULL WHERE id = $1', [id]);
      }

      // Send update email with meeting link
      return emailService.sendUpdate({
        guestName: booking.guest_name,
        guestEmail: booking.guest_email,
        slotStart: booking.slot_start.toISOString(),
        slotEnd: booking.slot_end.toISOString(),
        guestTz,
        venueName: booking.venue_name,
        venueAddress: booking.venue_address,
        meetingTypeLabel: booking.meeting_type_label || 'Training',
        meetingLink: hangoutLink || booking.meeting_link || null,
        replyTo: newStaff.email || undefined,
      });
    }).catch(err => {
      logger.error({ err, bookingId: id }, 'Calendar or update email failed during reassignment');
      // Still try to send email without meeting link
      emailService.sendUpdate({
        guestName: booking.guest_name,
        guestEmail: booking.guest_email,
        slotStart: booking.slot_start.toISOString(),
        slotEnd: booking.slot_end.toISOString(),
        guestTz,
        venueName: booking.venue_name,
        venueAddress: booking.venue_address,
        meetingTypeLabel: booking.meeting_type_label || 'Training',
        meetingLink: null,
        replyTo: newStaff.email || undefined,
      }).catch(() => {});
    });

    // Invalidate cache
    availabilityCache.clear();

    logger.info({ bookingId: id, oldStaffId, newStaffId: newStaff.id, adminId: req.admin.id }, 'Booking reassigned');
    res.json({ message: 'Booking reassigned', booking: { ...booking, staff_member_id: newStaff.id, staff_name: newStaff.name } });
  } catch (err) { next(err); }
});

// POST /api/admin/bookings/:id/resend-confirmation
router.post('/bookings/:id/resend-confirmation', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT b.*, sm.email as staff_email
       FROM bookings b
       LEFT JOIN staff_members sm ON b.staff_member_id = sm.id
       WHERE b.id = $1`,
      [id]
    );

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
      replyTo: booking.staff_email || undefined,
      meetingLink: booking.meeting_link || null,
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
    const { name, label, duration_minutes, is_active, buffer_minutes, min_advance_minutes } = req.body;
    if (!name || !label || !duration_minutes) {
      return res.status(400).json({ error: 'name, label, and duration_minutes are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO meeting_types (name, label, duration_minutes, is_active, buffer_minutes, min_advance_minutes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, label, duration_minutes, is_active !== false, buffer_minutes || 0, min_advance_minutes != null ? min_advance_minutes : 60]
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
    const { name, label, duration_minutes, is_active, buffer_minutes, min_advance_minutes } = req.body;
    const { rows } = await pool.query(
      `UPDATE meeting_types SET
        name = COALESCE($1, name),
        label = COALESCE($2, label),
        duration_minutes = COALESCE($3, duration_minutes),
        is_active = COALESCE($4, is_active),
        buffer_minutes = COALESCE($5, buffer_minutes),
        min_advance_minutes = COALESCE($6, min_advance_minutes),
        updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [name, label, duration_minutes, is_active, buffer_minutes, min_advance_minutes, id]
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
