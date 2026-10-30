#!/usr/bin/env node
// Imports the pre-decided per-round price moves from a spreadsheet into the game config.
//
//   node scripts/import-moves.js FILE.xlsx|FILE.csv [--sheet NAME|N] [--units auto|fraction|percent|bps]
//                                [--config config/game.json] [--write] [--replace-companies]
//
// The sheet needs a header row with a "Ticker" column and "Round 1" … "Round N" columns; each row
// below it is one company. Values are the % move at that round's market update, as Excel stores a
// %-formatted cell (0.0242 = 2.42%). Other columns (Company, Total, …) are ignored.
//
// Without --write it only prints what it read, so you can check it. With --write it stores the moves
// in the config's "price_script" block; companies in the sheet but not in the config are added with
// no price (seeding will refuse until you fill one in). --replace-companies also removes companies
// that are not in the sheet.
const fs = require('fs');
const path = require('path');
const { readWorkbook } = require('./lib/xlsx');

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes(name);
const VALUE_FLAGS = ['--sheet', '--units', '--config'];
const file = args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1]));
if (!file) {
  console.error('Usage: node scripts/import-moves.js FILE.xlsx|FILE.csv [--sheet NAME|N] [--units auto|fraction|percent|bps] [--config PATH] [--write] [--replace-companies]');
  process.exit(2);
}
const die = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => { const t = c.trim(); return t === '' ? null : t; }));
}

// --- Read the sheet --------------------------------------------------------------------------
let sheetName;
let rows;
if (/\.csv$/i.test(file)) {
  sheetName = path.basename(file);
  rows = parseCsv(fs.readFileSync(file, 'utf8'));
} else {
  const sheets = readWorkbook(file);
  const want = arg('--sheet');
  let sheet;
  if (want == null) {
    if (sheets.length > 1) die(`The workbook has ${sheets.length} sheets: ${sheets.map((s, i) => `${i + 1}. "${s.name}"`).join(', ')}. Choose one with --sheet.`);
    sheet = sheets[0];
  } else {
    sheet = sheets.find((s) => s.name.toLowerCase() === want.toLowerCase()) || (/^\d+$/.test(want) ? sheets[Number(want) - 1] : null);
    if (!sheet) die(`No sheet "${want}". Sheets: ${sheets.map((s, i) => `${i + 1}. "${s.name}"`).join(', ')}`);
  }
  sheetName = sheet.name;
  rows = sheet.rows;
}

const headerAt = rows.findIndex((r) => r && r.some((c) => typeof c === 'string' && c.trim().toLowerCase() === 'ticker'));
if (headerAt < 0) die('No header row with a "Ticker" column found.');
const header = rows[headerAt].map((c) => (typeof c === 'string' ? c.trim() : c));
const tickerCol = header.findIndex((c) => typeof c === 'string' && c.toLowerCase() === 'ticker');
const nameCol = header.findIndex((c) => typeof c === 'string' && /^(company|name|company name)$/i.test(c));
const totalCol = header.findIndex((c) => typeof c === 'string' && /^total/i.test(c));
const roundCols = [];
header.forEach((c, i) => { const m = typeof c === 'string' && c.match(/^round\s*(\d+)$/i); if (m) roundCols[Number(m[1]) - 1] = i; });
if (!roundCols.length) die('No "Round 1", "Round 2", … columns found in the header row.');
for (let r = 0; r < roundCols.length; r++) if (roundCols[r] == null) die(`Column "Round ${r + 1}" is missing.`);

const toNumber = (v) => {
  if (typeof v === 'number') return { n: v, pct: false };
  if (typeof v === 'string') {
    const t = v.replace(/[,\s]/g, '');
    const m = t.match(/^([+-]?\d*\.?\d+)(%?)$/);
    if (m) return { n: Number(m[1]), pct: m[2] === '%' };
  }
  return null;
};

const companies = [];
const problems = [];
for (let r = headerAt + 1; r < rows.length; r++) {
  const row = rows[r] || [];
  const raw = row[tickerCol];
  if (raw == null || String(raw).trim() === '') continue;
  const ticker = String(raw).trim().toUpperCase();
  if (!/^[A-Z]{2,6}$/.test(ticker)) { problems.push(`row ${r + 1}: ticker "${raw}" must be 2–6 letters`); continue; }
  const values = roundCols.map((col, i) => {
    const v = toNumber(row[col]);
    if (!v) problems.push(`${ticker} Round ${i + 1}: "${row[col] == null ? '(empty)' : row[col]}" is not a number`);
    return v;
  });
  companies.push({ ticker, name: nameCol >= 0 && row[nameCol] ? String(row[nameCol]).trim() : ticker, values, sheetTotal: totalCol >= 0 ? toNumber(row[totalCol]) : null, row: r + 1 });
}
const seen = new Set();
for (const c of companies) { if (seen.has(c.ticker)) problems.push(`${c.ticker} appears twice`); seen.add(c.ticker); }
if (problems.length) die(`The sheet has problems:\n  ${problems.join('\n  ')}`);
if (!companies.length) die('No company rows found under the header.');

