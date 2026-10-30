#!/usr/bin/env node
// Pre-event check of a deployment. Read-only. Run where the app runs:
//   docker compose exec app node scripts/preflight.js      (production stack)
//   node scripts/preflight.js                              (local)
// FAIL = must fix before the event. WARN = check it is what you intend.
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const passwords = require('../src/passwords');

const results = [];
const add = (level, msg) => { results.push({ level, msg }); console.log(`${level.padEnd(4)}  ${msg}`); };
const ok = (m) => add('ok', m);
const warn = (m) => add('WARN', m);
const fail = (m) => add('FAIL', m);
const ROOT = path.join(__dirname, '..');

(async () => {
  // --- Environment ---------------------------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  (major >= 20 ? ok : fail)(`Node ${process.versions.node}`);
  (process.env.COOKIE_SECURE === '1' ? ok : warn)(`COOKIE_SECURE=${process.env.COOKIE_SECURE || '(unset)'}${process.env.COOKIE_SECURE === '1' ? '' : ' (must be 1 when served over HTTPS)'}`);
  const ap = process.env.ADMIN_PASSWORD || '';
  if (!ap) warn('ADMIN_PASSWORD is not set in this environment (cannot check it)');
  else if (ap.length < 12 || /^(change-me-now|stress|admin|password|test-admin)$/i.test(ap)) fail('ADMIN_PASSWORD is short or a known default; use 12+ random characters');
  else ok('ADMIN_PASSWORD is set and not a default');
  if (/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || 'localhost') && process.env.NODE_ENV === 'production') warn('DATABASE_URL points at localhost in production');

  // --- Database ------------------------------------------------------------------------------
  let rtt;
  try {
    await db.query('SELECT 1');
    const t = [];
    for (let i = 0; i < 10; i++) { const t0 = performance.now(); await db.query('SELECT 1'); t.push(performance.now() - t0); }
    rtt = t.sort((a, b) => a - b)[5];
    const pool = Number(process.env.DB_POOL_SIZE || 20);
    (rtt < 10 ? ok : pool >= 40 ? warn : fail)(`database round trip ${rtt.toFixed(1)} ms${rtt >= 10 && pool < 40 ? ' — put app and DB in the same region, or set DB_POOL_SIZE=40' : ''}`);
    const { rows: [{ max_connections: mc }] } = await db.query('SHOW max_connections');
    const need = pool + Number(process.env.DB_ADMIN_POOL_SIZE || 4) + 10;
    (Number(mc) >= need ? ok : fail)(`max_connections ${mc} (needs ≥ ${need})`);
    // Every connection the app may use, open at once. Supabase's session pooler caps this at its Pool Size.
    const held = await Promise.allSettled([db.pool, db.adminPool].flatMap((p) => Array.from({ length: p.options.max }, () => p.connect())));
    const failed = held.find((h) => h.status === 'rejected');
    held.forEach((h) => h.status === 'fulfilled' && h.value.release());
    (failed ? fail : ok)(failed
      ? `could not open all ${held.length} app connections at once: ${failed.reason.message}${db.isSupabase ? ' — raise Pool Size in Supabase (Database settings → Connection pooling) to at least ' + need : ''}`
      : `opened all ${held.length} app connections at once`);
    const { rows: [api] } = await db.query(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AS supabase`);
    if (api.supabase) {
      const { rows: [x] } = await db.query(`SELECT
        (SELECT COUNT(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
           AND (NOT relrowsecurity OR has_table_privilege('anon', oid, 'SELECT,INSERT,UPDATE,DELETE'))) AS tables,
        (SELECT COUNT(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND has_function_privilege('anon', oid, 'EXECUTE')) AS fns`);
      (Number(x.tables) + Number(x.fns) ? fail : ok)(Number(x.tables) + Number(x.fns)
        ? `Supabase Data API can reach ${x.tables} tables and ${x.fns} functions with the public anon key: restart the app (its startup locks them down)`
        : 'Supabase Data API (anon key) cannot reach any game table or function');
    }
    const { rows: [{ skew }] } = await db.query('SELECT EXTRACT(EPOCH FROM (clock_timestamp() - $1::timestamptz)) * 1000 AS skew', [new Date().toISOString()]);
    (Math.abs(skew) < 2000 ? ok : warn)(`app/database clock difference ${Number(skew).toFixed(0)} ms (the app compensates; large values mean a misconfigured clock)`);
  } catch (e) {
    fail(`cannot reach the database: ${e.message}`);
    return finish();
  }

  // --- Game state ----------------------------------------------------------------------------
  const { rows: [gs] } = await db.query('SELECT * FROM game_state WHERE id = 1').catch(() => ({ rows: [] }));
  if (!gs) { fail('database is not seeded: run scripts/seed.js'); return finish(); }
  (gs.status === 'setup' ? ok : warn)(`event status: ${gs.status}${gs.status === 'setup' ? '' : ` (round ${gs.current_round})`}`);
  const { rows: [{ teams }] } = await db.query('SELECT COUNT(*)::int AS teams FROM teams');
  ok(`${teams} teams`);
  const { rows: [t1] } = await db.query('SELECT access_identifier, password_hash FROM teams ORDER BY id LIMIT 1');
  if (t1 && await passwords.verify(`pw-${t1.access_identifier}`, t1.password_hash)) fail('teams have TEST passwords (seeded with --test-passwords): re-seed without it');
  else ok('team passwords are not the test passwords');
  if (ap) {
    const { rows: [a] } = await db.query('SELECT password_hash FROM admins ORDER BY id LIMIT 1');
    (a && await passwords.verify(ap, a.password_hash) ? ok : warn)(a && await passwords.verify(ap, a.password_hash)
      ? 'admin password in the database matches ADMIN_PASSWORD' : 'admin password in the database differs from ADMIN_PASSWORD (seeded with another one?)');
  }
  const s = gs.settings;
  ok(`settings: fee ${s.fee_bps / 100}%, pressure ${s.pressure_scale_bps / 100}% per reference volume (cap ±${s.pressure_cap_bps / 100}%), noise ±${s.noise_bps / 100}%, loans ${s.loans.enabled ? 'ON' : 'off'}, players see rankings: ${s.players_see_leaderboard === false ? 'no' : 'YES'}`);

  // --- Config vs database --------------------------------------------------------------------
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'game.json'), 'utf8')); } catch (e) { warn(`config/game.json not readable here: ${e.message}`); }
  const { rows: cos } = await db.query('SELECT ticker, name, description, industry, ceo, initial_price FROM companies ORDER BY ticker');
  const noCeo = cos.filter((c) => !c.ceo);
  (noCeo.length ? warn : ok)(noCeo.length ? `${noCeo.length} companies have no CEO name: ${noCeo.map((c) => c.ticker).join(', ')}` : 'CEO names filled in');
  const placeholders = cos.filter((c) => /placeholder/i.test(c.description) || c.industry === 'Unassigned');
  (placeholders.length ? warn : ok)(placeholders.length ? `${placeholders.length} companies still have placeholder descriptions/industries: ${placeholders.map((c) => c.ticker).join(', ')}` : 'company descriptions filled in');
  const { rows: rounds } = await db.query('SELECT id, title, newspaper_pdf FROM rounds ORDER BY id');
  const phTitles = rounds.filter((r) => /placeholder/i.test(r.title));
  (phTitles.length ? warn : ok)(phTitles.length ? `${phTitles.length} round titles are placeholders` : 'round titles filled in');
  const { rows: news } = await db.query('SELECT round_id FROM news_items WHERE title ILIKE $1', ['%placeholder%']);
  (news.length ? warn : ok)(news.length ? `${news.length} news-segment headlines are placeholders` : 'news-segment headlines filled in');
  const missing = rounds.filter((r) => !r.newspaper_pdf || !fs.existsSync(path.join(ROOT, 'papers', path.basename(r.newspaper_pdf))));
  (missing.length ? warn : ok)(missing.length ? `newspaper PDFs missing in papers/ for rounds ${missing.map((r) => r.id).join(', ')}` : 'all newspaper PDFs present');
  const { rows: script } = await db.query(`SELECT id, configuration FROM scheduled_events WHERE id LIKE 'SCRIPT-R%' ORDER BY id`);
  if (!script.length) warn('no price script in the database (prices move only by events and trading)');
  else if (cfg && cfg.price_script) {
    const diff = [];
    for (const [t, moves] of Object.entries(cfg.price_script.moves)) {
      moves.forEach((m, i) => {
        const ev = script.find((e) => e.id === `SCRIPT-R${String(i + 1).padStart(2, '0')}`);
        const v = ev ? (ev.configuration.companies[t] || 0) : null;
        if (v !== m) diff.push(`${t} R${i + 1}`);
      });
    }
    (diff.length ? warn : ok)(diff.length ? `database price script differs from config/game.json at ${diff.slice(0, 8).join(', ')}${diff.length > 8 ? '…' : ''} (config edited after seeding, or corrected in the admin panel)` : `price script in the database matches config/game.json (${cfg.price_script.source || 'source unknown'})`);
    const prices = cfg.companies.filter((c) => { const d = cos.find((x) => x.ticker === c.ticker); return !d || d.initial_price !== Math.round(c.price * 100); });
    (prices.length ? warn : ok)(prices.length ? `starting prices differ from config for ${prices.map((c) => c.ticker).join(', ')} (re-seed?)` : 'starting prices match config/game.json');
  }
  const { rows: [{ n: prob }] } = await db.query(`SELECT COUNT(*)::int AS n FROM system_log WHERE level = 'error' AND created_at > now() - interval '1 day'`);
  (prob ? warn : ok)(`${prob} server errors logged in the last 24 h`);
  return finish();
})().catch((e) => { fail(e.stack); finish(); });

async function finish() {
  await db.end().catch(() => {});
  const f = results.filter((r) => r.level === 'FAIL').length;
  const w = results.filter((r) => r.level === 'WARN').length;
  console.log(`\n${f ? 'NOT READY' : w ? 'READY, with warnings to review' : 'READY'}: ${f} fail, ${w} warn`);
  process.exit(f ? 1 : 0);
}
