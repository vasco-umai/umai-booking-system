require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const seedFiles = ['default_schedule.sql', 'default_meeting_types.sql'];
    for (const file of seedFiles) {
      const sqlFile = path.join(__dirname, file);
      const sql = fs.readFileSync(sqlFile, 'utf8');
      await pool.query(sql);
      console.log(`Seed applied: ${file}`);
    }
    console.log('Seed data inserted successfully');
  } catch (err) {
    console.error('Seeding failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();
