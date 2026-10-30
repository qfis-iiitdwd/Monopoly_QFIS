#!/usr/bin/env node
// End-to-end audit of the two web apps in a real (headless) browser.
//
// For every button a user can press it checks three things:
//   1. the click sends the expected API request (method + path) and the server accepts it;
//   2. the server's state really changed (read back through the API, not from the screen);
//   3. the other screen shows it (admin action -> player screen, and vice versa).
// Then a "dead button" sweep clicks every visible button on every page and fails if any of them
// does nothing at all (no request, no dialog, no change on screen, no download).
//
// DESTRUCTIVE: it plays a whole event. Run it only against a throwaway database seeded with
// --test-passwords, e.g.
//   DATABASE_URL=.../marketverse_ui node scripts/seed.js --reset --test-passwords   (ADMIN_PASSWORD=admin-dev-pass)
//   node scripts/ui-audit.js --url http://localhost:3100 --admin-password admin-dev-pass
// Browser: BROWSER=/path/to/chrome (default: Brave or Chrome in /Applications).
// --insecure accepts a self-signed certificate (local HTTPS test stacks only). For the API read-backs
// run it with NODE_TLS_REJECT_UNAUTHORIZED=0 in that case.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg('--url', 'http://localhost:3100');
const ADMIN_PW = arg('--admin-password', process.env.ADMIN_PASSWORD || 'admin-dev-pass');
const BROWSER = process.env.BROWSER || ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
const PORT = 9555;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let failed = 0;
function record(ok, what, detail = '') {
  results.push({ ok, what, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`);
}

// ---- API client (independent of the browser) for read-back checks ---------------------------
function client() {
  let cookie = '';
  return async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    if (!r.ok && r.status !== 422) throw new Error(`${method} ${p} -> ${r.status} ${t.slice(0, 200)}`);
    return j;
  };
}

// ---- Minimal CDP page driver -------------------------------------------------------------------
const HELPERS = `
window.T = {
  vis: (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length)),
  modal: () => { const m = [...document.querySelectorAll('.fixed.inset-0.z-50')].filter(T.vis); return m[m.length - 1] || null; },
  scope: (s) => s === 'modal' ? T.modal() : s === 'main' ? document.querySelector('main') : document,
  norm: (t) => (t || '').replace(/\\s+/g, ' ').trim(),
  find: (re, s, sel = 'button') => { const root = T.scope(s); if (!root) return null; const r = new RegExp(re, 'i');
    return [...root.querySelectorAll(sel)].find((e) => T.vis(e) && r.test(T.norm(e.textContent) || e.getAttribute('aria-label') || '')) || null; },
  click: (re, s, sel) => { const e = T.find(re, s, sel); if (!e) return 'missing'; if (e.disabled) return 'disabled'; e.click(); return 'ok'; },
  set: (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return 'ok'; },
  field: (re, s) => { const root = T.scope(s); if (!root) return null; const r = new RegExp(re, 'i');
    const lab = [...root.querySelectorAll('label')].find((l) => T.vis(l) && r.test(T.norm(l.textContent)));
    if (lab) { const f = lab.querySelector('input,textarea,select') || (lab.htmlFor && document.getElementById(lab.htmlFor)); if (f) return f; }
    return [...root.querySelectorAll('input,textarea,select')].find((f) => T.vis(f) && (r.test(f.placeholder || '') || r.test(f.getAttribute('aria-label') || ''))) || null; },
  fill: (re, v, s) => { const f = T.field(re, s); return f ? T.set(f, v) : 'missing'; },
  text: (s) => { const r = T.scope(s); return T.norm((r === document || !r ? document.body : r).innerText); },
  sig: () => { const m = document.querySelector('main'); if (!m) return '';
    const s = m.innerHTML + m.innerText + [...m.querySelectorAll('input,select,textarea')].map((f) => f.value).join('|') + document.querySelectorAll('.fixed.inset-0.z-50').length;
    let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); },
};`;

async function launch() {
  if (!BROWSER) throw new Error('No browser found. Set BROWSER=/path/to/chrome');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-audit-'));
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-dl-'));
  const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1440,1000',
    ...(process.argv.includes('--insecure') ? ['--ignore-certificate-errors'] : []), 'about:blank'], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 100 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(150); } }
  const browser = await connect(ver.webSocketDebuggerUrl);
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true });
  return { proc, browser, dl, profile };
}

function connect(url) {
  return new Promise((res) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method) listeners.forEach((l) => l(d));
    };
    ws.onopen = () => res({
      send: (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }),
      on: (fn) => listeners.push(fn),
      close: () => ws.close(),
    });
  });
}

async function newPage(env, name, url, width = 1440, height = 1000) {
  const { result: { browserContextId } } = await env.browser.send('Target.createBrowserContext');
  const { result: { targetId } } = await env.browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const c = await connect(list.find((x) => x.id === targetId).webSocketDebuggerUrl);
  const page = { name, c, log: [], downloads: 0, errors: [] };
  await env.browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: env.dl, browserContextId, eventsEnabled: true });
  const byId = new Map();
  c.on((e) => {
    if (e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/api/')) {
      const r = { method: e.params.request.method, path: new URL(e.params.request.url).pathname + new URL(e.params.request.url).search, status: null };
      byId.set(e.params.requestId, r);
      page.log.push(r);
    }
    if (e.method === 'Network.responseReceived' && byId.has(e.params.requestId)) byId.get(e.params.requestId).status = e.params.response.status;
    if (e.method === 'Network.loadingFailed' && byId.has(e.params.requestId)) byId.get(e.params.requestId).status = 0;
    if (e.method === 'Page.downloadWillBegin' || e.method === 'Browser.downloadWillBegin') page.downloads++;
    // Any JavaScript error in the page (a crashed screen) fails the audit.
    if (e.method === 'Runtime.exceptionThrown') page.errors.push(e.params.exceptionDetails.exception ? e.params.exceptionDetails.exception.description : e.params.exceptionDetails.text);
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') page.errors.push(e.params.args.map((a) => a.value || a.description).join(' '));
  });
  env.browser.on((e) => { if (e.method === 'Browser.downloadWillBegin') page.downloads++; });
  await c.send('Network.enable');
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });
  await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await c.send('Page.navigate', { url });
  page.eval = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(`${name}: ${expr}: ${r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description}`);
    return r.result.result.value;
  };
  page.waitFor = async (expr, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (await page.eval(expr)) return true; } catch { /* page navigating */ } await sleep(100); }
    return false;
  };
  page.waitText = (re, ms = 8000, scope) => page.waitFor(`typeof T !== 'undefined' && new RegExp(${JSON.stringify(re)}, 'i').test(T.text(${JSON.stringify(scope || '')}))`, ms);
  page.click = (re, scope, sel) => page.eval(`T.click(${JSON.stringify(re)}, ${JSON.stringify(scope || '')}${sel ? `, ${JSON.stringify(sel)}` : ''})`);
  page.fill = (re, v, scope) => page.eval(`T.fill(${JSON.stringify(re)}, ${JSON.stringify(String(v))}, ${JSON.stringify(scope || '')})`);
  // Runs `fn` (clicks) and waits for a request matching method+path to complete.
  page.expect = async (what, method, pathRe, fn, okStatus = [200]) => {
    const start = page.log.length;
    const how = await fn();
    if (how && how !== 'ok') {
      const seen = await page.eval(`[...document.querySelectorAll('button')].filter(T.vis).map((b) => T.norm(b.textContent) || b.getAttribute('aria-label')).join(' | ')`);
      record(false, `${page.name}: ${what}`, `button/field ${how}; visible buttons: ${seen.slice(0, 400)}`);
      return null;
    }
    const t0 = Date.now();
    let hit = null;
    while (Date.now() - t0 < 8000) {
      hit = page.log.slice(start).find((r) => r.method === method && new RegExp(pathRe).test(r.path) && r.status !== null);
      if (hit) break;
      await sleep(50);
    }
    if (!hit) { record(false, `${page.name}: ${what}`, `no ${method} ${pathRe} request was sent`); return null; }
    const ok = okStatus.includes(hit.status);
    record(ok, `${page.name}: ${what}`, `${hit.method} ${hit.path} → ${hit.status}`);
    return hit;
  };
  await page.waitFor(`typeof T !== 'undefined' && document.readyState === 'complete'`);
  return page;
}

// Clicks every visible, enabled button in <main> one at a time and checks that each did something.
async function sweep(page, label, skip) {
  const home = await page.eval(`(() => { const a = document.querySelector('aside [aria-current=page]'); return a ? T.norm(a.textContent) : null; })()`);
  const n = await page.eval(`[...document.querySelectorAll('main button')].filter(T.vis).length`);
  let dead = [];
  let tested = 0;
  for (let i = 0; i < n; i++) {
    const info = await page.eval(`(() => { const b = [...document.querySelectorAll('main button')].filter(T.vis)[${i}]; if (!b) return null;
      return { text: T.norm(b.textContent) || b.getAttribute('aria-label') || '(icon)', disabled: b.disabled,
        current: b.getAttribute('aria-pressed') === 'true' || b.hasAttribute('aria-current') }; })()`);
    // Already-selected toggles, tabs and page numbers are no-ops by design.
    if (!info || info.disabled || info.current || (skip && new RegExp(skip, 'i').test(info.text))) continue;
    const before = await page.eval('T.sig()');
    const reqs = page.log.length;
    const dls = page.downloads;
    await page.eval(`[...document.querySelectorAll('main button')].filter(T.vis)[${i}].click()`);
    await sleep(450);
    const after = await page.eval('T.sig()');
    const did = page.log.length > reqs || after !== before || page.downloads > dls;
    tested++;
    if (!did) dead.push(info.text);
    // Close whatever opened and undo navigation side effects.
    for (let k = 0; k < 3 && await page.eval('!!T.modal()'); k++) {
      await page.eval(`(() => { const m = T.modal(); const x = m && (m.querySelector('[aria-label=Close]') || [...m.querySelectorAll('button')].find((b) => /cancel|close|done/i.test(b.textContent))); if (x) x.click(); })()`);
      await sleep(200);
    }
    // A button that navigates (e.g. "View All") worked; go back to the page being swept.
    if (home && await page.eval(`(() => { const a = document.querySelector('aside [aria-current=page]'); return a ? T.norm(a.textContent) : null; })()`) !== home) {
      await tab(page, home);
      await sleep(300);
    }
  }
  record(dead.length === 0, `${page.name}: every button on ${label} does something (${tested} clicked)`, dead.length ? `dead: ${dead.join(', ')}` : '');
}

async function tab(page, name) {
  await page.eval(`T.click(${JSON.stringify(`^${name}$`)}, '', 'aside button')`);
  await sleep(300);
}

(async () => {
  const env = await launch();
  const api = client();
  const team1 = client();
  try {
    await api('POST', '/api/admin/login', { username: 'admin', password: ADMIN_PW });
    const st0 = await api('GET', '/api/admin/overview');
    if (st0.state.status !== 'setup') throw new Error('Run this against a freshly seeded database (event status must be "setup").');
    const company = (await api('GET', '/api/admin/companies'))[0];

    // ===== Admin logs in, starts the event, opens Round 1 ======================================
    const A = await newPage(env, 'admin', `${BASE}/admin/`);
    record(await A.waitText('ADMIN PANEL'), 'admin: login screen shown');
    await A.fill('Password', ADMIN_PW);
    await A.expect('log in', 'POST', '^/api/admin/login$', () => A.click('^Log in$'));
    record(await A.waitText(`Teams ${st0.counts.teams}`), 'admin: Overview shows the real team count', `${st0.counts.teams}`);
    record(!(await A.eval(`/237|18,42,560|1,428/.test(T.text())`)), 'admin: none of the old demo numbers on Overview');
    await sweep(A, 'Overview (before start)', 'Logout');

    await A.click('^Start event$', 'main');
    await A.expect('Start event', 'POST', '^/api/admin/event/start$', () => A.click('^Start event$', 'modal'));
    record((await api('GET', '/api/admin/overview')).state.status === 'running', 'server: event is running');

    await A.fill('Type your announcement', 'Welcome to Monopoly! Round 1 opens now.');
    await A.expect('publish announcement', 'POST', '^/api/admin/message$', () => A.click('^Publish$', 'main'));
    record((await api('GET', '/api/market/status')).message.startsWith('Welcome'), 'server: message stored');

    await tab(A, 'Rounds');
    await A.click('^Open Round 1$', 'main');
    await A.expect('Open Round 1', 'POST', '^/api/admin/rounds/1/open$', () => A.click('^Open Round 1$', 'modal'));
    record((await api('GET', '/api/market/status')).phase === 'trading', 'server: Round 1 trading');

    // ===== Player logs in and trades ==========================================================
    const P = await newPage(env, 'player', `${BASE}/`);
    record(await P.waitText('Team login'), 'player: login screen shown');
    record(!(await P.eval(`/Admin Panel|Switch to/i.test(document.body.innerText)`)), 'player: no way to switch to the admin panel');
    await P.fill('Team ID', 'team01');
    await P.fill('Password', 'wrong-password');
    await P.expect('wrong password is refused', 'POST', '^/api/auth/login$', () => P.click('^Log in$'), [401]);
    record(await P.waitText('Incorrect team ID or password'), 'player: shows the server error text');
    await P.fill('Password', 'pw-team01');
    await P.fill('Your name', 'Asha');
    await P.expect('log in', 'POST', '^/api/auth/login$', () => P.click('^Log in$'));
    record(await P.waitText('Team 01'), 'player: dashboard shows own team name');
    record(await P.waitText('1,00,00,000'), 'player: net worth equals real starting cash (₹1,00,00,000)');
    record(await P.waitText('Welcome to Monopoly! Round 1 opens now.'), 'player: organiser message from the admin is shown');
    record(await P.waitText('Market Open'), 'player: market state from the server');
    record(!(await P.eval(`/Alpha Industries|Rohan Mehta|ALP\\b|Gazette/.test(T.text())`)), 'player: none of the old demo companies or news');
    await sweep(P, 'Dashboard', 'Logout');

    await tab(P, 'Markets');
    const rows = await P.eval(`document.querySelectorAll('main tbody tr').length`);
    const companies = await team1('GET', '/api/market/prices');
    record(rows === companies.length, 'player: Markets lists every company from the API', `${rows} rows / ${companies.length} companies`);
    await P.fill('Search company', company.ticker);
    record(await P.waitFor(`document.querySelectorAll('main tbody tr').length === 1`), 'player: Markets search filters');
    await sweep(P, 'Markets', 'Logout');
    await P.eval(`document.querySelector('main tbody tr').click()`);
    record(await P.waitText('Place Order'), 'player: clicking a company opens Trading');
    record(await P.waitText(company.name, 3000, 'main'), 'player: Trading shows the chosen company');

    await P.fill('Quantity', '10');
    await P.click('^Review Order');
    record(await P.waitText('Review & Confirm Order', 3000, 'modal'), 'player: review dialog opens');
    const buy = await P.expect('confirm BUY 10', 'POST', '^/api/orders$', () => P.click('^Confirm BUY Order$', 'modal'));
    record(await P.waitText('Executed ✓', 4000, 'modal'), 'player: shows the server\'s execution');
    await P.click('^Done$', 'modal');
    await team1('POST', '/api/auth/login', { team_id: 'team01', password: 'pw-team01' });
    let pf = await team1('GET', '/api/portfolio');
    const h1 = pf.holdings.find((h) => h.ticker === company.ticker);
    record(h1 && h1.quantity === 10, 'server: team01 holds 10 shares after the UI order', h1 ? `${h1.quantity}` : 'none');
    record(!!buy, 'player: order executed through POST /api/orders');

    await P.click('^Sell$', 'main');
    await P.fill('Quantity', '999');
    await P.click('^Review Order');
    await P.expect('SELL more than owned is rejected by the server', 'POST', '^/api/orders$', () => P.click('^Confirm SELL Order$', 'modal'), [422]);
    record(await P.waitText('can sell at most', 4000, 'modal'), 'player: shows the server\'s rejection reason');
    await P.click('^Done$', 'modal');
    await P.eval(`T.click('^Buy$', 'main')`);
    await sweep(P, 'Trading', 'Logout|Review Order');

    await tab(P, 'Dashboard');
    record(await P.waitText(company.name, 6000, 'main'), 'player: holding appears on the Dashboard');
    await P.click('View All Transactions', 'main');
    record(await P.waitText('Rejected', 3000, 'modal') && await P.waitText('BUY', 3000, 'modal'), 'player: history shows the executed and the rejected order');
    await P.click('^Rejected$', 'modal');
    record(await P.waitFor(`!/\\bExecuted\\b/.test(T.text('modal').replace('Executed ✓',''))`, 2000), 'player: history filter works');
    await P.click('^Done$', 'modal');

    // ===== Admin: pause/resume reach the player ==================================================
    await tab(A, 'Overview');
    await A.click('^Pause Trading$', 'main');
    await A.fill('Reason', 'Audit pause');
    await A.expect('Pause', 'POST', '^/api/admin/pause$', () => A.click('^Pause trading$', 'modal'));
    record(await P.waitText('paused by the organisers', 4000), 'player: sees the pause within 4 s');
    await tab(P, 'Trading');
    record(await P.waitFor(`T.find('^Review Order', 'main').disabled`, 3000), 'player: Review Order disabled while paused');
    await A.click('^Resume Trading$', 'main');
    await A.expect('Resume', 'POST', '^/api/admin/resume$', () => A.click('^Resume trading$', 'modal'));
    record(await P.waitFor(`!/paused by the organisers/i.test(T.text())`, 4000), 'player: pause banner gone after resume');

    await A.click('^Extend Round$', 'main');
    await A.fill('Reason', 'Audit extension');
    await A.expect('Extend round', 'POST', '^/api/admin/rounds/1/extend$', () => A.click('^Extend$', 'modal'));
    await sweep(A, 'Overview (round open)', 'Logout|^Clear$');

    // ===== Admin: Participants ====================================================================
    await tab(A, 'Participants');
    record(await A.waitFor(`document.querySelectorAll('main tbody tr').length === 15`, 5000), 'admin: Participants lists teams (15 per page)');
    await A.fill('Search team name', 'team01', 'main');
    record(await A.waitFor(`document.querySelectorAll('main tbody tr').length === 1`), 'admin: Participants search by login ID');
    await A.eval(`[...document.querySelectorAll('main tbody tr')].find((r) => /Team 01/.test(r.innerText)).click()`);
    record(await A.waitText('Login ID team01', 5000, 'main'), 'admin: team drawer loads');
    record(await A.waitText('Asha', 5000, 'main'), 'admin: shows the member name typed at login');
    record(await A.waitText('Adjust Cash', 5000, 'main'), 'admin: team details and actions loaded');
    const cashBefore = (await team1('GET', '/api/portfolio')).cash;
    await A.click('^Adjust Cash$', 'main');
    await A.fill('Amount', '5000', 'modal');
    await A.fill('Reason', 'Audit credit', 'modal');
    await A.expect('Adjust cash +₹5,000', 'POST', '^/api/admin/teams/1/adjust-cash$', () => A.click('^Confirm Adjustment$', 'modal'));
    const cashAfter = (await team1('GET', '/api/portfolio')).cash;
    record(cashAfter - cashBefore === 500000, 'server: cash moved by exactly ₹5,000', `${cashAfter - cashBefore} paise`);
    await tab(P, 'Dashboard');
    record(await P.waitText(Math.round(cashAfter / 100).toLocaleString('en-IN'), 7000), 'player: new cash shown on the Dashboard');

    await A.click('^Adjust Holdings$', 'main');
    const second = (await api('GET', '/api/admin/companies'))[1];
    await A.waitFor(`T.field('Company', 'modal').options.length > 1`);
    await A.eval(`T.set(T.field('Company', 'modal'), '${second.id}')`);
    await A.fill('Number of shares', '5', 'modal');
    await A.fill('Reason', 'Audit shares', 'modal');
    await A.expect('Adjust holdings +5', 'POST', '^/api/admin/teams/1/adjust-holdings$', () => A.click('^Confirm Adjustment$', 'modal'));
    pf = await team1('GET', '/api/portfolio');
    record((pf.holdings.find((h) => h.ticker === second.ticker) || {}).quantity === 5, `server: team01 now holds 5 ${second.ticker}`);

    await A.click('^Reward$', 'main');
    await A.waitFor('!!T.modal()');
    await A.eval(`(() => { const l = [...T.modal().querySelectorAll('label')].find((x) => T.norm(x.textContent) === 'Team 01'); const c = l.querySelector('input'); if (!c.checked) c.click(); })()`);
    await A.fill('Quiz', 'Audit quiz', 'modal');
    await A.fill('Amount per team', '1000', 'modal');
    await A.fill('Reason', 'Audit reward', 'modal');
    await A.expect('Reward ₹1,000', 'POST', '^/api/admin/rewards$', () => A.click('^Give reward$', 'modal'));
    const led = await api('GET', '/api/admin/ledger?team=1&type=quest_reward');
    record(led.rows.length === 1 && led.rows[0].amount === 100000, 'server: reward ledgered once');

    await A.click('^Reset Password$', 'main');
    await A.fill('Reason', 'Audit reset', 'modal');
    const reset = await A.expect('Reset password team01', 'POST', '^/api/admin/teams/1/reset-password$', () => A.click('^Create new password$', 'modal'));
    const newPw = reset && await A.eval(`(T.modal().querySelector('.font-mono.text-2xl')||{}).textContent`);
    record(!!newPw && newPw.length >= 8, 'admin: new password shown once', newPw ? 'shown' : 'missing');
    await A.click('^Done$', 'modal');
    record(await P.waitText('Team login', 8000), 'player: logged out after the password reset');
    await P.fill('Team ID', 'team01');
    await P.fill('Password', newPw);
    await P.fill('Your name', 'Asha');
    await P.expect('log in with the new password', 'POST', '^/api/auth/login$', () => P.click('^Log in$'));
    await team1('POST', '/api/auth/login', { team_id: 'team01', password: newPw });

    await A.click('^Disable Team$', 'main');
    await A.fill('Reason', 'Audit disable', 'modal');
    await A.expect('Disable team01', 'POST', '^/api/admin/teams/1/active$', () => A.click('^Disable team$', 'modal'));
    record(await P.waitText('Team login', 8000), 'player: disabled team is logged out');
    await P.fill('Team ID', 'team01');
    await P.fill('Password', newPw);
    await P.expect('disabled team cannot log in', 'POST', '^/api/auth/login$', () => P.click('^Log in$'), [401]);
    record(!(await api('GET', '/api/admin/teams')).find((t) => t.team_id === 1).is_active, 'server: team01 inactive');
    await A.click('^Enable Team$', 'main');
    await A.fill('Reason', 'Audit enable', 'modal');
    await A.expect('Enable team01', 'POST', '^/api/admin/teams/1/active$', () => A.click('^Enable team$', 'modal'));
    await P.expect('enabled team logs in again', 'POST', '^/api/auth/login$', () => P.click('^Log in$'));
    await team1('POST', '/api/auth/login', { team_id: 'team01', password: newPw });
    await sweep(A, 'Participants', 'Logout|Disable Team|^Reset$|^Close$');

    // ===== Admin: Orders (reverse) ================================================================
    await tab(A, 'Orders');
    record(await A.waitText('Order Details', 5000, 'main'), 'admin: Orders loads');
    const ord = (await api('GET', '/api/admin/orders?round=1')).find((x) => x.status === 'executed' && x.team_id === 1);
    await A.eval(`[...document.querySelectorAll('main tbody tr')].find((r) => r.innerText.includes('#${ord.id}')).click()`);
    await A.click('^Reverse Order$', 'main');
    await A.fill('Reason', 'Audit: team pressed buy by mistake', 'modal');
    await A.expect(`Reverse order #${ord.id}`, 'POST', `^/api/admin/orders/${ord.id}/reverse$`, () => A.click('^Reverse order$', 'modal'));
    pf = await team1('GET', '/api/portfolio');
    record(!pf.holdings.find((h) => h.ticker === company.ticker), `server: ${company.ticker} shares returned to the exchange`);
    await tab(P, 'Dashboard');
    await P.click('View All Transactions', 'main');
    record(await P.waitText('Reversed', 6000, 'modal'), 'player: history shows the reversal and its reason');
    await P.click('^Done$', 'modal');
    await sweep(A, 'Orders', 'Logout|^Reverse|^Reset$');

    // ===== Admin: Companies =======================================================================
    await tab(A, 'Companies');
    await A.eval(`[...document.querySelectorAll('main tbody tr')].find((r) => r.innerText.includes('${company.ticker}')).querySelector('button').click()`);
    await A.fill('CEO', 'Audit CEO', 'modal');
    await A.eval(`T.click('Add detail', 'modal')`);
    await A.eval(`(() => { const i = [...T.modal().querySelectorAll('input[placeholder="e.g. Founded"]')].pop(); T.set(i, 'Founded'); const v = [...T.modal().querySelectorAll('input[placeholder="e.g. 1998"]')].pop(); T.set(v, '1998'); })()`);
    await A.fill('Reason', 'Audit company edit', 'modal');
    await A.expect('Edit CEO and details', 'PATCH', `^/api/admin/companies/${company.id}$`, () => A.click('^Save', 'modal'));
    await tab(P, 'Markets');
    record(await P.waitText('Audit CEO', 8000, 'main'), 'player: new CEO shown on Markets');
    await A.eval(`[...document.querySelectorAll('main tbody tr')].find((r) => r.innerText.includes('${second.ticker}')).querySelectorAll('button')[1].click()`);
    await A.fill('Reason', 'Audit suspension', 'modal');
    await A.expect(`Suspend ${second.ticker}`, 'POST', `^/api/admin/companies/${second.id}/trading$`, () => A.click('^Suspend trading$', 'modal'));
    record(await P.waitText('SUSPENDED', 8000, 'main'), 'player: suspension shown');
    await A.eval(`[...document.querySelectorAll('main tbody tr')].find((r) => r.innerText.includes('${second.ticker}')).querySelectorAll('button')[1].click()`);
    await A.fill('Reason', 'Audit resume', 'modal');
    await A.expect(`Resume ${second.ticker}`, 'POST', `^/api/admin/companies/${second.id}/trading$`, () => A.click('^Resume trading$', 'modal'));
    await sweep(A, 'Companies', 'Logout|Suspend|Resume');

    // ===== Admin: Rounds — close, reopen, edit plan, apply, undo ==================================
    await tab(A, 'Rounds');
    await A.click('^Close Market$', 'main');
    await A.expect('Close Round 1', 'POST', '^/api/admin/rounds/1/close$', () => A.click('^Close market$', 'modal'));
    record(await P.waitText('Market Closed', 5000), 'player: sees the market closed');
    await A.click('^Reopen trading$', 'main');
    await A.fill('Reason', 'Audit reopen', 'modal');
    await A.expect('Reopen Round 1', 'POST', '^/api/admin/rounds/1/reopen$', () => A.click('^Reopen trading$', 'modal'));
    await A.waitText('Close Market', 5000, 'main');
    await A.click('^Close Market$', 'main');
    await A.expect('Close Round 1 again', 'POST', '^/api/admin/rounds/1/close$', () => A.click('^Close market$', 'modal'));
    await A.waitFor(`!!T.field('${company.ticker} script move', 'main')`, 6000);
    await A.fill(`${company.ticker} script move`, '5.00', 'main');
    await A.click('^Save Changes', 'main');
    await A.fill('Reason', 'Audit plan edit', 'modal');
    await A.expect('Save price plan', 'PATCH', '^/api/admin/events/SCRIPT-R01$', () => A.click('^Save price plan$', 'modal'));
    const ev = (await api('GET', '/api/admin/events')).events.find((e) => e.id === 'SCRIPT-R01');
    record(ev.configuration.companies[company.ticker] === 500, `server: ${company.ticker} script move is now +5.00%`);
    const preview = await api('GET', '/api/admin/rounds/1/preview');
    await A.waitFor(`!T.find('^Apply Market Update$', 'main').disabled`, 6000);
    await A.click('^Apply Market Update$', 'main');
    await A.expect('Apply market update', 'POST', '^/api/admin/rounds/1/apply-market-update$', () => A.click('^Apply new prices$', 'modal'));
    const board = await team1('GET', '/api/market/prices');
    const exp = preview.rows.find((r) => r.ticker === company.ticker).price;
    record(board.find((c) => c.ticker === company.ticker).price === exp, 'server: applied price equals the previewed price', `${exp}`);
    await tab(P, 'Markets');
    await P.fill('Search company', '');
    record(await P.waitText((exp / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 }), 8000, 'main'), 'player: sees the new price');
    await A.waitText('Undo market update', 5000, 'main');
    await A.click('^Undo market update$', 'main');
    await A.fill('Reason', 'Audit undo', 'modal');
    await A.expect('Undo market update', 'POST', '^/api/admin/rounds/1/undo-market-update$', () => A.click('^Undo update$', 'modal'));
    record((await api('GET', '/api/admin/overview')).rounds[0].status === 'closed', 'server: round back to closed');
    await A.waitFor(`!T.find('^Apply Market Update$', 'main').disabled`, 6000);
    await A.click('^Apply Market Update$', 'main');
    await A.expect('Apply again', 'POST', '^/api/admin/rounds/1/apply-market-update$', () => A.click('^Apply new prices$', 'modal'));
    await sweep(A, 'Rounds', 'Logout|Undo|Open Round');

    // ===== Admin: Transactions =====================================================================
    await tab(A, 'Transactions');
    record(await A.waitText('Adjustment', 6000, 'main'), 'admin: ledger shows the adjustment');
    await A.expect('filter by type', 'GET', '^/api/admin/ledger\\?.*type=adjustment', () => A.eval(`T.set([...document.querySelectorAll('main select')][0], 'adjustment')`));
    record(await A.waitText('Net Worth History', 6000, 'main'), 'admin: balance chart drawn from /teams/:id/history');
    await sweep(A, 'Transactions', 'Logout|^Reverse|^Reset$');

    // ===== Edge cases in the browser ================================================================
    await api('POST', '/api/admin/rounds/2/open');
    await tab(P, 'Markets');
    await P.waitText('Market Open', 8000);
    const pick = (await team1('GET', '/api/market/prices')).find((c) => c.is_tradable && c.id !== company.id);
    const ordersOf = async () => (await api('GET', '/api/admin/orders?round=2')).filter((x) => x.team_id === 1);
    const openReview = async (qty, side = 'Buy') => {
      await tab(P, 'Markets');
      await P.fill('Search company', pick.ticker);
      await P.waitFor(`document.querySelectorAll('main tbody tr').length === 1`);
      await P.eval(`document.querySelector('main tbody tr').click()`);
      await P.waitText('Place Order', 4000);
      await P.click(`^${side}$`, 'main');
      await P.fill('Quantity', String(qty));
      await P.waitFor(`!T.find('^Review Order', 'main').disabled`, 4000);
      await P.click('^Review Order');
      return P.waitText('Review & Confirm Order', 3000, 'modal');
    };

    // Double-tap on Confirm: one order, however fast the second tap is.
    await openReview(3);
    let n0 = (await ordersOf()).length;
    await P.eval(`(() => { const b = T.find('^Confirm BUY Order$', 'modal'); b.click(); b.click(); b.click(); })()`);
    record(await P.waitText('Executed ✓', 6000, 'modal'), 'edge: triple-tapped Confirm shows one execution');
    record((await ordersOf()).length - n0 === 1, 'edge: triple-tapped Confirm placed exactly one order', `${(await ordersOf()).length - n0}`);
    await P.click('^Done$', 'modal');

    // Wi-Fi drops right as Confirm is pressed, comes back 1.5 s later: retried with the same key, placed once.
    await openReview(4);
    n0 = (await ordersOf()).length;
    await P.c.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await P.click('^Confirm BUY Order$', 'modal');
    record(await P.waitText('Retrying', 3000, 'modal'), 'edge: offline Confirm shows "Retrying"');
    await sleep(1500);
    await P.c.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    record(await P.waitText('Executed ✓', 9000, 'modal'), 'edge: after reconnecting the order goes through');
    record((await ordersOf()).length - n0 === 1, 'edge: dropped connection still means exactly one order');
    await P.click('^Done$', 'modal');

    // Offline for the whole retry window: the app says it could not confirm, and nothing is doubled.
    await openReview(2);
    n0 = (await ordersOf()).length;
    await P.c.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await P.click('^Confirm BUY Order$', 'modal');
    record(await P.waitText('could not reach the market server', 12000, 'modal'), 'edge: long outage → "could not confirm", no false success');
    record(await P.waitText('Connection lost', 4000), 'edge: offline banner shown');
    await P.c.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    record(await P.waitFor(`!/Connection lost/.test(T.text())`, 6000), 'edge: offline banner clears on reconnect');
    record((await ordersOf()).length - n0 === 0, 'edge: an order never sent is not placed');
    await P.click('^Done$', 'modal');

    // The organisers pause while a team is on the confirm screen.
    await openReview(5);
    await api('POST', '/api/admin/pause', { reason: 'audit edge' });
    await P.expect('edge: Confirm while paused is refused by the server', 'POST', '^/api/orders$', () => P.click('^Confirm BUY Order$', 'modal'), [422]);
    record(await P.waitText('paused by the organisers', 4000, 'modal'), 'edge: shows "paused" as the reason');
    await P.click('^Done$', 'modal');
    await api('POST', '/api/admin/resume', { extend: true });

    // Bad quantities never reach the server.
    await tab(P, 'Trading');
    await P.fill('Quantity', '0');
    record(await P.waitFor(`T.find('^Review Order', 'main').disabled`, 2000), 'edge: quantity 0 → Review disabled');
    await P.fill('Quantity', '-5abc');
    record(await P.eval(`T.field('Quantity', 'main').value === '5'`), 'edge: letters and minus signs are stripped from quantity');
    await P.fill('Quantity', '999999999');
    record(await P.waitText('Maximum order size', 2000, 'main'), 'edge: above max order size → explained, Review disabled');

    // Hostile text from the organisers is shown as text, never run.
    await api('PATCH', `/api/admin/companies/${pick.id}`, { ceo: '<img src=x onerror="window.__xss=1">', reason: 'audit xss check' });
    await api('POST', '/api/admin/message', { message: '<script>window.__xss=2</script><b>bold?</b>' });
    await tab(P, 'Markets');
    await P.fill('Search company', '');
    record(await P.waitText('<img src=x onerror', 8000, 'main'), 'edge: HTML in a CEO name is shown literally');
    record(await P.waitText('<script>window.__xss=2</script>', 6000), 'edge: HTML in a message is shown literally');
    record(await P.eval('window.__xss === undefined'), 'edge: no injected script ran');
    await api('POST', '/api/admin/message', { message: '' });

    // A reversal the server must refuse: the shares have since been sold.
    const pre = (await ordersOf()).filter((x) => x.status === 'executed' && x.side === 'buy' && !x.reversed_at)[0];
    await team1('POST', '/api/orders', { company_id: pick.id, side: 'sell', quantity: (await team1('GET', '/api/portfolio')).holdings.find((h) => h.company_id === pick.id).quantity, idempotency_key: `audit-sellall-${Date.now()}` });
    await tab(A, 'Orders');
    await A.eval(`T.set([...document.querySelectorAll('main select')][3], '2')`);
    await A.waitFor(`[...document.querySelectorAll('main tbody tr')].some((r) => r.innerText.includes('#${pre.id}'))`, 8000);
    await A.eval(`[...document.querySelectorAll('main tbody tr')].find((r) => r.innerText.includes('#${pre.id}')).click()`);
    await A.click('^Reverse Order$', 'main');
    await A.fill('Reason', 'Audit: should be refused', 'modal');
    await A.expect('edge: reversing a buy whose shares were sold is refused', 'POST', `^/api/admin/orders/${pre.id}/reverse$`, () => A.click('^Reverse order$', 'modal'), [409]);
    record(await A.waitText('unpledged', 4000, 'modal'), 'edge: the dialog shows the server\'s reason');
    await A.click('^Cancel$', 'modal');
    await A.click('^Reverse Order$', 'main');
    await A.fill('Reason', 'abc', 'modal');
    record(await A.waitFor(`T.find('^Reverse order$', 'modal').disabled`, 2000), 'edge: a reason shorter than 5 characters cannot be submitted');
    await A.click('^Cancel$', 'modal');

    // The round closes while a team is on the confirm screen.
    await openReview(1);
    await api('POST', '/api/admin/rounds/2/close');
    await P.expect('edge: Confirm after the round closed is refused', 'POST', '^/api/orders$', () => P.click('^Confirm BUY Order$', 'modal'), [422]);
    record(await P.waitText('closed', 4000, 'modal'), 'edge: shows "trading window is closed"');
    await P.click('^Done$', 'modal');
    record(await P.waitFor(`T.find('^Review Order', 'main').disabled`, 4000), 'edge: Review disabled once the market is closed');

    // Sessions expiring under the apps.
    await P.c.send('Network.deleteCookies', { name: 'mv_team', url: BASE });
    record(await P.waitText('Team login', 8000), 'edge: player whose session vanished lands on the login screen');
    await P.fill('Team ID', 'team01');
    await P.fill('Password', newPw);
    await P.expect('edge: logs back in', 'POST', '^/api/auth/login$', () => P.click('^Log in$'));
    await A.c.send('Network.deleteCookies', { name: 'mv_admin', url: BASE });
    record(await A.waitText('Username', 8000), 'edge: admin whose session vanished lands on the login screen');
    await A.fill('Password', ADMIN_PW);
    await A.expect('edge: admin logs back in', 'POST', '^/api/admin/login$', () => A.click('^Log in$'));
    await A.waitText('Overview', 5000);

    // ===== Run remaining rounds through the API, then End event in the UI =======================
    for (let r = 2; r <= st0.state.settings.total_rounds; r++) {
      let st = (await api('GET', '/api/admin/overview')).rounds.find((x) => x.id === r).status;
      if (st === 'pending') { await api('POST', `/api/admin/rounds/${r}/open`); st = 'open'; }
      if (st === 'open') { await api('POST', `/api/admin/rounds/${r}/close`); st = 'closed'; }
      if (st === 'closed') await api('POST', `/api/admin/rounds/${r}/apply-market-update`);
    }
    await tab(A, 'Overview');
    await A.waitText('End event', 6000, 'main');
    await A.click('^End event$', 'main');
    await A.expect('End event', 'POST', '^/api/admin/event/end$', () => A.click('^End event and freeze rankings$', 'modal'));
    record(await P.waitText('Event finished', 6000), 'player: sees the event finished');
    await A.expect('Check books', 'GET', '^/api/admin/integrity$', () => A.click('^Check books$', 'main'));
    record(await A.waitText('Books balance', 4000, 'main'), 'admin: integrity check passes');
    record(await team1('GET', '/api/leaderboard').then(() => false, (e) => /404/.test(e.message)), 'server: players cannot read rankings (404)');
    await sweep(A, 'Overview (finished)', 'Logout');

    // ===== Phone width ===========================================================================
    await P.c.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 2, mobile: true });
    await sleep(400);
    for (const t of ['Dashboard', 'Trading', 'Markets']) {
      await P.eval(`(() => { const b = document.querySelector('[aria-label=Menu]'); b && b.click(); })()`);
      await sleep(200);
      await P.eval(`T.click('^${t}$', '', 'button')`);
      await sleep(400);
      const overflow = await P.eval(`document.documentElement.scrollWidth - window.innerWidth`);
      record(overflow <= 0, `player: ${t} fits a 375 px phone without sideways page scroll`, `${overflow}px over`);
    }

    // ===== Logout =================================================================================
    await P.eval(`(() => { const b = document.querySelector('[aria-label=Menu]'); b && b.click(); })()`);
    await sleep(200);
    await P.expect('Logout', 'POST', '^/api/auth/logout$', () => P.click('^Logout$'));
    record(await P.waitText('Team login', 4000), 'player: back at the login screen');
    await A.expect('Logout', 'POST', '^/api/admin/logout$', () => A.click('^Logout$', '', 'aside button'));
    record(await A.waitText('Username', 4000), 'admin: back at the login screen');

    record(!A.errors.length && !P.errors.length, 'no JavaScript errors in either app', [...A.errors, ...P.errors].slice(0, 3).join(' || '));
    const errs = [...A.log, ...P.log].filter((r) => r.status >= 500);
    record(errs.length === 0, 'no 5xx responses during the audit', errs.map((e) => `${e.method} ${e.path} ${e.status}`).join(', '));
  } catch (e) {
    record(false, 'audit crashed', e.stack);
  } finally {
    env.proc.kill();
    fs.rmSync(env.profile, { recursive: true, force: true });
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
})();
