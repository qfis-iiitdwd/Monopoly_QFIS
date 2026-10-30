// Price script (pre-decided % moves per round) and admin corrections, checked against an
// independent re-calculation. Run against a disposable database, like game.test.js:
//   TEST_DATABASE_URL=postgres://marketverse:marketverse@localhost:5433/marketverse_test npm test
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://marketverse:marketverse@localhost:5433/marketverse_test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const db = require('../src/db');
const { seed } = require('../src/seed');
const trading = require('../src/trading');
const market = require('../src/market');
const loans = require('../src/loans');
const adminOps = require('../src/admin');
const views = require('../src/views');
const { createApp } = require('../src/server');

const { baseConfig, REAL_CONFIG } = require('./config');
const key = () => crypto.randomBytes(9).toString('base64url');
let ids; // ticker -> company id
let co;  // ticker -> company row

function config(mutate) {
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  if (mutate) mutate(cfg);
  return cfg;
}

async function fresh(mutate) {
  await db.migrate();
  await seed(config(mutate), { reset: true, force: true, adminPassword: 'test-admin', fixedPasswords: true });
  const { rows } = await db.query('SELECT * FROM companies');
  ids = Object.fromEntries(rows.map((r) => [r.ticker, r.id]));
  co = Object.fromEntries(rows.map((r) => [r.ticker, r]));
  views.invalidate();
}

const order = (team, ticker, side, qty) => trading.placeOrder(team, { companyId: ids[ticker], side, quantity: qty, idempotencyKey: key() });
const buy = (team, ticker, qty) => order(team, ticker, 'buy', qty);
const sell = (team, ticker, qty) => order(team, ticker, 'sell', qty);
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const teamRow = (id) => one('SELECT * FROM teams WHERE id = $1', [id]);
const holding = async (team, ticker) => (await one('SELECT * FROM holdings WHERE team_id = $1 AND company_id = $2', [team, ids[ticker]])) || { quantity: 0, cost_basis: 0, pledged_quantity: 0 };
const price = async (ticker, round) => (await one('SELECT price FROM stock_prices WHERE company_id = $1 AND round_id = $2', [ids[ticker], round])).price;
const inventory = async (ticker) => (await one('SELECT exchange_inventory FROM companies WHERE id = $1', [ids[ticker]])).exchange_inventory;
const reverse = (orderId, reason = 'test correction') => adminOps.reverseOrder(null, orderId, reason);

async function assertHealthy() {
  const problems = await adminOps.integrityCheck();
  assert.deepEqual(problems, [], JSON.stringify(problems));
}

// --- Independent re-implementation of the published price rule -----------------------------
// new price = prev × (1 + scripted move + trading pressure), rounded half away from zero to the paisa.
// Written separately from src/pricing.js on purpose.
const S = baseConfig.settings;
function oraclePressure(net, ref) {
  const raw = Math.sign(net) * Math.floor((Math.abs(net) * S.pressure_scale_bps * 2 + ref) / (2 * ref));
  return Math.max(-S.pressure_cap_bps, Math.min(S.pressure_cap_bps, raw));
}
function oraclePrice(prev, bps) {
  const total = Math.max(-S.max_move_down_bps, Math.min(S.max_move_up_bps, bps));
  const p = (BigInt(prev) * BigInt(10000 + total) * 2n + 10000n) / 20000n;
  return Math.max(S.min_price_rupees * 100, Math.min(S.max_price_rupees * 100, Number(p)));
}
const script = (ticker, round) => baseConfig.price_script.moves[ticker][round - 1];

async function playRound(round, during) {
  await market.openRound(round, null);
  if (during) await during();
  await market.closeRound(round, null);
  return market.applyMarketUpdate(round, null);
}

test.after(() => db.end());

// ---------------------------------------------------------------------------------------------
test('price script: ten rounds with no trading reproduce the spreadsheet exactly', async () => {
  await fresh();
  await market.startEvent(null);
  const expected = Object.fromEntries(Object.keys(ids).map((t) => [t, co[t].initial_price]));
  for (let r = 1; r <= 10; r++) {
    const preview = await market.previewMarketUpdate(r).catch(() => null); // round still pending: preview works anyway
    if (preview) for (const row of preview.rows) assert.equal(row.fundamental_bps, script(row.ticker, r));
    await playRound(r);
    for (const t of Object.keys(ids)) {
      expected[t] = oraclePrice(expected[t], script(t, r));
      assert.equal(await price(t, r), expected[t], `${t} round ${r}`);
    }
  }
  // Against the compounded change per company, computed separately from the spreadsheet (its own
  // Total column adds the moves instead of compounding them). Kept in config/, out of git: the
  // totals would give the game away.
  const totalsFile = path.join(__dirname, '..', 'config', 'expected-totals.json');
  const sheetTotals = REAL_CONFIG && fs.existsSync(totalsFile) ? JSON.parse(fs.readFileSync(totalsFile, 'utf8')) : {};
  for (const [t, total] of Object.entries(sheetTotals)) {
    const actual = expected[t] / co[t].initial_price - 1;
    assert.ok(Math.abs(actual - total) < 0.001, `${t}: game ${actual.toFixed(4)} vs sheet ${total}`);
  }
  await assertHealthy();
});

