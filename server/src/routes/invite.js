const { Router } = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { getOAuth2Client } = require('../config/google');

const router = Router();

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// GET /api/invite/google/authorize
// Returns the Google OAuth consent URL for a staff member during the invite flow.
// Requires a JWT from set-password (not requireAdmin).
router.get('/google/authorize', async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let payload;
    try {
      payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Look up the staff_members entry for this user
    const { rows } = await pool.query(
      'SELECT id FROM staff_members WHERE email = $1',
      [payload.email]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const staffId = rows[0].id;
    const oauth2 = getOAuth2Client();
    if (!oauth2) {
      return res.status(500).json({ error: 'Google OAuth is not configured' });
    }

    const authUrl = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent select_account',
      scope: SCOPES,
      state: JSON.stringify({ staffId: String(staffId), source: 'invite' }),
    });

    res.json({ url: authUrl });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
