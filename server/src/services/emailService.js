const path = require('path');
const fs = require('fs');
const { DateTime } = require('luxon');
const { getTransporter } = require('../config/email');
const logger = require('../lib/logger');

const templateCache = {};

function getTemplate(type, lang) {
  const key = `${type}.${lang || 'en'}`;
  if (templateCache[key]) return templateCache[key];

  const filePath = path.join(__dirname, '..', 'templates', `${type}.${lang || 'en'}.html`);
  try {
    templateCache[key] = fs.readFileSync(filePath, 'utf8');
  } catch {
    // Fall back to English
    const fallback = path.join(__dirname, '..', 'templates', `${type}.en.html`);
    templateCache[key] = fs.readFileSync(fallback, 'utf8');
  }
  return templateCache[key];
}

const SUBJECTS = {
  confirmation: {
    en: 'UMAI Training Session Confirmed',
    pt: 'Sessao de Treino UMAI Confirmada',
    es: 'Sesion de Formacion UMAI Confirmada',
    fr: 'Session de Formation UMAI Confirmee',
    de: 'UMAI Schulung Bestatigt',
    da: 'UMAI Traningssession Bekraeftet',
  },
  cancellation: {
    en: 'UMAI Training Session Cancelled',
    pt: 'Sessao de Treino UMAI Cancelada',
    es: 'Sesion de Formacion UMAI Cancelada',
    fr: 'Session de Formation UMAI Annulee',
    de: 'UMAI Schulung Storniert',
    da: 'UMAI Traningssession Aflyst',
  },
  update: {
    en: 'UMAI Training Session Updated',
    pt: 'Sessao de Treino UMAI Atualizada',
    es: 'Sesion de Formacion UMAI Actualizada',
    fr: 'Session de Formation UMAI Mise a Jour',
    de: 'UMAI Schulung Aktualisiert',
    da: 'UMAI Traningssession Opdateret',
  },
};

const MEETING_LINK_TEXT = {
  en: { join: 'Join Meeting', copy: 'Or copy this link:' },
  pt: { join: 'Entrar na Reuniao', copy: 'Ou copie este link:' },
  es: { join: 'Unirse a la Reunion', copy: 'O copie este enlace:' },
  fr: { join: 'Rejoindre la Reunion', copy: 'Ou copiez ce lien :' },
  de: { join: 'Meeting beitreten', copy: 'Oder kopieren Sie diesen Link:' },
  da: { join: 'Deltag i modet', copy: 'Eller kopier dette link:' },
};

function buildMeetingLinkBlock(meetingLink, lang) {
  if (!meetingLink) return '';
  const t = MEETING_LINK_TEXT[lang] || MEETING_LINK_TEXT.en;
  return `
      <div style="text-align:center;margin:24px 0 8px;">
        <a href="${meetingLink}" target="_blank" style="display:inline-block;background:#2BBCB3;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 36px;border-radius:8px;mso-padding-alt:0;text-align:center;">
          <!--[if mso]><i style="letter-spacing:36px;mso-font-width:-100%;mso-text-raise:21pt">&nbsp;</i><![endif]-->
          <span style="mso-text-raise:10pt;">${t.join}</span>
          <!--[if mso]><i style="letter-spacing:36px;mso-font-width:-100%">&nbsp;</i><![endif]-->
        </a>
      </div>
      <p style="text-align:center;font-size:12px;color:#71717A;margin:0 0 24px;">
        ${t.copy} <a href="${meetingLink}" style="color:#2BBCB3;word-break:break-all;">${meetingLink}</a>
      </p>`;
}

/**
 * Send booking confirmation email.
 * Returns true if sent successfully, false otherwise.
 */
