#!/usr/bin/env node
// "50 laptops at once" test. Each simulated laptop behaves like the participant web app in a browser:
// its own connections (keep-alive, up to 6 in parallel like a browser) and cookies, loads the page and
// its assets, logs in, then polls exactly as public/participant/app.js does (status every 2 s,
// portfolio + companies every 6 s) and trades. Logins are released in the same instant.
//
// DESTROYS game state. Needs a fresh seed with --test-passwords and ≥4 rounds:
//   node scripts/seed.js --reset --force --test-passwords
//   ADMIN_PASSWORD=... node scripts/laptops.js [--url https://your-site] [--laptops 50] [--waves 10] [--soak 60]
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = new URL(arg('--url', 'http://localhost:3000'));
const LAPTOPS = Number(arg('--laptops', 50));
const WAVES = Number(arg('--waves', 10));
const SOAK = Number(arg('--soak', 60));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) { console.error('Set ADMIN_PASSWORD'); process.exit(1); }
const lib = BASE.protocol === 'https:' ? https : http;
const INSECURE = process.argv.includes('--insecure'); // self-signed certificate on a staging server

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => crypto.randomBytes(12).toString('hex');
const pctl = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const lat = (xs) => `n=${xs.length} p50=${pctl(xs, 0.5).toFixed(0)}ms p95=${pctl(xs, 0.95).toFixed(0)}ms max=${Math.max(0, ...xs).toFixed(0)}ms`;
const failures = [];
const notes = [];
let errors5xx = 0;
let netErrors = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// One browser: its own connection pool and cookie jar.
class Laptop {
  constructor(n, team) {
    this.n = n;
    this.team = team;
    this.agent = new lib.Agent({ keepAlive: true, maxSockets: 6, rejectUnauthorized: !INSECURE });
    this.cookies = new Map();
  }
  request(path, { method = 'GET', body, timeout = 30000 } = {}) {
    const t0 = performance.now();
    return new Promise((resolve) => {
      const headers = { 'user-agent': `laptop-${this.n}`, accept: '*/*' };
      if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      let data;
      if (body !== undefined) { data = JSON.stringify(body); headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
      const req = lib.request({ host: BASE.hostname, port: BASE.port, path, method, headers, agent: this.agent, timeout }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          for (const c of [].concat(res.headers['set-cookie'] || [])) {
            const [kv] = c.split(';');
            const i = kv.indexOf('=');
            const v = kv.slice(i + 1);
            if (v) this.cookies.set(kv.slice(0, i), v); else this.cookies.delete(kv.slice(0, i));
          }
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          if ((res.headers['content-type'] || '').includes('json')) { try { json = JSON.parse(text); } catch { /* not JSON */ } }
          if (res.statusCode >= 500) errors5xx++;
          resolve({ status: res.statusCode, json, text: (res.headers['content-type'] || '').includes('html') ? text : undefined, bytes: text.length, ms: performance.now() - t0 });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => { netErrors++; resolve({ status: 0, error: e.message, ms: performance.now() - t0 }); });
      if (data) req.write(data);
      req.end();
    });
  }
  // What the browser fetches when the page is opened or refreshed (HTML, then CSS/JS in parallel).
  async loadPage() {
    const t0 = performance.now();
    const html = await this.request('/');
    // Whatever scripts and stylesheets the real page references (hashed React build or legacy files).
    const refs = [...String(html.text || '').matchAll(/(?:src|href)="(\/(?!\/)[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    const assets = await Promise.all(refs.map((p) => this.request(p)));
    if (!refs.length) assets.push({ status: 0 });
    const me = await this.request('/api/me');
    return { ok: html.status === 200 && assets.every((a) => a.status === 200), loggedIn: me.status === 200, ms: performance.now() - t0, statuses: [html, ...assets, me].map((r) => r.status) };
  }
  // The login form submit: POST login, GET me, then the app's first status + data fetch.
  async login(password = `pw-team${String(this.team).padStart(2, '0')}`) {
    const t0 = performance.now();
    const r = await this.request('/api/auth/login', { method: 'POST', body: { team_id: `team${String(this.team).padStart(2, '0')}`, password, member_name: `Laptop ${this.n}` } });
    if (r.status !== 200) return { ok: false, status: r.status, error: r.json && r.json.error, ms: performance.now() - t0 };
    const me = await this.request('/api/me');
    const [st, p, c] = await Promise.all([this.request('/api/market/status'), this.request('/api/portfolio'), this.request('/api/companies')]);
    const ok = me.status === 200 && st.status === 200 && p.status === 200 && c.status === 200;
    return { ok, status: r.status, loginMs: r.ms, ms: performance.now() - t0, statuses: [me, st, p, c].map((x) => x.status) };
  }
  logout() { return this.request('/api/auth/logout', { method: 'POST', body: {} }); }
  // The app's polling loop, until stop() returns true. Returns per-request latencies.
  async poll(stop, onStatus) {
    const lats = [];
    let last5 = 0;
    let last10 = 0;
    // Same schedule as the player app: status every 2 s, portfolio + companies every 5 s, history every 10 s.
    while (!stop()) {
      const st = await this.request('/api/market/status');
      lats.push(st.ms);
      if (st.json && onStatus) onStatus(st.json);
      if (Date.now() - last5 > 5000) {
        last5 = Date.now();
        const rs = await Promise.all([this.request('/api/portfolio'), this.request('/api/companies')]);
        lats.push(...rs.map((r) => r.ms));
      }
      if (Date.now() - last10 > 10000) {
        last10 = Date.now();
        lats.push((await this.request('/api/transactions')).ms);
      }
      await sleep(2000);
    }
    return lats;
  }
  close() { this.agent.destroy(); }
}

// Releases every laptop in the same instant.
async function together(laptops, fn) {
  let go;
  const gate = new Promise((r) => (go = r));
  const runs = laptops.map(async (l) => { await gate; return fn(l); });
  await sleep(50);
  go();
  return Promise.all(runs);
}

async function main() {
  const adminLaptop = new Laptop(0, 0);
  const admin = async (path, body) => {
    const r = await adminLaptop.request('/api/admin/' + path, body === undefined ? {} : { method: 'POST', body });
    if (r.status !== 200) throw new Error(`admin ${path}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const al = await adminLaptop.request('/api/admin/login', { method: 'POST', body: { username: 'admin', password: ADMIN_PASSWORD } });
  if (al.status !== 200) throw new Error('admin login failed');
  let ov = await admin('overview');
  if (ov.state.status !== 'setup') throw new Error('Needs a freshly seeded game (status=setup).');
  const teams = ov.counts.teams;
  await admin('event/start', {});
  console.log(`${BASE.origin}: ${teams} teams; simulating ${LAPTOPS} laptops`);
  const mk = (n, perTeam = 1) => Array.from({ length: n }, (_, i) => new Laptop(i + 1, (Math.floor(i / perTeam) % teams) + 1));

  // ---------------------------------------------------------------------------------------
  console.log(`\n[1] ${WAVES} waves: ${LAPTOPS} laptops open the page and log in at the same instant, then all log out`);
  {
    const all = [];
    const pages = [];
    for (let w = 1; w <= WAVES; w++) {
      const laptops = mk(LAPTOPS);
      const res = await together(laptops, async (l) => { const p = await l.loadPage(); pages.push(p.ms); return l.login(); });
      all.push(...res);
      if (w === 1) {
        // The first wave is the real event start (and the case after a server restart): no password
        // has been verified yet, so every login pays the full password check.
        check('first (cold) wave: login + first screen p95 under 3 s', pctl(res.map((r) => r.ms), 0.95) < 3000, lat(res.map((r) => r.ms)));
        notes.push(`Cold wave (first login of ${LAPTOPS} laptops, nothing cached): ${lat(res.map((r) => r.ms))}`);
      }
      const bad = res.filter((r) => !r.ok);
      if (bad.length) console.log(`       wave ${w}: ${bad.length} failed: ${[...new Set(bad.map((b) => `${b.status} ${b.error || b.statuses}`))].join('; ')}`);
      await together(laptops, (l) => l.logout());
      laptops.forEach((l) => l.close());
    }
    check(`all ${all.length} logins succeed and the app's first screen loads`, all.every((r) => r.ok), `${all.filter((r) => !r.ok).length} failed`);
    check('login + first screen p95 under 3 s', pctl(all.map((r) => r.ms), 0.95) < 3000, `login ${lat(all.map((r) => r.loginMs))}; login→dashboard ${lat(all.map((r) => r.ms))}`);
    notes.push(`${LAPTOPS} simultaneous laptop logins ×${WAVES}: password check ${lat(all.map((r) => r.loginMs))}, to dashboard ${lat(all.map((r) => r.ms))}, page load ${lat(pages)}`);
  }

  // ---------------------------------------------------------------------------------------
  console.log(`\n[2] Every team on 3 laptops at once (${teams * 3} logins in the same instant)`);
  let laptops;
  {
    laptops = mk(teams * 3, 3);
    const res = await together(laptops, (l) => l.login());
    check(`all ${res.length} logins succeed`, res.every((r) => r.ok), `${res.filter((r) => !r.ok).length} failed; ${lat(res.map((r) => r.ms))}`);
    notes.push(`${teams * 3} simultaneous logins (3 laptops per team): ${lat(res.map((r) => r.ms))}`);
    const me = await Promise.all(laptops.map((l) => l.request('/api/me')));
    check('every laptop sees its own team (no crossed sessions)', me.every((r, i) => r.json && r.json.team.access_identifier === `team${String(laptops[i].team).padStart(2, '0')}`));
  }

  // ---------------------------------------------------------------------------------------
  console.log('\n[3] Typos: a third of the laptops first enter a wrong password, then the right one');
  {
    const fresh = mk(LAPTOPS);
    const res = await together(fresh, async (l) => {
      if (l.n % 3 === 0) {
        const bad = await l.login('wrong-password');
        if (bad.ok || bad.status !== 401) return { ok: false, why: `wrong password gave ${bad.status}` };
      }
      return l.login();
    });
    check('wrong password → 401, then the right one works, for everyone', res.every((r) => r.ok), res.filter((r) => !r.ok).map((r) => r.why || r.status).join(','));
    const odd = await together(mk(10), (l) => l.request('/api/auth/login', { method: 'POST', body: { team_id: ` TEAM${String(l.team).padStart(2, '0')} `, password: `pw-team${String(l.team).padStart(2, '0')}` } }));
    check('Team ID with capitals/spaces still logs in', odd.every((r) => r.status === 200), odd.map((r) => r.status).join(','));
    fresh.forEach((l) => l.close());
  }

  // ---------------------------------------------------------------------------------------
  console.log('\n[4] Wi-Fi drops mid-login: requests cut off, then retried');
  {
    const flaky = mk(LAPTOPS);
    const res = await together(flaky, async (l) => {
      await l.request('/api/auth/login', { method: 'POST', timeout: 5, body: { team_id: `team${String(l.team).padStart(2, '0')}`, password: `pw-team${String(l.team).padStart(2, '0')}` } });
      await sleep(200);
      return l.login();
    });
    check('every laptop gets in on the retry', res.every((r) => r.ok), `${res.filter((r) => !r.ok).length} failed`);
    flaky.forEach((l) => l.close());
    netErrors = 0; // the deliberate cut-offs above are counted as network errors; reset
  }

  // ---------------------------------------------------------------------------------------
  console.log(`\n[5] Refresh storm: all ${laptops.length} laptops reload the page at the same instant, 5 times`);
  {
    const loads = [];
    for (let i = 0; i < 5; i++) loads.push(...(await together(laptops, (l) => l.loadPage())));
    check('every reload works and stays logged in', loads.every((p) => p.ok && p.loggedIn), `${loads.filter((p) => !(p.ok && p.loggedIn)).length} bad`);
    notes.push(`Refresh storm (${laptops.length} laptops ×5): page + session check ${lat(loads.map((p) => p.ms))}`);
  }

  // ---------------------------------------------------------------------------------------
  console.log('\n[6] Round opens while every laptop is polling: how fast does every screen see it?');
  const companies = (await laptops[0].request('/api/companies')).json;
  {
    let stop = false;
    const seen = new Map();
    const polling = laptops.map((l) => l.poll(() => stop, (st) => { if (st.phase === 'trading' && !seen.has(l.n)) seen.set(l.n, Date.now()); }));
    await sleep(2500);
    const opened = Date.now();
    await admin('rounds/1/open', {});
    await admin('rounds/1/extend', { seconds: 900, reason: 'laptop test' });
    for (let i = 0; i < 40 && seen.size < laptops.length; i++) await sleep(250);
    const delays = [...seen.values()].map((t) => t - opened);
    check('every laptop shows "trading open" within 3 s', seen.size === laptops.length && Math.max(...delays) < 3000, `${seen.size}/${laptops.length}; ${lat(delays)}`);

    // -------------------------------------------------------------------------------------
    console.log(`\n[7] Trading while ${LAPTOPS} more laptops log in at the same instant`);
    let tradeStop = false;
    const tradeLat = [];
    const statuses = new Map();
    const traders = laptops.map(async (l) => {
      while (!tradeStop) {
        const c = companies[Math.floor(Math.random() * companies.length)];
        const r = await l.request('/api/orders', { method: 'POST', body: { company_id: c.id, side: Math.random() < 0.7 ? 'buy' : 'sell', quantity: 1 + Math.floor(Math.random() * 20), idempotency_key: key() } });
        tradeLat.push(r.ms);
        statuses.set(r.status, (statuses.get(r.status) || 0) + 1);
        await sleep(400 + Math.random() * 800);
      }
    });
    await sleep(3000);
    const before = tradeLat.length;
    const late = mk(LAPTOPS);
    const res = await together(late, async (l) => { await l.loadPage(); return l.login(); });
    const during = tradeLat.slice(before);
    await sleep(3000);
    tradeStop = true;
    await Promise.all(traders);
    check(`all ${LAPTOPS} late logins succeed during trading`, res.every((r) => r.ok), lat(res.map((r) => r.ms)));
    check('orders during the login burst stay fast (p95 < 1.5 s)', pctl(during, 0.95) < 1500, `orders ${lat(during)}`);
    check('orders only ever 200/422/429', [...statuses.keys()].every((s) => [200, 422, 429].includes(s)), JSON.stringify(Object.fromEntries(statuses)));
    notes.push(`Orders while ${LAPTOPS} laptops logged in at once: ${lat(during)}`);
    late.forEach((l) => l.close());

    // -------------------------------------------------------------------------------------
    console.log(`\n[8] Soak: ${laptops.length} laptops poll and trade like the real app for ${SOAK} s, then the round closes under them`);
    const soakLat = [];
    const soakStatus = new Map();
    let soakStop = false;
    const soakTraders = laptops.map(async (l) => {
      while (!soakStop) {
        const c = companies[Math.floor(Math.random() * companies.length)];
        const r = await l.request('/api/orders', { method: 'POST', body: { company_id: c.id, side: Math.random() < 0.6 ? 'buy' : 'sell', quantity: 1 + Math.floor(Math.random() * 10), idempotency_key: key() } });
        soakLat.push(r.ms);
        soakStatus.set(r.status, (soakStatus.get(r.status) || 0) + 1);
        await sleep(3000 + Math.random() * 6000);
      }
    });
    await sleep(SOAK * 1000);
    await admin('rounds/1/close', {});
    const closedAt = Date.now();
    await sleep(2500);
    soakStop = true;
    await Promise.all(soakTraders);
    stop = true;
    const pollLat = (await Promise.all(polling)).flat();
    check('polling stays fast for the whole soak (p95 < 1 s)', pctl(pollLat, 0.95) < 1000, `${lat(pollLat)}`);
    check('soak orders only 200/422/429', [...soakStatus.keys()].every((s) => [200, 422, 429].includes(s)), JSON.stringify(Object.fromEntries(soakStatus)));
    const ex = (await admin('orders?round=1&status=executed&limit=20000')).filter((o) => new Date(o.executed_at).getTime() > closedAt + 1000);
    check('nothing executes after the round closes', ex.length === 0, `${ex.length}`);
    notes.push(`Soak polling (${laptops.length} laptops, ${SOAK}s): ${lat(pollLat)}; soak orders ${lat(soakLat)}`);
    await admin('rounds/1/apply-market-update', {});
  }

  // ---------------------------------------------------------------------------------------
  console.log('\n[9] Everyone logs out at once, then everyone logs back in at once');
  {
    const outs = await together(laptops, (l) => l.logout());
    check('all logouts succeed', outs.every((r) => r.status === 200), [...new Set(outs.map((r) => r.status))].join(','));
    const me = await Promise.all(laptops.map((l) => l.request('/api/me')));
    check('logged-out laptops are really logged out', me.every((r) => r.status === 401));
    const ins = await together(laptops, (l) => l.login());
    check('all log back in', ins.every((r) => r.ok), lat(ins.map((r) => r.ms)));
  }

  const integ = await admin('integrity');
  check('books balance (integrity check)', integ.problems.length === 0, JSON.stringify(integ.problems).slice(0, 300));
  const health = await adminLaptop.request('/api/health');
  check('server healthy at the end', health.status === 200);
  check('zero 5xx and zero connection errors', errors5xx === 0 && netErrors === 0, `5xx=${errors5xx} net=${netErrors}`);
  ov = await admin('overview');
  console.log(`\nSessions now: ${ov.counts.sessions}; DB pool ${ov.pool.total}/${ov.pool.max}`);
  console.log('\nNotes:\n  ' + notes.join('\n  '));
  console.log(failures.length ? `\nFAIL (${failures.length}):\n  - ${failures.join('\n  - ')}` : '\nPASS');
  laptops.forEach((l) => l.close());
  adminLaptop.close();
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
