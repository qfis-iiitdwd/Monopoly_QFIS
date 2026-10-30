#!/usr/bin/env node
// Adversarial stress suite: the things real people (and the odd mischievous student) do to a live
// event — hostile input, races between teammates, a whole hall hitting one stock, order spam,
// admin double-clicks, pausing mid-flood, orders straddling the deadline. Every scenario checks
// the books afterwards. Run it against the deployed server before the event.
//
// DESTROYS game state. Needs a fresh seed with --test-passwords and short rounds, e.g.
//   node scripts/seed.js --reset --force --test-passwords --config <config with duration_seconds ≈ 20>
//   ADMIN_PASSWORD=... node scripts/stress.js [--url http://localhost:3000] [--teams 50] [--members 5]

const crypto = require('crypto');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg('--url', 'http://localhost:3000');
const TEAMS = Number(arg('--teams', 50));
const MEMBERS = Number(arg('--members', 5));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) { console.error('Set ADMIN_PASSWORD'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => crypto.randomBytes(12).toString('hex');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const pctl = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const lat = (xs) => `n=${xs.length} p50=${pctl(xs, 0.5).toFixed(0)}ms p95=${pctl(xs, 0.95).toFixed(0)}ms max=${Math.max(0, ...xs).toFixed(0)}ms`;

const failures = [];
const notes = [];
let serverErrors = 0;
const LEAK = /effective_round|password_hash|scheduled_events|"impacts"|noise_seed|price_script|SCRIPT-R|fundamental_bps/;

function check(name, cond, detail) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function raw(path, { method, cookie, body, headers = {}, rawBody } = {}) {
  const t = performance.now();
  const init = { method: method || (body !== undefined || rawBody !== undefined ? 'POST' : 'GET'), headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  if (rawBody !== undefined) init.body = rawBody;
  try {
    const res = await fetch(BASE + path, init);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (res.status >= 500) serverErrors++;
    return { status: res.status, data, text, ms: performance.now() - t, res };
  } catch (e) {
    serverErrors++;
    return { status: 0, error: e.message, ms: performance.now() - t };
  }
}
const cookieOf = (r) => (r.res && r.res.headers.get('set-cookie') || '').split(';')[0];

let ADMIN;
const ADMIN_GETS = /^(integrity|overview|teams|system-log|orders\?.*|rounds\/\d+\/preview)$/;
async function admin(path, body = {}, { allow = [] } = {}) {
  const r = await raw('/api/admin/' + path, { cookie: ADMIN, body: ADMIN_GETS.test(path) ? undefined : body });
  if (r.status !== 200 && !allow.includes(r.status)) throw new Error(`admin ${path}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.data;
}
const order = (u, company, side, quantity, k = key()) =>
  raw('/api/orders', { cookie: u.cookie, body: { company_id: company.id, side, quantity, idempotency_key: k } });

async function teamState(u) { return (await raw('/api/portfolio', { cookie: u.cookie })).data; }
async function integrity(label) {
  const r = await admin('integrity');
  check(`integrity after ${label}`, r.problems.length === 0, r.problems.length ? JSON.stringify(r.problems).slice(0, 400) : '');
}

// Samples the server's DB pool while load runs, so saturation shows up in the report.
let poolPeak = { waiting: 0, total: 0 };
let sampling = true;
async function samplePool() {
  while (sampling) {
    const o = await raw('/api/admin/overview', { cookie: ADMIN });
    if (o.data && o.data.pool) {
      poolPeak.waiting = Math.max(poolPeak.waiting, o.data.pool.waiting);
      poolPeak.total = Math.max(poolPeak.total, o.data.pool.total);
      poolPeak.max = o.data.pool.max;
    }
    await sleep(500);
  }
}

async function main() {
  const login = await raw('/api/admin/login', { body: { username: 'admin', password: ADMIN_PASSWORD } });
  if (login.status !== 200) throw new Error('admin login failed');
  ADMIN = cookieOf(login);
  const st0 = (await raw('/api/market/status')).data;
  if (st0.status !== 'setup') throw new Error('Needs a freshly seeded game (status=setup). Re-seed with --reset --force --test-passwords.');
  await admin('event/start');
  const companies = (await raw('/api/market/prices')).data;
  // Scenario roles. Named after the original sample config's tickers; any other config gets distinct
  // companies assigned in order (scenario [4] uses the first four tradable companies).
  const ROLES = ['CHAI', 'RAIL', 'MEME', 'GENE', 'DOSA', 'BIMA', 'CMNT', 'JETL'];
  const named = Object.fromEntries(companies.map((c) => [c.ticker, c]));
  const spare = companies.filter((c) => c.is_tradable).slice(4).filter((c) => !ROLES.includes(c.ticker));
  const byTicker = {};
  for (const r of ROLES) {
    if (named[r]) { byTicker[r] = named[r]; continue; }
    const i = r === 'CMNT' ? spare.findIndex((c) => c.loan_eligible !== false) : 0;
    if (i < 0 || !spare.length) throw new Error('Config needs at least 12 tradable companies for the stress suite');
    byTicker[r] = spare.splice(i, 1)[0];
  }
  const sampler = samplePool();

  // ---------------------------------------------------------------------------------------
  console.log(`\n[1] ${TEAMS * MEMBERS} simultaneous logins`);
  const logins = await Promise.all(Array.from({ length: TEAMS * MEMBERS }, async (_, i) => {
    const t = String((i % TEAMS) + 1).padStart(2, '0');
    const r = await raw('/api/auth/login', { body: { team_id: `TEAM${t} `, password: `pw-team${t}`, member_name: `m${i}<b>` } });
    return { ok: r.status === 200, ms: r.ms, cookie: cookieOf(r), team: Number(t), idx: i };
  }));
  check('all logins succeed (case/space-insensitive ID)', logins.every((l) => l.ok), lat(logins.map((l) => l.ms)));
  const users = logins;
  const teamUsers = (t) => users.filter((u) => u.team === t);

  await admin('rounds/1/open');
  await admin('rounds/1/extend', { seconds: 900, reason: 'stress' });

  // ---------------------------------------------------------------------------------------
  console.log('\n[2] Hostile and malformed input never causes a 500 or a leak');
  const u0 = users[0];
  const good = { company_id: companies[0].id, side: 'buy', quantity: 1, idempotency_key: key() };
  const bad = [
    ['text/plain body', { rawBody: 'x', headers: { 'content-type': 'text/plain' } }],
    ['form body', { rawBody: 'a=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
    ['truncated JSON', { rawBody: '{"side":', headers: { 'content-type': 'application/json' } }],
    ['JSON array', { rawBody: '[]', headers: { 'content-type': 'application/json' } }],
    ['JSON null', { rawBody: 'null', headers: { 'content-type': 'application/json' } }],
    ['JSON string', { rawBody: '"buy"', headers: { 'content-type': 'application/json' } }],
    ['100 KB body', { rawBody: JSON.stringify({ ...good, pad: 'x'.repeat(100000) }), headers: { 'content-type': 'application/json' } }],
    ['deeply nested', { rawBody: '['.repeat(5000) + ']'.repeat(5000), headers: { 'content-type': 'application/json' } }],
    ...[-1, 0, 1.5, 'abc', '10', 1e308, true, null, [], {}, 2 ** 53 + 2, '0x10', ' 5 ', 1e21].map((q) => [`quantity=${JSON.stringify(q)}`, { body: { ...good, quantity: q, idempotency_key: key() } }]),
    ...['BUY', '', null, 'short', ['buy'], { side: 'buy' }].map((s) => [`side=${JSON.stringify(s)}`, { body: { ...good, side: s, idempotency_key: key() } }]),
    ...[0, -1, 99999, 'BYTE', null, 1.5, 2 ** 53, '1 OR 1=1'].map((c) => [`company_id=${JSON.stringify(c)}`, { body: { ...good, company_id: c, idempotency_key: key() } }]),
    ...['short', 'x'.repeat(101), 'ünïcødé-key-1', 12345678901, null, "a'; DROP TABLE orders;--", ['abcdefgh1']].map((k) => [`key=${JSON.stringify(k).slice(0, 30)}`, { body: { ...good, idempotency_key: k } }]),
    ['__proto__ pollution', { rawBody: `{"__proto__":{"status":"executed"},"constructor":{"prototype":{"x":1}},"company_id":${companies[0].id},"side":"sell","quantity":999999,"idempotency_key":"${key()}"}`, headers: { 'content-type': 'application/json' } }],
  ];
  const results = [];
  for (const [name, opts] of bad) results.push([name, await raw('/api/orders', { cookie: u0.cookie, ...opts })]);
  const getPaths = ['/api/orders/abc', '/api/orders/1e400', '/api/orders/-1', '/api/orders/99999999999999999999', '/api/companies/0x1',
    '/api/companies/99999', '/api/paper/..%2f..%2fconfig%2fgame.json', '/api/paper/99', '/api/paper/-1', '/display/',
    '/api/paper/abc', '/shared/../../config/game.json', '/..%2fconfig/game.json', '/%2e%2e/config/game.json', '/config/game.json',
    '/src/schema.sql', '/package.json', '/.env', '/api/admin/events', '/api/admin/overview', '/admin/../config/game.json',
    '/api/market/history?x[]=1&x[]=2', '/api/leaderboard?team_id=2'];
  for (const p of getPaths) results.push([`GET ${p}`, await raw(p, { cookie: u0.cookie })]);
  const cookies = ['mv_team=%E0%A4%A', 'mv_team=' + 'a'.repeat(6000), 'mv_team=', 'mv_team="; mv_team=x', 'mv_admin=' + u0.cookie.split('=')[1],
    `mv_team=${u0.cookie.split('=')[1]}' OR '1'='1`];
  for (const c of cookies) {
    results.push([`cookie ${c.slice(0, 24)} /api/portfolio`, await raw('/api/portfolio', { cookie: c })]);
    results.push([`cookie ${c.slice(0, 24)} /api/admin/overview`, await raw('/api/admin/overview', { cookie: c })]);
  }
  results.push(['PUT /api/orders', await raw('/api/orders', { method: 'PUT', cookie: u0.cookie, body: good })]);
  results.push(['DELETE /api/orders/1', await raw('/api/orders/1', { method: 'DELETE', cookie: u0.cookie, body: {} })]);
  const fiveHundreds = results.filter(([, r]) => r.status >= 500 || r.status === 0);
  check('no 5xx from hostile input', fiveHundreds.length === 0, fiveHundreds.map(([n, r]) => `${n}→${r.status}`).join(', '));
  const leaks = results.filter(([, r]) => r.text && LEAK.test(r.text));
  check('no hidden data in any response', leaks.length === 0, leaks.map(([n]) => n).join(', '));
  const executed = results.filter(([, r]) => r.data && r.data.order && r.data.order.status === 'executed');
  check('no malformed order executed', executed.length === 0, executed.map(([n]) => n).join(', '));
  const adminWithTeam = results.filter(([n, r]) => n.includes('/api/admin') && r.status === 200);
  check('team/forged cookies never reach admin API', adminWithTeam.length === 0, adminWithTeam.map(([n]) => n).join(', '));

  // ---------------------------------------------------------------------------------------
  console.log('\n[3] Idempotency: 15 identical submissions from all five teammates at once');
  {
    const team = teamUsers(3);
    const k = key();
    const before = (await teamState(team[0])).cash;
    const rs = await Promise.all(Array.from({ length: 15 }, (_, i) => order(team[i % team.length], byTicker.CHAI, 'buy', 10, k)));
    const ids = new Set(rs.map((r) => r.data && r.data.order && r.data.order.id));
    check('one order id across 15 submissions', ids.size === 1 && !ids.has(undefined), `ids=${[...ids].join(',')} statuses=${[...new Set(rs.map((r) => r.status))]}`);
    const after = (await teamState(team[0])).cash;
    const px = byTicker.CHAI.price * 10;
    check('cash charged once', before - after === px + Math.ceil(px * 10 / 10000), `${before - after}`);
    const changed = await order(team[0], byTicker.CHAI, 'sell', 999, k);
    check('same key, different payload returns the original order (no new trade)', changed.data.duplicate === true && changed.data.order.quantity === 10);
  }

  // ---------------------------------------------------------------------------------------
  console.log('\n[4] Teammates racing for the same cash');
  {
    const team = teamUsers(4);
    const big = companies.filter((c) => c.is_tradable).slice(0, 4);
    const rs = await Promise.all(team.flatMap((u) => big.map((c) => order(u, c, 'buy', c.max_order_quantity))));
    const ok = rs.filter((r) => r.status === 200);
    const p = await teamState(team[0]);
    const spent = ok.reduce((a, r) => a - r.data.order.cash_delta, 0);
    check('cash never negative', p.cash >= 0, `cash=${p.cash}`);
    check('cash = start − executed costs', p.cash === st0.starting_cash - spent, `${ok.length}/${rs.length} executed`);
    const reasons = new Set(rs.filter((r) => r.status === 422).map((r) => r.data.order.rejection_reason.split(':')[0]));
    check('losers get a clear reason', [...reasons].every((x) => /Insufficient cash|left on the exchange/.test(x)), [...reasons].join(' | '));
  }

  // ---------------------------------------------------------------------------------------
  console.log('\n[5] Teammates racing to sell the same shares');
  {
    const team = teamUsers(5);
    const c = byTicker.RAIL;
    await order(team[0], c, 'buy', 100);
    const rs = await Promise.all(team.flatMap((u) => [order(u, c, 'sell', 100), order(u, c, 'sell', 100)]));
    check('exactly one of 10 concurrent full sells executes', rs.filter((r) => r.status === 200).length === 1,
      `${rs.filter((r) => r.status === 200).length} executed`);
    const h = (await teamState(team[0])).holdings.find((x) => x.ticker === c.ticker);
    check('no negative holding', !h || h.quantity >= 0);
  }

  // ---------------------------------------------------------------------------------------
  console.log(`\n[6] Hot stock: all ${users.length} phones buy the same stock in the same instant`);
  await sleep(3000); // let earlier scenarios' per-team order budgets refill, as real time would
  {
    const c = byTicker.MEME;
    const rs = await Promise.all(users.map((u) => order(u, c, 'buy', 1)));
    const bad6 = rs.filter((r) => r.status !== 200);
    check('all succeed', bad6.length === 0, `${bad6.length} failed: ${[...new Set(bad6.map((r) => `${r.status} ${r.data && (r.data.error || (r.data.order && r.data.order.rejection_reason))}`))].join('; ')}`);
    console.log(`       latency ${lat(rs.map((r) => r.ms))}`);
    notes.push(`Hot-stock burst (${users.length} simultaneous buys of one stock): ${lat(rs.map((r) => r.ms))}`);
  }

  // ---------------------------------------------------------------------------------------
  console.log('\n[7] Sell-out: every team throws a max-size order at one stock');
  {
    const c = byTicker.GENE;
    const inv0 = (await raw('/api/market/prices')).data.find((x) => x.id === c.id);
    const firsts = users.filter((u) => u.idx < TEAMS);
    const rs = await Promise.all(firsts.map((u) => order(u, c, 'buy', c.max_order_quantity)));
    const okQty = rs.filter((r) => r.status === 200).reduce((a, r) => a + r.data.order.quantity, 0);
    await sleep(1100);
    const inv1 = (await raw('/api/market/prices')).data.find((x) => x.id === c.id);
    check('never oversold', okQty <= inv0.exchange_inventory && inv1.exchange_inventory === inv0.exchange_inventory - okQty,
      `start=${inv0.exchange_inventory} sold=${okQty} left=${inv1.exchange_inventory}`);
    const soldOut = rs.filter((r) => r.status === 422 && /left on the exchange/.test(r.data.order.rejection_reason)).length;
    check('late teams told it sold out', soldOut > 0 || inv1.exchange_inventory >= c.max_order_quantity, `${soldOut} sold-out rejections`);
  }

  // ---------------------------------------------------------------------------------------
  console.log('\n[8] One team spams orders; does everyone else slow down?');
  {
    const spammer = teamUsers(6)[0];
    const others = users.filter((u) => u.team !== 6 && u.idx < TEAMS);
    const base = await Promise.all(others.map((u) => order(u, byTicker.DOSA, 'buy', 1)));
    let spamDone = false;
    const spamResults = [];
    const spam = (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 5000) {
        const batch = await Promise.all(Array.from({ length: 40 }, () => order(spammer, pick(companies), 'buy', 1)));
        spamResults.push(...batch);
      }
      spamDone = true;
    })();
    await sleep(500);
    const during = await Promise.all(others.map((u) => order(u, byTicker.DOSA, 'buy', 1)));
    await spam;
    const s429 = spamResults.filter((r) => r.status === 429).length;
    console.log(`       others baseline ${lat(base.map((r) => r.ms))}`);
    console.log(`       others during   ${lat(during.map((r) => r.ms))}`);
    console.log(`       spammer sent ${spamResults.length} in 5s, ${s429} throttled (429)`);
    check('others unaffected by spam (p95 < 1s)', pctl(during.map((r) => r.ms), 0.95) < 1000 && during.every((r) => r.status === 200));
    check('spammer is throttled', s429 > spamResults.length / 2, `${s429}/${spamResults.length}`);
    notes.push(`Order spam: one session sent ${spamResults.length} orders in 5s (${s429} throttled); others p95 ${pctl(during.map((r) => r.ms), 0.95).toFixed(0)}ms`);
    void spamDone;
  }

  // ---------------------------------------------------------------------------------------
  console.log('\n[9] Polling storm: 1,000 simultaneous reads (every player refreshing at once)');
  {
    const paths = ['/api/market/status', '/api/portfolio', '/api/market/prices', '/api/companies', '/api/transactions'];
    const rs = await Promise.all(Array.from({ length: 1000 }, (_, i) => raw(paths[i % paths.length], { cookie: users[i % users.length].cookie })));
    const ps = await Promise.all(users.map((u) => raw('/api/portfolio', { cookie: u.cookie })));
    check('all reads succeed', rs.every((r) => r.status === 200) && ps.every((r) => r.status === 200));
    console.log(`       reads ${lat(rs.map((r) => r.ms))}`);
    console.log(`       portfolio ${lat(ps.map((r) => r.ms))}`);
    notes.push(`1,000 concurrent reads: ${lat(rs.map((r) => r.ms))}; ${users.length} portfolios: ${lat(ps.map((r) => r.ms))}`);
  }

  // ---------------------------------------------------------------------------------------
  console.log('\n[10] Sessions and passwords');
  {
    const r1 = await raw('/api/portfolio', { cookie: ADMIN.replace('mv_admin', 'mv_team') });
    check('admin token is not a team session', r1.status === 401);
    const lo = await raw('/api/auth/login', { body: { team_id: 'team09', password: 'pw-team09' } });
    const c = cookieOf(lo);
    await raw('/api/auth/logout', { cookie: c, body: {} });
    check('logged-out cookie is dead', (await raw('/api/portfolio', { cookie: c })).status === 401);

    // Password reset while a teammate is mid-trade.
    const team = teamUsers(10);
    const flood = Promise.all(team.map(async (u) => { const out = []; for (let i = 0; i < 10; i++) out.push(await order(u, byTicker.BIMA, 'buy', 1)); return out; }));
    await sleep(50);
    const t10 = (await admin('teams')).find((t) => t.access_identifier === 'team10');
    const { password } = await admin(`teams/${t10.team_id}/reset-password`, { reason: 'stress' });
    const fl = (await flood).flat();
    check('reset mid-trade: only 200/422/401/429, no 5xx', fl.every((r) => [200, 401, 422, 429].includes(r.status)), [...new Set(fl.map((r) => r.status))].join(','));
    check('old sessions revoked after reset', (await raw('/api/portfolio', { cookie: team[0].cookie })).status === 401);
    for (const u of team) u.cookie = cookieOf(await raw('/api/auth/login', { body: { team_id: 'team10', password } }));
    check('new password works', (await raw('/api/portfolio', { cookie: team[0].cookie })).status === 200);

    // A rival tries to lock a team out by spamming wrong passwords.
    const victim = teamUsers(11);
    for (let i = 0; i < 12; i++) await raw('/api/auth/login', { body: { team_id: 'team11', password: 'wrong' + i } });
    const real = await raw('/api/auth/login', { body: { team_id: 'team11', password: 'pw-team11' } });
    check('existing team11 sessions keep working during the attack', (await raw('/api/portfolio', { cookie: victim[0].cookie })).status === 200);
    check('team11 can still log in with the right password after a rival spams wrong ones', real.status === 200, `status ${real.status}`);
    const storm = [];
    for (let i = 0; i < 25; i++) storm.push(await raw('/api/auth/login', { body: { team_id: 'team12', password: 'wrong' + i } }));
    check('a sustained attack (25 rapid wrong passwords) triggers a short cool-down', storm.some((r) => r.status === 429), storm.find((r) => r.status === 429)?.data?.error);
    let reported = false;
    for (let i = 0; i < 10 && !reported; i++) {
      reported = (await admin('system-log')).some((l) => /team:team12/.test(l.message));
      if (!reported) await sleep(300);
    }
    check('the attack is reported to organisers', reported);
    const unknown = await Promise.all(Array.from({ length: 50 }, (_, i) => raw('/api/auth/login', { body: { team_id: `nobody${i}`, password: 'x' } })));
    check('unknown-ID logins are cheap 401s', unknown.every((r) => r.status === 401), lat(unknown.map((r) => r.ms)));
  }

  // ---------------------------------------------------------------------------------------
  console.log('\n[11] Margin Bank races');
  {
    const team = teamUsers(12);
    await order(team[0], byTicker.CMNT, 'buy', byTicker.CMNT.max_order_quantity);
    const s = (await raw('/api/loans', { cookie: team[0].cookie })).data;
    const k = key();
    const amt = Math.floor((byTicker.CMNT.price * byTicker.CMNT.max_order_quantity) / 4);
    const body = { amount: amt, collateral: [{ company_id: byTicker.CMNT.id, quantity: byTicker.CMNT.max_order_quantity }], request_key: k };
    const rs = await Promise.all(team.map((u) => raw('/api/loans', { cookie: u.cookie, body })));
    const ids = new Set(rs.filter((r) => r.status === 200).map((r) => (r.data.loan || r.data).id));
    check('5 teammates submitting one loan request → one loan', ids.size === 1, `statuses ${rs.map((r) => r.status)} ids ${[...ids]}`);
    const rs2 = await Promise.all(team.map((u) => raw('/api/loans', { cookie: u.cookie, body: { ...body, request_key: key() } })));
    check('pledged shares cannot be pledged twice', rs2.every((r) => r.status !== 200 && r.status < 500), `${rs2.map((r) => r.status)}`);
    const sell = await order(team[1], byTicker.CMNT, 'sell', 1);
    check('pledged shares cannot be sold', sell.status === 422);
    const loanId = [...ids][0];
    const rp = await Promise.all(team.map((u) => raw(`/api/loans/${loanId}/repay`, { cookie: u.cookie, body: {} })));
    check('5 concurrent repays → repaid once, no 5xx', rp.filter((r) => r.status === 200).length >= 1 && rp.every((r) => r.status < 500), `${rp.map((r) => r.status)}`);
    void s;
  }
  await integrity('round 1 scenarios');

  // ---------------------------------------------------------------------------------------
  console.log('\n[12] Admin double/triple clicks while orders are flowing');
  {
    let stop = false;
    const flow = Promise.all(users.slice(0, 100).map(async (u) => {
      const out = [];
      while (!stop) { out.push(await order(u, pick(companies), Math.random() < 0.7 ? 'buy' : 'sell', 1 + Math.floor(Math.random() * 20))); await sleep(50); }
      return out;
    }));
    await sleep(1000);
    const closes = await Promise.all([1, 2, 3].map(() => raw('/api/admin/rounds/1/close', { cookie: ADMIN, body: {} })));
    await sleep(500);
    stop = true;
    const fl = (await flow).flat();
    check('3 concurrent closes all return 200', closes.every((r) => r.status === 200), closes.map((r) => r.status).join(','));
    const r1 = (await admin('overview')).rounds.find((r) => r.id === 1);
    const late = (await admin('orders?round=1&status=executed&limit=20000')).filter((o) => new Date(o.executed_at) > new Date(r1.closed_at));
    check('no order executed after the close', late.length === 0, `${late.length} late`);
    check('orders during close: only 200/422/429', fl.every((r) => [200, 422, 429].includes(r.status)), [...new Set(fl.map((r) => r.status))].join(','));
    const news = await Promise.all([1, 2].map(() => raw('/api/admin/rounds/1/publish-news', { cookie: ADMIN, body: {} })));
    check('double publish-news', news.every((r) => r.status === 200 || r.status === 409));
    const prev = await admin('rounds/1/preview');
    const applies = await Promise.all([1, 2, 3].map(() => raw('/api/admin/rounds/1/apply-market-update', { cookie: ADMIN, body: {} })));
    check('triple apply → exactly one real update', applies.filter((r) => r.status === 200 && !r.data.alreadyApplied).length === 1, applies.map((r) => `${r.status}${r.data && r.data.alreadyApplied ? '(dup)' : ''}`).join(','));
    const board = (await raw('/api/market/prices')).data;
    const mism = prev.rows ? prev.rows.filter((p) => board.find((b) => b.ticker === p.ticker).price !== p.price) : [];
    check('applied prices = previewed prices', mism.length === 0, mism.map((m) => m.ticker).join(','));
    const opens = await Promise.all([1, 2, 3].map(() => raw('/api/admin/rounds/2/open', { cookie: ADMIN, body: {} })));
    check('triple open → round opens once, no 5xx', opens.every((r) => r.status === 200 || r.status === 409), opens.map((r) => r.status).join(','));
  }
  await integrity('admin races');

  // ---------------------------------------------------------------------------------------
  console.log('\n[13] Pause mid-flood, resume with extension, orders straddling the real deadline');
  {
    const ov0 = await admin('overview');
    const r2 = ov0.rounds.find((r) => r.id === 2);
    const deadline0 = new Date(r2.trading_deadline);
    let stop = false;
    const flow = Promise.all(users.map(async (u) => {
      const out = [];
      await sleep(Math.random() * 300);
      while (!stop) { out.push(await order(u, pick(companies), 'buy', 1)); await sleep(150 + Math.random() * 200); }
      return out;
    }));
    await sleep(4000);
    await admin('pause', { reason: 'stress' });
    const pausedAt = new Date((await admin('overview')).state.paused_at);
    await sleep(3000);
    await admin('resume', { extend: true });
    const ov1 = await admin('overview');
    const deadline1 = new Date(ov1.rounds.find((r) => r.id === 2).trading_deadline);
    const resumedAt = new Date(pausedAt.getTime() + (deadline1 - deadline0));
    check('deadline extended by the pause length', deadline1 - deadline0 >= 2900 && deadline1 - deadline0 < 4500, `${deadline1 - deadline0}ms`);
    // Run past the real deadline so the server's own timer must close the round.
    while (Date.now() < deadline1.getTime() + 4000) await sleep(250);
    stop = true;
    const fl = (await flow).flat();
    const ex = await admin('orders?round=2&status=executed&limit=20000');
    const inPause = ex.filter((o) => new Date(o.executed_at) >= pausedAt && new Date(o.executed_at) < resumedAt);
    check('nothing executed while paused', inPause.length === 0, `${inPause.length}`);
    const pausedRejects = fl.filter((r) => r.status === 422 && r.data.order && /paused/.test(r.data.order.rejection_reason)).length;
    check('paused orders rejected with "paused" reason', pausedRejects > 0, `${pausedRejects}`);
    const overshoot = Math.max(0, ...ex.map((o) => new Date(o.executed_at) - deadline1));
    check('no execution meaningfully after the deadline (<500ms commit lag)', overshoot < 500, `max overshoot ${overshoot.toFixed(0)}ms`);
    const r2b = (await admin('overview')).rounds.find((r) => r.id === 2);
    check('server auto-closed the round on time', r2b.status === 'closed' && new Date(r2b.closed_at) - deadline1 < 2500, `closed ${new Date(r2b.closed_at) - deadline1}ms after deadline`);
    check('flood saw only 200/422/429', fl.every((r) => [200, 422, 429].includes(r.status)), [...new Set(fl.map((r) => r.status))].join(','));
    console.log(`       ${fl.length} orders, ${ex.length} executed`);
    await admin('rounds/2/apply-market-update', {});
  }
  await integrity('pause/deadline');

  // ---------------------------------------------------------------------------------------
  console.log('\n[14] Company suspended mid-flood');
  {
    await admin('rounds/3/open');
    await admin('rounds/3/extend', { seconds: 600, reason: 'stress' });
    const c = byTicker.JETL;
    let stop = false;
    const flow = Promise.all(users.slice(0, 100).map(async (u) => { const out = []; while (!stop) { out.push(await order(u, c, 'buy', 1)); await sleep(80); } return out; }));
    await sleep(1000);
    await admin(`companies/${c.id}/trading`, { tradable: false, reason: 'stress: circuit breaker' });
    const suspendedAt = Date.now();
    await sleep(1500);
    stop = true;
    const fl = (await flow).flat();
    const after = fl.filter((r) => r.status === 200 && new Date(r.data.order.executed_at).getTime() > suspendedAt + 200);
    check('no fills after suspension', after.length === 0, `${after.length}`);
    const said = fl.some((r) => r.status === 422 && /suspended: stress: circuit breaker/.test(r.data.order.rejection_reason));
    check('teams see the suspension reason', said);
    await admin(`companies/${c.id}/trading`, { tradable: true, reason: 'stress' });
    await admin('rounds/3/close', {});
    await admin('rounds/3/apply-market-update', {});
  }
  await integrity('suspension');

  // ---------------------------------------------------------------------------------------
  console.log('\n[15] Organiser corrections while the hall is trading');
  {
    await admin('rounds/4/open');
    await admin('rounds/4/extend', { seconds: 600, reason: 'stress' });
    let stop = false;
    const flow = Promise.all(users.slice(0, 150).map(async (u) => {
      const out = [];
      while (!stop) { out.push(await order(u, pick(companies), Math.random() < 0.6 ? 'buy' : 'sell', 1 + Math.floor(Math.random() * 30))); await sleep(100); }
      return out;
    }));
    await sleep(1500);
    const ex = (await admin('orders?round=4&status=executed&limit=20000')).slice(0, 40);
    const target = ex[0];
    const dbl = await Promise.all([1, 2, 3].map(() => raw(`/api/admin/orders/${target.id}/reverse`, { cookie: ADMIN, body: { reason: 'stress: triple click' } })));
    check('triple-clicked Reverse → reversed once', dbl.filter((r) => r.status === 200).length === 1 && dbl.every((r) => [200, 409].includes(r.status)), dbl.map((r) => r.status).join(','));
    const revs = await Promise.all(ex.slice(1).map((o) => raw(`/api/admin/orders/${o.id}/reverse`, { cookie: ADMIN, body: { reason: 'stress: correction under load' } })));
    const refused = revs.filter((r) => r.status === 409);
    check('reversals under load: 200, or 409 with a reason (shares/cash already used)', revs.every((r) => r.status === 200 || (r.status === 409 && /unpledged|undoing this sale|left on the exchange/.test(r.data.error))),
      `${revs.filter((r) => r.status === 200).length} reversed, ${refused.length} refused: ${[...new Set(revs.filter((r) => r.status !== 200).map((r) => `${r.status} ${r.data && r.data.error}`.slice(0, 60)))].join(' | ')}`);
    const nobody = await raw(`/api/admin/orders/${ex[2].id}/reverse`, { cookie: users[0].cookie, body: { reason: 'refund myself' } });
    check('a team cannot reverse its own trade', nobody.status === 401);
    await sleep(500);
    await admin('rounds/4/close');
    await sleep(300);
    const reopen = await Promise.all([1, 2].map(() => raw('/api/admin/rounds/4/reopen', { cookie: ADMIN, body: { seconds: 2, reason: 'stress: closed by mistake' } })));
    check('double-clicked Reopen → open, no 5xx', reopen.every((r) => r.status === 200), reopen.map((r) => r.status).join(','));
    await sleep(2600);
    stop = true;
    const fl = (await flow).flat();
    check('flood during corrections saw only 200/422/429', fl.every((r) => [200, 422, 429].includes(r.status)), [...new Set(fl.map((r) => r.status))].join(','));
    let r4 = (await admin('overview')).rounds.find((r) => r.id === 4);
    for (let i = 0; i < 10 && r4.status !== 'closed'; i++) { await sleep(300); r4 = (await admin('overview')).rounds.find((r) => r.id === 4); }
    check('reopened round closed itself at the new deadline', r4.status === 'closed', r4.status);
    await integrity('reversals under load');

    const prev1 = await admin('rounds/4/preview');
    await admin('rounds/4/apply-market-update');
    const undo = await Promise.all([1, 2].map(() => raw('/api/admin/rounds/4/undo-market-update', { cookie: ADMIN, body: { reason: 'stress: wrong script value' } })));
    check('double-clicked Undo → undone once', undo.filter((r) => r.status === 200).length === 1 && undo.every((r) => [200, 409].includes(r.status)), undo.map((r) => r.status).join(','));
    const board0 = (await raw('/api/market/prices')).data;
    const back = prev1.rows.every((p) => board0.find((b) => b.ticker === p.ticker).price === p.prev_price);
    check('after undo, teams see the previous prices again', back);
    const ev = (await raw('/api/admin/events', { cookie: ADMIN })).data.events.find((e) => e.effective_round === 4);
    const c0 = companies[0];
    if (ev) {
      const conf = { industries: ev.configuration.industries || {}, companies: { ...(ev.configuration.companies || {}), [c0.ticker]: 1234 } };
      const p = await raw(`/api/admin/events/${encodeURIComponent(ev.id)}`, { method: 'PATCH', cookie: ADMIN, body: { configuration: conf, reason: 'stress: fix typo' } });
      check('script value corrected', p.status === 200, `${p.status}`);
    } else notes.push('No event effective in round 4: skipped the script-edit check');
    const prev2 = await admin('rounds/4/preview');
    await admin('rounds/4/apply-market-update');
    const board1 = (await raw('/api/market/prices')).data;
    check('re-applied prices = corrected preview', prev2.rows.every((p) => board1.find((b) => b.ticker === p.ticker).price === p.price));
    if (ev) check(`${c0.ticker} moved by the corrected +12.34% (plus pressure)`, prev2.rows.find((r) => r.ticker === c0.ticker).fundamental_bps === 1234);
    await integrity('undo and re-apply');
  }

  // ---------------------------------------------------------------------------------------
  console.log('\n[16] New organiser features while 150 phones trade: disable team, story edits, ledger, rewards');
  {
    await admin('rounds/5/open');
    await admin('rounds/5/extend', { seconds: 600, reason: 'stress' });
    const victim = 20;
    const vUsers = teamUsers(victim);
    const others = users.filter((u) => u.team !== victim && u.team !== 9 && u.team !== 12).slice(0, 145);
    let stop = false;
    const flood = (list) => Promise.all(list.map(async (u) => {
      const out = [];
      while (!stop) { out.push(await order(u, pick(companies), Math.random() < 0.7 ? 'buy' : 'sell', 1 + Math.floor(Math.random() * 20))); await sleep(80); }
      return out;
    }));
    const flowOthers = flood(others);
    const flowVictim = flood(vUsers);
    await sleep(1200);

    // Disable (double-clicked) while the team's own five members are mid-flood.
    const dis = await Promise.all([1, 2].map(() => raw(`/api/admin/teams/${victim}/active`, { cookie: ADMIN, body: { active: false, reason: 'stress: disable mid-flood' } })));
    check('double-clicked Disable → 200 twice, no 5xx', dis.every((r) => r.status === 200), dis.map((r) => r.status).join(','));
    const disabledAt = Date.now();
    await sleep(1500);
    const after = await Promise.all(vUsers.map((u) => raw('/api/portfolio', { cookie: u.cookie })));
    check('every device of the disabled team is logged out', after.every((r) => r.status === 401), after.map((r) => r.status).join(','));
    const relogin = await raw('/api/auth/login', { body: { team_id: `team${victim}`, password: `pw-team${victim}` } });
    check('disabled team cannot log in', relogin.status === 401);
    const vOrders = (await admin('orders?round=5&status=executed&limit=20000')).filter((o) => o.team_id === victim);
    const late = vOrders.filter((o) => new Date(o.executed_at).getTime() > disabledAt + 50);
    check('no order of the disabled team executed after the disable', late.length === 0, `${late.length} late of ${vOrders.length}`);
    const frozen = (await raw(`/api/admin/teams/${victim}`, { cookie: ADMIN })).data.portfolio;
    const teams = await admin('teams');
    const vt = teams.find((t) => t.team_id === victim);
    check('disabled team listed for the admin, unranked; ranks of the rest are 1..n', vt && !vt.is_active && vt.rank === null &&
      teams.filter((t) => t.is_active).every((t) => t.rank >= 1 && t.rank <= teams.length - 1));

    // Story edits while trading: valid edits apply, hostile ones are refused cleanly.
    const c0 = (await raw('/api/market/prices')).data.find((c) => c.id === companies[1].id);
    const edits = await Promise.all([1, 2, 3].map((i) => raw(`/api/admin/companies/${c0.id}`, { method: 'PATCH', cookie: ADMIN,
      body: { ceo: `<script>alert(${i})</script> CEO ${i}`, details: { Founded: '1998', Note: 'Ünïcödé ✓ — ₹' }, reason: 'stress: story edit mid-flood' } })));
    check('3 concurrent CEO/details edits during trading → 200', edits.every((r) => r.status === 200), edits.map((r) => r.status).join(','));
    const bad = [
      { details: { a: { nested: true } } }, { details: ['x'] }, { details: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])) },
      { details: { long: 'x'.repeat(501) } }, { details: { n: 5 } }, { details: { ['k'.repeat(41)]: 'v' } }, { details: null },
      { ceo: 'x'.repeat(2001) }, { ceo: 42 }, { name: 'Renamed mid-event' }, { industry: 'Other' }, { initial_price: 1 },
      { float_shares: 1 }, { exchange_inventory: 999999999 }, { max_order_quantity: -5 }, { max_order_quantity: '10' },
    ];
    const badR = await Promise.all(bad.map((b) => raw(`/api/admin/companies/${c0.id}`, { method: 'PATCH', cookie: ADMIN, body: { ...b, reason: 'stress: hostile edit' } })));
    check(`${bad.length} hostile company edits → 400, nothing changed`, badR.every((r) => r.status === 400), badR.map((r) => r.status).join(','));
    const proto = await raw(`/api/admin/companies/${c0.id}`, { method: 'PATCH', cookie: ADMIN, headers: { 'content-type': 'application/json' },
      rawBody: '{"details":{"__proto__":{"polluted":"yes"}},"reason":"stress: proto"}' });
    check('__proto__ inside details → no 5xx, no pollution', proto.status < 500 && ({}).polluted === undefined, `${proto.status}`);
    const board = (await raw('/api/market/prices')).data;
    const cNow = board.find((c) => c.id === c0.id);
    check('teams see the edited CEO verbatim (the app escapes it)', /^<script>alert\(\d\)<\/script> CEO \d$/.test(cNow.ceo) && cNow.details.Note === 'Ünïcödé ✓ — ₹');
    check('story edits never touch the price or inventory', cNow.price === c0.price && cNow.max_order_quantity === c0.max_order_quantity);
    const story = await raw(`/api/admin/companies/${c0.id}`, { method: 'PATCH', cookie: users[0].cookie, body: { ceo: 'hacked', reason: 'team tries' } });
    check('a team cannot edit companies', story.status === 401);

    // Rewards: triple-clicked for one quest → paid once.
    const rw = await Promise.all([1, 2, 3].map(() => raw('/api/admin/rewards', { cookie: ADMIN, body: { team_ids: [3], quest: 'stress quiz', amount: 100000, reason: 'stress: triple reward' } })));
    const paid = rw.flatMap((r) => (r.data || [])).filter((x) => !x.skipped).length;
    check('triple-clicked Reward → paid exactly once', rw.every((r) => r.status === 200) && paid === 1, `${paid} paid; ${rw.map((r) => r.status).join(',')}`);

    // Message: oversized and HTML.
    const msg = await raw('/api/admin/message', { cookie: ADMIN, body: { message: '<img src=x onerror=alert(1)>' + 'm'.repeat(700) } });
    const st = (await raw('/api/market/status')).data;
    check('message capped at 500 characters and kept as text', msg.status === 200 && st.message.length === 500 && st.message.startsWith('<img'));
    await admin('message', { message: '' });

    // Hidden rankings: nothing a team can read exposes another team's standing.
    if (st.leaderboard_visible === false) {
      const lb = await raw('/api/leaderboard', { cookie: users[0].cookie });
      const pf = await raw('/api/portfolio', { cookie: users[0].cookie });
      const tx = await raw('/api/transactions', { cookie: users[0].cookie });
      check('rankings hidden: leaderboard 404, no rank in portfolio or history', lb.status === 404 && !/"rank"/.test(pf.text) && !/"rank"/.test(tx.text));
      const sneaky = await Promise.all(['/api/admin/teams', '/api/admin/summary', '/api/admin/ledger', `/api/admin/teams/${users[0].team}/history`, '/api/leaderboard?final=1']
        .map((p) => raw(p, { cookie: users[0].cookie })));
      check('a team cannot reach rankings through admin endpoints', sneaky.every((r) => [401, 404].includes(r.status)), sneaky.map((r) => r.status).join(','));
    } else notes.push('Rankings are visible to teams in this config: skipped the hidden-rankings checks');

    // Ledger and history: hostile parameters, then the numbers themselves.
    const q = ['type=bogus', 'type=trade_buy%27%20OR%201=1--', 'team=abc', 'team=1;DROP%20TABLE%20teams', 'round=-1', 'round=1e400', 'before=abc',
      'before=99999999999999999999', 'limit=0', 'limit=999999', 'limit=-5', 'team[]=1', 'type[]=adjustment', '%E0%A4%A=1'];
    const lr = await Promise.all(q.map((s) => raw(`/api/admin/ledger?${s}`, { cookie: ADMIN })));
    check(`${q.length} hostile ledger queries → 200 or 400, never 5xx`, lr.every((r) => [200, 400].includes(r.status)), lr.map((r, i) => `${q[i]}:${r.status}`).filter((x) => !/:(200|400)$/.test(x)).join(' '));
    const big = lr[q.indexOf('limit=999999')];
    check('ledger limit is capped at 5000 rows', big.status === 200 && big.data.rows.length <= 5000, `${big.data && big.data.rows.length}`);
    const hr = await Promise.all(['abc', '0', '-1', '1e400', '99999'].map((s) => raw(`/api/admin/teams/${s}/history`, { cookie: ADMIN })));
    check('hostile history ids → 400/404', hr.every((r) => [400, 404].includes(r.status)), hr.map((r) => r.status).join(','));
    const sample = teams.filter((t) => t.team_id !== victim).slice(0, 10);
    // Mid-flood, each ledger response must be self-consistent: entries sum to the newest balance.
    const ledgerOf = async (t) => (await raw(`/api/admin/ledger?team=${t.team_id}&limit=5000`, { cookie: ADMIN })).data.rows;
    const sums = await Promise.all(sample.map(async (t) => {
      const l = await ledgerOf(t);
      return { ok: l.length >= 5000 || l.reduce((s, r) => s + r.amount, 0) === l[0].balance_after, team: t.team_id };
    }));
    check('for 10 teams mid-flood, each ledger read sums to its newest balance', sums.every((s) => s.ok), sums.filter((s) => !s.ok).map((s) => s.team).join(','));

    // Re-enable (double-clicked): the team returns exactly as it was.
    const en = await Promise.all([1, 2].map(() => raw(`/api/admin/teams/${victim}/active`, { cookie: ADMIN, body: { active: true, reason: 'stress: re-enable' } })));
    check('double-clicked Enable → 200 twice', en.every((r) => r.status === 200));
    const back = await raw('/api/auth/login', { body: { team_id: `team${victim}`, password: `pw-team${victim}` } });
    const restored = (await raw('/api/portfolio', { cookie: cookieOf(back) })).data;
    const same = (p) => JSON.stringify([p.cash, p.holdings.map((h) => [h.ticker, h.quantity, h.cost_basis])]);
    check('re-enabled team logs in with cash and holdings exactly as when disabled', back.status === 200 && same(restored) === same(frozen), `cash ${restored.cash} vs ${frozen.cash}`);

    stop = true;
    const fo = (await flowOthers).flat();
    const fv = (await flowVictim).flat();
    check('other teams saw only 200/422/429 throughout', fo.every((r) => [200, 422, 429].includes(r.status)), [...new Set(fo.map((r) => r.status))].join(','));
    check('the disabled team saw only 200/422/429 then 401', fv.every((r) => [200, 401, 422, 429].includes(r.status)), [...new Set(fv.map((r) => r.status))].join(','));
    await admin('rounds/5/close');
    const settledSums = await Promise.all(sample.map(async (t) => {
      const l = await ledgerOf(t);
      const cash = (await raw(`/api/admin/teams/${t.team_id}`, { cookie: ADMIN })).data.portfolio.cash;
      return { ok: l.length >= 5000 || l.reduce((s, r) => s + r.amount, 0) === cash, team: t.team_id };
    }));
    check('after trading stops, ledger entries sum to cash for 10 teams', settledSums.every((s) => s.ok), settledSums.filter((s) => !s.ok).map((s) => s.team).join(','));
    const zero = await Promise.all(['/api/admin/teams/0', '/api/admin/teams/0/history', '/api/admin/teams/-3'].map((p) => raw(p, { cookie: ADMIN })));
    check('team id 0 / negative → 404, never another team\'s data', zero.every((r) => r.status === 404), zero.map((r) => r.status).join(','));
    await admin('rounds/5/apply-market-update');
    const hist = (await raw(`/api/admin/teams/${sample[0].team_id}/history`, { cookie: ADMIN })).data;
    check('history lists start + rounds 1..5', JSON.stringify(hist.rounds.map((r) => r.round_id)) === JSON.stringify([0, 1, 2, 3, 4, 5]), hist.rounds.map((r) => r.round_id).join(','));
    await integrity('new organiser features');
  }

  sampling = false;
  await sampler;
  const health = await raw('/api/health');
  check('server healthy at the end', health.status === 200);
  check('zero 5xx / connection errors across the whole run', serverErrors === 0, `${serverErrors}`);
  console.log(`\nDB pool peak: ${poolPeak.total}/${poolPeak.max} connections, ${poolPeak.waiting} requests waiting for a connection`);
  console.log('\nNotes:\n  ' + notes.join('\n  '));
  console.log(failures.length ? `\nFAIL (${failures.length}):\n  - ${failures.join('\n  - ')}` : '\nPASS');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
