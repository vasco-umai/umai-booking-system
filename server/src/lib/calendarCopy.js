const { DateTime } = require('luxon');

const SUMMARY_SUFFIX = {
  en: 'Setup and Settings Adjustments',
  pt: 'Configuração e Ajustes Iniciais',
  es: 'Configuración y Ajustes Iniciales',
  fr: 'Configuration et Ajustements',
  de: 'Einrichtung und Einstellungen',
  da: 'Opsætning og Indstillinger',
};

const THE_VENUE_FALLBACK = {
  en: 'the venue',
  pt: 'o local',
  es: 'el local',
  fr: 'le lieu',
  de: 'dem Veranstaltungsort',
  da: 'stedet',
};

const DESCRIPTION_BUILDERS = {
  en: ({ formattedDay, formattedTime, venueName, isMini, isOnline }) => {
    if (isMini) {
      return `We confirm our training session on day ${formattedDay}, online, at ${formattedTime}.\n\nThe setup and training session will last approximately 1 hour, divided as follows:\n- 30 to 40 minutes: UMAI account setup\n- 15 to 20 minutes: team training`;
    }
    if (isOnline) {
      return `We confirm our training session on day ${formattedDay}, online, at ${formattedTime}.\n\nThe setup and training session will last approximately 2 hours, divided as follows:\n- 1h15 to 1h30: UMAI account setup\n- 30 to 45 minutes: team training`;
    }
    return `We confirm our training session on day ${formattedDay}, at ${venueName}, at ${formattedTime}.\n\nThe setup and training session will last approximately 2 hours, divided as follows:\n- 1h15 to 1h30: UMAI account setup\n- 30 to 45 minutes: team training`;
  },
  pt: ({ formattedDay, formattedTime, venueName, isMini, isOnline }) => {
    if (isMini) {
      return `Confirmamos a sessão de treino no dia ${formattedDay}, online, às ${formattedTime}.\n\nA configuração e a sessão de treino terão aproximadamente 1 hora, divididas da seguinte forma:\n- 30 a 40 minutos: configuração da conta UMAI\n- 15 a 20 minutos: formação da equipa`;
    }
    if (isOnline) {
      return `Confirmamos a sessão de treino no dia ${formattedDay}, online, às ${formattedTime}.\n\nA configuração e a sessão de treino terão aproximadamente 2 horas, divididas da seguinte forma:\n- 1h15 a 1h30: configuração da conta UMAI\n- 30 a 45 minutos: formação da equipa`;
    }
    return `Confirmamos a sessão de treino no dia ${formattedDay}, em ${venueName}, às ${formattedTime}.\n\nA configuração e a sessão de treino terão aproximadamente 2 horas, divididas da seguinte forma:\n- 1h15 a 1h30: configuração da conta UMAI\n- 30 a 45 minutos: formação da equipa`;
  },
  es: ({ formattedDay, formattedTime, venueName, isMini, isOnline }) => {
    if (isMini) {
      return `Confirmamos la sesión de formación el día ${formattedDay}, online, a las ${formattedTime}.\n\nLa configuración y la sesión de formación durarán aproximadamente 1 hora, divididas así:\n- 30 a 40 minutos: configuración de la cuenta UMAI\n- 15 a 20 minutos: formación del equipo`;
    }
    if (isOnline) {
      return `Confirmamos la sesión de formación el día ${formattedDay}, online, a las ${formattedTime}.\n\nLa configuración y la sesión de formación durarán aproximadamente 2 horas, divididas así:\n- 1h15 a 1h30: configuración de la cuenta UMAI\n- 30 a 45 minutos: formación del equipo`;
    }
    return `Confirmamos la sesión de formación el día ${formattedDay}, en ${venueName}, a las ${formattedTime}.\n\nLa configuración y la sesión de formación durarán aproximadamente 2 horas, divididas así:\n- 1h15 a 1h30: configuración de la cuenta UMAI\n- 30 a 45 minutos: formación del equipo`;
  },
  fr: ({ formattedDay, formattedTime, venueName, isMini, isOnline }) => {
    if (isMini) {
      return `Nous confirmons la session de formation le ${formattedDay}, en ligne, à ${formattedTime}.\n\nLa configuration et la session de formation dureront environ 1 heure, réparties ainsi :\n- 30 à 40 minutes : configuration du compte UMAI\n- 15 à 20 minutes : formation de l'équipe`;
    }
    if (isOnline) {
      return `Nous confirmons la session de formation le ${formattedDay}, en ligne, à ${formattedTime}.\n\nLa configuration et la session de formation dureront environ 2 heures, réparties ainsi :\n- 1h15 à 1h30 : configuration du compte UMAI\n- 30 à 45 minutes : formation de l'équipe`;
    }
    return `Nous confirmons la session de formation le ${formattedDay}, à ${venueName}, à ${formattedTime}.\n\nLa configuration et la session de formation dureront environ 2 heures, réparties ainsi :\n- 1h15 à 1h30 : configuration du compte UMAI\n- 30 à 45 minutes : formation de l'équipe`;
  },
  de: ({ formattedDay, formattedTime, venueName, isMini, isOnline }) => {
    if (isMini) {
      return `Wir bestätigen unsere Schulung am ${formattedDay}, online, um ${formattedTime}.\n\nDie Einrichtung und Schulung dauert ca. 1 Stunde, aufgeteilt wie folgt:\n- 30 bis 40 Minuten: UMAI-Kontoeinrichtung\n- 15 bis 20 Minuten: Teamschulung`;
    }
    if (isOnline) {
      return `Wir bestätigen unsere Schulung am ${formattedDay}, online, um ${formattedTime}.\n\nDie Einrichtung und Schulung dauert ca. 2 Stunden, aufgeteilt wie folgt:\n- 1h15 bis 1h30: UMAI-Kontoeinrichtung\n- 30 bis 45 Minuten: Teamschulung`;
    }
    return `Wir bestätigen unsere Schulung am ${formattedDay}, bei ${venueName}, um ${formattedTime}.\n\nDie Einrichtung und Schulung dauert ca. 2 Stunden, aufgeteilt wie folgt:\n- 1h15 bis 1h30: UMAI-Kontoeinrichtung\n- 30 bis 45 Minuten: Teamschulung`;
  },
  da: ({ formattedDay, formattedTime, venueName, isMini, isOnline }) => {
    if (isMini) {
      return `Vi bekræfter vores træningssession den ${formattedDay}, online, kl. ${formattedTime}.\n\nOpsætningen og træningssessionen varer ca. 1 time, opdelt således:\n- 30 til 40 minutter: opsætning af UMAI-konto\n- 15 til 20 minutter: teamtræning`;
    }
    if (isOnline) {
      return `Vi bekræfter vores træningssession den ${formattedDay}, online, kl. ${formattedTime}.\n\nOpsætningen og træningssessionen varer ca. 2 timer, opdelt således:\n- 1t15 til 1t30: opsætning af UMAI-konto\n- 30 til 45 minutter: teamtræning`;
    }
    return `Vi bekræfter vores træningssession den ${formattedDay}, hos ${venueName}, kl. ${formattedTime}.\n\nOpsætningen og træningssessionen varer ca. 2 timer, opdelt således:\n- 1t15 til 1t30: opsætning af UMAI-konto\n- 30 til 45 minutter: teamtræning`;
  },
};

