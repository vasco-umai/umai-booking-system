const crypto = require('crypto');
const { DateTime } = require('luxon');
const { pool } = require('../config/db');
const logger = require('../lib/logger');
const calendarService = require('./calendarService');
const { hashToken } = require('../lib/tokenHash');

// Emails that must always have admin role -- prevents accidental role loss
const PROTECTED_ADMIN_EMAILS = [
  'admin@umai.io',
  'margarida.c@letsumai.com',
];

/**
 * Resolve the effective assignment weight for a staff member.
 *
 * Hierarchy (meeting-type > team):
 *   - If the meeting type defines a per-staff weight (including 0), that value wins.
 *   - Otherwise fall back to the team-level `meeting_pct` on the staff row.
 *
 * A meeting-type weight of 0 MUST return 0 — setting someone to 0% in the
 * meeting is how they're excluded from that meeting's rotation even when
 * the team default is >0.
 *
 * @param {{id:number|string, meeting_pct:number}} staff
 * @param {Record<string|number, number>} staffWeightMap - staff_member_id -> meeting weight
 * @returns {number}
 */
function resolveStaffWeight(staff, staffWeightMap) {
  const override = staffWeightMap ? staffWeightMap[staff.id] : undefined;
  return override != null ? override : staff.meeting_pct;
}

// ---------------------------------------------------------------------------
// CRUD Operations
// ---------------------------------------------------------------------------

/**
 * Get all staff members, ordered by name.
 * @returns {Array<object>}
 */
async function getAllStaff(teamId) {
  if (teamId) {
    const { rows } = await pool.query('SELECT * FROM staff_members WHERE team_id = $1 ORDER BY name', [teamId]);
    return rows;
  }
  const { rows } = await pool.query('SELECT * FROM staff_members ORDER BY name');
  return rows;
}

/**
 * Get active staff members who have a linked Google Calendar and a positive
 * meeting percentage. These are the staff eligible for meeting assignment.
 * @returns {Array<object>}
 */
