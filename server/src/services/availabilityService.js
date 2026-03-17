const { DateTime } = require('luxon');
const { pool } = require('../config/db');
const logger = require('../lib/logger');
const calendarService = require('./calendarService');
const staffService = require('./staffService');

/**
 * Build time-slot objects from a schedule row for a given date.
 * @param {object} sched - Schedule row from DB
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {Array<{start: DateTime, end: DateTime}>} Slots in UTC
 */
function buildSlotsFromSchedule(sched, dateStr, durationOverride) {
  const teamTz = sched.timezone;
  const duration = durationOverride || sched.slot_duration;

  const startOfDay = DateTime.fromISO(dateStr, { zone: teamTz }).set({
    hour: parseInt(sched.start_time.split(':')[0]),
    minute: parseInt(sched.start_time.split(':')[1]),
    second: 0, millisecond: 0
  });
  const endOfDay = DateTime.fromISO(dateStr, { zone: teamTz }).set({
    hour: parseInt(sched.end_time.split(':')[0]),
    minute: parseInt(sched.end_time.split(':')[1]),
    second: 0, millisecond: 0
  });

  const slots = [];
  let cursor = startOfDay;
  while (cursor.plus({ minutes: duration }) <= endOfDay) {
    slots.push({
      start: cursor.toUTC(),
      end: cursor.plus({ minutes: duration }).toUTC(),
    });
    cursor = cursor.plus({ minutes: duration });
  }
  return slots;
}

/**
 * Check if two time intervals overlap.
 */
function overlaps(startMs, endMs, interval) {
  return startMs < interval.end && endMs > interval.start;
}

/**
 * Get available slots for a specific date.
 *
 * Multi-staff mode (staff members with calendars exist):
 *   - If a staff member has their own schedule rows, use those.
 *   - Otherwise, fall back to global schedule rows (staff_member_id IS NULL).
 *   - A slot is available when ANY staff member is free during that slot.
 *
 * Legacy mode (no active staff):
 *   - Use global schedules and single-calendar logic.
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} userTz - User's IANA timezone
 * @returns {Array<{start: string, end: string, display: string}>}
 */
async function getAvailableSlots(dateStr, userTz = 'UTC', durationOverride, meetingTypeId) {
  const userDate = DateTime.fromISO(dateStr, { zone: userTz });
  if (!userDate.isValid) {
    throw Object.assign(new Error('Invalid date'), { status: 400 });
  }

  const dayOfWeek = userDate.weekday === 7 ? 0 : userDate.weekday;

  // Check meeting type day-of-week availability
  if (meetingTypeId) {
    const { rows } = await pool.query(
      `SELECT is_available FROM meeting_type_schedules
       WHERE meeting_type_id = $1 AND day_of_week = $2`,
      [meetingTypeId, dayOfWeek]
    );
    if (rows.length > 0 && !rows[0].is_available) {
      return [];
    }
  }

  // Determine mode
  const activeStaff = await staffService.getActiveStaffWithCalendar();

  if (activeStaff.length > 0) {
    return getAvailableSlotsMultiStaff(dateStr, userTz, dayOfWeek, activeStaff, durationOverride);
  }
  return getAvailableSlotsLegacy(dateStr, userTz, dayOfWeek, durationOverride);
}

