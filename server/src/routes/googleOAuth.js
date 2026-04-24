const { Router } = require('express');
const { pool } = require('../config/db');
const logger = require('../lib/logger');
const { getOAuth2Client } = require('../config/google');
const { requireAdmin, getEffectiveTeamId } = require('../middleware/auth');
const staffService = require('../services/staffService');

const router = Router();

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// GET /api/admin/staff/:id/google/authorize
// Returns the Google OAuth consent URL for a staff member.
router.get('/staff/:id/google/authorize', requireAdmin, async (req, res, next) => {
  try {
    const oauth2 = getOAuth2Client();
    if (!oauth2) {
      return res.status(500).json({ error: 'Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI.' });
    }

    const staffId = parseInt(req.params.id, 10);
    if (!Number.isInteger(staffId) || staffId <= 0) {
      return res.status(400).json({ error: 'Invalid staff id' });
    }
    const teamId = getEffectiveTeamId(req);

    // Tenant check: staff must belong to caller's team. Otherwise any admin could
    // start a Google OAuth flow for another team's staff. See H1 / self-review H-B.
    if (!(await staffService.staffBelongsToTeam(staffId, teamId))) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const authUrl = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent select_account',
      scope: SCOPES,
      state: String(staffId),
    });

    res.json({ url: authUrl });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/staff/google/callback
// Google redirects here after the user grants consent.
router.get('/staff/google/callback', async (req, res) => {
  const { code, state: rawState, error } = req.query;

  if (error) {
    return res.send(oauthResultPage(false, `Google authorization was denied: ${error}`));
  }

  if (!code || !rawState) {
    return res.send(oauthResultPage(false, 'Missing authorization code or staff ID.'));
  }

  // Parse state: JSON (new invite flow) or plain string (admin flow)
  let staffId, source;
  try {
    const parsed = JSON.parse(rawState);
    staffId = parsed.staffId;
    source = parsed.source;
  } catch {
    staffId = rawState;
    source = 'admin';
  }

  const oauth2 = getOAuth2Client();
  if (!oauth2) {
    return res.send(oauthResultPage(false, 'Google OAuth is not configured on the server.', source));
  }

  try {
    // Exchange code for tokens
    const { tokens } = await oauth2.getToken(code);

    if (!tokens.refresh_token) {
      return res.send(oauthResultPage(false, 'No refresh token received. The staff member may need to revoke access at myaccount.google.com/permissions and try again.', source));
    }

    // Get the staff member's primary calendar ID (their email) from Google
    oauth2.setCredentials(tokens);
    const { google } = require('googleapis');
    const calendar = google.calendar({ version: 'v3', auth: oauth2 });

    const calendarRes = await calendar.calendars.get({ calendarId: 'primary' });
    const calendarId = calendarRes.data.id;

    // Store refresh token and calendar ID
    const { rowCount } = await pool.query(
      `UPDATE staff_members
       SET google_refresh_token = $1,
           google_calendar_id = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [tokens.refresh_token, calendarId, staffId]
    );

    if (rowCount === 0) {
      return res.send(oauthResultPage(false, 'Staff member not found. The link may have expired.', source));
    }

    return res.send(oauthResultPage(true, `Google Calendar connected successfully (${calendarId}).`, source));
  } catch (err) {
    logger.error({ err }, 'Google OAuth callback error');
    return res.send(oauthResultPage(false, `Failed to connect: ${err.message}`, source));
  }
});

// GET /api/admin/staff/:id/google/disconnect
// Remove the stored OAuth tokens for a staff member.
router.post('/staff/:id/google/disconnect', requireAdmin, async (req, res, next) => {
  try {
    const staffId = parseInt(req.params.id, 10);
    if (!Number.isInteger(staffId) || staffId <= 0) {
      return res.status(400).json({ error: 'Invalid staff id' });
    }
    const teamId = getEffectiveTeamId(req);

    // Tenant scope: add team_id to WHERE so an admin in team A cannot disconnect
    // team B's Google integration by enumerating ids. See H1 / self-review H-B.
    const { rowCount } = await pool.query(
      `UPDATE staff_members
       SET google_refresh_token = NULL,
           google_calendar_id = NULL,
           updated_at = NOW()
       WHERE id = $1 AND team_id = $2`,
      [staffId, teamId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    res.json({ message: 'Google Calendar disconnected' });
  } catch (err) {
    next(err);
  }
});

function oauthResultPage(success, message, source = 'admin') {
  const isInvite = source === 'invite';
  const title = success
    ? (isInvite ? 'Onboarding Complete!' : 'Connected!')
    : 'Connection Failed';
  const action = isInvite
    ? '<p style="color:#999;font-size:13px;margin-top:8px;">You can close this page.</p>'
    : '<a class="btn" href="javascript:window.close()">Close Window</a>';

  return `<!DOCTYPE html>
<html><head><title>Google Calendar - ${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: #fff; padding: 40px; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.08); text-align: center; max-width: 420px; }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h2 { margin: 0 0 8px; color: #1a1a2e; }
  p { color: #666; margin: 0 0 24px; }
  .btn { display: inline-block; padding: 10px 24px; background: #2BBCB3; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; text-decoration: none; }
</style></head>
<body><div class="card">
  <div class="icon">${success ? '&#10003;' : '&#10007;'}</div>
  <h2>${title}</h2>
  <p>${message}</p>
  ${action}
</div></body></html>`;
}

module.exports = router;