// --- Units -----------------------------------------------------------------------------------
const all = companies.flatMap((c) => c.values);
let units = arg('--units', 'auto');
if (units === 'auto') {
  if (all.some((v) => v.pct)) units = 'percent';
  else units = all.every((v) => Math.abs(v.n) < 1) ? 'fraction' : 'percent';
}
const toBps = ({ n, pct }) => (pct || units === 'percent' ? n * 100 : units === 'fraction' ? n * 10000 : n);
const warnings = [];
for (const c of companies) {
  c.moves = c.values.map((v, i) => {
    const exact = toBps(v);
    const bps = Math.round(exact);
    if (Math.abs(exact - bps) > 1e-6) warnings.push(`${c.ticker} Round ${i + 1}: ${exact / 100}% rounded to ${bps / 100}% (the game works in 0.01% steps)`);
    return bps;
  });
  c.compounded = c.moves.reduce((f, b) => f * (1 + b / 10000), 1) - 1;
  c.simpleSum = c.moves.reduce((a, b) => a + b, 0) / 10000;
}

// --- Report ----------------------------------------------------------------------------------
const pct = (x, w = 7) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`.padStart(w);
console.log(`Read "${sheetName}": ${companies.length} companies × ${roundCols.length} rounds, values read as ${units === 'fraction' ? 'fractions (0.0242 = 2.42%)' : units === 'percent' ? 'percent (2.42 = 2.42%)' : 'basis points'}.\n`);
console.log('Ticker  ' + roundCols.map((_, i) => `R${i + 1}`.padStart(8)).join('') + '   no-trading total');
for (const c of companies) console.log(c.ticker.padEnd(8) + c.moves.map((b) => pct(b / 10000, 8)).join('') + pct(c.compounded, 11));
const worst = companies.flatMap((c) => c.moves.map((b, i) => ({ t: c.ticker, r: i + 1, b }))).sort((a, b) => Math.abs(b.b) - Math.abs(a.b))[0];
console.log(`\nLargest single move: ${worst.t} round ${worst.r}, ${pct(worst.b / 10000, 0)}.`);
const withTotals = companies.filter((c) => c.sheetTotal);
if (withTotals.length) {
  const tot = (c) => toBps(c.sheetTotal) / 10000;
  const matchesSum = withTotals.every((c) => Math.abs(tot(c) - c.simpleSum) < 0.0002);
  const matchesCompound = withTotals.every((c) => Math.abs(tot(c) - c.compounded) < 0.001);
  if (matchesCompound) console.log('The sheet\'s Total column matches the compounded change (within rounding), which is what the game computes.');
  else if (matchesSum) {
    console.log('Note: the sheet\'s Total column ADDS the round %s. Moves compound in the game (each % applies to the price after the');
    console.log('previous round), so the real no-trading change is the "no-trading total" above, not the sheet\'s Total.');
  } else console.log('Note: the sheet\'s Total column matches neither the simple sum nor the compounded change; the game uses the compounded change shown above.');
}
for (const w of warnings) console.log(`warning: ${w}`);

if (!flag('--write')) {
  console.log('\nNothing written. Re-run with --write to store these moves in the config.');
  process.exit(0);
}

// --- Write -----------------------------------------------------------------------------------
const cfgPath = path.resolve(arg('--config', path.join(__dirname, '..', 'config', 'game.json')));
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const total = (cfg.settings && cfg.settings.total_rounds) || 10;
if (roundCols.length !== total) die(`The sheet has ${roundCols.length} rounds but the config has total_rounds = ${total}.`);
const byTicker = new Map(cfg.companies.map((c) => [c.ticker, c]));
const added = [];
for (const c of companies) {
  if (!byTicker.has(c.ticker)) {
    const entry = { ticker: c.ticker, name: c.name, industry: 'Unassigned', price: null, description: '' };
    cfg.companies.push(entry);
    byTicker.set(c.ticker, entry);
    added.push(c.ticker);
  }
}
const inSheet = new Set(companies.map((c) => c.ticker));
const notInSheet = cfg.companies.filter((c) => !inSheet.has(c.ticker)).map((c) => c.ticker);
if (flag('--replace-companies')) cfg.companies = cfg.companies.filter((c) => inSheet.has(c.ticker));
cfg.price_script = {
  _readme: 'Fixed % move per company per round, in basis points (100 = 1%). Applied at each round\'s market update; trading pressure is added on top. Imported by scripts/import-moves.js.',
  source: `${path.basename(file)} / ${sheetName}`,
  imported_at: new Date().toISOString(),
  moves: Object.fromEntries(companies.map((c) => [c.ticker, c.moves])),
};
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(`\n✓ Wrote price_script (${companies.length} companies) to ${cfgPath}`);
if (added.length) console.log(`  Added ${added.length} new companies with no price or industry yet: ${added.join(', ')}. Fill in "price" (₹) and "industry" before seeding.`);
if (notInSheet.length) {
  console.log(flag('--replace-companies')
    ? `  Removed ${notInSheet.length} companies not in the sheet: ${notInSheet.join(', ')}.`
    : `  ${notInSheet.length} companies in the config are not in the sheet and will move only with trading: ${notInSheet.join(', ')}. (--replace-companies removes them.)`);
}