async function sendConfirmation({ guestName, guestEmail, slotStart, slotEnd, guestTz, venueName, replyTo, meetingLink, lang }) {
  const transporter = getTransporter();
  if (!transporter) {
    logger.warn('Email not configured - skipping confirmation email');
    return false;
  }

  const startDt = DateTime.fromISO(slotStart, { zone: guestTz });
  const endDt = DateTime.fromISO(slotEnd, { zone: guestTz });

  const dateStr = startDt.setLocale(lang || 'en').toFormat('EEEE, MMMM d, yyyy');
  const timeStr = `${startDt.toFormat('h:mm a')} - ${endDt.toFormat('h:mm a')}`;
  const tzStr = startDt.toFormat('ZZZZZ');

  let html = getTemplate('confirmationEmail', lang);
  html = html.replace(/{{guestName}}/g, guestName);
  html = html.replace(/{{date}}/g, dateStr);
  html = html.replace(/{{time}}/g, timeStr);
  html = html.replace(/{{timezone}}/g, tzStr);
  html = html.replace(/{{venueName}}/g, venueName || 'your venue');

  html = html.replace(/{{meetingLinkBlock}}/g, buildMeetingLinkBlock(meetingLink, lang));

  const subject = (SUBJECTS.confirmation[lang] || SUBJECTS.confirmation.en) + ` - ${dateStr}`;

  try {
    const mailOpts = {
      from: process.env.EMAIL_FROM || 'UMAI <noreply@umai.io>',
      to: guestEmail,
      subject,
      html,
    };
    if (replyTo) mailOpts.replyTo = replyTo;
    await transporter.sendMail(mailOpts);
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
async function sendCancellation({ guestName, guestEmail, slotStart, guestTz, replyTo, lang }) {
  const transporter = getTransporter();
  if (!transporter) return false;

  const startDt = DateTime.fromISO(slotStart, { zone: guestTz });
  const dateStr = startDt.setLocale(lang || 'en').toFormat('EEEE, MMMM d, yyyy');
  const timeStr = startDt.toFormat('h:mm a');

  let html;
  try {
    html = getTemplate('cancellationEmail', lang);
    html = html.replace(/{{guestName}}/g, guestName);
    html = html.replace(/{{date}}/g, dateStr);
    html = html.replace(/{{time}}/g, timeStr);
  } catch {
    // Fallback to inline HTML if no template exists
    html = `
      <div style="font-family: 'DM Sans', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #2D2D3A;">Session Cancelled</h2>
        <p>Hi ${guestName},</p>
        <p>Your UMAI training session on <strong>${dateStr}</strong> at <strong>${timeStr}</strong> has been cancelled.</p>
        <p>If you'd like to reschedule, please contact us or complete the sign-up process again.</p>
        <p style="color: #71717A; font-size: 13px; margin-top: 32px;">- The UMAI Team</p>
      </div>
    `;
  }

  const subject = SUBJECTS.cancellation[lang] || SUBJECTS.cancellation.en;

  try {
    const mailOpts = {
      from: process.env.EMAIL_FROM || 'UMAI <noreply@umai.io>',
      to: guestEmail,
      subject,
      html,
    };
    if (replyTo) mailOpts.replyTo = replyTo;
    await transporter.sendMail(mailOpts);
    logger.info({ to: guestEmail }, 'Cancellation email sent');
    return true;
  } catch (err) {
    logger.error({ err, to: guestEmail }, 'Failed to send cancellation email');
    return false;
  }
}

/**
 * Send booking update email (e.g. staff reassignment).
 * Returns true if sent successfully, false otherwise.
 */
async function sendUpdate({ guestName, guestEmail, slotStart, slotEnd, guestTz, venueName, venueAddress, meetingTypeLabel, meetingLink, replyTo, lang }) {
  const transporter = getTransporter();
  if (!transporter) {
    logger.warn('Email not configured - skipping update email');
    return false;
  }

  const startDt = DateTime.fromISO(slotStart, { zone: guestTz });
  const endDt = DateTime.fromISO(slotEnd, { zone: guestTz });

  const dateStr = startDt.setLocale(lang || 'en').toFormat('EEEE, MMMM d, yyyy');
  const timeStr = `${startDt.toFormat('h:mm a')} - ${endDt.toFormat('h:mm a')}`;
  const tzStr = startDt.toFormat('ZZZZZ');

  const isOnline = meetingTypeLabel === 'Online' || meetingTypeLabel === 'Freemium';
  const location = isOnline ? 'Online' : (venueAddress || venueName || 'In-Person');

  let html = getTemplate('updateEmail', lang);
  html = html.replace(/{{guestName}}/g, guestName);
  html = html.replace(/{{date}}/g, dateStr);
  html = html.replace(/{{time}}/g, timeStr);
  html = html.replace(/{{timezone}}/g, tzStr);
  html = html.replace(/{{venueName}}/g, venueName || 'your venue');
  html = html.replace(/{{meetingType}}/g, meetingTypeLabel || 'Training');
  html = html.replace(/{{location}}/g, location);
  html = html.replace(/{{meetingLinkBlock}}/g, buildMeetingLinkBlock(meetingLink, lang));

  const subject = (SUBJECTS.update[lang] || SUBJECTS.update.en) + ` - ${dateStr}`;

  try {
    const mailOpts = {
      from: process.env.EMAIL_FROM || 'UMAI <noreply@umai.io>',
      to: guestEmail,
      subject,
      html,
    };
    if (replyTo) mailOpts.replyTo = replyTo;
    await transporter.sendMail(mailOpts);
    logger.info({ to: guestEmail }, 'Update email sent');
    return true;
  } catch (err) {
    logger.error({ err, to: guestEmail }, 'Failed to send update email');
    return false;
  }
}

module.exports = { sendConfirmation, sendCancellation, sendUpdate };
