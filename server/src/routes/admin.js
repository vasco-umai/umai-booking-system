const { Router } = require('express');
const { DateTime } = require('luxon');
const { pool } = require('../config/db');
const logger = require('../lib/logger');
const { availabilityCache } = require('../lib/cache');
const { requireAdmin, requireRole, requireTeamLead, getEffectiveTeamId } = require('../middleware/auth');
const calendarService = require('../services/calendarService');
const emailService = require('../services/emailService');
const staffService = require('../services/staffService');
const pushover = require('../services/pushoverService');
const { buildCalendarCopy } = require('../lib/calendarCopy');

const router = Router();

// All admin routes require auth
router.use(requireAdmin);

// ── Teams ─────────────────────────────────────────

// GET /api/admin/teams
router.get('/teams', async (req, res, next) => {
  try {
    let query, params;
    if (req.admin.role === 'admin') {
      // Super admin sees all teams
      query = `SELECT t.*,
                 (SELECT COUNT(*) FROM staff_members sm WHERE sm.team_id = t.id) as member_count,
                 (SELECT au.name FROM admin_users au WHERE au.team_id = t.id AND au.team_role = 'lead' LIMIT 1) as lead_name,
                 (SELECT au.id FROM admin_users au WHERE au.team_id = t.id AND au.team_role = 'lead' LIMIT 1) as lead_id
               FROM teams t ORDER BY t.id`;
      params = [];
    } else {
      // Regular users see only their team
      query = `SELECT t.*,
                 (SELECT COUNT(*) FROM staff_members sm WHERE sm.team_id = t.id) as member_count,
                 (SELECT au.name FROM admin_users au WHERE au.team_id = t.id AND au.team_role = 'lead' LIMIT 1) as lead_name,
                 (SELECT au.id FROM admin_users au WHERE au.team_id = t.id AND au.team_role = 'lead' LIMIT 1) as lead_id
               FROM teams t WHERE t.id = $1`;
      params = [req.admin.teamId];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/admin/teams — create team (super admin only)
router.post('/teams', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, slug, lead_id } = req.body;
    if (!name || !slug) {
      return res.status(400).json({ error: 'name and slug are required' });
    }
    const { rows } = await pool.query(
      'INSERT INTO teams (name, slug) VALUES ($1, $2) RETURNING *',
      [name, slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')]
    );
    const team = rows[0];

    // Set team lead if provided
    if (lead_id) {
      await pool.query(
        `UPDATE admin_users SET team_role = 'lead', team_id = $1 WHERE id = $2`,
        [team.id, lead_id]
      );
    }

    res.status(201).json(team);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A team with this slug already exists' });
    }
    next(err);
  }
});

// PUT /api/admin/teams/:id — update team (super admin only)
router.put('/teams/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, slug, lead_id } = req.body;
    const teamId = parseInt(req.params.id);
    const { rows } = await pool.query(
      `UPDATE teams SET
        name = COALESCE($1, name),
        slug = COALESCE($2, slug),
        updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [name, slug ? slug.toLowerCase().replace(/[^a-z0-9-]/g, '-') : null, teamId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Team not found' });

    // Update team lead if provided
    if (lead_id !== undefined) {
      // Remove lead role from previous lead(s) on this team
      await pool.query(
        `UPDATE admin_users SET team_role = 'member' WHERE team_id = $1 AND team_role = 'lead'`,
        [teamId]
      );
      // Set new lead
      if (lead_id) {
        await pool.query(
          `UPDATE admin_users SET team_role = 'lead' WHERE id = $1 AND team_id = $2`,
          [lead_id, teamId]
        );
      }
    }

    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A team with this slug already exists' });
    }
    next(err);
  }
});

// DELETE /api/admin/teams/:id — delete team (super admin only, only if empty)
router.delete('/teams/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const teamId = parseInt(req.params.id);
    // Check for staff/bookings
    const { rows: [counts] } = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM staff_members WHERE team_id = $1) as staff_count,
        (SELECT COUNT(*) FROM bookings WHERE team_id = $1 AND status = 'confirmed') as booking_count`,
      [teamId]
    );
    if (parseInt(counts.staff_count) > 0 || parseInt(counts.booking_count) > 0) {
      return res.status(400).json({ error: 'Cannot delete team with active staff or bookings' });
    }
    const { rowCount } = await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Team not found' });
    res.json({ message: 'Team deleted' });
  } catch (err) { next(err); }
});

