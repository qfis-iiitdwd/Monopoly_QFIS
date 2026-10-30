#!/usr/bin/env node
// Realistic load test: 50 teams × 5 members = 250 sessions doing what phones do at the event —
// polling status, loading portfolio/companies, and submitting orders (including deliberate
// duplicate submissions and a burst right at the deadline). Then it checks the books.
//
// Requires a database seeded with --test-passwords. DESTROYS the game state on that server.
//   node scripts/seed.js --reset --force --test-passwords && npm start   (in another terminal)
//   ADMIN_PASSWORD=... node scripts/loadtest.js [--url http://localhost:3000] [--rounds 2] [--seconds 60]

const crypto = require('crypto');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg('--url', 'http://localhost:3000');
const ROUNDS = Number(arg('--rounds', 2));
const SECONDS = Number(arg('--seconds', 60));
const TEAMS = Number(arg('--teams', 50));
const MEMBERS = Number(arg('--members', 5));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) { console.error('Set ADMIN_PASSWORD'); process.exit(1); }

const stats = new Map();
function record(name, ms, ok) {
  const s = stats.get(name) || { n: 0, errors: 0, times: [] };
  s.n++; if (!ok) s.errors++; s.times.push(ms);
  stats.set(name, s);
}

async function call(name, path, { cookie, body } = {}) {
  const t = performance.now();
  try {
    const res = await fetch(BASE + path, {
      method: body ? 'POST' : 'GET',
      headers: { cookie: cookie || '', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    record(name, performance.now() - t, res.status < 500);
    return { status: res.status, data, res };
  } catch (e) {
    record(name, performance.now() - t, false);
    return { status: 0, error: e.message };
  }
}
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Math.floor(Math.random() * n);

async function admin(path, body = {}) {
  const r = await call('admin', '/api/admin/' + path, { cookie: admin.cookie, body });
  if (r.status !== 200) throw new Error(`admin ${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

async function main() {
  const login = await call('admin login', '/api/admin/login', { body: { username: 'admin', password: ADMIN_PASSWORD } });
  if (login.status !== 200) throw new Error('admin login failed');
  admin.cookie = cookieOf(login.res);
  const st = (await call('status', '/api/market/status')).data;
  if (st.status === 'setup') await admin('event/start');
  const companies = (await call('prices', '/api/market/prices')).data;

  // 250 logins at once, like the start of the event.
  console.log(`Logging in ${TEAMS * MEMBERS} sessions…`);
  const t0 = performance.now();
  const users = await Promise.all(Array.from({ length: TEAMS * MEMBERS }, async (_, i) => {
    const team = String((i % TEAMS) + 1).padStart(2, '0');
    const r = await call('login', '/api/auth/login', { body: { team_id: `team${team}`, password: `pw-team${team}`, member_name: `m${i}` } });
    if (r.status !== 200) throw new Error(`login team${team} failed: ${r.status}`);
    return { cookie: cookieOf(r.res), team };
  }));
  console.log(`  done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  const sentKeys = []; // keys we deliberately sent twice
  for (let round = 0; round < ROUNDS; round++) {
    const status = (await call('status', '/api/market/status')).data;
    const next = status.current_round + 1;
    if (next > status.total_rounds) break;
    await admin(`rounds/${next}/open`);
    // The round's real window is longer; the test closes it manually after SECONDS.
    console.log(`Round ${next} open. Simulating ${SECONDS}s of trading…`);
    const until = Date.now() + SECONDS * 1000;

    await Promise.all(users.map(async (u, idx) => {
      await sleep(rnd(2000));
      let lastPortfolio = 0;
      while (Date.now() < until) {
        await call('status', '/api/market/status', { cookie: u.cookie });
        if (Date.now() - lastPortfolio > 6000) {
          await Promise.all([call('portfolio', '/api/portfolio', { cookie: u.cookie }), call('companies', '/api/companies', { cookie: u.cookie })]);
          lastPortfolio = Date.now();
        }
        if (Math.random() < 0.18) {
          const c = companies[rnd(companies.length)];
          const body = { company_id: c.id, side: Math.random() < 0.7 ? 'buy' : 'sell', quantity: 1 + rnd(1500), idempotency_key: crypto.randomBytes(12).toString('hex') };
          const first = call('order', '/api/orders', { cookie: u.cookie, body });
          if (Math.random() < 0.1) { // double tap / retry with the same key
            const [a, b] = await Promise.all([first, call('order (dup)', '/api/orders', { cookie: u.cookie, body })]);
            sentKeys.push({ key: body.idempotency_key, same: !!(a.data && b.data && a.data.order && b.data.order && a.data.order.id === b.data.order.id) });
          } else await first;
        }
        await sleep(1500 + rnd(1000));
      }
      // Last-second burst from one member of each team.
      if (idx < TEAMS) {
        const c = companies[rnd(companies.length)];
        await call('order (deadline burst)', '/api/orders', { cookie: u.cookie, body: { company_id: c.id, side: 'buy', quantity: 1 + rnd(50), idempotency_key: crypto.randomBytes(12).toString('hex') } });
      }
    }));

    await Promise.all([1, 2, 3].map(() => admin(`rounds/${next}/close`)));
    await admin(`rounds/${next}/publish-news`);
    const applies = await Promise.all([1, 2, 3].map(() => admin(`rounds/${next}/apply-market-update`)));
    console.log(`  applied (${applies.filter((a) => !a.alreadyApplied).length} real apply of 3 concurrent clicks)`);
  }

  // Verify.
  const integrity = await call('admin', '/api/admin/integrity', { cookie: admin.cookie });
  console.log('\nEndpoint                    n     err   p50ms  p95ms  p99ms  max');
  for (const [name, s] of [...stats.entries()].sort()) {
    const t = s.times.sort((a, b) => a - b);
    const q = (p) => t[Math.min(t.length - 1, Math.floor(p * t.length))].toFixed(0);
    console.log(`${name.padEnd(26)} ${String(s.n).padStart(6)} ${String(s.errors).padStart(5)} ${q(0.5).padStart(7)} ${q(0.95).padStart(6)} ${q(0.99).padStart(6)} ${t[t.length - 1].toFixed(0).padStart(6)}`);
  }
  const dupBad = sentKeys.filter((d) => !d.same).length;
  console.log(`\nDuplicate submissions sent: ${sentKeys.length}; resolved to two different orders: ${dupBad}`);
  console.log(`Integrity problems: ${integrity.data.problems.length}`);
  if (integrity.data.problems.length) console.log(JSON.stringify(integrity.data.problems, null, 2));
  const errors = [...stats.values()].reduce((a, s) => a + s.errors, 0);
  console.log(errors || dupBad || integrity.data.problems.length ? '\nFAIL' : '\nPASS: no server errors, books balance.');
  process.exit(errors || dupBad || integrity.data.problems.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
