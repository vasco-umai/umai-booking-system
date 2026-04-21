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

// Locales that use 24-hour clocks by default. English defaults to 12-hour AM/PM.
// Anything not listed falls through to 12-hour to avoid surprising users whose
// locale convention hasn't been explicitly validated yet.
const TWENTY_FOUR_HOUR_LOCALES = new Set(['pt', 'es', 'fr', 'de', 'da']);

// Map app locale codes to full IETF tags for Intl APIs. Luxon's setLocale accepts
// either, but Intl.DateTimeFormat.formatToParts expects full tags for timeZoneName.
const LOCALE_TAG = {
  en: 'en-US',
  pt: 'pt-PT',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  da: 'da-DK',
};

// Cache city labels to avoid recomputing on every email; tz keys are stable.
const cityLabelCache = new Map();

/**
 * Human-friendly city label for an IANA timezone, e.g. 'Europe/Lisbon' -> 'Lisboa' (PT)
 * or 'America/New_York' -> 'New York' (EN). Falls back to the last path segment with
 * underscores replaced by spaces if the Intl lookup doesn't surface a city.
 */
function timezoneCityLabel(tz, lang) {
  const cacheKey = `${tz}|${lang || 'en'}`;
  if (cityLabelCache.has(cacheKey)) return cityLabelCache.get(cacheKey);

  const tag = LOCALE_TAG[lang] || LOCALE_TAG.en;
  let label = tz.split('/').pop().replace(/_/g, ' ');
  try {
    const parts = new Intl.DateTimeFormat(tag, {
      timeZone: tz,
      timeZoneName: 'long',
    }).formatToParts(new Date());
    const tzPart = parts.find((p) => p.type === 'timeZoneName');
    if (tzPart && tzPart.value) {
      // Strip leading "Hora de ..." / "Horário ..." / etc. — we want a short city label,
      // not the full zone name. If the Intl name looks like a raw offset (GMT+01:00),
      // keep the city-path fallback instead.
      if (!/^(GMT|UTC)/i.test(tzPart.value)) label = tzPart.value;
    }
  } catch { /* keep fallback */ }

  // Hand-tuned PT translations for the most common zones — Intl's full zone name in
  // pt-PT produces verbose strings ("Hora de Verão da Europa Ocidental") unsuitable
  // for a compact `City (UTC±X)` label. Fall back to the raw city path otherwise.
  if (lang === 'pt') {
    const PT_CITY = {
      'Europe/Lisbon': 'Lisboa',
      'Europe/Madrid': 'Madrid',
      'Europe/London': 'Londres',
      'Europe/Paris': 'Paris',
      'Europe/Berlin': 'Berlim',
      'Europe/Copenhagen': 'Copenhaga',
      'America/New_York': 'Nova Iorque',
      'America/Los_Angeles': 'Los Angeles',
      'America/Sao_Paulo': 'São Paulo',
      'Asia/Tokyo': 'Tóquio',
      'Asia/Dubai': 'Dubai',
      'Asia/Singapore': 'Singapura',
      'Australia/Sydney': 'Sydney',
    };
    if (PT_CITY[tz]) label = PT_CITY[tz];
  }

  cityLabelCache.set(cacheKey, label);
  return label;
}

/**
 * Format the booking's date/time/timezone as locale-native strings for email.
 *
 * EN:  "Monday, April 21, 2026" + "2:30 PM - 3:00 PM" + "Lisbon (UTC+1)"
 * PT:  "segunda-feira, 21 de abril de 2026" + "14:30 - 15:00" + "Lisboa (UTC+1)"
 *
 * Offset is recomputed per slot via Luxon, so DST transitions surface correctly
 * (UTC+0 in winter / UTC+1 in summer for Lisbon).
 */