// ---------------------------------------------------------------------------------------------
test('price script + trading pressure: buying pushes up, selling pushes down, capped at ±8%', async () => {
  await fresh();
  await market.startEvent(null);
  const ref = co.NVID.pressure_ref_qty;
  const maxQ = co.NVID.max_order_quantity;
  await playRound(1, async () => {
    // Moderate net buying of NVID, heavy buying of PEAR (hits the cap), nothing on SONG.
    assert.equal((await buy(1, 'NVID', Math.min(maxQ, ref))).order.status, 'executed');
    for (let t = 1; t <= 15; t++) assert.equal((await buy(t, 'PEAR', co.PEAR.max_order_quantity)).order.status, 'executed');
  });
  const netPear = 15 * co.PEAR.max_order_quantity;
  assert.equal(await price('NVID', 1), oraclePrice(co.NVID.initial_price, script('NVID', 1) + oraclePressure(Math.min(maxQ, ref), ref)));
  assert.equal(oraclePressure(netPear, co.PEAR.pressure_ref_qty), 800, 'test setup: PEAR pressure should hit the cap');
  assert.equal(await price('PEAR', 1), oraclePrice(co.PEAR.initial_price, script('PEAR', 1) + 800));
  assert.equal(await price('SONG', 1), oraclePrice(co.SONG.initial_price, script('SONG', 1)));
  // Round 2: the PEAR holders all sell → negative pressure on top of the script.
  await playRound(2, async () => {
    for (let t = 1; t <= 15; t++) assert.equal((await sell(t, 'PEAR', co.PEAR.max_order_quantity)).order.status, 'executed');
  });
  assert.equal(await price('PEAR', 2), oraclePrice(await price('PEAR', 1), script('PEAR', 2) - 800));
  // The stored breakdown matches.
  const row = await one('SELECT * FROM stock_prices WHERE company_id = $1 AND round_id = 2', [ids.PEAR]);
  assert.deepEqual([row.fundamental_bps, row.trading_bps, row.noise_bps, row.net_demand], [script('PEAR', 2), -800, 0, -netPear]);
  await assertHealthy();
});

// ---------------------------------------------------------------------------------------------
test('reverse a buy: everything returns to exactly where it was, and pressure is cancelled', async () => {
  await fresh();
  await market.startEvent(null);
  await market.openRound(1, null);
  const before = await teamRow(3);
  const inv = await inventory('XIO');
  const r = await buy(3, 'XIO', 500);
  assert.equal(r.order.status, 'executed');
  const out = await reverse(r.order.id, 'Team typed 500 instead of 50');
  assert.equal(out.cash, before.cash);
  const after = await teamRow(3);
  assert.equal(after.cash, before.cash, 'full refund including the fee');
  assert.equal(after.realized_pnl, 0);
  assert.deepEqual([(await holding(3, 'XIO')).quantity, (await holding(3, 'XIO')).cost_basis], [0, 0]);
  assert.equal(await inventory('XIO'), inv);

  // Refusals: twice, a rejected order, an unknown order, missing reason.
  await assert.rejects(reverse(r.order.id), /already reversed/);
  const rej = await buy(3, 'XIO', 10 ** 9);
  assert.equal(rej.order.status, 'rejected');
  await assert.rejects(reverse(rej.order.id), /Only executed/);
  await assert.rejects(reverse(99999999), /not found/);
  await assert.rejects(adminOps.reverseOrder(null, r.order.id, ''), /reason/);

  // The team can trade normally afterwards; the round's net demand ignores the reversed order.
  await buy(3, 'XIO', 40);
  await market.closeRound(1, null);
  const p = await market.previewMarketUpdate(1);
  assert.equal(p.rows.find((x) => x.ticker === 'XIO').net_demand, 40);
  await market.applyMarketUpdate(1, null);
  assert.equal(await price('XIO', 1), oraclePrice(co.XIO.initial_price, script('XIO', 1) + oraclePressure(40, co.XIO.pressure_ref_qty)));

  // History shows the correction to the team; the audit log has it; suspected duplicates ignore it.
  const tx = await views.transactions(3);
  assert.ok(tx.orders.find((o) => o.order_id === r.order.id).reversed_reason.includes('500 instead of 50'));
  assert.ok(tx.orders.find((o) => o.source === 'reversal' && o.placed_by === 'organisers'));
  const audit = await one(`SELECT * FROM admin_audit_log WHERE action = 'reverse_order'`);
  assert.equal(audit.before_state.order, Number(r.order.id));
  await assertHealthy();
});

