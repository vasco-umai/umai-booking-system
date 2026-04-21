const crypto = require('crypto');
const { pool } = require('../config/db');
const logger = require('../lib/logger');
const { AppError, ErrorCodes } = require('../lib/errors');

const KEY_PREFIX = 'umai_live_';

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function generateKey() {
  // 32 random bytes → 43 url-safe chars, prefixed for discoverability in logs
  const body = crypto.randomBytes(32).toString('base64url');
  return `${KEY_PREFIX}${body}`;
}

function extractKey(req) {
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  const xHeader = req.headers['x-api-key'];
  if (typeof xHeader === 'string' && xHeader.trim().length > 0) return xHeader.trim();
  return null;
}

async function requireApiKey(req, res, next) {
  try {
    const rawKey = extractKey(req);
    if (!rawKey) {
      throw new AppError('Missing API key. Send Authorization: Bearer <key>.', 401, ErrorCodes.API_KEY_MISSING);
    }

    const keyHash = hashKey(rawKey);
    const { rows } = await pool.query(
      'SELECT id, team_id, name, revoked_at FROM api_keys WHERE key_hash = $1 LIMIT 1',
      [keyHash]
    );

    if (rows.length === 0) {
      throw new AppError('Invalid API key.', 401, ErrorCodes.API_KEY_INVALID);
    }
    const key = rows[0];
    if (key.revoked_at) {
      throw new AppError('API key has been revoked.', 403, ErrorCodes.API_KEY_REVOKED);
    }

    req.apiKey = { id: key.id, teamId: key.team_id, name: key.name };

    // Fire-and-forget last_used_at update. Does NOT block the response.
    pool
      .query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [key.id])
      .catch((err) => logger.warn({ err, keyId: key.id }, 'Failed to update api_key last_used_at'));

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireApiKey, hashKey, generateKey, KEY_PREFIX };
