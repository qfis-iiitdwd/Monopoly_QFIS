// Integration tests. Run against a disposable Supabase project (never the game's):
//   TEST_DATABASE_URL='<test Supabase project URI>' npm test
require('./db-url');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../src/db');
const { seed } = require('../src/seed');
const trading = require('../src/trading');
const market = require('../src/market');
const loans = require('../src/loans');
const adminOps = require('../src/admin');
const views = require('../src/views');
const pricing = require('../src/pricing');
const { createApp } = require('../src/server');

const baseConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'game.sample.json'), 'utf8'));
const key = () => crypto.randomBytes(9).toString('base64url');
let ids; // ticker -> company id

function config(mutate) {
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  if (mutate) mutate(cfg);
  return cfg;
}

async function fresh(mutate) {
  await db.migrate();
  await seed(config(mutate), { reset: true, force: true, adminPassword: 'test-admin', fixedPasswords: true });
  const { rows } = await db.query('SELECT id, ticker FROM companies');
  ids = Object.fromEntries(rows.map((r) => [r.ticker, r.id]));
  views.invalidate();
}

const buy = (team, ticker, qty, k = key()) => trading.placeOrder(team, { companyId: ids[ticker], side: 'buy', quantity: qty, idempotencyKey: k });
const sell = (team, ticker, qty, k = key()) => trading.placeOrder(team, { companyId: ids[ticker], side: 'sell', quantity: qty, idempotencyKey: k });
const cash = async (team) => (await db.query('SELECT cash FROM teams WHERE id = $1', [team])).rows[0].cash;
const price = async (ticker, round) => (await db.query('SELECT price FROM stock_prices WHERE company_id = $1 AND round_id = $2', [ids[ticker], round])).rows[0].price;

async function settle(round) {
  await market.closeRound(round, null);
  return market.applyMarketUpdate(round, null);
}

async function assertHealthy() {
  const problems = await adminOps.integrityCheck();
  assert.deepEqual(problems, [], JSON.stringify(problems));
}

test.after(() => db.end());

// ---------------------------------------------------------------------------------------------
test('pricing engine is deterministic, bounded and applies mitigations', () => {
  const settings = { pressure_scale_bps: 300, pressure_cap_bps: 800, noise_bps: 0, noise_seed: 's',
    max_move_up_bps: 6000, max_move_down_bps: 6000, min_price: 100, max_price: 10000000 };
  const co = [{ id: 1, ticker: 'QBIT', industry: 'Technology', pressure_ref_qty: 1000 },
    { id: 2, ticker: 'BYTE', industry: 'Technology', pressure_ref_qty: 1000 }];
  const events = [{ configuration: { industries: { Technology: -1200 }, companies: { QBIT: -400 } } }];
  const input = { roundId: 4, companies: co, prevPrices: new Map([[1, 85000], [2, 120000]]), netDemand: new Map([[1, 500], [2, -5000]]), events, settings };
  const out = pricing.computeRound(input);
  assert.equal(out[0].fundamental_bps, -400, 'company entry replaces industry entry');
  assert.equal(out[1].fundamental_bps, -1200);
  assert.equal(out[0].trading_bps, 150, '500/1000 × 300');
  assert.equal(out[1].trading_bps, -800, 'capped');
  assert.equal(out[0].price, 85000 * (10000 - 250) / 10000); // 82875
  assert.equal(out[1].price, 120000 * (10000 - 2000) / 10000);
  assert.deepEqual(pricing.computeRound(input), out, 'same inputs, same outputs');

  // Noise is reproducible and bounded.
  for (let r = 1; r <= 50; r++) {
    const n = pricing.noiseBps('seed', r, 'ABC', 50);
    assert.ok(n >= -50 && n <= 50);
    assert.equal(n, pricing.noiseBps('seed', r, 'ABC', 50));
  }
  // Huge crash is clamped and price never drops below the minimum.
  const crash = pricing.computeRound({ ...input, events: [{ configuration: { industries: { Technology: -50000 } } }] });
  assert.equal(crash[1].total_bps, -6000);
  assert.equal(pricing.nextPrice(150, -9999, settings), 100);
  assert.equal(pricing.nextPrice(5, 1, settings), 100);
  // Half-away-from-zero rounding to the paisa.
  assert.equal(pricing.nextPrice(101, 50, { ...settings, min_price: 1 }), 102); // 101.505 → 102 (101*10050/10000 = 101.505)
});

