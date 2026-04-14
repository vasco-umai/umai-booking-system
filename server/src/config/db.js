const { Pool } = require('pg');
const logger = require('../lib/logger');

// Strip sslmode from URL (pg treats 'require' as 'verify-full' which fails
// with managed DB certs). We set SSL config programmatically instead.
let dbUrl = process.env.DATABASE_URL || '';
dbUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, '');

const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database error');
});

module.exports = { pool };
