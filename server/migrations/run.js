require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Find all .sql migration files and sort alphabetically
    const files = fs.readdirSync(__dirname)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const sqlFile = path.join(__dirname, file);
      const sql = fs.readFileSync(sqlFile, 'utf8');
      await pool.query(sql);
      console.log(`Migration applied: ${file}`);
    }

    console.log('All migrations completed successfully');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