function formatBookingDateTime({ slotStart, slotEnd, tz, lang }) {
  const locale = lang || 'en';
  // If the supplied tz is missing or invalid (garbage string in legacy data),
  // fall back to UTC — better a correct UTC time than "UTC+NaN" in an email.
  // Warn so bad data surfaces in logs instead of shipping wrong-zone emails silently.
  const tzValid = !!(tz && DateTime.now().setZone(tz).isValid);
  if (tz && !tzValid) {
    logger.warn({ tz, lang }, 'formatBookingDateTime: invalid timezone, falling back to UTC');
  }
  const safeTz = tzValid ? tz : 'UTC';
  const startDt = DateTime.fromISO(slotStart, { zone: safeTz }).setLocale(locale);
  const endDt = slotEnd ? DateTime.fromISO(slotEnd, { zone: safeTz }).setLocale(locale) : null;

  const dateStr = startDt.toLocaleString(DateTime.DATE_HUGE);

  const timeFormat = TWENTY_FOUR_HOUR_LOCALES.has(locale)
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : DateTime.TIME_SIMPLE;
  const timeStr = endDt
    ? `${startDt.toLocaleString(timeFormat)} - ${endDt.toLocaleString(timeFormat)}`
    : startDt.toLocaleString(timeFormat);

  const offsetMinutes = startDt.isValid ? startDt.offset : 0;
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absMinutes / 60);
  const offsetMins = absMinutes % 60;
  const offsetLabel = offsetMins === 0
    ? `UTC${offsetSign}${offsetHours}`
    : `UTC${offsetSign}${offsetHours}:${String(offsetMins).padStart(2, '0')}`;
  const tzStr = `${timezoneCityLabel(safeTz, locale)} (${offsetLabel})`;

  return { dateStr, timeStr, tzStr };
}

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

  const { dateStr, timeStr, tzStr } = formatBookingDateTime({ slotStart, slotEnd, tz: guestTz, lang });

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

  const { dateStr, timeStr } = formatBookingDateTime({ slotStart, slotEnd: null, tz: guestTz, lang });

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

  const { dateStr, timeStr, tzStr } = formatBookingDateTime({ slotStart, slotEnd, tz: guestTz, lang });

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

/* ─────────────────────────────────────────────────────────────
 * Staff-facing notifications (English only, inline HTML)
 * ───────────────────────────────────────────────────────────── */

const STAFF_TZ_DEFAULT = 'Europe/Lisbon';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function staffEmailFrame(innerHtml) {
  const baseUrl = process.env.FRONTEND_URL || 'https://umai-booking.vercel.app';
  const dashboardUrl = `${baseUrl}/admin.html`;
  return `
    <div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#2D2D3A;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="font-size:22px;font-weight:700;color:#2BBCB3;">UMAI Meetings</div>
      </div>
      ${innerHtml}
      <p style="color:#71717A;font-size:12px;margin-top:32px;text-align:center;">
        <a href="${dashboardUrl}" style="color:#2BBCB3;text-decoration:none;">Open admin dashboard</a>
      </p>
    </div>`;
}

