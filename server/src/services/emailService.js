const path = require('path');
const fs = require('fs');
const { DateTime } = require('luxon');
const { getTransporter } = require('../config/email');
const logger = require('../lib/logger');

let confirmationTemplate = null;

function getConfirmationTemplate() {
  if (confirmationTemplate) return confirmationTemplate;
  const filePath = path.join(__dirname, '..', 'templates', 'confirmationEmail.html');
  confirmationTemplate = fs.readFileSync(filePath, 'utf8');
  return confirmationTemplate;
}

/**
 * Send booking confirmation email.
 * Returns true if sent successfully, false otherwise.
 */
async function sendConfirmation({ guestName, guestEmail, slotStart, slotEnd, guestTz, venueName }) {
  const transporter = getTransporter();
  if (!transporter) {
    logger.warn('Email not configured - skipping confirmation email');
    return false;
  }

  const startDt = DateTime.fromISO(slotStart, { zone: guestTz });
  const endDt = DateTime.fromISO(slotEnd, { zone: guestTz });

  const dateStr = startDt.toFormat('EEEE, MMMM d, yyyy');
  const timeStr = `${startDt.toFormat('h:mm a')} - ${endDt.toFormat('h:mm a')}`;
  const tzStr = startDt.toFormat('ZZZZZ');

  let html = getConfirmationTemplate();
  html = html.replace(/{{guestName}}/g, guestName);
  html = html.replace(/{{date}}/g, dateStr);
  html = html.replace(/{{time}}/g, timeStr);
  html = html.replace(/{{timezone}}/g, tzStr);
  html = html.replace(/{{venueName}}/g, venueName || 'your venue');

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'UMAI <noreply@umai.io>',
      to: guestEmail,
      subject: `UMAI Training Session Confirmed - ${dateStr}`,
      html,
    });
    logger.info({ to: guestEmail }, 'Confirmation email sent');
    return true;
  } catch (err) {
    logger.error({ err, to: guestEmail }, 'Failed to send confirmation email');
    return false;
  }
}

/**
 * Send cancellation email.
 * Returns true if sent successfully, false otherwise.
 */
async function sendCancellation({ guestName, guestEmail, slotStart, guestTz }) {
  const transporter = getTransporter();
  if (!transporter) return false;

  const startDt = DateTime.fromISO(slotStart, { zone: guestTz });
  const dateStr = startDt.toFormat('EEEE, MMMM d, yyyy');
  const timeStr = startDt.toFormat('h:mm a');

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'UMAI <noreply@umai.io>',
      to: guestEmail,
      subject: 'UMAI Training Session Cancelled',
      html: `
        <div style="font-family: 'DM Sans', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
          <h2 style="color: #2D2D3A;">Session Cancelled</h2>
          <p>Hi ${guestName},</p>
          <p>Your UMAI training session on <strong>${dateStr}</strong> at <strong>${timeStr}</strong> has been cancelled.</p>
          <p>If you'd like to reschedule, please contact us or complete the sign-up process again.</p>
          <p style="color: #71717A; font-size: 13px; margin-top: 32px;">- The UMAI Team</p>
        </div>
      `,
    });
    logger.info({ to: guestEmail }, 'Cancellation email sent');
    return true;
  } catch (err) {
    logger.error({ err, to: guestEmail }, 'Failed to send cancellation email');
    return false;
  }
}

module.exports = { sendConfirmation, sendCancellation };
