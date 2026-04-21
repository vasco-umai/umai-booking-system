#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();
const { pool } = require('../src/config/db');
const { generateKey, hashKey, KEY_PREFIX } = require('../src/middleware/apiKey');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--team-slug') args.teamSlug = argv[++i];
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Usage: node scripts/issue-api-key.js --team-slug <slug> --name "<consumer name>"

Example:
  node scripts/issue-api-key.js --team-slug customer-success --name "AI Voice Agent"

The full key is printed ONCE. Store it in 1Password — it cannot be retrieved later.`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.teamSlug || !args.name) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  try {
    const { rows: teamRows } = await pool.query('SELECT id, name FROM teams WHERE slug = $1', [args.teamSlug]);
    if (teamRows.length === 0) {
      console.error(`Team not found: slug="${args.teamSlug}"`);
      process.exit(2);
    }
    const team = teamRows[0];

    const rawKey = generateKey();
    const keyHash = hashKey(rawKey);
    const keyPrefix = rawKey.slice(0, KEY_PREFIX.length + 4); // e.g. "umai_live_abcd"

    const { rows } = await pool.query(
      `INSERT INTO api_keys (team_id, name, key_hash, key_prefix)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [team.id, args.name, keyHash, keyPrefix]
    );

    const created = rows[0];
    console.log('');
    console.log('API key issued');
    console.log('─'.repeat(60));
    console.log(`id:         ${created.id}`);
    console.log(`team:       ${team.name} (${args.teamSlug})`);
    console.log(`name:       ${args.name}`);
    console.log(`prefix:     ${keyPrefix}`);
    console.log(`created_at: ${created.created_at.toISOString()}`);
    console.log('─'.repeat(60));
    console.log('FULL KEY (copy now, stored only as a hash):');
    console.log('');
    console.log(`  ${rawKey}`);
    console.log('');
    console.log('Pass as header: Authorization: Bearer <key>');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Failed to issue key:', err.message);
  process.exit(1);
});
