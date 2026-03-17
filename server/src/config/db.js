const { Pool } = require('pg');
const logger = require('../lib/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database error');
});

module.exports = { pool };
