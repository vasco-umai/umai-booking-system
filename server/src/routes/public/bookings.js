const { Router } = require('express');
const { AppError, ErrorCodes } = require('../../lib/errors');
const { isValidEmail, stripHtml } = require('../../middleware/validate');
const { isValidTimezone } = require('../../services/staffService');
const { createBooking } = require('../../services/publicBookingService');

const router = Router();

function requireString(value, field, { max = 500 } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(`${field} is required.`, 400, ErrorCodes.MISSING_FIELDS);
  }
  if (value.length > max) {
    throw new AppError(`${field} is too long.`, 400, ErrorCodes.INVALID_INPUT);
  }
  return value.trim();
}

// POST /api/public/bookings
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};

    const meetingTypeIdRaw = body.meeting_type_id;
    const meetingTypeId = parseInt(meetingTypeIdRaw, 10);
    if (!Number.isInteger(meetingTypeId) || meetingTypeId <= 0) {
      throw new AppError('meeting_type_id must be a positive integer.', 400, ErrorCodes.INVALID_INPUT);
    }

    const slotStart = requireString(body.slot_start, 'slot_start', { max: 64 });
    const guestName = stripHtml(requireString(body.guest_name, 'guest_name', { max: 200 }));
    const guestEmailRaw = requireString(body.guest_email, 'guest_email', { max: 254 });
    if (!isValidEmail(guestEmailRaw)) {
      throw new AppError('guest_email is not a valid email.', 400, ErrorCodes.INVALID_EMAIL);
    }
    const guestEmail = guestEmailRaw.trim();
    const guestTz = requireString(body.guest_tz, 'guest_tz', { max: 64 });
    if (!isValidTimezone(guestTz)) {
      throw new AppError('guest_tz is not a valid IANA timezone.', 400, ErrorCodes.UNSUPPORTED_TIMEZONE);
    }

    // Optional fields
    const guestPhone = body.guest_phone ? stripHtml(String(body.guest_phone)).slice(0, 32) : null;
    const lang = body.lang && typeof body.lang === 'string' ? body.lang.slice(0, 8) : null;

    const result = await createBooking({
      teamId: req.apiKey.teamId,
      meetingTypeId,
      slotStartIso: slotStart,
      guestName,
      guestEmail,
      guestPhone,
      guestTz,
      lang,
    });

    const status = 201;
    // Persist idempotency record so subsequent retries of this exact request
    // replay the same response.
    if (typeof req.storeIdempotent === 'function') {
      await req.storeIdempotent(result.booking_id, status, result);
    }

    res.status(status).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