// ---------------------------------------------------------------------------------------------
test('buy/sell accounting, fees, validation and idempotency', async () => {
  await fresh();
  await market.startEvent(null);

  let r = await buy(1, 'CHAI', 10);
  assert.equal(r.order.status, 'rejected');
  assert.match(r.order.rejection_reason, /closed/);

  await market.openRound(1, null);
  const start = await cash(1);
  r = await buy(1, 'CHAI', 1000);
  assert.equal(r.order.status, 'executed');
  // ₹260 × 1000 = ₹2,60,000; fee 0.1% = ₹260 → 26,026,000 paise
  assert.equal(r.order.cash_delta, -26026000);
  assert.equal(await cash(1), start - 26026000);

  // Same idempotency key twice → one trade.
  const k = key();
  const [a, b] = await Promise.all([buy(1, 'BYTE', 5, k), buy(1, 'BYTE', 5, k)]);
  assert.equal(a.order.id, b.order.id);
  assert.ok(a.duplicate || b.duplicate);
  // Ten concurrent submissions with one key → still one trade.
  const k2 = key();
  const many = await Promise.all(Array.from({ length: 10 }, () => buy(1, 'MEME', 7, k2)));
  assert.equal(new Set(many.map((m) => m.order.id)).size, 1);
  const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int AS n FROM trades WHERE team_id = 1 AND company_id = $1`, [ids.MEME]);
  assert.equal(n, 1);

  r = await sell(1, 'CHAI', 1001);
  assert.equal(r.order.status, 'rejected');
  assert.match(r.order.rejection_reason, /at most 1000/);
  for (const bad of [0, -5, 1.5, NaN]) {
    r = await buy(1, 'CHAI', bad);
    assert.equal(r.order.status, 'rejected', `quantity ${bad}`);
  }
  r = await buy(1, 'HEAL', 1000000);
  assert.match(r.order.rejection_reason, /Maximum order size/);
  r = await trading.placeOrder(1, { companyId: ids.CHAI, side: 'short', quantity: 1, idempotencyKey: key() });
  assert.match(r.order.rejection_reason, /Side/);
  await assert.rejects(() => trading.placeOrder(1, { companyId: ids.CHAI, side: 'buy', quantity: 1, idempotencyKey: 'x' }), /idempotency/);

  // Insufficient cash: max order of HEAL is 2000 shares @ ₹1500 = ₹30 lakh; four of them exceed ₹1 crore.
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await buy(2, 'HEAL', 2000));
  assert.deepEqual(results.map((x) => x.order.status), ['executed', 'executed', 'executed', 'rejected']);
  assert.match(results[3].order.rejection_reason, /Insufficient cash/);

  // Sell realizes profit/loss against average cost (here: a loss equal to both fees).
  r = await sell(1, 'CHAI', 1000);
  assert.equal(r.order.status, 'executed');
  const { rows: [t] } = await db.query('SELECT realized_pnl FROM teams WHERE id = 1');
  assert.equal(t.realized_pnl, -26026000 + (26000000 - 26000));

  // Suspension and pause block trading.
  await adminOps.setTradable(1, ids.GENE, false, 'regulatory halt drill');
  assert.match((await buy(3, 'GENE', 1)).order.rejection_reason, /suspended/);
  await adminOps.setTradable(1, ids.GENE, true, 'halt lifted');
  await market.setPaused(true, null, {});
  assert.match((await buy(3, 'GENE', 1)).order.rejection_reason, /paused/);
  await market.setPaused(false, null, { extend: true });
  assert.equal((await buy(3, 'GENE', 1)).order.status, 'executed');

  await assertHealthy();
});

// ---------------------------------------------------------------------------------------------
test('competing buyers cannot oversell limited exchange inventory', async () => {
  await fresh((cfg) => {
    const g = cfg.companies.find((c) => c.ticker === 'GENE');
    g.float_shares = 1000;
    g.max_order_quantity = 100;
  });
  await market.startEvent(null);
  await market.openRound(1, null);
  const all = await Promise.all(Array.from({ length: 50 }, (_, i) => buy(i + 1, 'GENE', 100)));
  const executed = all.filter((r) => r.order.status === 'executed').length;
  assert.equal(executed, 10);
  assert.ok(all.filter((r) => r.order.status === 'rejected').every((r) => /shares left/.test(r.order.rejection_reason)));
  const { rows: [co] } = await db.query('SELECT exchange_inventory FROM companies WHERE id = $1', [ids.GENE]);
  assert.equal(co.exchange_inventory, 0);
  await assertHealthy();
});

// ---------------------------------------------------------------------------------------------
test('deadline is server-enforced and pause can extend it', async () => {
  await fresh();
  await market.startEvent(null);
  await market.openRound(1, null);
  await db.query(`UPDATE rounds SET trading_deadline = clock_timestamp() - interval '1 second' WHERE id = 1`);
  const r = await buy(1, 'CHAI', 1);
  assert.equal(r.order.status, 'rejected');
  assert.match(r.order.rejection_reason, /deadline/);
  assert.equal(await market.autoCloseExpired(), 1);
  assert.equal((await db.query('SELECT status FROM rounds WHERE id = 1')).rows[0].status, 'closed');
  assert.equal(await market.autoCloseExpired(), 0);

  await market.applyMarketUpdate(1, null);
  await market.openRound(2, null);
  const before = (await db.query('SELECT trading_deadline FROM rounds WHERE id = 2')).rows[0].trading_deadline;
  await market.setPaused(true, null, {});
  await db.query(`UPDATE game_state SET paused_at = paused_at - interval '30 seconds'`); // simulate a 30s pause
  await db.query(`UPDATE rounds SET trading_deadline = clock_timestamp() - interval '1 second' WHERE id = 2`);
  assert.equal(await market.autoCloseExpired(), 0, 'never auto-closes while paused');
  await db.query(`UPDATE rounds SET trading_deadline = $1 WHERE id = 2`, [before]);
  await market.setPaused(false, null, { extend: true });
  const after = (await db.query('SELECT trading_deadline FROM rounds WHERE id = 2')).rows[0].trading_deadline;
  assert.ok(after - before >= 30000, `deadline extended by pause duration (${after - before}ms)`);
});

// ---------------------------------------------------------------------------------------------
test('market update: preview matches apply, concurrent double-apply is harmless, transitions enforced', async () => {
  await fresh();
  await market.startEvent(null);
  await assert.rejects(() => market.openRound(2, null), /next round/);
  await market.openRound(1, null);
  await assert.rejects(() => market.applyMarketUpdate(1, null), /must be closed/);
  await assert.rejects(() => market.publishBulletin(1, null), /Close trading/);
  for (let t = 1; t <= 20; t++) await buy(t, 'CHAI', 2000);
  await market.closeRound(1, null);
  assert.equal((await buy(1, 'CHAI', 1)).order.status, 'rejected');
  await assert.rejects(() => market.openRound(2, null), /market update first/);

  const preview = await market.previewMarketUpdate(1);
  const [x, y, z] = await Promise.all([1, 2, 3].map(() => market.applyMarketUpdate(1, null)));
  assert.equal([x, y, z].filter((r) => !r.alreadyApplied).length, 1);
  const { rows } = await db.query('SELECT * FROM stock_prices WHERE round_id = 1 ORDER BY company_id');
  assert.equal(rows.length, 20);
  for (const p of preview.rows) assert.equal(rows.find((r) => r.company_id === p.company_id).price, p.price);

  // CHAI: monsoon event +600 (company entry replaces Consumer +300) and net demand 40,000.
  const chai = rows.find((r) => r.company_id === ids.CHAI);
  assert.equal(chai.fundamental_bps, 600);
  assert.equal(chai.net_demand, 40000);
  const { rows: [{ pressure_ref_qty: ref }] } = await db.query('SELECT pressure_ref_qty FROM companies WHERE id = $1', [ids.CHAI]);
  assert.equal(chai.trading_bps, Math.min(800, Math.round((40000 * 300) / ref)));
  assert.equal(chai.price, Math.round((26000 * (10000 + chai.total_bps)) / 10000));
  assert.equal((await db.query('SELECT is_applied FROM scheduled_events WHERE id = $1', ['E01-monsoon'])).rows[0].is_applied, true);

  // Applied events cannot be edited away: stock_prices is append-only.
  await assert.rejects(() => db.query('UPDATE stock_prices SET price = 1 WHERE round_id = 1'), /append-only/);
  await assert.rejects(() => db.query('DELETE FROM ledger_entries'), /append-only/);

  // Leaderboard snapshot exists and values holdings at the new official price.
  const lb = await views.leaderboardFor(1);
  assert.equal(lb.round_id, 1);
  const [v1] = await (require('../src/valuation').teamValuations)(db, { teamId: 1 });
  assert.equal(v1.holdings_value, 2000 * chai.price);
  await assertHealthy();
});

// ---------------------------------------------------------------------------------------------
test('margin bank: borrow, pledge protection, repay, interest and forced liquidation', async () => {
  await fresh((cfg) => {
    cfg.settings.loans.enabled = true;
    cfg.settings.loans.due_round = 3;
  });
  await market.startEvent(null);
  await market.openRound(1, null);
  await buy(1, 'HEAL', 2000); // ₹30 lakh
  await buy(2, 'HEAL', 2000);

  await assert.rejects(() => loans.borrow(1, { amount: 1600000 * 100, collateral: [{ company_id: ids.HEAL, quantity: 2000 }], requestKey: key() }), /at most/);
  const rk = key();
  const { loan } = await loans.borrow(1, { amount: 1000000 * 100, collateral: [{ company_id: ids.HEAL, quantity: 1500 }], requestKey: rk });
  const again = await loans.borrow(1, { amount: 1000000 * 100, collateral: [{ company_id: ids.HEAL, quantity: 1500 }], requestKey: rk });
  assert.equal(again.loan.id, loan.id, 'loan requests are idempotent');
  await assert.rejects(() => loans.borrow(1, { amount: 100, collateral: [{ company_id: ids.HEAL, quantity: 501 }], requestKey: key() }), /unpledged/);
  assert.match((await sell(1, 'HEAL', 501)).order.rejection_reason, /pledged/);
  assert.equal((await sell(1, 'HEAL', 500)).order.status, 'executed');
  await assert.rejects(() => loans.borrow(1, { amount: 100, collateral: [{ company_id: ids.GENE, quantity: 1 }], requestKey: key() }), /own|eligible/);

  // Team 2 borrows and repays.
  const l2 = (await loans.borrow(2, { amount: 500000 * 100, collateral: [{ company_id: ids.HEAL, quantity: 1000 }], requestKey: key() })).loan;
  await settle(1); // interest accrues: 2% of principal
  const { rows: [l2a] } = await db.query('SELECT * FROM loans WHERE id = $1', [l2.id]);
  assert.equal(l2a.interest_due, 1000000);
  const c2 = await cash(2);
  await market.openRound(2, null);
  await loans.repay(2, l2.id);
  assert.equal(await cash(2), c2 - 50000000 - 1000000);
  assert.equal((await db.query('SELECT pledged_quantity FROM holdings WHERE team_id = 2 AND company_id = $1', [ids.HEAL])).rows[0].pledged_quantity, 0);
  await assertHealthy();

  // Team 1 never repays: at round 3's update the collateral is liquidated.
  await settle(2);
  await market.openRound(3, null);
  await settle(3);
  const { rows: [l1] } = await db.query('SELECT * FROM loans WHERE id = $1', [loan.id]);
  assert.equal(l1.status, 'liquidated');
  const { rows: liq } = await db.query(`SELECT * FROM trades WHERE team_id = 1 AND source = 'liquidation'`);
  assert.equal(liq.length, 1);
  const healP3 = await price('HEAL', 3);
  assert.equal(liq[0].execution_price, healP3);
  assert.equal(liq[0].quantity, Math.ceil((100000000 + 3 * 2000000) / healP3));
  assert.equal((await db.query('SELECT pledged_quantity FROM holdings WHERE team_id = 1 AND company_id = $1', [ids.HEAL])).rows[0].pledged_quantity, 0);
  await assertHealthy();
});

// ---------------------------------------------------------------------------------------------
test('rewards and admin corrections are ledgered, capped and audited', async () => {
  await fresh();
  await market.startEvent(null);
  const before = await cash(5);
  await adminOps.grantReward(1, [5, 6], 'quiz-r1', 50000 * 100, 'Round 1 quiz winners');
  const dup = await adminOps.grantReward(1, [5], 'quiz-r1', 50000 * 100, 'Round 1 quiz winners again');
  assert.ok(dup[0].skipped);
  assert.equal(await cash(5), before + 5000000);
  await assert.rejects(() => adminOps.grantReward(1, [5], 'big', 300000 * 100, 'too generous'), /cap/);
  await assert.rejects(() => adminOps.adjustCash(1, 5, 100, ''), /reason/);
  await adminOps.adjustCash(1, 5, -100, 'fee refund reversal');
  await adminOps.adjustHoldings(1, 5, ids.CHAI, 10, 'manual trade during outage');
  await adminOps.adjustHoldings(1, 5, ids.CHAI, -4, 'partial reversal');
  const { rows } = await db.query(`SELECT action FROM admin_audit_log WHERE action IN ('grant_reward', 'adjust_cash', 'adjust_holdings')`);
  assert.equal(rows.length, 5); // 2 reward calls (one fully skipped) + 1 cash + 2 holdings
  await assertHealthy();
});

// ---------------------------------------------------------------------------------------------
test('full ten-round game with random trading ends with consistent books and frozen rankings', async () => {
  await fresh();
  await market.startEvent(null);
  const tickers = Object.keys(ids);
  let seedN = 7;
  const rnd = (n) => { seedN = (seedN * 1103515245 + 12345) % 2147483648; return seedN % n; };
  for (let round = 1; round <= 10; round++) {
    await market.openRound(round, null);
    const jobs = [];
    for (let team = 1; team <= 50; team++) {
      for (let k = 0; k < 3; k++) {
        const t = tickers[rnd(tickers.length)];
        jobs.push(rnd(3) === 0 ? sell(team, t, 1 + rnd(400)) : buy(team, t, 1 + rnd(800)));
      }
    }
    await Promise.all(jobs);
    await market.closeRound(round, null);
    await market.publishBulletin(round, null);
    await market.applyMarketUpdate(round, null);
    await assertHealthy();
  }
  await assert.rejects(() => market.openRound(11, null), /complete/);
  const end = await market.endEvent(null);
  assert.ok(end.winner);
  assert.equal((await market.endEvent(null)).already, true);
  const { rows: fr } = await db.query('SELECT * FROM final_rankings ORDER BY rank');
  assert.equal(fr.length, 50);
  for (let i = 1; i < fr.length; i++) assert.ok(fr[i - 1].net_worth >= fr[i].net_worth);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM stock_prices')).rows[0].n, 20 * 11);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM scheduled_events WHERE NOT is_applied')).rows[0].n, 0);
  const pub = await views.roundSummary();
  assert.ok(pub.final && pub.final.winner);
});

// ---------------------------------------------------------------------------------------------
test('HTTP: auth separation, no leakage of hidden events, idempotent order endpoint', async () => {
  await fresh();
  const app = createApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, cookie) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie || '' }, body: JSON.stringify(body || {}) });
  const get = (p, cookie) => fetch(base + p, { headers: { cookie: cookie || '' } });
  const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];
  try {
    const bad = await post('/api/auth/login', { team_id: 'team01', password: 'nope' });
    assert.equal(bad.status, 401);
    const teamCookie = cookieOf(await post('/api/auth/login', { team_id: 'TEAM01', password: 'pw-team01', member_name: 'Ravi' }));
    const adminCookie = cookieOf(await post('/api/admin/login', { username: 'admin', password: 'test-admin' }));

    assert.equal((await post('/api/admin/event/start', {}, teamCookie)).status, 401, 'team session cannot reach admin');
    assert.equal((await get('/api/admin/events', teamCookie)).status, 401);
    assert.equal((await get('/api/portfolio')).status, 401);
    const formPost = await fetch(base + '/api/admin/event/start', { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=1' });
    assert.equal(formPost.status, 415, 'non-JSON writes refused');

    assert.equal((await post('/api/admin/event/start', {}, adminCookie)).status, 200);
    assert.equal((await post('/api/admin/rounds/1/open', {}, adminCookie)).status, 200);

    const body = { company_id: ids.CHAI, side: 'buy', quantity: 10, idempotency_key: key() };
    const r1 = await (await post('/api/orders', body, teamCookie)).json();
    const r2 = await (await post('/api/orders', body, teamCookie)).json();
    assert.equal(r1.order.id, r2.order.id);
    assert.equal(r2.duplicate, true);
    assert.equal(r1.order.placed_by, 'Ravi');
    assert.equal((await post('/api/orders', { ...body, idempotency_key: key(), quantity: -1 }, teamCookie)).status, 422);

    // Nothing a participant can fetch mentions future events or bulletins.
    const publicPaths = ['/api/market/status', '/api/market/prices', '/api/market/history', '/api/news/current', '/api/portfolio',
      '/api/companies', `/api/companies/${ids.QBIT}`, '/api/transactions', '/api/leaderboard'];
    for (const p of publicPaths) {
      const text = await (await get(p, teamCookie)).text();
      for (const secret of ['E04-rare-earth', 'Zanzibaria', 'configuration', 'effective_round', 'Rare Earth, Rare Temper']) {
        assert.ok(!text.includes(secret), `${p} leaked "${secret}"`);
      }
    }
    assert.equal((await get('/api/paper/2', teamCookie)).status, 404, 'unpublished newspaper not served');
    assert.equal((await get('/api/paper/1')).status, 401, 'newspapers need a login');
    for (const gone of ['/display/', '/api/public/market', '/api/public/leaderboard']) assert.ok([401, 404].includes((await get(gone)).status), `${gone} removed`);
  } finally {
    server.close();
  }
});