// ---------------------------------------------------------------------------------------------
test('reverse a sell after the price moved: shares, basis, cash and realised P&L restored', async () => {
  await fresh();
  await market.startEvent(null);
  await playRound(1, () => buy(4, 'NVID', 300));
  const afterBuy = { team: await teamRow(4), h: await holding(4, 'NVID') };
  await market.openRound(2, null);
  const s = await sell(4, 'NVID', 120);
  assert.equal(s.order.status, 'executed');
  const realized = (await teamRow(4)).realized_pnl;
  assert.notEqual(realized, 0);
  await reverse(s.order.id);
  const t = await teamRow(4);
  const h = await holding(4, 'NVID');
  assert.equal(t.cash, afterBuy.team.cash);
  assert.equal(t.realized_pnl, 0);
  assert.equal(h.quantity, 300);
  assert.equal(h.cost_basis, afterBuy.h.cost_basis);
  await assertHealthy();
});

// ---------------------------------------------------------------------------------------------
test('reversals that cannot be undone are refused with a clear reason and change nothing', async () => {
  await fresh();
  await market.startEvent(null);
  await market.openRound(1, null);
  // Buy then sell part: the buy can't be reversed (shares gone) until the sell is reversed.
  const b = await buy(5, 'ABOD', 200);
  const s = await sell(5, 'ABOD', 150);
  const snapshot = JSON.stringify([await teamRow(5), await holding(5, 'ABOD'), await inventory('ABOD')]);
  await assert.rejects(reverse(b.order.id), /only 50 unpledged ABOD/);
  assert.equal(JSON.stringify([await teamRow(5), await holding(5, 'ABOD'), await inventory('ABOD')]), snapshot);
  await reverse(s.order.id);
  await reverse(b.order.id);
  assert.equal((await holding(5, 'ABOD')).quantity, 0);

  // Sell then spend the money: the sale can't be reversed for lack of cash.
  await buy(6, 'MRCZ', co.MRCZ.max_order_quantity);
  const sale = await sell(6, 'MRCZ', co.MRCZ.max_order_quantity);
  let cash = (await teamRow(6)).cash;
  for (const t of Object.keys(ids)) {
    const q = Math.min(co[t].max_order_quantity, Math.floor(cash / (co[t].initial_price * 1.002)));
    if (q > 0 && (await buy(6, t, q)).order.status === 'executed') cash = (await teamRow(6)).cash;
  }
  assert.ok(cash < sale.order.cash_delta, 'test setup: team should have spent the proceeds');
  await assert.rejects(reverse(sale.order.id), /undoing this sale takes back/);

  // Sell, then other teams buy the inventory: the sale can't be reversed (no shares to return).
  const smallCo = 'KOLA';
  const all = co[smallCo].float_shares;
  const max = co[smallCo].max_order_quantity;
  await buy(7, smallCo, max);
  const s7 = await sell(7, smallCo, max);
  for (let t = 8, left = all; left > 0; t++) {
    const q = Math.min(max, await inventory(smallCo));
    if (!q) break;
    assert.equal((await buy(t, smallCo, q)).order.status, 'executed');
    left -= q;
  }
  assert.equal(await inventory(smallCo), 0);
  await assert.rejects(reverse(s7.order.id), /shares are left on the exchange/);
  await assertHealthy();
});

