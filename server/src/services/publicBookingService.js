const crypto = require('crypto');
const { DateTime } = require('luxon');
const { pool } = require('../config/db');
const logger = require('../lib/logger');
const { AppError, ErrorCodes } = require('../lib/errors');
const { availabilityCache } = require('../lib/cache');
const calendarService = require('./calendarService');
const emailService = require('./emailService');
const staffService = require('./staffService');
const pushover = require('./pushoverService');

// Stable 32-bit integer lock key derived from the slot bounds. Two concurrent
// requests targeting the same slot will serialize on this key via
// pg_advisory_xact_lock, so we never issue two confirmed bookings for it.
function slotLockKey(slotStartIso, slotEndIso) {
  const canonical = `${DateTime.fromISO(slotStartIso).toUTC().toISO()}|${DateTime.fromISO(slotEndIso).toUTC().toISO()}`;
  const digest = crypto.createHash('sha1').update(canonical).digest();
  return digest.readInt32BE(0);
}

function redactEmail(email) {
  if (!email || typeof email !== 'string') return 'unknown';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${(local || '').slice(0, 2)}***@${domain}`;
}

/**
 * Create a booking from a trusted public-API caller (e.g. the AI voice agent).
 *
 * Differences vs the funnel's /api/bookings handler:
 *   - team_id comes from the API key (not request body)
 *   - reduced input surface: no venue/company/plan/addons/lang fields
 *   - slot_end is derived server-side from meeting_type.duration_minutes
 *   - no Pushover success notification (too noisy for high-volume AI agent
 *     traffic); we DO still fire a Pushover alert on hard failures so we don't
 *     silently lose bookings
 *
 * Shared with the funnel flow:
 *   - staff auto-assignment (staffService.selectStaffForSlot, weighted)
 *   - conflict check (with buffer)
 *   - Google Calendar event creation
 *   - confirmation email to the guest
 *   - staff new-booking notification email
 *
 * Throws AppError on business-logic failures; the route's error envelope
 * renders them as { error: { code, message, request_id } }.
 */
async function createBooking(input) {
  const {
    teamId,
    meetingTypeId,
    slotStartIso,
    guestName,
    guestEmail,
    guestPhone,
    guestTz,
    lang,
  } = input;

  // --- Load meeting type (team-scoped) ---
  const { rows: mtRows } = await pool.query(
    `SELECT id, name, label, duration_minutes, buffer_minutes, max_daily_meetings, is_active
       FROM meeting_types
      WHERE id = $1 AND team_id = $2`,
    [meetingTypeId, teamId]
  );
  if (mtRows.length === 0 || !mtRows[0].is_active) {
    throw new AppError('Meeting type not found for this team.', 404, ErrorCodes.MEETING_TYPE_NOT_FOUND);
  }
  const mt = mtRows[0];
  const bufferMinutes = mt.buffer_minutes || 0;
  const maxDailyMeetings = mt.max_daily_meetings || 0;

  // --- Derive slot_end from meeting type duration ---
  const slotStartDt = DateTime.fromISO(slotStartIso, { zone: 'utc' });
  if (!slotStartDt.isValid) {
    throw new AppError('Invalid slot_start (expected ISO 8601).', 400, ErrorCodes.INVALID_DATE);
  }
  if (slotStartDt.toMillis() <= Date.now()) {
    throw new AppError('Cannot book a slot in the past.', 400, ErrorCodes.SLOT_IN_PAST);
  }
  const slotEndDt = slotStartDt.plus({ minutes: mt.duration_minutes });
  const slotStart = slotStartDt.toISO();
  const slotEnd = slotEndDt.toISO();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [slotLockKey(slotStart, slotEnd)]);

    const assignedStaff = await staffService.selectStaffForSlot(
      slotStart,
      slotEnd,
      bufferMinutes,
      maxDailyMeetings,
      { teamId, meetingTypeId: mt.id }
    );

    // --- Conflict check (any confirmed booking on the same staff overlapping the slot+buffer) ---
    let conflictQuery;
    const conflictParams = [slotStart, slotEnd];
    if (bufferMinutes > 0) {
      conflictQuery = `SELECT id FROM bookings WHERE status = 'confirmed'
         AND slot_start < ($2::timestamptz + $3 * interval '1 minute')
         AND slot_end   > ($1::timestamptz - $3 * interval '1 minute')`;
      conflictParams.push(bufferMinutes);
    } else {
      conflictQuery = `SELECT id FROM bookings WHERE status = 'confirmed'
         AND slot_start < $2 AND slot_end > $1`;
    }
    if (assignedStaff) {
      conflictQuery += ` AND staff_member_id = $${conflictParams.length + 1}`;
      conflictParams.push(assignedStaff.id);
    }
    const { rows: conflicts } = await client.query(conflictQuery, conflictParams);
    if (conflicts.length > 0) {
      await client.query('ROLLBACK');
      throw new AppError('Slot is no longer available.', 409, ErrorCodes.SLOT_CONFLICT);
    }

    if (!assignedStaff) {
      await client.query('ROLLBACK');
      throw new AppError('No sales rep is available for this slot.', 409, ErrorCodes.SLOT_CONFLICT);
    }

    // --- Insert booking ---
    const { rows: insertRows } = await client.query(
      `INSERT INTO bookings (guest_name, guest_email, guest_phone, slot_start, slot_end, guest_tz,
                             staff_member_id, meeting_type_id, team_id, lang)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [guestName, guestEmail, guestPhone || null, slotStart, slotEnd, guestTz,
       assignedStaff.id, mt.id, teamId, lang || null]
    );
    const booking = insertRows[0];
    await client.query('COMMIT');

    logger.info({
      bookingId: booking.id,
      staffId: assignedStaff.id,
      teamId,
      meetingTypeId: mt.id,
      guest: redactEmail(guestEmail),
    }, '[PUBLIC_API] Booking created');

    availabilityCache.clear();

    // --- Google Calendar (awaited, failures tracked on the booking row) ---
    const meetingTypeLabel = mt.label;
    const isOnline = meetingTypeLabel === 'Online';
    const { summary, description: calendarDescription } = buildMinimalCalendarCopy({
      guestName,
      meetingTypeLabel: meetingTypeLabel || mt.name,
    });

    let meetingLink = null;
    let gcalFailed = false;
    try {
      const { eventId, hangoutLink, failed } = await calendarService.createEvent({
        summary,
        description: calendarDescription,
        startTime: slotStart,
        endTime: slotEnd,
        attendeeEmail: guestEmail,
        staffEmail: assignedStaff.email,
        timeZone: guestTz,
        staffRefreshToken: assignedStaff.google_refresh_token,
        addConference: isOnline,
      });
      if (eventId) {
        meetingLink = hangoutLink || null;
        await pool.query(
          'UPDATE bookings SET gcal_event_id = $1, gcal_sync_failed = false, meeting_link = $2 WHERE id = $3',
          [eventId, meetingLink, booking.id]
        );
      } else if (failed) {
        gcalFailed = true;
        await pool.query('UPDATE bookings SET gcal_sync_failed = true WHERE id = $1', [booking.id]);
      }
    } catch (err) {
      gcalFailed = true;
      await pool.query('UPDATE bookings SET gcal_sync_failed = true WHERE id = $1', [booking.id]);
      logger.error({ err, bookingId: booking.id }, 'GCal event creation failed (public API)');
    }

    // --- Confirmation email to guest ---
    let confirmationSent = false;
    try {
      confirmationSent = await emailService.sendConfirmation({
        guestName,
        guestEmail,
        slotStart,
        slotEnd,
        guestTz,
        venueName: null,
        replyTo: assignedStaff.email,
        meetingLink,
        lang: lang || 'en',
      });
      await pool.query(
        'UPDATE bookings SET confirmation_email_sent = $1 WHERE id = $2',
        [confirmationSent, booking.id]
      );
    } catch (err) {
      confirmationSent = false;
      logger.error({ err, bookingId: booking.id }, 'Confirmation email failed (public API)');
    }

    // --- Staff notification email (failure must not block response) ---
    if (assignedStaff.email) {
      try {
        await emailService.sendStaffNewBooking({
          staffEmail: assignedStaff.email,
          staffName: assignedStaff.name,
          guestName,
          guestEmail,
          guestPhone,
          slotStart,
          slotEnd,
          staffTz: assignedStaff.timezone || undefined,
          venueName: null,
          venueAddress: null,
          meetingTypeLabel,
          meetingLink,
          bookingId: booking.id,
        });
      } catch (err) {
        logger.error({ err, bookingId: booking.id }, 'Staff notification email failed (public API)');
      }
    }

    // --- Pushover: alert on hard failures only (avoid alert-spam on volume) ---
    if (gcalFailed || !confirmationSent) {
      const pushDateDisplay = slotStartDt.setZone(guestTz || 'Europe/Lisbon').toFormat('dd/MM HH:mm');
      const issues = [gcalFailed && 'GCal sync failed', !confirmationSent && 'Email failed'].filter(Boolean).join(', ');
      await pushover.sendNotification({
        title: 'Public API Booking Warning',
        message: `${guestName} - ${pushDateDisplay}\nStaff: ${assignedStaff.name}\nIssues: ${issues}`,
        priority: 1,
      });
    }

    return {
      booking_id: booking.id,
      slot_start: booking.slot_start,
      slot_end: booking.slot_end,
      status: booking.status,
      staff: { name: assignedStaff.name, email: assignedStaff.email },
      meeting_link: meetingLink,
      meeting_type: { id: mt.id, name: mt.name, label: mt.label },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Minimal calendar copy for public API bookings. The funnel handler uses a
// richer multi-language/venue-aware builder; the AI agent flow doesn't have
// venue context, so we keep the summary plain.
function buildMinimalCalendarCopy({ guestName, meetingTypeLabel }) {
  const summary = `UMAI ${meetingTypeLabel} — ${guestName}`;
  const description = `Booked via UMAI Public API. Meeting type: ${meetingTypeLabel}.`;
  return { summary, description };
}

module.exports = { createBooking };
