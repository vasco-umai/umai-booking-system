const crypto = require('crypto');
const { pool } = require('../config/db');
const logger = require('../lib/logger');
const { AppError, ErrorCodes } = require('../lib/errors');

// Idempotency records older than this are treated as expired (ignored on read).
// A separate cleanup job can delete them; for MVP, they'll accumulate slowly
// and the partial index on created_at makes the expiry check cheap.
const RETENTION_MS = 24 * 60 * 60 * 1000;

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function hashBody(body) {
  // Canonical JSON: stable key order so logically-equal bodies hash the same.
  const canonical = JSON.stringify(body, Object.keys(body || {}).sort());
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Guard POST endpoints that must not double-write on client retries.
 *
 * Contract:
 *   - If the client resends the same Idempotency-Key with the same body within
 *     RETENTION_MS, return the original response (same status, same body).
 *   - If the key is reused with a DIFFERENT body, return 409 — the client is
 *     reusing a UUID for two different intents, which is a bug on their side.
 *   - The handler is responsible for calling `req.storeIdempotent(bookingId, status, body)`
 *     after a successful write. If it doesn't, the guard degrades gracefully
 *     (no stored record = no replay on retry, but no double-write either since
 *     the handler's own conflict check takes over).
 */
async function requireIdempotencyKey(req, res, next) {
  try {
    const key = req.headers['idempotency-key'];
    if (!key || typeof key !== 'string') {
      throw new AppError('Missing Idempotency-Key header (UUID).', 400, ErrorCodes.IDEMPOTENCY_KEY_MISSING);
    }
    if (!UUID_REGEX.test(key)) {
      throw new AppError('Idempotency-Key must be a UUID.', 400, ErrorCodes.IDEMPOTENCY_KEY_MISSING);
    }

    const teamId = req.apiKey?.teamId;
    if (!teamId) {
      // Should never happen: requireApiKey runs before this middleware.
      throw new AppError('API key context missing.', 500, ErrorCodes.INTERNAL_ERROR);
    }

    const requestHash = hashBody(req.body);

    const { rows } = await pool.query(
      `SELECT booking_id, request_hash, response_body, response_status, created_at
         FROM idempotency_keys
        WHERE team_id = $1 AND key = $2
        LIMIT 1`,
      [teamId, key]
    );

    if (rows.length > 0) {
      const record = rows[0];
      const ageMs = Date.now() - new Date(record.created_at).getTime();
      if (ageMs <= RETENTION_MS) {
        if (record.request_hash !== requestHash) {
          throw new AppError(
            'Idempotency-Key was reused with a different request body.',
            409,
            ErrorCodes.IDEMPOTENCY_KEY_CONFLICT
          );
        }
        logger.info({ key, teamId, bookingId: record.booking_id }, '[IDEMPOTENCY] replay');
        return res.status(record.response_status).json(record.response_body);
      }
      // Expired record — delete and fall through to a fresh handler run.
      await pool.query('DELETE FROM idempotency_keys WHERE team_id = $1 AND key = $2', [teamId, key]);
    }

    // Attach a helper the handler calls after a successful write.
    req.storeIdempotent = async (bookingId, status, body) => {
      try {
        await pool.query(
          `INSERT INTO idempotency_keys (team_id, key, booking_id, request_hash, response_body, response_status)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (team_id, key) DO NOTHING`,
          [teamId, key, bookingId, requestHash, body, status]
        );
      } catch (err) {
        logger.warn({ err, key, teamId, bookingId }, 'Failed to persist idempotency record');
      }
    };

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireIdempotencyKey, hashBody, RETENTION_MS };