// -----------------------------------------------------------------------
// MULTI-STAFF MODE
// -----------------------------------------------------------------------
async function getAvailableSlotsMultiStaff(dateStr, userTz, dayOfWeek, activeStaff, durationOverride) {
  // 1. Get schedules: per-staff + global fallback
  const staffIds = activeStaff.map(s => s.id);

  const { rows: allSchedules } = await pool.query(
    `SELECT * FROM schedules
     WHERE day_of_week = $1 AND is_active = true
       AND (staff_member_id = ANY($2) OR staff_member_id IS NULL)`,
    [dayOfWeek, staffIds]
  );

  if (allSchedules.length === 0) return [];

  // Separate per-staff schedules from global schedules
  const staffSchedules = {};  // staffId -> schedule rows
  const globalSchedules = []; // staff_member_id IS NULL

  for (const sched of allSchedules) {
    if (sched.staff_member_id) {
      if (!staffSchedules[sched.staff_member_id]) {
        staffSchedules[sched.staff_member_id] = [];
      }
      staffSchedules[sched.staff_member_id].push(sched);
    } else {
      globalSchedules.push(sched);
    }
  }

  // 2. Build per-staff slot lists
  //    If a staff member has their own schedule, use it; otherwise use global.
  const staffSlotMap = {}; // staffId -> array of {start, end} in UTC
  const allSlotSet = new Set(); // unique slot keys for deduplication

  for (const staff of activeStaff) {
    const schedules = staffSchedules[staff.id] || globalSchedules;
    if (schedules.length === 0) continue;

    const slots = [];
    for (const sched of schedules) {
      slots.push(...buildSlotsFromSchedule(sched, dateStr, durationOverride));
    }
    staffSlotMap[staff.id] = slots;
    for (const slot of slots) {
      allSlotSet.add(slot.start.toISO());
    }
  }

  if (allSlotSet.size === 0) return [];

  // 3. Filter out past slots (must be at least 1 hour in the future)
  const now = DateTime.utc().plus({ hours: 1 });

  // Collect all unique slots across all staff for the response
  // We need to check: for each unique time slot, is ANY staff member free?
  let uniqueSlots = [];
  const seen = new Set();
  for (const staffId of Object.keys(staffSlotMap)) {
    for (const slot of staffSlotMap[staffId]) {
      const key = slot.start.toISO();
      if (!seen.has(key)) {
        seen.add(key);
        uniqueSlots.push(slot);
      }
    }
  }

  // Sort by start time
  uniqueSlots.sort((a, b) => a.start.toMillis() - b.start.toMillis());

  // Filter past
  uniqueSlots = uniqueSlots.filter(s => s.start > now);
  if (uniqueSlots.length === 0) return [];

  const dayStart = uniqueSlots[0].start;
  const dayEnd = uniqueSlots[uniqueSlots.length - 1].end;

  // 4. Get confirmed bookings for the day INCLUDING staff_member_id
  const { rows: bookings } = await pool.query(
    `SELECT slot_start, slot_end, staff_member_id FROM bookings
     WHERE status = 'confirmed'
       AND slot_start < $2
       AND slot_end > $1`,
    [dayStart.toISO(), dayEnd.toISO()]
  );

  // 5. Get globally blocked times
  const { rows: blocked } = await pool.query(
    `SELECT start_at, end_at FROM blocked_times
     WHERE start_at < $2 AND end_at > $1`,
    [dayStart.toISO(), dayEnd.toISO()]
  );

  // 6. Get per-staff freebusy via OAuth (each staff member's own token)
  let busyResult = { busy: {}, errors: {} };
  try {
    busyResult = await calendarService.getStaffBusyTimes(
      activeStaff, dayStart.toISO(), dayEnd.toISO()
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'Staff freebusy check failed');
  }

  // Pre-compute intervals
  const blockedIntervals = blocked.map(bt => ({
    start: DateTime.fromJSDate(new Date(bt.start_at)).toMillis(),
    end: DateTime.fromJSDate(new Date(bt.end_at)).toMillis(),
  }));

  const staffBookings = {};
  for (const staff of activeStaff) staffBookings[staff.id] = [];
  for (const b of bookings) {
    const staffId = b.staff_member_id;
    if (staffId && staffBookings[staffId]) {
      staffBookings[staffId].push({
        start: DateTime.fromJSDate(new Date(b.slot_start)).toMillis(),
        end: DateTime.fromJSDate(new Date(b.slot_end)).toMillis(),
      });
    }
  }

  // Track which staff have inaccessible calendars (treat as fully busy)
  const inaccessibleStaff = new Set();
  for (const staff of activeStaff) {
    if (busyResult.errors[staff.id]) {
      inaccessibleStaff.add(staff.id);
    }
  }

  const staffGcalBusy = {};
  for (const staff of activeStaff) {
    const busyTimes = busyResult.busy[staff.id] || [];
    staffGcalBusy[staff.id] = busyTimes.map(gb => ({
      start: DateTime.fromISO(gb.start).toMillis(),
      end: DateTime.fromISO(gb.end).toMillis(),
    }));
  }

  // 7. Filter: a slot is available if ANY staff member is free AND not globally blocked
  const available = uniqueSlots.filter(slot => {
    const slotStartMs = slot.start.toMillis();
    const slotEndMs = slot.end.toMillis();

    // Check global blocked times
    for (const bt of blockedIntervals) {
      if (overlaps(slotStartMs, slotEndMs, bt)) return false;
    }

    // Check if at least one staff member is free AND has this slot in their schedule
    for (const staff of activeStaff) {
      // Skip staff whose calendar we cannot access
      if (inaccessibleStaff.has(staff.id)) continue;

      // Does this staff member's schedule include this slot?
      const staffSlots = staffSlotMap[staff.id] || [];
      const hasSlot = staffSlots.some(
        ss => ss.start.toMillis() === slotStartMs && ss.end.toMillis() === slotEndMs
      );
      if (!hasSlot) continue;

      let staffFree = true;

      // Check bookings
      for (const b of (staffBookings[staff.id] || [])) {
        if (overlaps(slotStartMs, slotEndMs, b)) { staffFree = false; break; }
      }
      if (!staffFree) continue;

      // Check Google Calendar
      for (const gb of (staffGcalBusy[staff.id] || [])) {
        if (overlaps(slotStartMs, slotEndMs, gb)) { staffFree = false; break; }
      }

      if (staffFree) return true;
    }

    return false;
  });

  return available.map(slot => {
    const startInUserTz = slot.start.setZone(userTz);
    return {
      start: slot.start.toISO(),
      end: slot.end.toISO(),
      display: startInUserTz.toFormat('h:mm a'),
    };
  });
}

