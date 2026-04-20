const logger = require('../lib/logger');

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

/**
 * Send a Pushover notification.
 * Silently skips if credentials are not configured.
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
    });

    if (!res.ok) {
      const text = await res.text();
      logger.warn({ status: res.status, body: text }, 'Pushover notification failed');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Pushover notification error');
  }
}

module.exports = { sendNotification };