async function sendStaffNewBooking({
  staffEmail, staffName, guestName, guestEmail, guestPhone,
  slotStart, slotEnd, staffTz, venueName, venueAddress,
  meetingTypeLabel, meetingLink, bookingId,
}) {
  const transporter = getTransporter();
  if (!transporter || !staffEmail) return false;

  const tz = staffTz || STAFF_TZ_DEFAULT;
  const startDt = DateTime.fromISO(slotStart, { zone: tz });
  const endDt = DateTime.fromISO(slotEnd, { zone: tz });
  const dateStr = startDt.toFormat('EEEE, MMMM d, yyyy');
  const timeStr = `${startDt.toFormat('h:mm a')} - ${endDt.toFormat('h:mm a')}`;
  const tzStr = startDt.toFormat('ZZZZZ');

  const inner = `
    <h2 style="font-size:20px;margin:0 0 8px;">New booking: ${escapeHtml(guestName)}</h2>
    <p style="margin:0 0 20px;color:#52525B;">
      Hi ${escapeHtml(staffName || 'there')}, a new training session was just booked with you.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
      <tr><td style="padding:8px 0;color:#71717A;width:120px;">When</td><td style="padding:8px 0;"><strong>${dateStr}</strong><br>${timeStr} (${tzStr})</td></tr>
      <tr><td style="padding:8px 0;color:#71717A;">Guest</td><td style="padding:8px 0;">${escapeHtml(guestName)}</td></tr>
      <tr><td style="padding:8px 0;color:#71717A;">Email</td><td style="padding:8px 0;"><a href="mailto:${escapeHtml(guestEmail)}" style="color:#2BBCB3;">${escapeHtml(guestEmail)}</a></td></tr>
      ${guestPhone ? `<tr><td style="padding:8px 0;color:#71717A;">Phone</td><td style="padding:8px 0;">${escapeHtml(guestPhone)}</td></tr>` : ''}
      ${venueName ? `<tr><td style="padding:8px 0;color:#71717A;">Venue</td><td style="padding:8px 0;">${escapeHtml(venueName)}</td></tr>` : ''}
      ${venueAddress && meetingTypeLabel !== 'Online' && meetingTypeLabel !== 'Freemium' ? `<tr><td style="padding:8px 0;color:#71717A;">Address</td><td style="padding:8px 0;"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venueAddress)}" style="color:#2BBCB3;text-decoration:none;">${escapeHtml(venueAddress)}</a></td></tr>` : ''}
      ${meetingTypeLabel ? `<tr><td style="padding:8px 0;color:#71717A;">Type</td><td style="padding:8px 0;">${escapeHtml(meetingTypeLabel)}</td></tr>` : ''}
      ${bookingId ? `<tr><td style="padding:8px 0;color:#71717A;">Booking ID</td><td style="padding:8px 0;color:#71717A;">#${escapeHtml(bookingId)}</td></tr>` : ''}
    </table>
    ${buildMeetingLinkBlock(meetingLink, 'en')}`;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'UMAI <noreply@umai.io>',
      to: staffEmail,
      replyTo: guestEmail,
      subject: `New UMAI booking: ${guestName} - ${dateStr}`,
      html: staffEmailFrame(inner),
    });
    logger.info({ to: staffEmail, bookingId }, 'Staff new-booking email sent');
    return true;
  } catch (err) {
    logger.error({ err, to: staffEmail, bookingId }, 'Failed to send staff new-booking email');
    return false;
  }
}

async function sendStaffCancellation({
  staffEmail, staffName, guestName, guestEmail,
  slotStart, staffTz, bookingId,
}) {
  const transporter = getTransporter();
  if (!transporter || !staffEmail) return false;

  const tz = staffTz || STAFF_TZ_DEFAULT;
  const startDt = DateTime.fromISO(slotStart, { zone: tz });
  const dateStr = startDt.toFormat('EEEE, MMMM d, yyyy');
  const timeStr = startDt.toFormat('h:mm a');
  const tzStr = startDt.toFormat('ZZZZZ');

  const inner = `
    <h2 style="font-size:20px;margin:0 0 8px;">Booking cancelled</h2>
    <p style="margin:0 0 20px;color:#52525B;">
      Hi ${escapeHtml(staffName || 'there')}, the following training session was cancelled.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:8px 0;color:#71717A;width:120px;">When</td><td style="padding:8px 0;"><strong>${dateStr}</strong> at ${timeStr} (${tzStr})</td></tr>
      <tr><td style="padding:8px 0;color:#71717A;">Guest</td><td style="padding:8px 0;">${escapeHtml(guestName)}</td></tr>
      <tr><td style="padding:8px 0;color:#71717A;">Email</td><td style="padding:8px 0;"><a href="mailto:${escapeHtml(guestEmail)}" style="color:#2BBCB3;">${escapeHtml(guestEmail)}</a></td></tr>
      ${bookingId ? `<tr><td style="padding:8px 0;color:#71717A;">Booking ID</td><td style="padding:8px 0;color:#71717A;">#${escapeHtml(bookingId)}</td></tr>` : ''}
    </table>`;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'UMAI <noreply@umai.io>',
      to: staffEmail,
      subject: `Cancelled: UMAI booking with ${guestName} - ${dateStr}`,
      html: staffEmailFrame(inner),
    });
    logger.info({ to: staffEmail, bookingId }, 'Staff cancellation email sent');
    return true;
  } catch (err) {
    logger.error({ err, to: staffEmail, bookingId }, 'Failed to send staff cancellation email');
    return false;
  }
}

async function sendStaffUpdate({
  staffEmail, staffName, guestName, guestEmail,
  slotStart, slotEnd, staffTz, venueName, meetingTypeLabel,
  meetingLink, bookingId, note,
}) {
  const transporter = getTransporter();
  if (!transporter || !staffEmail) return false;

  const tz = staffTz || STAFF_TZ_DEFAULT;
  const startDt = DateTime.fromISO(slotStart, { zone: tz });
  const endDt = DateTime.fromISO(slotEnd, { zone: tz });
  const dateStr = startDt.toFormat('EEEE, MMMM d, yyyy');
  const timeStr = `${startDt.toFormat('h:mm a')} - ${endDt.toFormat('h:mm a')}`;
  const tzStr = startDt.toFormat('ZZZZZ');

  const inner = `
    <h2 style="font-size:20px;margin:0 0 8px;">Booking updated: ${escapeHtml(guestName)}</h2>
    <p style="margin:0 0 20px;color:#52525B;">
      Hi ${escapeHtml(staffName || 'there')}, a booking assigned to you was updated.${note ? ` ${escapeHtml(note)}` : ''}
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
      <tr><td style="padding:8px 0;color:#71717A;width:120px;">When</td><td style="padding:8px 0;"><strong>${dateStr}</strong><br>${timeStr} (${tzStr})</td></tr>
      <tr><td style="padding:8px 0;color:#71717A;">Guest</td><td style="padding:8px 0;">${escapeHtml(guestName)}</td></tr>
      <tr><td style="padding:8px 0;color:#71717A;">Email</td><td style="padding:8px 0;"><a href="mailto:${escapeHtml(guestEmail)}" style="color:#2BBCB3;">${escapeHtml(guestEmail)}</a></td></tr>
      ${venueName ? `<tr><td style="padding:8px 0;color:#71717A;">Venue</td><td style="padding:8px 0;">${escapeHtml(venueName)}</td></tr>` : ''}
      ${meetingTypeLabel ? `<tr><td style="padding:8px 0;color:#71717A;">Type</td><td style="padding:8px 0;">${escapeHtml(meetingTypeLabel)}</td></tr>` : ''}
      ${bookingId ? `<tr><td style="padding:8px 0;color:#71717A;">Booking ID</td><td style="padding:8px 0;color:#71717A;">#${escapeHtml(bookingId)}</td></tr>` : ''}
    </table>
    ${buildMeetingLinkBlock(meetingLink, 'en')}`;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'UMAI <noreply@umai.io>',
      to: staffEmail,
      replyTo: guestEmail,
      subject: `Updated: UMAI booking with ${guestName} - ${dateStr}`,
      html: staffEmailFrame(inner),
    });
    logger.info({ to: staffEmail, bookingId }, 'Staff update email sent');
    return true;
  } catch (err) {
    logger.error({ err, to: staffEmail, bookingId }, 'Failed to send staff update email');
    return false;
  }
}

module.exports = {
  sendConfirmation,
  sendCancellation,
  sendUpdate,
  sendStaffNewBooking,
  sendStaffCancellation,
  sendStaffUpdate,
};
