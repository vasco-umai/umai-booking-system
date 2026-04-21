const logger = require('../lib/logger');

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';
// 8s: comfortable margin under Vercel's 15s serverless cap but tolerant of cold-start
// network latency that was hitting the previous 3s ceiling.
const TIMEOUT_MS = 8000;

/**
 * Send a Pushover notification.
 *
 * Every outcome (missing creds, 2xx, 4xx, timeout, network error) is logged so
 * failures show up in Vercel logs instead of silently disappearing. Returns an
 * object so callers (and the admin diagnostic endpoint) can tell what happened.
 *
 * Bounded to TIMEOUT_MS so callers (which await this) don't hang past Vercel's
 * serverless function limit.
 *
 * @param {object} opts
 * @param {string} opts.title - Notification title
 * @param {string} opts.message - Notification body
 * @param {number} [opts.priority=0] - -2 (lowest) to 2 (emergency)
 * @returns {Promise<{ok: boolean, status: number|null, reason?: string, body?: string}>}
 */
async function sendNotification({ title, message, priority = 0 }) {
  const userKey = process.env.PUSHOVER_USER_KEY;
  const appToken = process.env.PUSHOVER_APP_TOKEN;

  if (!userKey || !appToken) {
    // Previously returned silently. Now loud — "notifications don't work because
    // the env var is missing/empty" is worth seeing in logs.
    logger.warn(
      { hasUserKey: !!userKey, hasAppToken: !!appToken, title },
      'Pushover notification skipped — credentials missing'
    );
    return { ok: false, status: null, reason: 'missing-credentials' };
  }

  logger.info({ title, priority }, 'Pushover notification sending');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(PUSHOVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: appToken,
        user: userKey,
        title,
        message,
        priority,
      }),
      signal: controller.signal,
    });

    const bodyText = await res.text();

    if (!res.ok) {
      logger.warn(
        { status: res.status, body: bodyText, title },
        'Pushover notification failed (non-2xx)'
      );
      return { ok: false, status: res.status, body: bodyText, reason: 'api-error' };
    }

    logger.info({ status: res.status, title }, 'Pushover notification sent');
    return { ok: true, status: res.status, body: bodyText };
  } catch (err) {
    const isAbort = err && err.name === 'AbortError';
    logger.warn(
      { err: err?.message || String(err), isAbort, timeoutMs: TIMEOUT_MS, title },
      isAbort ? 'Pushover notification timed out' : 'Pushover notification error'
    );
    return { ok: false, status: null, reason: isAbort ? 'timeout' : 'network-error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendNotification };
