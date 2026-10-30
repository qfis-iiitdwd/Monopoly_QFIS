#!/usr/bin/env node
// Imports the company story sheet ("Monopoly Company Profiles.xlsx") into config/game.json:
// name, sector, ticker, description, CEO, other executive, starting price, shares outstanding.
//
//   node scripts/import-profiles.js "Monopoly Company Profiles.xlsx"            # show what would change
//   node scripts/import-profiles.js "Monopoly Company Profiles.xlsx" --write    # update config/game.json
//   (--config path/to/other.json to update a different file)
//
// Rows are matched to existing companies by ticker, then by company name, so a corrected ticker
// (e.g. ADIB -> ABIB) is renamed everywhere, including the price script. Columns are found by
// their header text, so their order in the sheet does not matter. "Inspired By" is not imported:
// players never see the real-world names.
const fs = require('fs');
const path = require('path');
const { readWorkbook } = require('./lib/xlsx');

const file = process.argv[2];
const write = process.argv.includes('--write');
const ci = process.argv.indexOf('--config');
const cfgPath = ci > 0 ? path.resolve(process.argv[ci + 1]) : path.join(__dirname, '..', 'config', 'game.json');
if (!file) { console.error('usage: node scripts/import-profiles.js FILE.xlsx [--write]'); process.exit(1); }

const sheet = readWorkbook(file)[0];
const [header, ...body] = sheet.rows;
const col = (re) => {
  const i = header.findIndex((h) => h && re.test(String(h)));
  if (i < 0) throw new Error(`no column matching ${re} in ${JSON.stringify(header)}`);
  return i;
};
const C = {
  sector: col(/^sector$/i), name: col(/company name/i), ticker: col(/^ticker$/i), description: col(/description/i),
  ceo: col(/ceo|chair/i), other: col(/other executive/i), price: col(/starting share price/i), shares: col(/shares outstanding/i),
};
const num = (v) => Number(String(v).replace(/[₹,\s]/g, ''));
// "Larry Ellisonn (Chairman)" -> { name: 'Larry Ellisonn', role: 'Chairman' }
const person = (v) => {
  const m = String(v || '').trim().match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return m ? { name: m[1].trim(), role: m[2].trim() } : { name: String(v || '').trim(), role: '' };
};

const rows = body.filter((r) => r && r[C.ticker]).map((r) => {
  const people = [person(r[C.ceo]), person(r[C.other])].filter((p) => p.name);
  const ceo = people.find((p) => /^ceo$/i.test(p.role)) || people[0];
  const details = {};
  for (const p of people) if (p !== ceo) details[p.role || 'Executive'] = p.name;
  const sharesCrore = num(r[C.shares]);
  const price = num(r[C.price]);
  if (!(price > 0)) throw new Error(`${r[C.ticker]}: bad price ${r[C.price]}`);
  if (!(sharesCrore > 0)) throw new Error(`${r[C.ticker]}: bad shares outstanding ${r[C.shares]}`);
  return {
    ticker: String(r[C.ticker]).trim().toUpperCase(),
    name: String(r[C.name]).trim(),
    industry: String(r[C.sector]).trim(),
    description: String(r[C.description] || '').trim(),
    ceo: ceo ? ceo.name : '',
    details,
    price,
    shares_outstanding: Math.round(sharesCrore * 1e7),
  };
});

const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const changes = [];
const renames = {};
const used = new Set();
for (const row of rows) {
  let c = cfg.companies.find((x) => x.ticker === row.ticker) || cfg.companies.find((x) => x.name.toLowerCase() === row.name.toLowerCase());
  if (!c) {
    c = { ticker: row.ticker };
    cfg.companies.push(c);
    changes.push(`+ new company ${row.ticker} ${row.name} (it has no price script yet)`);
  }
  used.add(c);
  if (c.ticker !== row.ticker) { renames[c.ticker] = row.ticker; changes.push(`~ ticker ${c.ticker} -> ${row.ticker} (${row.name})`); }
  for (const k of ['name', 'industry', 'description', 'ceo', 'price', 'shares_outstanding']) {
    if (JSON.stringify(c[k]) !== JSON.stringify(row[k])) changes.push(`~ ${row.ticker} ${k}: ${JSON.stringify(c[k])} -> ${JSON.stringify(row[k])}`);
  }
  if (JSON.stringify(c.details || {}) !== JSON.stringify(row.details)) changes.push(`~ ${row.ticker} details: ${JSON.stringify(row.details)}`);
  // Keep the key order readable in the JSON.
  const rest = { ...c };
  for (const k of ['ticker', 'name', 'ceo', 'industry', 'price', 'shares_outstanding', 'description', 'details']) delete rest[k];
  Object.keys(c).forEach((k) => delete c[k]);
  Object.assign(c, { ticker: row.ticker, name: row.name, ceo: row.ceo, industry: row.industry, price: row.price,
    shares_outstanding: row.shares_outstanding, description: row.description, details: row.details }, rest);
}
const orphans = cfg.companies.filter((c) => !used.has(c));
for (const o of orphans) changes.push(`! ${o.ticker} ${o.name} is in the config but not in the sheet (left unchanged)`);

if (cfg.price_script && cfg.price_script.moves) {
  for (const [from, to] of Object.entries(renames)) {
    if (cfg.price_script.moves[from]) { cfg.price_script.moves[to] = cfg.price_script.moves[from]; delete cfg.price_script.moves[from]; }
  }
  const missing = cfg.companies.filter((c) => !cfg.price_script.moves[c.ticker]).map((c) => c.ticker);
  if (missing.length) changes.push(`! no price script for ${missing.join(', ')}`);
}
for (const e of cfg.events || []) {
  for (const [from, to] of Object.entries(renames)) if (e.companies && e.companies[from] != null) { e.companies[to] = e.companies[from]; delete e.companies[from]; }
}
const sectors = new Set(rows.map((r) => r.industry));
for (const e of cfg.events || []) for (const ind of Object.keys(e.industries || {})) if (!sectors.has(ind)) changes.push(`! event ${e.id} refers to sector "${ind}", which no company has now`);
const dupes = rows.filter((r, i) => r.description && rows.findIndex((x) => x.description === r.description) !== i);
for (const d of dupes) changes.push(`! ${d.ticker} has the same description as another company`);

console.log(`${rows.length} companies in ${path.basename(file)}`);
console.log(changes.length ? changes.join('\n') : 'no changes');
if (write) {
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`\nwrote ${cfgPath}. Re-seed the database for it to take effect.`);
} else {
  console.log('\n(dry run; add --write to update config/game.json)');
}
