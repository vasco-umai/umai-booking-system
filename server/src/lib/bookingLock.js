const crypto = require('crypto');

/**
 * Compute the pg_advisory_xact_lock key for a booking slot.
 *
 * Any handler that commits a row against a slot (POST /bookings, PUT /reassign)
 * must acquire the same lock so the availability check + write serialize.
 *
 * Inputs are normalized to `new Date(x).toISOString()` so that callers passing a
 * raw ISO string from the request body and callers passing a Postgres timestamptz
 * Date object produce the same hash. Before this helper existed, POST used the
 * raw request string (`2026-04-21T14:30:00Z`) and reassign used the stored Date
 * (`2026-04-21T14:30:00.000Z`) — different strings, different locks, no serialization.
 */
function bookingSlotLockKey(slotStart, slotEnd) {
  const start = new Date(slotStart).toISOString();
  const end = new Date(slotEnd).toISOString();
  const hash = crypto.createHash('md5').update(`${start}:${end}`).digest();
  return Math.abs(hash.readInt32BE(0));
}

module.exports = { bookingSlotLockKey };
