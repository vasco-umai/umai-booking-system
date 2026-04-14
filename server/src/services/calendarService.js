const crypto = require('crypto');
const { getCalendarClient, getCalendarClientForStaff } = require('../config/google');
const logger = require('../lib/logger');

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';
const MAX_RETRIES = 3;

// Retry helper with exponential backoff
async function withRetry(fn, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        logger.error({ err, attempt, label }, 'All retry attempts exhausted');
        throw err;
      }
      const delay = Math.pow(2, attempt) * 500; // 1s, 2s, 4s
      logger.warn({ err: err.message, attempt, label, delay }, 'Retrying after failure');
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Create a Google Calendar event for a booking.
 * Retries up to 3 times with exponential backoff.
 * Returns { eventId, failed } so callers can track sync status.
 */
async function createEvent({ summary, description, startTime, endTime, attendeeEmail, timeZone, calendarId, staffRefreshToken, addConference }) {
  const calendar = staffRefreshToken
    ? getCalendarClientForStaff(staffRefreshToken)
    : getCalendarClient();

  if (!calendar) return { eventId: null, hangoutLink: null, failed: true };

  const targetCalendar = staffRefreshToken ? 'primary' : (calendarId || CALENDAR_ID);

  const event = {
    summary,
    description,
    start: { dateTime: startTime, timeZone: timeZone || 'UTC' },
    end: { dateTime: endTime, timeZone: timeZone || 'UTC' },
    attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 60 },
        { method: 'popup', minutes: 15 },
      ],
    },
  };

  if (addConference) {
    event.conferenceData = {
      createRequest: {
        conferenceSolutionKey: { type: 'hangoutsMeet' },
        requestId: crypto.randomUUID(),
      },
    };
  }

  try {
    const res = await withRetry(
      () => calendar.events.insert({
        calendarId: targetCalendar,
        resource: event,
        sendUpdates: 'all',
        conferenceDataVersion: addConference ? 1 : 0,
      }),
      'createEvent'
    );
    // hangoutLink is the primary field, but conferenceData.entryPoints may have it too
    let hangoutLink = res.data.hangoutLink || null;
    if (!hangoutLink && res.data.conferenceData && res.data.conferenceData.entryPoints) {
      const videoEntry = res.data.conferenceData.entryPoints.find(ep => ep.entryPointType === 'video');
      if (videoEntry) hangoutLink = videoEntry.uri;
    }
    logger.info({
      eventId: res.data.id,
      hangoutLink,
      hasConferenceData: !!res.data.conferenceData,
      conferenceStatus: res.data.conferenceData?.createRequest?.status?.statusCode,
      addConference,
      summary,
    }, 'Google Calendar event created');
    return { eventId: res.data.id, hangoutLink, failed: false };
  } catch (err) {
    logger.error({ err, summary }, 'Failed to create Google Calendar event after retries');
    return { eventId: null, hangoutLink: null, failed: true };
  }
}

/**
 * Delete a Google Calendar event.
 */
async function deleteEvent(eventId, calendarId, staffRefreshToken) {
  const calendar = staffRefreshToken
    ? getCalendarClientForStaff(staffRefreshToken)
    : getCalendarClient();

  if (!calendar || !eventId) return;

  const targetCalendar = staffRefreshToken ? 'primary' : (calendarId || CALENDAR_ID);

  try {
    await calendar.events.delete({
      calendarId: targetCalendar,
      eventId,
      sendUpdates: 'all',
    });
    logger.info({ eventId }, 'Google Calendar event deleted');
  } catch (err) {
    logger.error({ err, eventId }, 'Failed to delete Google Calendar event');
  }
}

/**
 * Extract busy intervals from a list of Google Calendar events.
 * Includes ALL events except cancelled or explicitly declined by the calendar owner.
 * This means tentative/unconfirmed meetings are treated as busy.
 */
function eventsToBusy(events) {
  return events
    .filter(evt => {
      if (evt.status === 'cancelled') return false;
      // If staff is an attendee and explicitly declined, skip
      const self = (evt.attendees || []).find(a => a.self);
      if (self && self.responseStatus === 'declined') return false;
      return true;
    })
    .map(evt => ({
      start: evt.start.dateTime || evt.start.date,
      end: evt.end.dateTime || evt.end.date,
    }));
}

/**
 * Get busy times from Google Calendar for a time range (legacy single-calendar).
 * Uses events.list instead of freebusy to include tentative/unconfirmed events.
 */
async function getBusyTimes(timeMin, timeMax, calendarId) {
  const calendar = getCalendarClient();
  if (!calendar) return [];

  const targetCalendar = calendarId || CALENDAR_ID;

  try {
    const res = await calendar.events.list({
      calendarId: targetCalendar,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      fields: 'items(start,end,status,attendees)',
    });
    return eventsToBusy(res.data.items || []);
  } catch (err) {
    logger.error({ err }, 'Failed to check Google Calendar events');
    return [];
  }
}

/**
 * Get busy times for multiple staff members, each using their own OAuth token.
 * Uses events.list instead of freebusy to include tentative/unconfirmed events.
 */
async function getStaffBusyTimes(staffList, timeMin, timeMax) {
  const busy = {};
  const errors = {};

  const promises = staffList.map(async (staff) => {
    const calendar = getCalendarClientForStaff(staff.google_refresh_token);
    if (!calendar) {
      errors[staff.id] = 'No OAuth token';
      return;
    }

    try {
      const res = await calendar.events.list({
        calendarId: 'primary',
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        fields: 'items(start,end,status,attendees)',
      });

      busy[staff.id] = eventsToBusy(res.data.items || []);
    } catch (err) {
      logger.error({ err, staffId: staff.id }, 'Calendar events.list failed');
      errors[staff.id] = err.message;
    }
  });

  await Promise.all(promises);
  return { busy, errors };
}

module.exports = { createEvent, deleteEvent, getBusyTimes, getStaffBusyTimes };
