require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { pool } = require('./config/db');
const logger = require('./lib/logger');
const errorHandler = require('./middleware/errorHandler');
const requestId = require('./middleware/requestId');
const { availabilityLimiter, bookingLimiter } = require('./middleware/rateLimiter');
const availabilityRoutes = require('./routes/availability');
const bookingRoutes = require('./routes/bookings');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const googleOAuthRoutes = require('./routes/googleOAuth');
const inviteRoutes = require('./routes/invite');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// CORS - hard-fail on boot if FRONTEND_URL is unset in production.
// Previously this degraded to `origin: '*'` with only a warn log, which meant
// a missing env var silently opened CORS to any origin. See H4.
if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) {
  logger.fatal('FRONTEND_URL must be set in production to constrain CORS origin');
  process.exit(1);
}
const corsOrigin = process.env.FRONTEND_URL || '*';
app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Core middleware
app.use(requestId);
app.use(express.json());

// Serve static frontend files
const frontendDir = path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(frontendDir));

// Public routes (with rate limiting)
app.use('/api/availability', availabilityLimiter, availabilityRoutes);
app.use('/api/bookings', bookingLimiter, bookingRoutes);
app.use('/api/invite', inviteRoutes);

// Auth + Admin routes (rate limiting applied per-endpoint in auth.js)
app.use('/api/auth', authRoutes);
app.use('/api/admin', googleOAuthRoutes); // Must be before adminRoutes (callback has no Bearer token)
app.use('/api/admin', adminRoutes);

// Health check with real diagnostics
app.get('/api/health', async (req, res) => {
  const checks = { db: 'ok', smtp: 'ok', google: 'ok' };

  // DB check
  try {
    await pool.query('SELECT 1');
  } catch {
    checks.db = 'down';
  }

  // SMTP check
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    checks.smtp = 'not_configured';
  }

  // Google Calendar check
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && !process.env.GOOGLE_OAUTH_CLIENT_ID) {
    checks.google = 'not_configured';
  }

  const status = checks.db === 'ok' ? 'ok' : 'degraded';
  const httpStatus = checks.db === 'ok' ? 200 : 503;

  res.status(httpStatus).json({ status, checks, timestamp: new Date().toISOString() });
});

// Error handler
app.use(errorHandler);

// Start server
async function start() {
  try {
    await pool.query('SELECT NOW()');
    logger.info('Database connected');

    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
    });
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }
}

// Vercel serverless: export the Express app; locally: start listening
if (process.env.VERCEL) {
  module.exports = app;
} else {
  start();
}