// ── Schedules ──────────────────────────────────────

// GET /api/admin/schedules?staff_member_id=1 (optional filter)
router.get('/schedules', async (req, res, next) => {
  try {
    const { staff_member_id } = req.query;
    const teamId = getEffectiveTeamId(req);
    let query = `SELECT s.*, sm.name as staff_name
                 FROM schedules s
                 LEFT JOIN staff_members sm ON s.staff_member_id = sm.id
                 WHERE s.team_id = $1`;
    const params = [teamId];

    if (staff_member_id === 'global') {
      query += ' AND s.staff_member_id IS NULL';
    } else if (staff_member_id) {
      params.push(parseInt(staff_member_id));
      query += ` AND s.staff_member_id = $${params.length}`;
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
    const teamId = getEffectiveTeamId(req);

    if (day_of_week == null || !start_time || !end_time) {
      return res.status(400).json({ error: 'day_of_week, start_time, and end_time are required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO schedules (day_of_week, start_time, end_time, slot_duration, timezone, is_active, staff_member_id, team_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [day_of_week, start_time, end_time, slot_duration || 60, timezone || 'Europe/Lisbon', is_active !== false, staff_member_id || null, teamId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/admin/schedules/:id
router.put('/schedules/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const teamId = getEffectiveTeamId(req);
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
       WHERE id = $7 AND team_id = $9 RETURNING *`,
      [day_of_week, start_time, end_time, slot_duration, timezone, is_active, id, staff_member_id !== undefined ? staff_member_id : null, teamId]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Schedule not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/admin/schedules/:id
router.delete('/schedules/:id', async (req, res, next) => {
  try {
    const teamId = getEffectiveTeamId(req);
    const { rowCount } = await pool.query('DELETE FROM schedules WHERE id = $1 AND team_id = $2', [req.params.id, teamId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ message: 'Schedule deleted' });
  } catch (err) { next(err); }
});

// ── Blocked Times ──────────────────────────────────

// GET /api/admin/blocked-times
router.get('/blocked-times', async (req, res, next) => {
  try {
    const teamId = getEffectiveTeamId(req);
    const { rows } = await pool.query('SELECT * FROM blocked_times WHERE team_id = $1 ORDER BY start_at DESC', [teamId]);
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/admin/blocked-times
router.post('/blocked-times', async (req, res, next) => {
  try {
    const { start_at, end_at, reason } = req.body;
    const teamId = getEffectiveTeamId(req);
    if (!start_at || !end_at) {
      return res.status(400).json({ error: 'start_at and end_at are required' });
    }
    const { rows } = await pool.query(
      'INSERT INTO blocked_times (start_at, end_at, reason, team_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [start_at, end_at, reason || null, teamId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/admin/blocked-times/:id
router.delete('/blocked-times/:id', async (req, res, next) => {
  try {
    const teamId = getEffectiveTeamId(req);
    const { rowCount } = await pool.query('DELETE FROM blocked_times WHERE id = $1 AND team_id = $2', [req.params.id, teamId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Blocked time not found' });
    res.json({ message: 'Blocked time deleted' });
  } catch (err) { next(err); }
});

// ── Staff Members (admin only) ─────────────────────

// GET /api/admin/staff
router.get('/staff', requireTeamLead, async (req, res, next) => {
  try {
    const teamId = getEffectiveTeamId(req);
    const staff = await staffService.getAllStaff(teamId);

    // Fetch invite/onboarding info from admin_users for all staff emails
    const emails = staff.map(s => s.email.toLowerCase());
    const { rows: adminRows } = await pool.query(
      `SELECT id as admin_user_id, email, must_set_password, password_hash, invite_token, invite_token_expires, role, team_role
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
        admin_user_id: admin?.admin_user_id || null,
        google_refresh_token: hasCalendar,
        onboarding_status,
        role: admin?.role || 'restricted',
        team_role: admin?.team_role || 'member',
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
router.post('/staff', requireTeamLead, async (req, res, next) => {
  try {
    const { name, email, meeting_pct, google_calendar_id, is_active, max_daily_meetings } = req.body;
    const teamId = getEffectiveTeamId(req);
    if (!name || !email) {
      return res.status(400).json({ error: 'name and email are required' });
    }
    const staff = await staffService.createStaff({
      name,
      email,
      meetingPct: meeting_pct != null ? meeting_pct : 100,
      googleCalendarId: google_calendar_id || null,
      isActive: is_active !== false,
      maxDailyMeetings: max_daily_meetings || 0,
      teamId,
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
router.post('/staff/:id/invite', requireTeamLead, async (req, res, next) => {
  try {
    const token = await staffService.regenerateInviteToken(req.params.id);
    if (!token) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ invite_token: token });
  } catch (err) { next(err); }
});

// PUT /api/admin/staff/:id
router.put('/staff/:id', requireTeamLead, async (req, res, next) => {
  try {
    const { name, email, meeting_pct, google_calendar_id, is_active, max_daily_meetings } = req.body;
    const staff = await staffService.updateStaff(req.params.id, {
      name,
      email,
      meetingPct: meeting_pct,
      googleCalendarId: google_calendar_id,
      isActive: is_active,
      maxDailyMeetings: max_daily_meetings,
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
router.delete('/staff/:id', requireTeamLead, async (req, res, next) => {
  try {
    const deleted = await staffService.deleteStaff(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ message: 'Staff member deleted' });
  } catch (err) { next(err); }
});

// ── Staff Duration Overrides ──────────────────────

// GET /api/admin/staff/:id/duration-overrides
router.get('/staff/:id/duration-overrides', requireTeamLead, async (req, res, next) => {
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
router.put('/staff/:id/duration-overrides', requireTeamLead, async (req, res, next) => {
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
    const teamId = getEffectiveTeamId(req);
    let query = `SELECT b.*, s.name as staff_name, mt.label as meeting_type_label
                 FROM bookings b
                 LEFT JOIN staff_members s ON b.staff_member_id = s.id
                 LEFT JOIN meeting_types mt ON b.meeting_type_id = mt.id
                 WHERE b.team_id = $1`;
    const params = [teamId];

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
    const teamId = getEffectiveTeamId(req);

    const { rows } = await pool.query(
      `UPDATE bookings SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND status = 'confirmed' AND team_id = $2 RETURNING *`,
      [id, teamId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found or already cancelled' });
    }

    const booking = rows[0];

    // Delete Google Calendar event (awaited so Vercel doesn't kill it)
    let staffEmail;
    if (booking.staff_member_id) {
      const staff = await staffService.getStaffById(booking.staff_member_id);
      if (staff) {
        staffEmail = staff.email;
        if (booking.gcal_event_id) {
          try {
            await calendarService.deleteEvent(booking.gcal_event_id, undefined, staff.google_refresh_token);
            await pool.query('UPDATE bookings SET gcal_event_id = NULL, meeting_link = NULL WHERE id = $1', [id]);
          } catch (err) {
            logger.error({ err, bookingId: id }, 'Failed to delete calendar event on cancel');
          }
        }
      }
    } else if (booking.gcal_event_id) {
      try {
        await calendarService.deleteEvent(booking.gcal_event_id);
        await pool.query('UPDATE bookings SET gcal_event_id = NULL, meeting_link = NULL WHERE id = $1', [id]);
      } catch (err) {
        logger.error({ err, bookingId: id }, 'Failed to delete calendar event on cancel');
      }
    }

    // Invalidate availability cache
    availabilityCache.clear();

    // Send cancellation email (awaited)
    try {
      await emailService.sendCancellation({
        guestName: booking.guest_name,
        guestEmail: booking.guest_email,
        slotStart: booking.slot_start.toISOString(),
        guestTz: booking.guest_tz,
        replyTo: staffEmail || undefined,
        lang: booking.lang,
      });
    } catch (err) {
      logger.error({ err, bookingId: id }, 'Failed to send cancellation email');
    }

    // Notify assigned staff that their booking was cancelled
    if (staffEmail) {
      try {
        const staff = await staffService.getStaffById(booking.staff_member_id);
        await emailService.sendStaffCancellation({
          staffEmail,
          staffName: staff?.name,
          guestName: booking.guest_name,
          guestEmail: booking.guest_email,
          slotStart: booking.slot_start.toISOString(),
          staffTz: staff?.timezone || undefined,
          bookingId: booking.id,
        });
      } catch (err) {
        logger.error({ err, bookingId: id, staffEmail }, 'Staff cancellation notification failed');
      }
    }

    logger.info({ bookingId: booking.id, adminId: req.admin.id }, 'Booking cancelled');

    await pushover.sendNotification({
      title: 'Booking Cancelled',
      message: `${booking.guest_name} - ${booking.venue_name || '-'}\nSlot: ${DateTime.fromJSDate(booking.slot_start, { zone: booking.guest_tz || 'Europe/Lisbon' }).toFormat('dd/MM HH:mm')}`,
    });

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

    const teamId = getEffectiveTeamId(req);

    // Get the booking
    const { rows: bookingRows } = await pool.query(
      `SELECT b.*, mt.label as meeting_type_label, mt.name as meeting_type_name
       FROM bookings b
       LEFT JOIN meeting_types mt ON b.meeting_type_id = mt.id
       WHERE b.id = $1 AND b.status = 'confirmed' AND b.team_id = $2`,
      [id, teamId]
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

    // Resolve old staff once, reused below for gcal token + pushover message
    const oldStaff = oldStaffId ? await staffService.getStaffById(oldStaffId).catch(() => null) : null;

    // Update the booking
    await pool.query(
      'UPDATE bookings SET staff_member_id = $1, updated_at = NOW() WHERE id = $2',
      [newStaff.id, id]
    );

    // Delete old calendar event if exists
    if (booking.gcal_event_id) {
      calendarService.deleteEvent(booking.gcal_event_id, undefined, oldStaff?.google_refresh_token).catch(() => {});
    }

    // Build calendar copy (summary + description) in customer language
    const isMini = booking.plan === 'mini';
    const isOnline = booking.meeting_type_label === 'Online' || booking.meeting_type_label === 'Freemium' || isMini;
    const guestTz = booking.guest_tz || 'UTC';
    const { summary: calSummary, description: calendarDescription } = buildCalendarCopy({
      lang: booking.lang,
      slotStartIso: booking.slot_start.toISOString(),
      guestTz,
      plan: booking.plan,
      meetingTypeLabel: booking.meeting_type_label,
      venueName: booking.venue_name,
      venueAddress: booking.venue_address,
      guestName: booking.guest_name,
    });

    // Notify old staff that the booking was taken off their schedule
    if (oldStaffId) {
      staffService.getStaffById(oldStaffId).then(oldStaff => {
        if (oldStaff?.email) {
          return emailService.sendStaffCancellation({
            staffEmail: oldStaff.email,
            staffName: oldStaff.name,
            guestName: booking.guest_name,
            guestEmail: booking.guest_email,
            slotStart: booking.slot_start.toISOString(),
            staffTz: oldStaff.timezone || undefined,
            bookingId: booking.id,
          });
        }
      }).catch(err => logger.error({ err, bookingId: id, oldStaffId }, 'Old-staff reassignment notification failed'));
    }

    // Create new calendar event on new staff's calendar, then send update email
    calendarService.createEvent({
      summary: calSummary,
      description: calendarDescription,
      startTime: booking.slot_start.toISOString(),
      endTime: booking.slot_end.toISOString(),
      attendeeEmail: booking.guest_email,
      staffEmail: newStaff.email,
      timeZone: guestTz,
      staffRefreshToken: newStaff.google_refresh_token,
      addConference: isOnline,
    }).then(({ eventId, hangoutLink, failed }) => {
      if (eventId) {
        pool.query('UPDATE bookings SET gcal_event_id = $1, gcal_sync_failed = false, meeting_link = $2 WHERE id = $3', [eventId, hangoutLink, id]);
      } else if (failed) {
        pool.query('UPDATE bookings SET gcal_event_id = NULL, gcal_sync_failed = true, meeting_link = NULL WHERE id = $1', [id]);
      }

      const resolvedMeetingLink = hangoutLink || booking.meeting_link || null;

      // Send update email to the guest
      const guestEmailPromise = emailService.sendUpdate({
        guestName: booking.guest_name,
        guestEmail: booking.guest_email,
        slotStart: booking.slot_start.toISOString(),
        slotEnd: booking.slot_end.toISOString(),
        guestTz,
        venueName: booking.venue_name,
        venueAddress: booking.venue_address,
        meetingTypeLabel: booking.meeting_type_label || 'Training',
        meetingLink: resolvedMeetingLink,
        replyTo: newStaff.email || undefined,
        lang: booking.lang,
      });

      // Notify the new staff member they now own this booking
      const staffEmailPromise = newStaff.email ? emailService.sendStaffNewBooking({
        staffEmail: newStaff.email,
        staffName: newStaff.name,
        guestName: booking.guest_name,
        guestEmail: booking.guest_email,
        guestPhone: booking.guest_phone,
        slotStart: booking.slot_start.toISOString(),
        slotEnd: booking.slot_end.toISOString(),
        staffTz: newStaff.timezone || undefined,
        venueName: booking.venue_name,
        venueAddress: booking.venue_address,
        meetingTypeLabel: booking.meeting_type_label || 'Training',
        meetingLink: resolvedMeetingLink,
        bookingId: booking.id,
      }) : Promise.resolve();

      return Promise.all([guestEmailPromise, staffEmailPromise]);
    }).catch(err => {
      logger.error({ err, bookingId: id }, 'Calendar or update email failed during reassignment');
      // Still try to send emails without meeting link
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
        lang: booking.lang,
      }).catch(() => {});
      if (newStaff.email) {
        emailService.sendStaffNewBooking({
          staffEmail: newStaff.email,
          staffName: newStaff.name,
          guestName: booking.guest_name,
          guestEmail: booking.guest_email,
          guestPhone: booking.guest_phone,
          slotStart: booking.slot_start.toISOString(),
          slotEnd: booking.slot_end.toISOString(),
          staffTz: newStaff.timezone || undefined,
          venueName: booking.venue_name,
          venueAddress: booking.venue_address,
          meetingTypeLabel: booking.meeting_type_label || 'Training',
          meetingLink: null,
          bookingId: booking.id,
        }).catch(() => {});
      }
    });

    // Invalidate cache
    availabilityCache.clear();

    logger.info({ bookingId: id, oldStaffId, newStaffId: newStaff.id, adminId: req.admin.id }, 'Booking reassigned');

    await pushover.sendNotification({
      title: 'Booking Reassigned',
      message: `${booking.guest_name} - ${booking.venue_name || '-'}\n${oldStaff?.name || 'unassigned'} → ${newStaff.name}`,
    });

    res.json({ message: 'Booking reassigned', booking: { ...booking, staff_member_id: newStaff.id, staff_name: newStaff.name } });
  } catch (err) { next(err); }
});

// POST /api/admin/bookings/:id/resend-confirmation
router.post('/bookings/:id/resend-confirmation', async (req, res, next) => {
  try {
    const { id } = req.params;
    const teamId = getEffectiveTeamId(req);
    const { rows } = await pool.query(
      `SELECT b.*, sm.email as staff_email
       FROM bookings b
       LEFT JOIN staff_members sm ON b.staff_member_id = sm.id
       WHERE b.id = $1 AND b.team_id = $2`,
      [id, teamId]
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
      lang: booking.lang,
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
    const teamId = getEffectiveTeamId(req);
    // Super admin sees all teams' meeting types with team name; others see only their team
    let typesQuery;
    let typesParams;
    if (req.admin.role === 'admin' && !req.query.team_id) {
      typesQuery = 'SELECT mt.*, t.name as team_name, t.slug as team_slug FROM meeting_types mt LEFT JOIN teams t ON t.id = mt.team_id ORDER BY mt.team_id, mt.id';
      typesParams = [];
    } else {
      typesQuery = 'SELECT mt.*, t.name as team_name, t.slug as team_slug FROM meeting_types mt LEFT JOIN teams t ON t.id = mt.team_id WHERE mt.team_id = $1 ORDER BY mt.id';
      typesParams = [teamId];
    }
    const { rows: types } = await pool.query(typesQuery, typesParams);
    const typeIds = types.map(t => t.id);
    const { rows: planMappings } = await pool.query(
      'SELECT * FROM plan_meeting_types WHERE meeting_type_id = ANY($1) ORDER BY meeting_type_id, plan_name', [typeIds]
    );
    const { rows: schedules } = await pool.query(
      'SELECT * FROM meeting_type_schedules WHERE meeting_type_id = ANY($1) ORDER BY meeting_type_id, day_of_week', [typeIds]
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
    const { name, label, duration_minutes, is_active, buffer_minutes, min_advance_minutes, max_daily_meetings } = req.body;
    const teamId = getEffectiveTeamId(req);
    if (!name || !label || !duration_minutes) {
      return res.status(400).json({ error: 'name, label, and duration_minutes are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO meeting_types (name, label, duration_minutes, is_active, buffer_minutes, min_advance_minutes, max_daily_meetings, team_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, label, duration_minutes, is_active !== false, buffer_minutes || 0, min_advance_minutes != null ? min_advance_minutes : 60, max_daily_meetings || 0, teamId]
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
    const teamId = getEffectiveTeamId(req);
    const { name, label, duration_minutes, is_active, buffer_minutes, min_advance_minutes, max_daily_meetings } = req.body;
    const { rows } = await pool.query(
      `UPDATE meeting_types SET
        name = COALESCE($1, name),
        label = COALESCE($2, label),
        duration_minutes = COALESCE($3, duration_minutes),
        is_active = COALESCE($4, is_active),
        buffer_minutes = COALESCE($5, buffer_minutes),
        min_advance_minutes = COALESCE($6, min_advance_minutes),
        max_daily_meetings = COALESCE($7, max_daily_meetings),
        updated_at = NOW()
       WHERE id = $8 AND team_id = $9 RETURNING *`,
      [name, label, duration_minutes, is_active, buffer_minutes, min_advance_minutes, max_daily_meetings, id, teamId]
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
    const teamId = getEffectiveTeamId(req);
    const { rowCount } = await pool.query('DELETE FROM meeting_types WHERE id = $1 AND team_id = $2', [req.params.id, teamId]);
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

// GET /api/admin/meeting-types/:id/weights  — staff weights for this meeting type
router.get('/meeting-types/:id/weights', requireTeamLead, async (req, res, next) => {
  try {
    const meetingTypeId = parseInt(req.params.id);
    const teamId = getEffectiveTeamId(req);

    const { rows } = await pool.query(
      `SELECT sm.id, sm.name, sm.email, sm.meeting_pct,
              COALESCE(smw.weight, sm.meeting_pct) as weight
       FROM staff_members sm
       LEFT JOIN staff_meeting_weights smw ON smw.staff_member_id = sm.id AND smw.meeting_type_id = $1
       WHERE sm.team_id = $2 AND sm.is_active = true
       ORDER BY sm.name`,
      [meetingTypeId, teamId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// PUT /api/admin/meeting-types/:id/weights  — bulk upsert staff weights
router.put('/meeting-types/:id/weights', requireTeamLead, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const meetingTypeId = parseInt(req.params.id);
    const { weights } = req.body; // [{staff_member_id, weight}]

    if (!Array.isArray(weights)) {
      return res.status(400).json({ error: 'weights must be an array of {staff_member_id, weight}' });
    }

    await client.query('BEGIN');

    // Delete existing weights for this meeting type
    await client.query('DELETE FROM staff_meeting_weights WHERE meeting_type_id = $1', [meetingTypeId]);

    // Insert new weights
    for (const w of weights) {
      if (w.staff_member_id && w.weight != null) {
        await client.query(
          `INSERT INTO staff_meeting_weights (staff_member_id, meeting_type_id, weight)
           VALUES ($1, $2, $3)`,
          [w.staff_member_id, meetingTypeId, w.weight]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Weights updated' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
