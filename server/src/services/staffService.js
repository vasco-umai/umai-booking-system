const crypto = require('crypto');
const { DateTime } = require('luxon');
const { pool } = require('../config/db');
const logger = require('../lib/logger');
const calendarService = require('./calendarService');

// Emails that must always have admin role -- prevents accidental role loss
const PROTECTED_ADMIN_EMAILS = [
  'admin@umai.io',
  'margarida.c@letsumai.com',
];

// ---------------------------------------------------------------------------
// CRUD Operations
// ---------------------------------------------------------------------------

/**
 * Get all staff members, ordered by name.
 * @returns {Array<object>}
 */
async function getAllStaff() {
  const { rows } = await pool.query('SELECT * FROM staff_members ORDER BY name');
  return rows;
}

/**
 * Get active staff members who have a linked Google Calendar and a positive
 * meeting percentage. These are the staff eligible for meeting assignment.
 * @returns {Array<object>}
 */
async function getActiveStaffWithCalendar() {
  const { rows } = await pool.query(
    `SELECT * FROM staff_members
     WHERE is_active = true
       AND google_refresh_token IS NOT NULL
       AND meeting_pct > 0
     ORDER BY name`
  );
  return rows;
}

/**
 * Get a single staff member by ID.
 * @param {number} id
 * @returns {object|null}
 */
