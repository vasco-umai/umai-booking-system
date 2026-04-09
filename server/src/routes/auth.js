const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const logger = require('../lib/logger');
const { loginLimiter, forgotPasswordLimiter, checkEmailLimiter } = require('../middleware/rateLimiter');
const { isValidEmail, isStrongPassword } = require('../middleware/validate');

const router = Router();

function signToken(admin) {
  // Admin tokens expire sooner for security
  const expiresIn = admin.role === 'admin' ? '8h' : '24h';
  return jwt.sign(
    { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
    process.env.JWT_SECRET,
    { expiresIn }
  );
}

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const { rows } = await pool.query(
      'SELECT * FROM admin_users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const admin = rows[0];

    // First-time login: no password set yet
    if (admin.must_set_password || !admin.password_hash) {
      if (password) {
        return res.status(403).json({
          error: 'You need to set a password first',
          mustSetPassword: true
        });
      }
      // Issue a short-lived token so the user can set their password
      const token = jwt.sign(
        { id: admin.id, email: admin.email, name: admin.name, setPasswordOnly: true },
        process.env.JWT_SECRET,
        { expiresIn: '15m' }
      );
      return res.json({ mustSetPassword: true, token, admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } });
    }

    // Normal login: password required
    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(admin);
    res.json({ token, admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/invite/validate?token=xxx
router.get('/invite/validate', async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const { rows } = await pool.query(
      `SELECT au.id, au.name, au.email, au.must_set_password, au.password_hash,
              sm.id as staff_id, sm.google_refresh_token
       FROM admin_users au
       LEFT JOIN staff_members sm ON LOWER(sm.email) = LOWER(au.email)
       WHERE au.invite_token = $1 AND au.invite_token_expires > NOW()`,
      [token]
    );

    if (rows.length === 0) {
      // Check if token exists at all (even if expired) to provide useful diagnostics
      const { rows: debugRows } = await pool.query(
        `SELECT invite_token_expires, NOW() as db_now FROM admin_users WHERE invite_token = $1`,
        [token]
      );
      if (debugRows.length > 0) {
        const expires = debugRows[0].invite_token_expires;
        const dbNow = debugRows[0].db_now;
        logger.warn({ tokenPrefix: token.slice(0, 8), expires, dbNow }, '[INVITE] Token found but expired');
        return res.status(400).json({
          error: 'Invalid or expired invite link',
          debug: { reason: 'expired', expires, dbNow }
        });
      } else {
        logger.warn({ tokenPrefix: token.slice(0, 8) }, '[INVITE] Token not found in database');
        return res.status(400).json({
          error: 'Invalid or expired invite link',
          debug: { reason: 'token_not_found' }
        });
      }
    }

    const user = rows[0];
    res.json({
      name: user.name,
      email: user.email,
      staffId: user.staff_id,
      needsPassword: user.must_set_password || !user.password_hash,
      hasGoogleCalendar: !!user.google_refresh_token
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/set-password
router.post('/set-password', async (req, res, next) => {
  try {
    const { password, token: resetToken } = req.body;

    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters with uppercase, lowercase, and a number', code: 'WEAK_PASSWORD' });
    }

    let adminId;

    if (resetToken) {
      // Forgot-password or invite flow: validate reset_token or invite_token
      const { rows } = await pool.query(
        `SELECT * FROM admin_users
         WHERE (reset_token = $1 AND reset_token_expires > NOW())
            OR (invite_token = $1 AND invite_token_expires > NOW())`,
        [resetToken]
      );
      if (rows.length === 0) {
        return res.status(400).json({ error: 'Invalid or expired link' });
      }
      adminId = rows[0].id;
    } else {
      // First-login flow: validate JWT from Authorization header
      const header = req.headers.authorization;
      if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      try {
        const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
        adminId = payload.id;
      } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
    }

    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `UPDATE admin_users
       SET password_hash = $1, must_set_password = false,
           reset_token = NULL, reset_token_expires = NULL,
           invite_token = NULL, invite_token_expires = NULL
       WHERE id = $2`,
      [hash, adminId]
    );

    // Fetch updated admin for token
    const { rows } = await pool.query('SELECT * FROM admin_users WHERE id = $1', [adminId]);
    const admin = rows[0];
    const token = signToken(admin);

    res.json({ token, admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', forgotPasswordLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const { rows } = await pool.query(
      'SELECT * FROM admin_users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    // Always respond with success to avoid email enumeration
    if (rows.length === 0) {
      return res.json({ message: 'If that email exists, a reset link has been sent.' });
    }

    const admin = rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      'UPDATE admin_users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
      [resetToken, expires, admin.id]
    );

    // Send reset email
    try {
      const { getTransporter } = require('../config/email');
      const transporter = getTransporter();
      if (transporter) {
        const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3001'}/admin.html?reset=${resetToken}`;
        await transporter.sendMail({
          from: process.env.EMAIL_FROM || 'UMAI <noreply@umai.io>',
          to: admin.email,
          subject: 'UMAI — Reset Your Password',
          html: `
            <div style="font-family: 'DM Sans', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
              <h2 style="color: #2D2D3A;">Reset Your Password</h2>
              <p>Hi ${admin.name},</p>
              <p>Click the button below to reset your password. This link expires in 1 hour.</p>
              <a href="${resetUrl}" style="display:inline-block;padding:14px 32px;background:#2BBCB3;color:#fff;text-decoration:none;border-radius:50px;font-weight:600;margin:24px 0;">Reset Password</a>
              <p style="color: #71717A; font-size: 13px; margin-top: 32px;">If you didn't request this, you can ignore this email.</p>
            </div>
          `,
        });
      } else {
        logger.warn({ resetToken }, 'Email not configured - reset token generated but not sent');
      }
    } catch (emailErr) {
      logger.error({ err: emailErr }, 'Failed to send reset email');
    }

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/check-email
// Checks if an email exists in the system (for smart login flow)
router.post('/check-email', checkEmailLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const { rows } = await pool.query(
      'SELECT password_hash, must_set_password FROM admin_users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0) {
      return res.json({ exists: false });
    }

    const user = rows[0];
    const hasPassword = !!user.password_hash && !user.must_set_password;
    res.json({ exists: true, hasPassword });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