// ---------------------------------------------------------------------------------------------
test('races: two admins reverse the same order; reversals during an order storm', async () => {
  await fresh();
  await market.startEvent(null);
  await market.openRound(1, null);
  const r = await buy(1, 'GOGL', 100);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => reverse(r.order.id)));
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1, 'exactly one reversal wins');
  assert.ok(results.filter((x) => x.status === 'rejected').every((x) => /already reversed/.test(x.reason.message)));
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM trades WHERE source = $1', ['reversal'])).n, 1);

  // 10 teams each place 30 orders while an admin reverses their earlier orders.
  const seedOrders = [];
  for (let t = 1; t <= 10; t++) seedOrders.push((await buy(t, 'CLSD', 50)).order.id);
  const storm = [];
  for (let t = 1; t <= 10; t++) {
    for (let i = 0; i < 30; i++) storm.push(order(t, i % 3 ? 'CLSD' : 'ANTH', i % 4 === 3 ? 'sell' : 'buy', 5 + (i % 7)));
  }
  const revs = seedOrders.map((id) => reverse(id).catch((e) => e));
  const settled = await Promise.allSettled([...storm, ...revs]);
  const failures = settled.filter((x) => x.status === 'rejected' || x.value instanceof Error);
  // A reversal may legitimately be refused if the team sold CLSD in the storm first; nothing else may fail.
  for (const f of failures) assert.match((f.reason || f.value).message, /unpledged|cannot be undone/);
  await assertHealthy();
  await market.closeRound(1, null);
  const p = await market.previewMarketUpdate(1);
  const { rows: [{ net }] } = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN t.side = 'buy' THEN t.quantity ELSE -t.quantity END), 0)::int AS net
       FROM trades t WHERE t.round_id = 1 AND t.company_id = $1`, [ids.CLSD]);
  assert.equal(p.rows.find((x) => x.ticker === 'CLSD').net_demand, net);
});

// ---------------------------------------------------------------------------------------------
test('reopen a round closed by mistake; refused once the news is out or the round is settled', async () => {
  await fresh();
  await market.startEvent(null);
  await market.openRound(1, null);
  await buy(1, 'POP', 10);
  await market.closeRound(1, null);
  assert.equal((await buy(1, 'POP', 10)).order.status, 'rejected');
  await assert.rejects(market.reopenRound(1, 60, null, ''), /reason/);
  await assert.rejects(market.reopenRound(1, 0, null, 'oops closed'), /1–3600/);
  await assert.rejects(market.reopenRound(2, 60, null, 'oops closed'), /current round/);
  const r = await market.reopenRound(1, 2, null, 'Closed by mistake');
  assert.equal(r.status, 'open');
  assert.equal((await buy(1, 'POP', 10)).order.status, 'executed');
  // The new deadline is enforced by the server.
  await new Promise((res) => setTimeout(res, 2100));
  assert.match((await buy(1, 'POP', 10)).order.rejection_reason, /deadline/);
  assert.equal(await market.autoCloseExpired(), 1);
  await market.publishBulletin(1, null);
  await assert.rejects(market.reopenRound(1, 60, null, 'too late now'), /news segment/);
  await market.applyMarketUpdate(1, null);
  await assert.rejects(market.reopenRound(1, 60, null, 'too late now'), /settled/);
  await assertHealthy();
});

// ---------------------------------------------------------------------------------------------
test('undo a market update, fix a typo in the script, re-apply; limits on undo and on edits', async () => {
  await fresh();
  await market.startEvent(null);
  await playRound(1, () => buy(2, 'TLSA', 400));
  const wrong = await price('TLSA', 1);
  const lbBefore = (await one('SELECT COUNT(*)::int AS n FROM leaderboard_snapshots WHERE round_id = 1')).n;
  assert.equal(lbBefore, 50);

  // Editing an applied event is refused; the trigger still protects prices outside an undo.
  await assert.rejects(market.updateEvent('SCRIPT-R01', { companies: { TLSA: 100 } }, null, 'fix typo'), /already applied/);
  await assert.rejects(db.query('DELETE FROM stock_prices WHERE round_id = 1'), /append-only/);
  await assert.rejects(db.query(`UPDATE stock_prices SET price = 1 WHERE round_id = 1`), /append-only/);

  await assert.rejects(market.undoMarketUpdate(1, null, 'x'), /reason/);
  const u = await market.undoMarketUpdate(1, null, 'TLSA round 1 should be +5.00%');
  assert.equal(u.removed_prices, 20);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM stock_prices WHERE round_id = 1')).n, 0);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM leaderboard_snapshots WHERE round_id = 1')).n, 0);
  assert.equal((await one('SELECT status FROM rounds WHERE id = 1')).status, 'closed');
  // Prices teams see are back to the listing prices; nobody can trade (round is closed).
  const board = await views.priceBoard();
  assert.equal(board.find((b) => b.ticker === 'TLSA').price, co.TLSA.initial_price);
  assert.equal((await buy(3, 'TLSA', 1)).order.status, 'rejected');
  // Undoing twice is refused; the audit log keeps the removed prices.
  await assert.rejects(market.undoMarketUpdate(1, null, 'again please'), /no market update/);
  const audit = await one(`SELECT * FROM admin_audit_log WHERE action = 'undo_market_update'`);
  assert.equal(audit.before_state.prices.find((p) => p.ticker === 'TLSA').price, wrong);

  // Edit validation, then the fix.
  const cfg = (await one(`SELECT configuration FROM scheduled_events WHERE id = 'SCRIPT-R01'`)).configuration;
  await assert.rejects(market.updateEvent('SCRIPT-R01', { companies: { ...cfg.companies, NOPE: 5 } }, null, 'fix typo'), /Unknown ticker/);
  await assert.rejects(market.updateEvent('SCRIPT-R01', { companies: { TLSA: 1.5 } }, null, 'fix typo'), /whole basis points/);
  await assert.rejects(market.updateEvent('SCRIPT-R01', { companies: { TLSA: 99999 } }, null, 'fix typo'), /within/);
  await assert.rejects(market.updateEvent('SCRIPT-R01', { companies: { TLSA: 500 } }, null, ''), /reason/);
  await assert.rejects(market.updateEvent('NOPE', { companies: {} }, null, 'fix typo'), /not found/);
  await market.updateEvent('SCRIPT-R01', { companies: { ...cfg.companies, TLSA: 500 } }, null, 'TLSA round 1 should be +5.00%');
  const again = await market.applyMarketUpdate(1, null);
  assert.equal(again.alreadyApplied, false);
  assert.equal(await price('TLSA', 1), oraclePrice(co.TLSA.initial_price, 500 + oraclePressure(400, co.TLSA.pressure_ref_qty)));
  assert.equal(await price('PEAR', 1), oraclePrice(co.PEAR.initial_price, script('PEAR', 1)), 'other companies unchanged');
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM leaderboard_snapshots WHERE round_id = 1')).n, 50);

  // Once the next round opens, round 1 can no longer be undone.
  await market.openRound(2, null);
  await assert.rejects(market.undoMarketUpdate(1, null, 'too late now'), /latest round/);
  await assert.rejects(market.undoMarketUpdate(2, null, 'not applied'), /no market update/);
  await assertHealthy();
});

// ---------------------------------------------------------------------------------------------
test('undo is refused when the update charged loan interest', async () => {
  await fresh((cfg) => { cfg.settings.loans.enabled = true; });
  await market.startEvent(null);
  await playRound(1, () => buy(1, 'MCRH', 500));
  // A round-1 update with no loans outstanding can be undone and re-applied.
  await market.undoMarketUpdate(1, null, 'check undo with loans on');
  await market.applyMarketUpdate(1, null);
  await market.openRound(2, null);
  await loans.borrow(1, { amount: 1000000, collateral: [{ company_id: ids.MCRH, quantity: 500 }], requestKey: key() });
  await market.closeRound(2, null);
  await market.applyMarketUpdate(2, null);
  await assert.rejects(market.undoMarketUpdate(2, null, 'should be refused'), /loan interest/);
  await assertHealthy();
});

// ---------------------------------------------------------------------------------------------
test('seed rejects a malformed price script before anything is written', async () => {
  await fresh();
  const bad = [
    [(c) => { c.price_script.moves.PEAR = c.price_script.moves.PEAR.slice(0, 9); }, /exactly 10 moves/],
    [(c) => { c.price_script.moves.ZZZ = Array(10).fill(0); }, /ZZZ is not in companies/],
    [(c) => { c.price_script.moves.PEAR[3] = 12.5; }, /whole basis points/],
    [(c) => { c.price_script.moves.PEAR[3] = 7000; }, /outside the ±60% per-round limit/],
    [(c) => { c.companies[0].price = null; }, /needs a positive price/],
    [(c) => { c.events = [{ id: 'SCRIPT-R01', name: 'x', effective_round: 1 }]; }, /reserved/],
  ];
  for (const [mutate, err] of bad) {
    await assert.rejects(seed(config(mutate), { reset: true, force: true, adminPassword: 'x' }), err);
  }
  // The earlier, valid seed is untouched.
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM scheduled_events')).n, 10);
});

// ---------------------------------------------------------------------------------------------
test('import-moves reads the spreadsheet format (CSV, %, fractions) and writes the config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-import-'));
  const run = (...a) => execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'import-moves.js'), ...a], { encoding: 'utf8' });
  const rounds = Array.from({ length: 10 }, (_, i) => `Round ${i + 1}`);
  fs.writeFileSync(path.join(dir, 'f.csv'), ['Moves', '', `Company,Ticker,${rounds.join(',')},Total`,
    `"Pear, Inc",PEAR,${[0.0137, -0.1911, 0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07].join(',')},0.1`,
    `Popsi,pop,${Array(10).fill(-0.0001).join(',')},0`].join('\n'));
  fs.writeFileSync(path.join(dir, 'p.csv'), [`Ticker,${rounds.join(',')}`, `PEAR,${Array(10).fill('1.37%').join(',')}`].join('\n'));
  fs.writeFileSync(path.join(dir, 'bad.csv'), [`Ticker,${rounds.join(',')}`, `PEAR,${Array(9).fill('1').join(',')},oops`].join('\n'));
  const cfgFile = path.join(dir, 'game.json');
  fs.writeFileSync(cfgFile, JSON.stringify(config()));

  assert.match(run(path.join(dir, 'f.csv')), /Nothing written/);
  run(path.join(dir, 'f.csv'), '--config', cfgFile, '--write');
  let cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.deepEqual(cfg.price_script.moves.PEAR, [137, -1911, 0, 100, 200, 300, 400, 500, 600, 700]);
  assert.deepEqual(cfg.price_script.moves.POP, Array(10).fill(-1));
  assert.equal(cfg.companies.length, 20, 'existing companies kept, none added');

  run(path.join(dir, 'p.csv'), '--config', cfgFile, '--write');
  cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.deepEqual(cfg.price_script.moves.PEAR, Array(10).fill(137));
  assert.throws(() => run(path.join(dir, 'bad.csv')), /PEAR Round 10: "oops" is not a number/);

  const xlsx = path.join(os.homedir(), 'Downloads', 'Monopoly Market Simulation.xlsx');
  if (fs.existsSync(xlsx)) {
    assert.throws(() => run(xlsx), /2 sheets/);
    const out = run(xlsx, '--sheet', 'Table 1');
    assert.match(out, /20 companies × 10 rounds/);
    assert.match(out, /Total column ADDS/);
    assert.match(run(xlsx, '--sheet', 'Table 2'), /matches the compounded change/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
test('HTTP: corrections are admin-only, visible to the team, and the script never leaks', async () => {
  await fresh();
  const app = createApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (method, p, body, cookie) => fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie: cookie || '' }, body: body ? JSON.stringify(body) : undefined });
  const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];
  try {
    const admin = cookieOf(await req('POST', '/api/admin/login', { username: 'admin', password: 'test-admin' }));
    const team = cookieOf(await req('POST', '/api/auth/login', { team_id: 'team01', password: 'pw-team01', member_name: 'Asha' }));
    assert.equal((await req('POST', '/api/admin/event/start', {}, admin)).status, 200);
    assert.equal((await req('POST', '/api/admin/rounds/1/open', {}, admin)).status, 200);
    const o = await (await req('POST', '/api/orders', { company_id: ids.NVID, side: 'buy', quantity: 25, idempotency_key: key() }, team)).json();
    assert.equal(o.order.status, 'executed');

    // Team and anonymous callers cannot use any correction endpoint.
    for (const [m, p, b] of [['POST', `/api/admin/orders/${o.order.id}/reverse`, { reason: 'self-serve refund' }],
      ['POST', '/api/admin/rounds/1/reopen', { seconds: 60, reason: 'more time pls' }],
      ['POST', '/api/admin/rounds/1/undo-market-update', { reason: 'undo please' }],
      ['PATCH', '/api/admin/events/SCRIPT-R01', { configuration: { companies: { NVID: 5000 } }, reason: 'make me rich' }],
      ['GET', '/api/admin/events']]) {
      for (const cookie of [team, '']) assert.equal((await req(m, p, b, cookie)).status, 401, `${m} ${p}`);
    }
    // Bad ids are 4xx, not 500.
    assert.equal((await req('POST', '/api/admin/orders/abc/reverse', { reason: 'bad id test' }, admin)).status, 400);
    assert.equal((await req('POST', '/api/admin/orders/999999/reverse', { reason: 'bad id test' }, admin)).status, 404);
    for (const configuration of ['nonsense', null, [], { companies: [1] }, { comapnies: {} }]) {
      assert.equal((await req('PATCH', '/api/admin/events/SCRIPT-R01', { configuration, reason: 'bad body test' }, admin)).status, 400,
        `configuration ${JSON.stringify(configuration)} must be refused, not treated as "no moves"`);
    }
    assert.equal(Object.keys((await one(`SELECT configuration FROM scheduled_events WHERE id = 'SCRIPT-R01'`)).configuration.companies).length, 20);

    const rv = await req('POST', `/api/admin/orders/${o.order.id}/reverse`, { reason: 'Fat finger, confirmed with team' }, admin);
    assert.equal(rv.status, 200);
    assert.equal((await req('POST', `/api/admin/orders/${o.order.id}/reverse`, { reason: 'Fat finger, confirmed with team' }, admin)).status, 409);
    const hist = await (await req('GET', '/api/transactions', null, team)).json();
    assert.equal(hist.orders.find((x) => x.order_id === o.order.id).reversed_reason, 'Fat finger, confirmed with team');
    const admOrders = await (await req('GET', '/api/admin/orders', null, admin)).json();
    assert.ok(admOrders.find((x) => x.id === o.order.id).reversed_at);

    // Nothing a team or the public can read mentions the future script.
    for (const p of ['/api/market/status', '/api/market/prices', '/api/market/history', '/api/news/current', '/api/portfolio',
      '/api/transactions', '/api/companies', `/api/companies/${ids.NVID}`]) {
      const res = await req('GET', p, null, team);
      const text = await res.text();
      assert.equal(res.status, 200, p);
      assert.ok(!/SCRIPT-R|price_script|fundamental_bps|Scripted moves/.test(text), `${p} leaks the script`);
    }
    // The event's config hides rankings from teams.
    assert.equal((await req('GET', '/api/leaderboard', null, team)).status, 404);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The whole event, 50 teams, with random trading and every kind of correction, checked at each
// round against an independent replay of the books and the price rule.
test('full event with corrections matches an independent replay of every price and balance', async () => {
  await fresh();
  await market.startEvent(null);
  let seedN = 7;
  const rnd = () => { seedN = (seedN * 1103515245 + 12345) % 2147483648; return seedN / 2147483648; };
  const tickers = Object.keys(ids);
  const scriptNow = async (round) => (await one('SELECT configuration FROM scheduled_events WHERE id = $1', [`SCRIPT-R${String(round).padStart(2, '0')}`])).configuration.companies;
  const stats = { orders: 0, executed: 0, reversed: 0, refusedReversals: 0, adjustments: 0 };

  for (let round = 1; round <= 10; round++) {
    await market.openRound(round, null);
    const prev = Object.fromEntries(await Promise.all(tickers.map(async (t) => [t, await price(t, round - 1)])));
    const placed = [];
    const batch = [];
    for (let i = 0; i < 300; i++) {
      const t = tickers[Math.floor(rnd() * tickers.length)];
      batch.push(order(1 + Math.floor(rnd() * 50), t, rnd() < 0.62 ? 'buy' : 'sell', 1 + Math.floor(rnd() * co[t].max_order_quantity * 0.6)));
      if (batch.length === 25) placed.push(...(await Promise.all(batch.splice(0))));
    }
    placed.push(...(await Promise.all(batch)));
    stats.orders += placed.length;
    const executed = placed.filter((p) => p.order.status === 'executed');
    stats.executed += executed.length;
    // Every execution used the official price and the published fee rule.
    for (const { order: o } of executed) {
      assert.equal(o.execution_price, prev[tickers.find((t) => ids[t] === o.company_id)]);
      assert.equal(o.fee, Math.ceil((o.gross * S.fee_bps) / 10000));
      assert.equal(o.gross, o.execution_price * o.quantity);
    }
    // Corrections: reverse a few orders (some legitimately refused), an adjustment, a reward.
    for (let i = 0; i < 6; i++) {
      const pick = executed[Math.floor(rnd() * executed.length)];
      try { await reverse(pick.order.id, `round ${round} correction`); stats.reversed++; } catch (e) {
        assert.match(e.message, /already reversed|cannot be undone|undoing this sale|left on the exchange/);
        stats.refusedReversals++;
      }
    }
    await adminOps.adjustCash(null, 1 + (round % 50), 100000 * round, `round ${round} manual fix`);
    await adminOps.grantReward(null, [round, round + 10], `quiz-${round}`, 50000 * round, 'quiz reward');
    stats.adjustments++;
    if (round === 4) { // closed by mistake, reopened, more trading
      await market.closeRound(round, null);
      await market.reopenRound(round, 300, null, 'closed by mistake');
      assert.equal((await buy(50, 'KOLA', 10)).order.status, 'executed');
    }
    await market.closeRound(round, null);
    await market.applyMarketUpdate(round, null);
    if (round === 6) { // wrong script value spotted after applying: undo, fix, re-apply
      await market.undoMarketUpdate(round, null, 'typo in sheet');
      const companies = await scriptNow(round);
      await market.updateEvent(`SCRIPT-R0${round}`, { companies: { ...companies, NVID: -companies.NVID } }, null, 'NVID sign was wrong');
      await market.applyMarketUpdate(round, null);
    }

    // Independent check of every company's new price.
    const sc = await scriptNow(round);
    const { rows: demand } = await db.query(
      `SELECT company_id, SUM(CASE WHEN side = 'buy' THEN quantity ELSE -quantity END)::int AS net
         FROM trades WHERE round_id = $1 AND source <> 'liquidation' GROUP BY company_id`, [round]);
    const net = new Map(demand.map((d) => [d.company_id, d.net]));
    for (const t of tickers) {
      const bps = (sc[t] || 0) + oraclePressure(net.get(ids[t]) || 0, co[t].pressure_ref_qty);
      assert.equal(await price(t, round), oraclePrice(prev[t], bps), `${t} round ${round}`);
    }
    await assertHealthy();
  }
  assert.equal(await price('NVID', 6), oraclePrice(await price('NVID', 5),
    -script('NVID', 6) + (await one('SELECT trading_bps FROM stock_prices WHERE company_id = $1 AND round_id = 6', [ids.NVID])).trading_bps));

  // Replay every team's books from the trade and ledger history alone.
  const { rows: teams } = await db.query('SELECT * FROM teams ORDER BY id');
  const { rows: trades } = await db.query('SELECT * FROM trades ORDER BY id');
  const { rows: other } = await db.query(`SELECT team_id, amount FROM ledger_entries WHERE transaction_type IN ('adjustment', 'quest_reward')`);
  const final = Object.fromEntries(await Promise.all(tickers.map(async (t) => [ids[t], await price(t, 10)])));
  const replay = new Map(teams.map((t) => [t.id, { cash: S.starting_cash_rupees * 100, realized: 0, qty: new Map() }]));
  for (const tr of trades) {
    const r = replay.get(tr.team_id);
    r.cash += tr.cash_delta;
    r.realized += tr.realized_pnl;
    r.qty.set(tr.company_id, (r.qty.get(tr.company_id) || 0) + (tr.side === 'buy' ? tr.quantity : -tr.quantity));
  }
  for (const l of other) replay.get(l.team_id).cash += l.amount;
  const { rows: holdings } = await db.query('SELECT * FROM holdings');
  for (const t of teams) {
    const r = replay.get(t.id);
    assert.equal(t.cash, r.cash, `${t.name} cash`);
    assert.equal(t.realized_pnl, r.realized, `${t.name} realised P&L`);
    for (const h of holdings.filter((x) => x.team_id === t.id)) assert.equal(h.quantity, r.qty.get(h.company_id) || 0, `${t.name} holding ${h.company_id}`);
    r.netWorth = r.cash + [...r.qty].reduce((a, [c, q]) => a + q * final[c], 0);
  }
  // Final ranking order follows the replayed net worth (ties broken by the published rules).
  await market.endEvent(null);
  const { rows: ranks } = await db.query('SELECT * FROM final_rankings ORDER BY rank, team_id');
  for (const f of ranks) assert.equal(f.net_worth, replay.get(f.team_id).netWorth, `team ${f.team_id} net worth`);
  for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i - 1].net_worth >= ranks[i].net_worth, 'ranking order');
  assert.ok(stats.executed > 800 && stats.reversed > 20, JSON.stringify(stats));
  // After the event, nothing can be corrected.
  await assert.rejects(reverse(trades.find((t) => t.order_id).order_id), /finished/);
  await assertHealthy();
});

// ---------------------------------------------------------------------------------------------
test('login: remembered passwords stop working after a reset; a rush of identical logins shares one check', async () => {
  await fresh();
  const auth = require('../src/auth');
  const passwords = require('../src/passwords');
  // 30 laptops of one team at once, plus wrong passwords mixed in.
  const rush = await Promise.allSettled([
    ...Array.from({ length: 30 }, () => auth.loginTeam('team05', 'pw-team05', 'x')),
    ...Array.from({ length: 5 }, () => auth.loginTeam('team05', 'nope', 'x')),
  ]);
  assert.equal(rush.slice(0, 30).filter((r) => r.status === 'fulfilled').length, 30);
  assert.ok(rush.slice(30).every((r) => r.status === 'rejected' && r.reason.status === 401));
  // Cached: no scrypt queue builds up for repeat logins.
  await Promise.all(Array.from({ length: 50 }, () => auth.loginTeam('TEAM05 ', 'pw-team05')));
  assert.equal(passwords.queueLength(), 0);
  // Reset (as the admin route does): the old password must fail even though it was cached.
  const { rows: [t] } = await db.query(`SELECT id FROM teams WHERE access_identifier = 'team05'`);
  await db.query('UPDATE teams SET password_hash = $2 WHERE id = $1', [t.id, passwords.hash('brand-new-pw', passwords.TEAM_N)]);
  await assert.rejects(auth.loginTeam('team05', 'pw-team05'), (e) => e.status === 401);
  assert.equal((await auth.loginTeam('team05', 'brand-new-pw')).team.id, t.id);
  // A deactivated team cannot log in, cached or not.
  await db.query('UPDATE teams SET is_active = false WHERE id = $1', [t.id]);
  await assert.rejects(auth.loginTeam('team05', 'brand-new-pw'), (e) => e.status === 401);
});