async function getActiveStaffWithCalendar(teamId) {
  // Include staff with meeting_pct > 0 OR any per-meeting-type weight > 0
  if (teamId) {
    const { rows } = await pool.query(
      `SELECT DISTINCT sm.* FROM staff_members sm
       LEFT JOIN staff_meeting_weights smw ON smw.staff_member_id = sm.id AND smw.weight > 0
       WHERE sm.is_active = true
         AND sm.google_refresh_token IS NOT NULL
         AND (sm.meeting_pct > 0 OR smw.id IS NOT NULL)
         AND sm.team_id = $1
       ORDER BY sm.name`,
      [teamId]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT DISTINCT sm.* FROM staff_members sm
     LEFT JOIN staff_meeting_weights smw ON smw.staff_member_id = sm.id AND smw.weight > 0
     WHERE sm.is_active = true
       AND sm.google_refresh_token IS NOT NULL
       AND (sm.meeting_pct > 0 OR smw.id IS NOT NULL)
     ORDER BY sm.name`
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
async function createStaff({ name, email, meetingPct = 100, googleCalendarId = null, isActive = true, maxDailyMeetings = 0, teamId }) {
  const { rows } = await pool.query(
    `INSERT INTO staff_members (name, email, meeting_pct, google_calendar_id, is_active, max_daily_meetings, team_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [name, email, meetingPct, googleCalendarId, isActive, maxDailyMeetings || 0, teamId]
  );

  // Also create an admin_users login so the team member can log in.
  // Invite token: the raw value goes into the invite URL (emailed), but we
  // store only the SHA-256 hash in the DB. See H3.
  const inviteToken = crypto.randomBytes(32).toString('hex');
  const inviteTokenHash = hashToken(inviteToken);
  const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const { rows: existingAdmin } = await pool.query(
    'SELECT id, password_hash, must_set_password, role FROM admin_users WHERE LOWER(email) = LOWER($1)',
    [email]
  );

  if (existingAdmin.length === 0) {
    // New user -- create admin_users record with appropriate role
    const role = PROTECTED_ADMIN_EMAILS.includes(email.toLowerCase()) ? 'admin' : 'restricted';
    await pool.query(
      `INSERT INTO admin_users (email, password_hash, name, must_set_password, role, invite_token_hash, invite_token_expires, team_id)
       VALUES (LOWER($1), NULL, $2, true, $3, $4, $5, $6)`,
      [email, name, role, inviteTokenHash, inviteExpires, teamId]
    );
  } else {
    const admin = existingAdmin[0];
    // Only regenerate invite token if user hasn't completed onboarding yet
    if (admin.must_set_password || !admin.password_hash) {
      await pool.query(
        `UPDATE admin_users
         SET invite_token = NULL, invite_token_hash = $1, invite_token_expires = $2
         WHERE id = $3`,
        [inviteTokenHash, inviteExpires, admin.id]
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
async function updateStaff(id, { name, email, meetingPct, googleCalendarId, isActive, maxDailyMeetings }, teamId) {
  // teamId REQUIRED — scope the WHERE so team A can't mutate team B's staff
  // via /api/admin/staff/:id by enumerating ids. See security audit H1.
  if (teamId == null) throw new Error('updateStaff: teamId is required for tenant scoping');
  const { rows } = await pool.query(
    `UPDATE staff_members
     SET name               = COALESCE($2, name),
         email              = COALESCE($3, email),
         meeting_pct        = COALESCE($4, meeting_pct),
         google_calendar_id = COALESCE($5, google_calendar_id),
         is_active          = COALESCE($6, is_active),
         max_daily_meetings = COALESCE($7, max_daily_meetings),
         updated_at         = NOW()
     WHERE id = $1 AND team_id = $8
     RETURNING *`,
    [id, name, email, meetingPct, googleCalendarId, isActive, maxDailyMeetings != null ? maxDailyMeetings : undefined, teamId]
  );
  return rows[0] || null;
}

/**
 * Delete a staff member by ID, scoped to the caller's team.
 * @param {number} id
 * @param {number} teamId - REQUIRED, blocks cross-team deletes. See H1.
 * @returns {boolean} True if a row was deleted, false otherwise.
 */
async function deleteStaff(id, teamId) {
  if (teamId == null) throw new Error('deleteStaff: teamId is required for tenant scoping');
  const { rowCount } = await pool.query(
    'DELETE FROM staff_members WHERE id = $1 AND team_id = $2',
    [id, teamId]
  );
  return rowCount > 0;
}

/**
 * Check whether a staff id belongs to the given team. Used by route handlers
 * to pre-authorize operations on sub-resources (duration-overrides, invites).
 */
async function staffBelongsToTeam(id, teamId) {
  if (teamId == null) return false;
  const { rows } = await pool.query(
    'SELECT 1 FROM staff_members WHERE id = $1 AND team_id = $2 LIMIT 1',
    [id, teamId]
  );
  return rows.length > 0;
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
async function selectStaffForSlot(slotStart, slotEnd, bufferMinutes = 0, maxDailyMeetings = 0, { teamId, meetingTypeId } = {}) {
  logger.info({ slotStart, slotEnd, bufferMinutes, teamId, meetingTypeId }, '[ASSIGN] Staff assignment started');

  // 1. Get all eligible staff (team-scoped if teamId provided)
  const eligibleStaff = await getActiveStaffWithCalendar(teamId);
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

  // 4c. Check max daily meetings limit
  const slotDate = slotStartDt.toISODate();
  const { rows: dailyCounts } = await pool.query(
    `SELECT staff_member_id, COUNT(*) as cnt FROM bookings
     WHERE staff_member_id = ANY($1) AND status = 'confirmed'
       AND slot_start::date = $2::date
     GROUP BY staff_member_id`,
    [trulyFreeStaff.map(s => s.id), slotDate]
  );
  const dailyCountMap = {};
  for (const r of dailyCounts) dailyCountMap[r.staff_member_id] = parseInt(r.cnt, 10);

  const underLimitStaff = trulyFreeStaff.filter(s => {
    if (maxDailyMeetings <= 0) return true; // 0 = unlimited
    return (dailyCountMap[s.id] || 0) < maxDailyMeetings;
  });

  logger.info({ staff: underLimitStaff.map(s => s.name) }, '[ASSIGN] Under daily limit');

  if (underLimitStaff.length === 0) {
    logger.info('[ASSIGN] All staff at daily meeting limit');
    return null;
  }

  // Short-circuit: if only one person is free, assign directly
  if (underLimitStaff.length === 1) {
    logger.info({ selected: underLimitStaff[0].name }, '[ASSIGN] Only one free - auto-selected');
    return underLimitStaff[0];
  }

  // 5. Get confirmed booking counts for the free staff over the last 30 days
  const freeIds = underLimitStaff.map((s) => s.id);

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
  for (const s of underLimitStaff) {
    if (!(s.id in bookingCounts)) {
      bookingCounts[s.id] = 0;
    }
  }

  // 6. Compute adjusted weights (per-meeting-type weights if available)
  // Look up per-meeting-type weights from staff_meeting_weights table
  const staffWeightMap = {};
  if (meetingTypeId) {
    const { rows: weightRows } = await pool.query(
      `SELECT staff_member_id, weight FROM staff_meeting_weights
       WHERE staff_member_id = ANY($1) AND meeting_type_id = $2`,
      [freeIds, meetingTypeId]
    );
    for (const w of weightRows) staffWeightMap[w.staff_member_id] = w.weight;
  }
  // For each staff, use per-meeting-type weight if available, else fall back to global meeting_pct.
  // See resolveStaffWeight() at the top of this file for the full hierarchy contract.
  const getWeight = (s) => resolveStaffWeight(s, staffWeightMap);

  const totalPct = underLimitStaff.reduce((sum, s) => sum + getWeight(s), 0);
  let weights;

  if (totalBookings < underLimitStaff.length) {
    weights = underLimitStaff.map((s) => getWeight(s));
  } else {
    weights = underLimitStaff.map((s) => {
      const pct = getWeight(s);
      const expectedRatio = pct / totalPct;
      const actualRatio = bookingCounts[s.id] / totalBookings;

      // adjustedWeight = weight * (expectedRatio / actualRatio)
      // Cap the multiplier between 0.1 and 10 to avoid extreme swings
      let multiplier = expectedRatio / actualRatio;
      multiplier = Math.max(0.1, Math.min(10, multiplier));

      return pct * multiplier;
    });
  }

  // 7. Priority-based selection: highest weight first, overflow to lower when saturated
  //    Sort by weight descending. Pick the staff member who is most "under-quota".
  //    Under-quota = expected share - actual share (bigger = more deserving of next booking).
  logger.info({ weights: underLimitStaff.map((s, i) => `${s.name}=${weights[i].toFixed(2)}`), totalPct }, '[ASSIGN] Weights');
  logger.info({ bookings: underLimitStaff.map(s => `${s.name}=${bookingCounts[s.id]}`), totalBookings }, '[ASSIGN] Bookings (30d)');

  // Calculate how far each staff is from their target share
  const staffWithGap = underLimitStaff.map((s, i) => {
    const pct = getWeight(s);
    const expectedShare = totalBookings > 0 ? (pct / totalPct) : (pct / 100);
    const actualShare = totalBookings > 0 ? (bookingCounts[s.id] / totalBookings) : 0;
    const gap = expectedShare - actualShare; // positive = under-quota, negative = over-quota
    return { staff: s, weight: pct, gap, bookings: bookingCounts[s.id] };
  });

  // Sort: highest weight first, then by biggest gap (most under-quota)
  staffWithGap.sort((a, b) => {
    // Primary: pick whoever is most under their quota
    if (Math.abs(a.gap - b.gap) > 0.01) return b.gap - a.gap;
    // Tiebreaker: higher weight wins
    return b.weight - a.weight;
  });

  const selected = staffWithGap[0].staff;
  logger.info({
    selected: selected.name,
    id: selected.id,
    ranking: staffWithGap.map(s => `${s.staff.name}(w:${s.weight},gap:${s.gap.toFixed(3)},b:${s.bookings})`)
  }, '[ASSIGN] Priority selected');
  return selected;
}

/**
 * Regenerate an invite token for an existing staff member (e.g. if the old one expired).
 * teamId REQUIRED — caller must be in the same team as the staff row. Without this a
 * team lead in team A could regenerate tokens for team B staff and read them back.
 * @param {number} staffId
 * @param {number} teamId
 * @returns {string|null} The new invite token, or null if staff not found or wrong team.
 */
async function regenerateInviteToken(staffId, teamId) {
  if (teamId == null) throw new Error('regenerateInviteToken: teamId is required for tenant scoping');
  const staff = await getStaffById(staffId);
  if (!staff || staff.team_id !== teamId) return null;

  const inviteToken = crypto.randomBytes(32).toString('hex');
  const inviteTokenHash = hashToken(inviteToken);
  const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // Store the hash in the DB; return the raw token to the caller so it can be
  // embedded in the invite URL. Legacy invite_token column cleared so any
  // outstanding plaintext token for this user is superseded. See H3.
  const result = await pool.query(
    `UPDATE admin_users
     SET invite_token = NULL, invite_token_hash = $1, invite_token_expires = $2
     WHERE LOWER(email) = LOWER($3)`,
    [inviteTokenHash, inviteExpires, staff.email]
  );

  // No admin_users record found -- create one so the invite token is actually saved
  if (result.rowCount === 0) {
    logger.info({ email: staff.email, staffId }, '[INVITE] No admin_users record found, creating one');
    const role = PROTECTED_ADMIN_EMAILS.includes(staff.email.toLowerCase()) ? 'admin' : 'restricted';
    await pool.query(
      `INSERT INTO admin_users (email, password_hash, name, must_set_password, role, invite_token_hash, invite_token_expires, team_id)
       VALUES (LOWER($1), NULL, $2, true, $3, $4, $5, $6)`,
      [staff.email, staff.name, role, inviteTokenHash, inviteExpires, staff.team_id]
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
  staffBelongsToTeam,
  selectStaffForSlot,
  regenerateInviteToken,
  resolveStaffWeight,
};
