#!/usr/bin/env node
// Usage: node scripts/seed.js [--config config/game.json] [--reset] [--force] [--out credentials.csv|-] [--test-passwords]
// --out - prints the credentials CSV to stdout (messages go to stderr), for running inside a container:
//   docker compose exec -T app node scripts/seed.js --reset --out - > credentials.csv
// Admin password comes from ADMIN_PASSWORD (generated and printed if unset).
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { seed } = require('../src/seed');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(name);

(async () => {
  const cfgPath = path.resolve(arg('--config', path.join(__dirname, '..', 'config', 'game.json')));
  const outArg = arg('--out', path.join(__dirname, '..', 'credentials.csv'));
  const toStdout = outArg === '-';
  const out = toStdout ? '-' : path.resolve(outArg);
  const log = toStdout ? console.error : console.log;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  await db.migrate();
  const { credentials, adminPassword } = await seed(cfg, {
    reset: flag('--reset'),
    force: flag('--force'),
    adminPassword: process.env.ADMIN_PASSWORD,
    adminUsername: process.env.ADMIN_USERNAME,
    fixedPasswords: flag('--test-passwords'),
  });
  const csv = ['team_name,team_id,password', ...credentials.map((c) => `"${c.name}",${c.team_id},${c.password}`)].join('\n') + '\n';
  if (toStdout) process.stdout.write(csv); else fs.writeFileSync(out, csv, { mode: 0o600 });
  log(`Seeded ${credentials.length} teams, ${cfg.companies.length} companies, ${cfg.rounds.length} rounds, ${(cfg.events || []).length} events.`);
  log(`Team credentials written to ${toStdout ? 'stdout' : out} (keep this file private).`);
  log(`Admin login: ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : adminPassword}`);
  await db.end();
})().catch(async (err) => {
  console.error('Seed failed:', err.message);
  await db.end();
  process.exit(1);
});