/**
 * Strip HTML-looking content and control characters from guest-controlled text
 * before it goes into a Google Calendar event. Google Calendar's description
 * field accepts a small HTML subset and surfaces in email attendee notifications,
 * so raw user input is unsafe.
 *
 * We remove < > entirely (not HTML-entity-encode — calendar description is not
 * HTML-rendered end-to-end, and `&lt;` would render literally in some clients)
 * and strip control chars that could smuggle calendar invite headers.
 */
function sanitizeCalendarText(s) {
  if (s == null) return '';
  // Strip: angle brackets (HTML smuggling), C0 controls, C1 controls, bidi
  // overrides (U+202A–U+202E, U+2066–U+2069), zero-width chars / BOM, and
  // line/paragraph separators. Covers more than the initial ASCII-only pass
  // so a guestName can't hide RTL overrides or invisible text in calendar
  // summaries seen by staff. See self-review M-B.
  return String(s).replace(/[<>\r\n\x00-\x1F\x7F-\x9F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ').trim();
}

function buildCalendarCopy({ lang, slotStartIso, guestTz, plan, meetingTypeLabel, venueName, venueAddress, guestName, addons }) {
  const effectiveLang = DESCRIPTION_BUILDERS[lang] ? lang : 'en';
  const isMini = plan === 'mini';
  const isOnline = meetingTypeLabel === 'Online' || meetingTypeLabel === 'Freemium' || isMini;
  const dt = DateTime.fromISO(slotStartIso, { zone: guestTz || 'UTC' }).setLocale(effectiveLang);
  const formattedDay = dt.toFormat('MMMM d');
  const formattedTime = dt.toFormat('HH:mm');

  // Sanitize every guest-controlled string before interpolating into calendar copy. See C3.
  const safeVenueName = sanitizeCalendarText(venueName);
  const safeVenueAddress = sanitizeCalendarText(venueAddress);
  const safeGuestName = sanitizeCalendarText(guestName);
  const venue = safeVenueAddress || safeVenueName || THE_VENUE_FALLBACK[effectiveLang] || THE_VENUE_FALLBACK.en;

  let description = DESCRIPTION_BUILDERS[effectiveLang]({
    formattedDay, formattedTime, venueName: venue, isMini, isOnline,
  });
  if (Array.isArray(addons) && addons.length > 0) {
    const addonsHeader = {
      en: 'Add-ons', pt: 'Extras', es: 'Extras', fr: 'Options', de: 'Zusätze', da: 'Tilvalg',
    }[effectiveLang] || 'Add-ons';
    description += `\n\n${addonsHeader}:\n` + addons.map(a => `- ${sanitizeCalendarText(a)}`).join('\n');
  }

  const summary = `UMAI x ${safeVenueName || safeGuestName} - ${SUMMARY_SUFFIX[effectiveLang] || SUMMARY_SUFFIX.en}`;
  return { summary, description };
}

module.exports = { buildCalendarCopy };