async function getStaffById(id) {
  const { rows } = await pool.query(
    'SELECT * FROM staff_members WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

/**
 * Create a new staff member.
 * @param {object} data
 * @param {string} data.name
 * @param {string} data.email
 * @param {number} [data.meetingPct=100]
 * @param {string|null} [data.googleCalendarId]
 * @param {boolean} [data.isActive=true]
 * @returns {object} The created staff row.
 */
async function createStaff({ name, email, meetingPct = 100, googleCalendarId = null, isActive = true }) {
  const { rows } = await pool.query(
    `INSERT INTO staff_members (name, email, meeting_pct, google_calendar_id, is_active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [name, email, meetingPct, googleCalendarId, isActive]
  );

  // Also create an admin_users login so the team member can log in
  const inviteToken = crypto.randomBytes(32).toString('hex');
  const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const { rows: existingAdmin } = await pool.query(
    'SELECT id, password_hash, must_set_password, role FROM admin_users WHERE LOWER(email) = LOWER($1)',
    [email]
  );

  if (existingAdmin.length === 0) {
    // New user -- create admin_users record with appropriate role
    const role = PROTECTED_ADMIN_EMAILS.includes(email.toLowerCase()) ? 'admin' : 'restricted';
    await pool.query(
      `INSERT INTO admin_users (email, password_hash, name, must_set_password, role, invite_token, invite_token_expires)
       VALUES (LOWER($1), NULL, $2, true, $3, $4, $5)`,
      [email, name, role, inviteToken, inviteExpires]
    );
  } else {
    const admin = existingAdmin[0];
    // Only regenerate invite token if user hasn't completed onboarding yet
    if (admin.must_set_password || !admin.password_hash) {
      await pool.query(
        'UPDATE admin_users SET invite_token = $1, invite_token_expires = $2 WHERE id = $3',
        [inviteToken, inviteExpires, admin.id]
      );
    }
    // If already onboarded: don't touch their record at all
  }

  return { ...rows[0], invite_token: existingAdmin.length === 0 ? inviteToken : null };
}

/**
 * Update an existing staff member. Only the provided fields are changed;
 * omitted fields retain their current values via COALESCE.
 * @param {number} id
 * @param {object} data
 * @param {string}  [data.name]
 * @param {string}  [data.email]
 * @param {number}  [data.meetingPct]
 * @param {string|null} [data.googleCalendarId]
 * @param {boolean} [data.isActive]
 * @returns {object|null} The updated row, or null if not found.
 */
async function updateStaff(id, { name, email, meetingPct, googleCalendarId, isActive }) {
  const { rows } = await pool.query(
    `UPDATE staff_members
     SET name               = COALESCE($2, name),
         email              = COALESCE($3, email),
         meeting_pct        = COALESCE($4, meeting_pct),
         google_calendar_id = COALESCE($5, google_calendar_id),
         is_active          = COALESCE($6, is_active),
         updated_at         = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, name, email, meetingPct, googleCalendarId, isActive]
  );
  return rows[0] || null;
}

/**
 * Delete a staff member by ID.
 * @param {number} id
 * @returns {boolean} True if a row was deleted, false otherwise.
 */
async function deleteStaff(id) {
  const { rowCount } = await pool.query(
    'DELETE FROM staff_members WHERE id = $1',
    [id]
  );
  return rowCount > 0;
}

// ---------------------------------------------------------------------------
// Weighted Distribution
// ---------------------------------------------------------------------------

/**
 * Select the best staff member to handle a meeting slot using a self-balancing
 * weighted random algorithm.
 *
 * Algorithm overview:
 *   1. Fetch all eligible (active + calendar-linked) staff.
 *   2. Check each staff member's own schedule (or global fallback) to see if
 *      the slot falls within their working hours.
 *   3. Check each staff member's Google Calendar for conflicts.
 *   4. Among those who are free, pull confirmed booking counts from the last
 *      30 days and compute an adjusted weight that steers assignment toward
 *      each member's desired meeting_pct share.
 *   5. Perform a weighted random pick.
 *
 * @param {string} slotStart - ISO 8601 start of the requested slot.
 * @param {string} slotEnd   - ISO 8601 end of the requested slot.
 * @returns {object|null} The selected staff member, or null if none available
 *                        (caller should fall back to legacy single-calendar).
 */
async function selectStaffForSlot(slotStart, slotEnd, bufferMinutes = 0) {
  logger.info({ slotStart, slotEnd, bufferMinutes }, '[ASSIGN] Staff assignment started');

  // 1. Get all eligible staff
  const eligibleStaff = await getActiveStaffWithCalendar();
  logger.info({ staff: eligibleStaff.map(s => `${s.name} (${s.meeting_pct}%)`) }, '[ASSIGN] Eligible staff');

  if (eligibleStaff.length === 0) {
    logger.info('[ASSIGN] No eligible staff - fallback to legacy single-calendar');
    return null; // Fallback to legacy single-calendar flow
  }

  // 2. Check per-staff schedule availability
  const slotStartDt = DateTime.fromISO(slotStart, { zone: 'utc' });
  const slotEndDt = DateTime.fromISO(slotEnd, { zone: 'utc' });
  const slotStartMs = slotStartDt.toMillis();
  const slotEndMs = slotEndDt.toMillis();

  // Determine day of week from the slot (in each schedule's timezone we'll check)
  const staffIds = eligibleStaff.map(s => s.id);

  // Get all relevant schedules (per-staff + global)
  const { rows: allSchedules } = await pool.query(
    `SELECT * FROM schedules
     WHERE is_active = true
       AND (staff_member_id = ANY($1) OR staff_member_id IS NULL)`,
    [staffIds]
  );

  const staffSchedules = {};
  const globalSchedules = [];
  for (const sched of allSchedules) {
    if (sched.staff_member_id) {
      if (!staffSchedules[sched.staff_member_id]) staffSchedules[sched.staff_member_id] = [];
      staffSchedules[sched.staff_member_id].push(sched);
    } else {
      globalSchedules.push(sched);
    }
  }

  // Filter staff to those whose schedule covers this slot
  const scheduleEligible = eligibleStaff.filter(staff => {
    const schedules = staffSchedules[staff.id] || globalSchedules;
    return schedules.some(sched => {
      // Check if the slot's day matches this schedule's day in the schedule's timezone
      const slotInTz = slotStartDt.setZone(sched.timezone);
      const dow = slotInTz.weekday === 7 ? 0 : slotInTz.weekday;
      if (dow !== sched.day_of_week) return false;

      // Check if slot time falls within schedule hours
      const schedStart = DateTime.fromISO(slotInTz.toISODate(), { zone: sched.timezone }).set({
        hour: parseInt(sched.start_time.split(':')[0]),
        minute: parseInt(sched.start_time.split(':')[1]),
        second: 0, millisecond: 0
      });
      const schedEnd = DateTime.fromISO(slotInTz.toISODate(), { zone: sched.timezone }).set({
        hour: parseInt(sched.end_time.split(':')[0]),
        minute: parseInt(sched.end_time.split(':')[1]),
        second: 0, millisecond: 0
      });

      return slotStartDt.toMillis() >= schedStart.toMillis() &&
             slotEndDt.toMillis() <= schedEnd.toMillis();
    });
  });

  logger.info({ staff: scheduleEligible.map(s => s.name) }, '[ASSIGN] Schedule-eligible');
  if (scheduleEligible.length === 0) {
    logger.info('[ASSIGN] No staff available for this schedule window');
    return null;
  }

  // 3. Get per-staff freebusy via OAuth
  const windowStart = slotStartDt.startOf('day').toISO();
  const windowEnd = slotEndDt.endOf('day').toISO();

  let busyResult = { busy: {}, errors: {} };
  try {
    busyResult = await calendarService.getStaffBusyTimes(scheduleEligible, windowStart, windowEnd);
  } catch (err) {
    logger.error({ err }, '[ASSIGN] Staff freebusy check failed');
    return null;
  }

  // 4. Filter to staff who are FREE during the requested slot (with buffer)
  //    Skip staff whose calendars are inaccessible (we can't verify availability)
  const bufferMs = bufferMinutes * 60 * 1000;
  const freeStaff = scheduleEligible.filter((staff) => {
    if (busyResult.errors[staff.id]) return false;

    const busyTimes = busyResult.busy[staff.id] || [];
    return !busyTimes.some((busy) => {
      const busyStart = DateTime.fromISO(busy.start).toMillis();
      const busyEnd = DateTime.fromISO(busy.end).toMillis();
      return slotStartMs < (busyEnd + bufferMs) && slotEndMs > (busyStart - bufferMs);
    });
  });

  logger.info({ staff: freeStaff.map(s => s.name) }, '[ASSIGN] Free (no calendar conflicts)');

  if (freeStaff.length === 0) {
    logger.info('[ASSIGN] All staff busy (calendar)');
    return null;
  }

  // 4b. Also check DB bookings (calendar events may be missing/deleted)
  const freeStaffIds = freeStaff.map(s => s.id);
  const { rows: dbBookingRows } = await pool.query(
    `SELECT staff_member_id, slot_start, slot_end FROM bookings
     WHERE staff_member_id = ANY($1) AND status = 'confirmed'
       AND slot_start < $3 AND slot_end > $2`,
    [freeStaffIds, windowStart, windowEnd]
  );

  const staffDbBusy = {};
  for (const b of dbBookingRows) {
    if (!staffDbBusy[b.staff_member_id]) staffDbBusy[b.staff_member_id] = [];
    staffDbBusy[b.staff_member_id].push({
      start: DateTime.fromJSDate(b.slot_start).toMillis(),
      end: DateTime.fromJSDate(b.slot_end).toMillis(),
    });
  }

  const trulyFreeStaff = freeStaff.filter(staff => {
    const bookings = staffDbBusy[staff.id] || [];
    return !bookings.some(b =>
      slotStartMs < (b.end + bufferMs) && slotEndMs > (b.start - bufferMs)
    );
  });

  logger.info({ staff: trulyFreeStaff.map(s => s.name) }, '[ASSIGN] Free (calendar + DB bookings)');

  if (trulyFreeStaff.length === 0) {
    logger.info('[ASSIGN] All staff busy (DB bookings conflict)');
    return null;
  }

  // Short-circuit: if only one person is free, assign directly
  if (trulyFreeStaff.length === 1) {
    logger.info({ selected: trulyFreeStaff[0].name }, '[ASSIGN] Only one free - auto-selected');
    return trulyFreeStaff[0];
  }

  // 5. Get confirmed booking counts for the free staff over the last 30 days
  const freeIds = trulyFreeStaff.map((s) => s.id);

  const { rows: countRows } = await pool.query(
    `SELECT staff_member_id, COUNT(*) as cnt FROM bookings
     WHERE staff_member_id = ANY($1)
       AND status = 'confirmed'
       AND created_at >= NOW() - INTERVAL '30 days'
     GROUP BY staff_member_id`,
    [freeIds]
  );

  // Build a lookup: staffId -> booking count
  const bookingCounts = {};
  let totalBookings = 0;
  for (const row of countRows) {
    const cnt = parseInt(row.cnt, 10);
    bookingCounts[row.staff_member_id] = cnt;
    totalBookings += cnt;
  }

  // Ensure every free staff member has an entry (default 0)
  for (const s of trulyFreeStaff) {
    if (!(s.id in bookingCounts)) {
      bookingCounts[s.id] = 0;
    }
  }

  // 6. Compute adjusted weights
  const totalPct = trulyFreeStaff.reduce((sum, s) => sum + s.meeting_pct, 0);
  let weights;

  if (totalBookings < trulyFreeStaff.length) {
    // Not enough historical data to self-balance — use raw meeting_pct
    weights = trulyFreeStaff.map((s) => s.meeting_pct);
  } else {
    // Self-balancing: nudge weights so actual ratios converge to expected ratios
    weights = trulyFreeStaff.map((s) => {
      const expectedRatio = s.meeting_pct / totalPct;
      const actualRatio = bookingCounts[s.id] / totalBookings;

      // adjustedWeight = meeting_pct * (expectedRatio / actualRatio)
      // Cap the multiplier between 0.1 and 10 to avoid extreme swings
      let multiplier = expectedRatio / actualRatio;
      multiplier = Math.max(0.1, Math.min(10, multiplier));

      return s.meeting_pct * multiplier;
    });
  }

  // 7. Weighted random selection
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  logger.info({ weights: trulyFreeStaff.map((s, i) => `${s.name}=${weights[i].toFixed(2)}`), totalWeight: totalWeight.toFixed(2) }, '[ASSIGN] Weights');
  logger.info({ bookings: trulyFreeStaff.map(s => `${s.name}=${bookingCounts[s.id]}`), totalBookings }, '[ASSIGN] Bookings (30d)');

  let rand = Math.random() * totalWeight;

  for (let i = 0; i < trulyFreeStaff.length; i++) {
    rand -= weights[i];
    if (rand <= 0) {
      logger.info({ selected: trulyFreeStaff[i].name, id: trulyFreeStaff[i].id }, '[ASSIGN] Selected');
      return trulyFreeStaff[i];
    }
  }

  // Fallback (should not be reached due to floating-point, but just in case)
  logger.info({ selected: trulyFreeStaff[trulyFreeStaff.length - 1].name }, '[ASSIGN] Fallback selected');
  return trulyFreeStaff[trulyFreeStaff.length - 1];
}

/**
 * Regenerate an invite token for an existing staff member (e.g. if the old one expired).
 * @param {number} staffId
 * @returns {string|null} The new invite token, or null if staff not found.
 */
async function regenerateInviteToken(staffId) {
  const staff = await getStaffById(staffId);
  if (!staff) return null;

  const inviteToken = crypto.randomBytes(32).toString('hex');
  const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const result = await pool.query(
    `UPDATE admin_users SET invite_token = $1, invite_token_expires = $2
     WHERE LOWER(email) = LOWER($3)`,
    [inviteToken, inviteExpires, staff.email]
  );

  // No admin_users record found -- create one so the invite token is actually saved
  if (result.rowCount === 0) {
    logger.info({ email: staff.email, staffId }, '[INVITE] No admin_users record found, creating one');
    const role = PROTECTED_ADMIN_EMAILS.includes(staff.email.toLowerCase()) ? 'admin' : 'restricted';
    await pool.query(
      `INSERT INTO admin_users (email, password_hash, name, must_set_password, role, invite_token, invite_token_expires)
       VALUES (LOWER($1), NULL, $2, true, $3, $4, $5)`,
      [staff.email, staff.name, role, inviteToken, inviteExpires]
    );
  } else {
    logger.info({ email: staff.email, staffId, rowCount: result.rowCount }, '[INVITE] Token regenerated');
  }

  return inviteToken;
}

module.exports = {
  getAllStaff,
  getActiveStaffWithCalendar,
  getStaffById,
  createStaff,
  updateStaff,
  deleteStaff,
  selectStaffForSlot,
  regenerateInviteToken,
};