// -----------------------------------------------------------------------
// LEGACY SINGLE-CALENDAR MODE
// -----------------------------------------------------------------------
async function getAvailableSlotsLegacy(dateStr, userTz, dayOfWeek, durationOverride) {
  const { rows: schedules } = await pool.query(
    'SELECT * FROM schedules WHERE day_of_week = $1 AND is_active = true AND staff_member_id IS NULL',
    [dayOfWeek]
  );

  if (schedules.length === 0) return [];

  let allSlots = [];
  for (const sched of schedules) {
    allSlots.push(...buildSlotsFromSchedule(sched, dateStr, durationOverride));
  }

  if (allSlots.length === 0) return [];

  const now = DateTime.utc().plus({ hours: 1 });
  allSlots = allSlots.filter(s => s.start > now);
  if (allSlots.length === 0) return [];

  const dayStart = allSlots[0].start;
  const dayEnd = allSlots[allSlots.length - 1].end;

  const { rows: bookings } = await pool.query(
    `SELECT slot_start, slot_end FROM bookings
     WHERE status = 'confirmed'
       AND slot_start < $2
       AND slot_end > $1`,
    [dayStart.toISO(), dayEnd.toISO()]
  );

  const { rows: blocked } = await pool.query(
    `SELECT start_at, end_at FROM blocked_times
     WHERE start_at < $2 AND end_at > $1`,
    [dayStart.toISO(), dayEnd.toISO()]
  );

  let gcalBusy = [];
  try {
    gcalBusy = await calendarService.getBusyTimes(dayStart.toISO(), dayEnd.toISO());
  } catch (err) {
    logger.warn({ err: err.message }, 'Google Calendar freebusy check failed');
  }

  const available = allSlots.filter(slot => {
    const slotStartMs = slot.start.toMillis();
    const slotEndMs = slot.end.toMillis();

    for (const b of bookings) {
      const bStart = DateTime.fromJSDate(new Date(b.slot_start)).toMillis();
      const bEnd = DateTime.fromJSDate(new Date(b.slot_end)).toMillis();
      if (slotStartMs < bEnd && slotEndMs > bStart) return false;
    }

    for (const bt of blocked) {
      const btStart = DateTime.fromJSDate(new Date(bt.start_at)).toMillis();
      const btEnd = DateTime.fromJSDate(new Date(bt.end_at)).toMillis();
      if (slotStartMs < btEnd && slotEndMs > btStart) return false;
    }

    for (const gb of gcalBusy) {
      const gbStart = DateTime.fromISO(gb.start).toMillis();
      const gbEnd = DateTime.fromISO(gb.end).toMillis();
      if (slotStartMs < gbEnd && slotEndMs > gbStart) return false;
    }

    return true;
  });

  return available.map(slot => {
    const startInUserTz = slot.start.setZone(userTz);
    return {
      start: slot.start.toISO(),
      end: slot.end.toISO(),
      display: startInUserTz.toFormat('h:mm a'),
    };
  });
}

