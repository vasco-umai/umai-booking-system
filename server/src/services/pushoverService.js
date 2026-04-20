const logger = require('../lib/logger');

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';
const TIMEOUT_MS = 3000;

/**
 * Send a Pushover notification.
 * Silently skips if credentials are not configured.
 * Bounded to TIMEOUT_MS so callers (which now await this) don't hang
 * the request past Vercel's serverless function limit.
 *
 * @param {object} opts
 * @param {string} opts.title - Notification title
 * @param {string} opts.message - Notification body
 * @param {number} [opts.priority=0] - -2 (lowest) to 2 (emergency)
 */
async function sendNotification({ title, message, priority = 0 }) {
  const userKey = process.env.PUSHOVER_USER_KEY;
  const appToken = process.env.PUSHOVER_APP_TOKEN;

  if (!userKey || !appToken) return;

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

    if (!res.ok) {
      const text = await res.text();
      logger.warn({ status: res.status, body: text }, 'Pushover notification failed');
    }
  } catch (err) {
    logger.warn({ err }, 'Pushover notification error');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendNotification };
