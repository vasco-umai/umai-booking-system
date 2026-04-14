const { Router } = require('express');
const crypto = require('crypto');
const { DateTime } = require('luxon');
const { pool } = require('../config/db');
const logger = require('../lib/logger');
const { availabilityCache } = require('../lib/cache');
const calendarService = require('../services/calendarService');
const emailService = require('../services/emailService');
const staffService = require('../services/staffService');
const { isValidEmail, stripHtml } = require('../middleware/validate');

const router = Router();

// POST /api/bookings
router.post('/', async (req, res, next) => {
  const client = await pool.connect();

  try {
    let { guest_name, guest_email, guest_phone, venue_name, venue_address, company, slot_start, slot_end, guest_tz, plan, meeting_type_id, addons, staff_member_id } = req.body;

    // Sanitize string inputs to prevent XSS in emails/calendar events
    guest_name = stripHtml(guest_name);
    venue_name = stripHtml(venue_name);
    venue_address = stripHtml(venue_address);
    company = stripHtml(company);

    // Validate required fields
    if (!guest_name || !guest_email || !slot_start || !slot_end) {
      return res.status(400).json({
        error: 'Missing required fields: guest_name, guest_email, slot_start, slot_end',
        code: 'MISSING_FIELDS'
      });
    }

    // Validate email format
    if (!isValidEmail(guest_email)) {
      return res.status(400).json({ error: 'Invalid email format', code: 'INVALID_EMAIL' });
    }

    // Validate slot times
    const start = DateTime.fromISO(slot_start);
    const end = DateTime.fromISO(slot_end);
    if (!start.isValid || !end.isValid || start >= end) {
      return res.status(400).json({ error: 'Invalid slot times', code: 'INVALID_DATE' });
    }

    // Check slot is in the future
    if (start <= DateTime.utc()) {
      return res.status(400).json({ error: 'Cannot book a slot in the past', code: 'SLOT_IN_PAST' });
    }

    await client.query('BEGIN');

    // Advisory lock: MD5 hash of slot times to avoid collisions
    const lockSeed = `${slot_start}:${slot_end}`;
    const lockHash = crypto.createHash('md5').update(lockSeed).digest();
    const lockKey = Math.abs(lockHash.readInt32BE(0));
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

    // Look up meeting type label and buffer before staff assignment and conflict check
    let meetingTypeLabel = null;
    let bufferMinutes = 0;
    if (meeting_type_id) {
      const { rows: mtRows } = await client.query('SELECT label, buffer_minutes FROM meeting_types WHERE id = $1', [meeting_type_id]);
      if (mtRows.length > 0) {
        meetingTypeLabel = mtRows[0].label;
        bufferMinutes = mtRows[0].buffer_minutes || 0;
      }
    }

    // Assign a staff member: use specified staff if provided, otherwise weighted distribution
    let assignedStaff;
    if (staff_member_id) {
      const activeStaff = await staffService.getActiveStaffWithCalendar();
      assignedStaff = activeStaff.find(s => s.id === parseInt(staff_member_id, 10)) || null;
      if (!assignedStaff) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Requested staff member is not available', code: 'INVALID_STAFF' });
      }
    } else {
      assignedStaff = await staffService.selectStaffForSlot(slot_start, slot_end, bufferMinutes);
    }

    // Check for conflicting confirmed bookings (including buffer zone)
    let conflictQuery;
    const conflictParams = [slot_start, slot_end];

    if (bufferMinutes > 0) {
      conflictQuery = `SELECT id FROM bookings WHERE status = 'confirmed' AND slot_start < ($2::timestamptz + $3 * interval '1 minute') AND slot_end > ($1::timestamptz - $3 * interval '1 minute')`;
      conflictParams.push(bufferMinutes);
    } else {
      conflictQuery = `SELECT id FROM bookings WHERE status = 'confirmed' AND slot_start < $2 AND slot_end > $1`;
    }

    if (assignedStaff) {
      conflictQuery += ` AND staff_member_id = $${conflictParams.length + 1}`;
      conflictParams.push(assignedStaff.id);
    }

    const { rows: conflicts } = await client.query(conflictQuery, conflictParams);

    if (conflicts.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This time slot is no longer available. Please select another slot.', code: 'SLOT_CONFLICT' });
    }

    // Insert the booking
    const { rows } = await client.query(
      `INSERT INTO bookings (guest_name, guest_email, guest_phone, venue_name, venue_address, company, slot_start, slot_end, guest_tz, staff_member_id, plan, meeting_type_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [guest_name, guest_email, guest_phone || null, venue_name || null, venue_address || null, company || null, slot_start, slot_end, guest_tz || 'UTC', assignedStaff ? assignedStaff.id : null, plan || null, meeting_type_id || null]
    );

    await client.query('COMMIT');

    const booking = rows[0];
    logger.info({ bookingId: booking.id, staffId: assignedStaff?.id }, 'Booking created');

    // Invalidate availability cache since a new booking was made
    availabilityCache.clear();

    // Build calendar event description based on plan and meeting type
    const isMini = plan === 'mini';
    const isOnline = meetingTypeLabel === 'Online' || isMini;
    const guestDt = DateTime.fromISO(slot_start, { zone: guest_tz || 'UTC' });
    const formattedDay = guestDt.toFormat('MMMM d');
    const formattedTime = guestDt.toFormat('HH:mm');

    let calendarDescription;
    if (isMini) {
      calendarDescription = `We confirm our training session on day ${formattedDay}, online, at ${formattedTime}.\n\nThe setup and training session will last approximately 1 hour, divided as follows:\n- 30 to 40 minutes: UMAI account setup\n- 15 to 20 minutes: team training`;
    } else if (isOnline) {
      calendarDescription = `We confirm our training session on day ${formattedDay}, online, at ${formattedTime}.\n\nThe setup and training session will last approximately 2 hours, divided as follows:\n- 1h15 to 1h30: UMAI account setup\n- 30 to 45 minutes: team training`;
    } else {
      calendarDescription = `We confirm our training session on day ${formattedDay}, at ${venue_address || venue_name || 'the venue'}, at ${formattedTime}.\n\nThe setup and training session will last approximately 2 hours, divided as follows:\n- 1h15 to 1h30: UMAI account setup\n- 30 to 45 minutes: team training`;
    }

    if (Array.isArray(addons) && addons.length > 0) {
      calendarDescription += `\n\nAdd-ons:\n` + addons.map(a => `- ${stripHtml(a)}`).join('\n');
    }

    // Create Google Calendar event (awaited so Vercel doesn't kill the function)
    let meetingLink = null;
    try {
      const { eventId, hangoutLink, failed } = await calendarService.createEvent({
        summary: `UMAI x ${venue_name || guest_name} - Setup and Settings Adjustments`,
        description: calendarDescription,
        startTime: slot_start,
        endTime: slot_end,
        attendeeEmail: guest_email,
        timeZone: guest_tz || 'UTC',
        staffRefreshToken: assignedStaff?.google_refresh_token,
        addConference: isOnline,
      });

      if (eventId) {
        meetingLink = hangoutLink || null;
        await pool.query('UPDATE bookings SET gcal_event_id = $1, gcal_sync_failed = false, meeting_link = $2 WHERE id = $3', [eventId, meetingLink, booking.id]);
      } else if (failed) {
        await pool.query('UPDATE bookings SET gcal_sync_failed = true WHERE id = $1', [booking.id]);
        logger.error({ bookingId: booking.id, staffName: assignedStaff?.name }, 'GCal sync failed for booking');
      }
    } catch (err) {
      await pool.query('UPDATE bookings SET gcal_sync_failed = true WHERE id = $1', [booking.id]);
      logger.error({ err, bookingId: booking.id }, 'GCal event creation failed');
    }

    // Send confirmation email (awaited so it completes before Vercel terminates)
    try {
      const sent = await emailService.sendConfirmation({
        guestName: guest_name,
        guestEmail: guest_email,
        slotStart: slot_start,
        slotEnd: slot_end,
        guestTz: guest_tz || 'UTC',
        venueName: venue_name,
        replyTo: assignedStaff?.email || undefined,
        meetingLink,
      });
      await pool.query('UPDATE bookings SET confirmation_email_sent = $1 WHERE id = $2', [sent, booking.id]);
    } catch (err) {
      await pool.query('UPDATE bookings SET confirmation_email_sent = false WHERE id = $1', [booking.id]);
      logger.error({ err, bookingId: booking.id }, 'Confirmation email failed');
    }

    res.status(201).json({
      message: 'Booking confirmed',
      booking: {
        id: booking.id,
        slot_start: booking.slot_start,
        slot_end: booking.slot_end,
        status: booking.status,
        staff_name: assignedStaff?.name?.trim() || null,
        meeting_link: meetingLink,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