/**
 * Get which dates in a month have availability.
 * Now considers per-staff schedules: a date has availability if ANY staff
 * member (or the global schedule) covers that day of week.
 *
 * @param {number} year
 * @param {number} month - 1-12
 * @param {string} userTz
 * @returns {Array<string>} Array of YYYY-MM-DD dates that have slots
 */
async function getMonthAvailability(year, month, userTz = 'UTC', meetingTypeId) {
  // Get meeting type day restrictions
  let mtDisabledDays = new Set();
  if (meetingTypeId) {
    const { rows } = await pool.query(
      `SELECT day_of_week FROM meeting_type_schedules
       WHERE meeting_type_id = $1 AND is_available = false`,
      [meetingTypeId]
    );
    mtDisabledDays = new Set(rows.map(r => r.day_of_week));
  }

  const activeStaff = await staffService.getActiveStaffWithCalendar();

  let scheduleQuery;
  let scheduleParams = [];

  if (activeStaff.length > 0) {
    // Get days covered by per-staff schedules + global fallback
    const staffIds = activeStaff.map(s => s.id);
    scheduleQuery = `SELECT DISTINCT day_of_week, staff_member_id FROM schedules
                     WHERE is_active = true
                       AND (staff_member_id = ANY($1) OR staff_member_id IS NULL)`;
    scheduleParams = [staffIds];
  } else {
    scheduleQuery = `SELECT DISTINCT day_of_week FROM schedules
                     WHERE is_active = true AND staff_member_id IS NULL`;
  }

  const { rows: schedules } = await pool.query(scheduleQuery, scheduleParams);

  if (schedules.length === 0) return [];

  // Determine which days of week have active schedules
  // In multi-staff mode: a day is active if any staff member has a schedule for it,
  // OR if there's a global schedule (and at least one staff member exists to serve it)
  let activeDays;

  if (activeStaff.length > 0) {
    const staffIds = new Set(activeStaff.map(s => s.id));
    const staffWithOwnSchedule = new Set();
    const globalDays = new Set();
    const staffDays = new Set();

    for (const s of schedules) {
      if (s.staff_member_id) {
        if (staffIds.has(s.staff_member_id)) {
          staffDays.add(s.day_of_week);
          staffWithOwnSchedule.add(s.staff_member_id);
        }
      } else {
        globalDays.add(s.day_of_week);
      }
    }

    // A day is available if:
    // - Any active staff member has their own schedule for that day, OR
    // - There's a global schedule for that day AND at least one active staff
    //   member doesn't have their own schedule (so they'd use the global one)
    const hasStaffOnGlobal = activeStaff.some(s => !staffWithOwnSchedule.has(s.id));
    activeDays = new Set([...staffDays]);
    if (hasStaffOnGlobal) {
      for (const d of globalDays) activeDays.add(d);
    }
  } else {
    activeDays = new Set(schedules.map(s => s.day_of_week));
  }

  if (activeDays.size === 0) return [];

  const startOfMonth = DateTime.fromObject({ year, month, day: 1 }, { zone: userTz });
  const daysInMonth = startOfMonth.daysInMonth;
  const now = DateTime.now().setZone(userTz).startOf('day');

  const availableDates = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = DateTime.fromObject({ year, month, day: d }, { zone: userTz });
    if (date < now) continue;

    const dow = date.weekday === 7 ? 0 : date.weekday;
    if (activeDays.has(dow) && !mtDisabledDays.has(dow)) {
      availableDates.push(date.toISODate());
    }
  }

  return availableDates;
}

module.exports = { getAvailableSlots, getMonthAvailability };
