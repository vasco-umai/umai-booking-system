const { google } = require('googleapis');

// ---------------------------------------------------------------------------
// Service-account calendar client (legacy / fallback)
// ---------------------------------------------------------------------------
let serviceCalendar = null;

function getCalendarClient() {
  if (serviceCalendar) return serviceCalendar;

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    // Not configured - calendar sync disabled
    return null;
  }

  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/calendar']
  );

  serviceCalendar = google.calendar({ version: 'v3', auth });
  return serviceCalendar;
}

// ---------------------------------------------------------------------------
// OAuth 2.0 helpers (per-staff calendar access)
// ---------------------------------------------------------------------------

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Build a Google Calendar client authenticated with a staff member's refresh token.
 * @param {string} refreshToken
 * @returns {object|null} google.calendar client, or null if OAuth is not configured.
 */
function getCalendarClientForStaff(refreshToken) {
  const oauth2 = getOAuth2Client();
  if (!oauth2 || !refreshToken) return null;

  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: 'v3', auth: oauth2 });
}

module.exports = { getCalendarClient, getOAuth2Client, getCalendarClientForStaff };
