// Backend features added for the React frontend: disabling teams, hidden rankings, company story
// details (CEO + extra facts), the all-teams ledger, net-worth history and the overview figures.
//   TEST_DATABASE_URL='<test Supabase project URI>' npm test
require('./db-url');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../src/db');
const { seed } = require('../src/seed');
const views = require('../src/views');
const { createApp } = require('../src/server');

const { baseConfig, REAL_CONFIG } = require('./config');
const key = () => crypto.randomBytes(9).toString('base64url');

async function fresh(mutate) {
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  if (mutate) mutate(cfg);
  await db.migrate();
  await seed(cfg, { reset: true, force: true, adminPassword: 'test-admin', fixedPasswords: true });
  views.invalidate();
}

// One HTTP server for the file; each client keeps its own cookie.
let server;
let base;
test.before(async () => {
  await db.migrate();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  await db.end();
});

function client() {
  let cookie = '';
  return async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.getSetCookie ? r.getSetCookie() : r.headers.getSetCookie();
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : null };
  };
}
async function admin() {
  const a = client();
  assert.equal((await a('POST', '/api/admin/login', { username: 'admin', password: 'test-admin' })).status, 200);
  return a;
}
async function team(n, member = 'Tester') {
  const t = client();
  const id = `team${String(n).padStart(2, '0')}`;
  const r = await t('POST', '/api/auth/login', { team_id: id, password: `pw-${id}`, member_name: member });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return t;
}

test('disabling a team logs it out, blocks login and trading, drops it from rankings; enabling restores it', async () => {
  await fresh();
  const a = await admin();
  await a('POST', '/api/admin/event/start');
  await a('POST', '/api/admin/rounds/1/open');
  const t2 = await team(2);
  const { rows: [pear] } = await db.query(`SELECT id FROM companies WHERE ticker = 'PEAR'`);
  assert.equal((await t2('POST', '/api/orders', { company_id: pear.id, side: 'buy', quantity: 10, idempotency_key: key() })).status, 200);

  assert.equal((await a('POST', '/api/admin/teams/2/active', { active: false })).status, 400, 'reason required');
  const off = await a('POST', '/api/admin/teams/2/active', { active: false, reason: 'caught sharing passwords' });
  assert.equal(off.status, 200);
  assert.equal((await t2('GET', '/api/portfolio')).status, 401, 'existing session ends at once');
  assert.equal((await team2Login()).status, 401, 'cannot log in');
  // Even a direct call into the order function refuses (defence in depth).
  const { rows: [r] } = await db.query(`SELECT ord FROM mv_place_order_json(2, $1, $2, 'buy', 1, NULL)`, [key(), pear.id]);
  assert.equal(r.ord.status, 'rejected');
  assert.match(r.ord.rejection_reason, /disabled/);

  const teams = (await a('GET', '/api/admin/teams')).body;
  const t = teams.find((x) => x.team_id === 2);
  assert.equal(t.is_active, false);
  assert.equal(t.rank, null);
  assert.equal(teams.length, 50, 'disabled teams stay listed for the admin');
  assert.ok(teams.filter((x) => x.is_active).every((x) => x.rank >= 1));
  assert.equal((await a('GET', '/api/admin/overview')).body.counts.teams_disabled, 1);
  const audit = (await a('GET', '/api/admin/audit-log')).body;
  assert.ok(audit.find((x) => x.action === 'disable_team' && x.reason === 'caught sharing passwords'));

  assert.equal((await a('POST', '/api/admin/teams/2/active', { active: true, reason: 'cleared after review' })).status, 200);
  const back = await team2Login();
  assert.equal(back.status, 200);
  assert.equal((await db.query('SELECT quantity FROM holdings WHERE team_id = 2 AND company_id = $1', [pear.id])).rows[0].quantity, 10, 'holdings kept');

  function team2Login() {
    return client()('POST', '/api/auth/login', { team_id: 'team02', password: 'pw-team02' });
  }
});

test('rankings are hidden from teams when players_see_leaderboard is false, visible when true', async () => {
  await fresh((c) => { c.settings.players_see_leaderboard = false; });
  let t = await team(1);
  assert.equal((await t('GET', '/api/market/status')).body.leaderboard_visible, false);
  assert.equal((await t('GET', '/api/leaderboard')).status, 404);
  const pf = (await t('GET', '/api/portfolio')).body;
  assert.equal(pf.rank, undefined, 'no rank in the portfolio either');
  const a = await admin();
  assert.equal((await a('GET', '/api/admin/teams')).body[0].rank, 1, 'admin still sees ranks');

  await fresh((c) => { c.settings.players_see_leaderboard = true; });
  t = await team(1);
  assert.equal((await t('GET', '/api/leaderboard')).status, 200);
  assert.throws(() => require('../src/settings').validateSettings({ ...require('../src/settings').DEFAULT_SETTINGS, players_see_leaderboard: 'no' }), /true or false/);
});

test('company CEO and details: seeded from config, shown to teams, editable (logged) during the event, validated', async () => {
  await fresh((c) => {
    c.companies[0].ceo = 'Tim Pearson';
    c.companies[0].details = { Founded: '1976', HQ: 'Cupertino' };
  });
  const t = await team(1);
  const pear = (await t('GET', '/api/companies')).body.find((x) => x.ticker === baseConfig.companies[0].ticker);
  assert.equal(pear.ceo, 'Tim Pearson');
  assert.deepEqual(pear.details, { Founded: '1976', HQ: 'Cupertino' });

  const a = await admin();
  await a('POST', '/api/admin/event/start');
  assert.equal((await a('PATCH', `/api/admin/companies/${pear.id}`, { ceo: 'New CEO' })).status, 400, 'reason required once started');
  assert.equal((await a('PATCH', `/api/admin/companies/${pear.id}`, { name: 'Renamed', reason: 'typo in name' })).status, 400, 'name frozen after start');
  assert.equal((await a('PATCH', `/api/admin/companies/${pear.id}`, { details: ['not', 'an', 'object'], reason: 'bad details' })).status, 400);
  assert.equal((await a('PATCH', `/api/admin/companies/${pear.id}`, { details: { Founded: 1976 }, reason: 'numbers are not text' })).status, 400);
  const ok = await a('PATCH', `/api/admin/companies/${pear.id}`, { ceo: 'Tina Pearson', details: { Founded: '1977' }, reason: 'CEO name received late' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  views.invalidate();
  const after = (await t('GET', '/api/companies')).body.find((x) => x.id === pear.id);
  assert.equal(after.ceo, 'Tina Pearson');
  assert.deepEqual(after.details, { Founded: '1977' });

  await assert.rejects(fresh((c) => { c.companies[0].details = { Founded: 1976 }; }), /details must be an object of short text values/);
});

test('ledger, net-worth history and overview figures come from the books', async () => {
  await fresh();
  const a = await admin();
  await a('POST', '/api/admin/event/start');
  await a('POST', '/api/admin/rounds/1/open');
  const t1 = await team(1, 'Asha');
  const { rows: cos } = await db.query('SELECT id, ticker FROM companies ORDER BY id LIMIT 2');
  const b = await t1('POST', '/api/orders', { company_id: cos[0].id, side: 'buy', quantity: 20, idempotency_key: key() });
  assert.equal(b.status, 200);
  await t1('POST', '/api/orders', { company_id: cos[1].id, side: 'sell', quantity: 5, idempotency_key: key() }); // rejected: no shares
  await a('POST', '/api/admin/teams/1/adjust-cash', { amount: 12345, reason: 'test adjustment' });
  await a('POST', `/api/admin/orders/${b.body.order.id}/reverse`, { reason: 'test reversal' });

  const all = (await a('GET', '/api/admin/ledger?team=1')).body;
  assert.deepEqual(all.rows.map((r) => r.transaction_type), ['trade_reversal', 'adjustment', 'trade_buy', 'initial_deposit']);
  const buyRow = all.rows.find((r) => r.transaction_type === 'trade_buy');
  assert.equal(buyRow.ticker, cos[0].ticker);
  assert.equal(buyRow.quantity, 20);
  assert.equal(buyRow.order_id, b.body.order.id);
  assert.equal(buyRow.round_id, 1);
  assert.equal(buyRow.fee, b.body.order.fee);
  const rev = all.rows.find((r) => r.transaction_type === 'trade_reversal');
  assert.equal(rev.ticker, cos[0].ticker, 'reversal entries carry the trade details too');
  assert.equal(rev.round_id, 1);
  const { rows: [{ cash }] } = await db.query('SELECT cash FROM teams WHERE id = 1');
  assert.equal(all.rows[0].balance_after, cash);
  assert.equal(all.rows.reduce((s, r) => s + r.amount, 0), cash, 'entries sum to cash');

  assert.equal((await a('GET', '/api/admin/ledger?type=adjustment')).body.rows.length, 1);
  assert.equal((await a('GET', '/api/admin/ledger?round=1&team=1')).body.rows.length, 2, 'buy + reversal are in round 1');
  const page2 = (await a('GET', `/api/admin/ledger?team=1&limit=2&before=${all.rows[1].id}`)).body.rows;
  assert.deepEqual(page2.map((r) => r.id), all.rows.slice(2).map((r) => r.id));
  assert.equal((await a('GET', '/api/admin/ledger?type=bogus')).status, 400);
  const totals = (await a('GET', '/api/admin/ledger')).body.totals;
  assert.equal(totals.find((x) => x.transaction_type === 'initial_deposit').n, 50);

  const ov = (await a('GET', '/api/admin/overview')).body;
  const r1 = ov.rounds[0];
  assert.equal(r1.executed, 1);
  assert.equal(r1.rejected, 1);
  assert.equal(r1.traded_value, b.body.order.gross, 'traded value = gross of executed team orders');
  assert.equal(r1.bought_shares, 20);
  assert.equal(ov.counts.companies, baseConfig.companies.length);

  await a('POST', '/api/admin/rounds/1/close');
  await a('POST', '/api/admin/rounds/1/apply-market-update');
  const hist = (await a('GET', '/api/admin/teams/1/history')).body;
  assert.deepEqual(hist.rounds.map((r) => r.round_id), [0, 1]);
  assert.equal(hist.rounds[0].net_worth, baseConfig.settings.starting_cash_rupees * 100);
  const { rows: [snap] } = await db.query('SELECT net_worth FROM leaderboard_snapshots WHERE team_id = 1 AND round_id = 1');
  assert.equal(hist.rounds[1].net_worth, snap.net_worth);
  assert.equal((await a('GET', '/api/admin/teams/999/history')).status, 404);

  const teams = (await a('GET', '/api/admin/teams')).body;
  const me = teams.find((x) => x.team_id === 1);
  assert.deepEqual(me.members, ['Asha']);
  assert.equal(me.executed_orders, 1);
  assert.equal(me.total_pnl, me.net_worth - baseConfig.settings.starting_cash_rupees * 100);

  // Teams cannot reach any of it.
  const t = await team(3);
  for (const p of ['/api/admin/ledger', '/api/admin/teams/1/history', '/api/admin/teams']) assert.equal((await t('GET', p)).status, 401, p);
});

test('the server serves the built React apps (or the legacy screens when asked)', async () => {
  const built = fs.existsSync(path.join(__dirname, '..', 'public', 'app', 'index.html'));
  const html = await (await fetch(base + '/')).text();
  const adminHtml = await (await fetch(base + '/admin/')).text();
  if (built) {
    assert.match(html, /<div id="root">/);
    assert.match(adminHtml, /Monopoly - Admin/);
    assert.doesNotMatch(html, /admin/i, 'the player page does not link the admin app');
  }
  assert.equal((await fetch(base + '/display/')).status, 404);
});

test('import-profiles: the story sheet maps onto the config (tickers renamed everywhere, people split by role)', { skip: !(REAL_CONFIG && fs.existsSync(path.join(__dirname, '..', 'Monopoly Company Profiles.xlsx'))) && 'needs the sheet and config/game.json' }, () => {
  const { execFileSync } = require('child_process');
  const os = require('os');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mv-prof-')), 'game.json');
  // Start from the config as it was before the sheet: old placeholder ticker and no story fields.
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  const abib = cfg.companies.find((c) => c.ticker === 'ABIB');
  abib.ticker = 'ADIB';
  cfg.price_script.moves.ADIB = cfg.price_script.moves.ABIB;
  delete cfg.price_script.moves.ABIB;
  for (const c of cfg.companies) { delete c.ceo; delete c.details; delete c.shares_outstanding; }
  fs.writeFileSync(tmp, JSON.stringify(cfg));
  const sheet = path.join(__dirname, '..', 'Monopoly Company Profiles.xlsx');
  const dry = execFileSync('node', [path.join(__dirname, '..', 'scripts', 'import-profiles.js'), sheet, '--config', tmp], { encoding: 'utf8' });
  assert.match(dry, /ticker ADIB -> ABIB/);
  assert.equal(JSON.parse(fs.readFileSync(tmp, 'utf8')).companies.find((c) => c.name === 'Abibas Group').ticker, 'ADIB', 'dry run writes nothing');
  execFileSync('node', [path.join(__dirname, '..', 'scripts', 'import-profiles.js'), sheet, '--config', tmp, '--write']);
  const out = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  assert.deepEqual(out, baseConfig, 'importing the sheet reproduces config/game.json exactly');
  const orax = out.companies.find((c) => c.ticker === 'ORAX');
  assert.equal(orax.ceo, 'Clay Maguyork', 'the CEO is whoever is marked (CEO), not the first column');
  assert.deepEqual(orax.details, { Chairman: 'Larry Ellisonn' });
  assert.ok(!JSON.stringify(out).includes('Apple'), '"Inspired By" never reaches the game');
});

test('team id 0 or an unknown id never returns another team\'s data', async () => {
  await fresh();
  const a = await admin();
  for (const p of ['/api/admin/teams/0', '/api/admin/teams/0/history', '/api/admin/teams/999', '/api/admin/teams/-1/history']) {
    assert.equal((await a('GET', p)).status, 404, p);
  }
  const { teamValuations } = require('../src/valuation');
  assert.deepEqual(await teamValuations(db, { teamId: 0 }), []);
});
