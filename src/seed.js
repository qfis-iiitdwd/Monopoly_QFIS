// Loads config/game.json into an empty database. Refuses to touch a database whose event has
// started unless explicitly forced, so a stray command cannot wipe a live game.

const crypto = require('crypto');
const passwords = require('./passwords');
const db = require('./db');
const { DEFAULT_SETTINGS, mergeSettings, validateSettings, RUPEE } = require('./settings');

const TABLES = ['sessions', 'final_rankings', 'leaderboard_snapshots', 'quest_awards', 'collateral', 'loans', 'ledger_entries',
  'trades', 'orders', 'holdings', 'stock_prices', 'news_items', 'scheduled_events', 'rounds', 'companies', 'teams',
  'admin_audit_log', 'admins', 'system_log', 'game_state'];

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function randomPassword(len = 8) {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

const rupees = (v) => Math.round(Number(v) * RUPEE);

function buildSettings(cfg) {
  const s = cfg.settings || {};
  const override = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'loans' || k === 'sizing') continue;
    if (k.endsWith('_rupees')) override[k.replace(/_rupees$/, '')] = rupees(v);
    else override[k] = v;
  }
  if (s.loans) {
    override.loans = {};
    for (const [k, v] of Object.entries(s.loans)) {
      if (k.endsWith('_rupees')) override.loans[k.replace(/_rupees$/, '')] = rupees(v);
      else override.loans[k] = v;
    }
  }
  return validateSettings(mergeSettings(DEFAULT_SETTINGS, override));
}

function sizeCompany(c, sizing) {
  const price = rupees(c.price);
  const floatShares = c.float_shares || Math.max(100, Math.round(rupees(sizing.float_value_rupees) / price / 100) * 100);
  return {
    price,
    float_shares: floatShares,
    shares_outstanding: c.shares_outstanding || floatShares * (sizing.outstanding_multiple || 4),
    max_order_quantity: c.max_order_quantity || Math.max(10, Math.round(rupees(sizing.max_order_value_rupees) / price / 10) * 10),
    pressure_ref_qty: c.pressure_ref_qty || Math.max(1, Math.round((floatShares * (sizing.pressure_ref_fraction_bps || 1000)) / 10000)),
  };
}

// Company "details" are extra story facts shown to players, e.g. { "Founded": "1998", "HQ": "Pune" }.
function validDetails(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  const entries = Object.entries(d);
  return entries.length <= 20 && entries.every(([k, v]) => k.length > 0 && k.length <= 40 && typeof v === 'string' && v.length <= 500);
}

function validateConfig(cfg, settings) {
  const t = cfg.teams || {};
  if (t.names) {
    const seen = new Set();
    for (const n of t.names) {
      if (typeof n !== 'string' || !n.trim()) throw new Error('teams.names has an empty name');
      if (seen.has(n.toLowerCase())) throw new Error(`duplicate team name "${n}"`);
      seen.add(n.toLowerCase());
    }
  }
  if (t.passwords) {
    if (!t.names || t.passwords.length !== t.names.length) throw new Error('teams.passwords must list one password per entry in teams.names');
    if (t.passwords.some((p) => typeof p !== 'string' || p.trim().length < 4)) throw new Error('teams.passwords: every password needs 4+ characters');
  }
  const tickers = new Set();
  const industries = new Set();
  for (const c of cfg.companies) {
    if (!/^[A-Z]{2,6}$/.test(c.ticker)) throw new Error(`bad ticker ${c.ticker}`);
    if (tickers.has(c.ticker)) throw new Error(`duplicate ticker ${c.ticker}`);
    if (!(Number(c.price) > 0)) throw new Error(`${c.ticker} needs a positive price`);
    if (c.ceo != null && typeof c.ceo !== 'string') throw new Error(`${c.ticker}: ceo must be text`);
    if (c.details != null && !validDetails(c.details)) throw new Error(`${c.ticker}: details must be an object of short text values`);
    tickers.add(c.ticker);
    industries.add(c.industry);
  }
  const roundIds = cfg.rounds.map((r) => r.id);
  const script = cfg.price_script && cfg.price_script.moves;
  if (script) {
    for (const [t, moves] of Object.entries(script)) {
      if (!tickers.has(t)) throw new Error(`price_script: ${t} is not in companies`);
      if (!Array.isArray(moves) || moves.length !== settings.total_rounds) {
        throw new Error(`price_script: ${t} needs exactly ${settings.total_rounds} moves (one per round), has ${Array.isArray(moves) ? moves.length : 0}`);
      }
      moves.forEach((v, i) => {
        if (!Number.isSafeInteger(v)) throw new Error(`price_script: ${t} round ${i + 1} must be whole basis points (got ${v})`);
        if (v > settings.max_move_up_bps || -v > settings.max_move_down_bps) {
          throw new Error(`price_script: ${t} round ${i + 1} (${v / 100}%) is outside the ±${settings.max_move_up_bps / 100}% per-round limit`);
        }
      });
    }
  }
  for (let i = 1; i <= settings.total_rounds; i++) if (!roundIds.includes(i)) throw new Error(`round ${i} missing from config`);
  const ids = new Set();
  for (const e of cfg.events || []) {
    if (ids.has(e.id)) throw new Error(`duplicate event id ${e.id}`);
    if (/^SCRIPT-/i.test(e.id)) throw new Error(`event id ${e.id}: ids starting with SCRIPT- are reserved for price_script`);
    ids.add(e.id);
    if (!roundIds.includes(e.effective_round)) throw new Error(`event ${e.id}: effective_round ${e.effective_round} is not a round`);
    for (const t of Object.keys(e.companies || {})) if (!tickers.has(t)) throw new Error(`event ${e.id}: unknown ticker ${t}`);
    for (const ind of Object.keys(e.industries || {})) if (!industries.has(ind)) throw new Error(`event ${e.id}: unknown industry ${ind}`);
    for (const v of [...Object.values(e.companies || {}), ...Object.values(e.industries || {})]) {
      if (!Number.isSafeInteger(v)) throw new Error(`event ${e.id}: impacts must be integer basis points`);
    }
  }
}

// price_script.moves = { TICKER: [round 1 bps, round 2 bps, ...] } becomes one scheduled event per
// round ("SCRIPT-R01" ...) that moves every listed company by its fixed amount at that round's market
// update. Trading pressure (and noise, if enabled) are added on top, as for any other event.
function scriptEvents(cfg) {
  const script = cfg.price_script && cfg.price_script.moves;
  if (!script) return [];
  const rounds = Math.max(0, ...Object.values(script).map((m) => m.length));
  const src = cfg.price_script.source ? ` (from ${cfg.price_script.source})` : '';
  const out = [];
  for (let r = 1; r <= rounds; r++) {
    const companies = {};
    for (const [t, moves] of Object.entries(script)) if (moves[r - 1]) companies[t] = moves[r - 1];
    out.push({ id: `SCRIPT-R${String(r).padStart(2, '0')}`, name: `Scripted moves, round ${r}`, effective_round: r, companies,
      notes: `Fixed per-company moves${src}` });
  }
  return out;
}

// opts: { reset, force, adminPassword, adminUsername, fixedPasswords }
// Returns { credentials: [{name, team_id, password}], adminPassword }
async function seed(cfg, opts = {}) {
  const settings = buildSettings(cfg);
  validateConfig(cfg, settings);
  const sizing = (cfg.settings && cfg.settings.sizing) || {};

  return db.tx(async (c) => {
    const existing = await c.query('SELECT status FROM game_state WHERE id = 1');
    if (existing.rows[0]) {
      if (!opts.reset) throw new Error('Database already seeded. Use --reset to wipe it.');
      if (existing.rows[0].status !== 'setup' && !opts.force) {
        throw new Error(`The event is ${existing.rows[0].status}. Refusing to wipe a started event without --force.`);
      }
    }
    await c.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    await c.query('INSERT INTO game_state (id, settings) VALUES (1, $1)', [JSON.stringify(settings)]);

    const adminPassword = opts.adminPassword || randomPassword(12);
    await c.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)',
      [opts.adminUsername || 'admin', passwords.hash(adminPassword)]);

    const tcfg = cfg.teams || {};
    const count = tcfg.count || (tcfg.names && tcfg.names.length) || 50;
    const credentials = [];
    for (let i = 1; i <= count; i++) {
      const num = String(i).padStart(2, '0');
      const name = (tcfg.names && tcfg.names[i - 1]) || `${tcfg.name_prefix || 'Team'} ${num}`;
      const ident = `${tcfg.id_prefix || 'team'}${num}`;
      // teams.passwords (optional) gives each team the password the organisers chose, in names order.
      // Team passwords are case-insensitive: stored lowercase, and login lowercases what is typed.
      const password = ((tcfg.passwords && tcfg.passwords[i - 1]) || (opts.fixedPasswords ? `pw-${ident}` : randomPassword())).trim().toLowerCase();
      const { rows: [team] } = await c.query(
        'INSERT INTO teams (name, access_identifier, password, cash) VALUES ($1, $2, $3, $4) RETURNING id',
        [name, ident, password, settings.starting_cash]);
      await c.query(
        `INSERT INTO ledger_entries (team_id, transaction_type, amount, balance_after, memo) VALUES ($1, 'initial_deposit', $2, $2, 'Starting capital')`,
        [team.id, settings.starting_cash]);
      credentials.push({ name, team_id: ident, password });
    }

    for (const co of cfg.companies) {
      const s = sizeCompany(co, sizing);
      const { rows: [row] } = await c.query(
        `INSERT INTO companies (ticker, name, industry, description, initial_price, shares_outstanding, float_shares,
                                exchange_inventory, max_order_quantity, pressure_ref_qty, loan_eligible, ceo, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [co.ticker, co.name, co.industry, co.description || '', s.price, s.shares_outstanding, s.float_shares,
          s.max_order_quantity, s.pressure_ref_qty, co.loan_eligible !== false, co.ceo || '', JSON.stringify(co.details || {})]);
      await c.query('INSERT INTO stock_prices (company_id, round_id, price) VALUES ($1, 0, $2)', [row.id, s.price]);
    }

    for (const r of cfg.rounds) {
      await c.query('INSERT INTO rounds (id, title, duration_seconds, newspaper_pdf) VALUES ($1, $2, $3, $4)',
        [r.id, r.title || `Round ${r.id}`, r.duration_seconds || 300, r.pdf || null]);
      for (let i = 0; i < (r.bulletins || []).length; i++) {
        const b = r.bulletins[i];
        await c.query('INSERT INTO news_items (round_id, title, content, affected, media_url, sort_order) VALUES ($1, $2, $3, $4, $5, $6)',
          [r.id, b.title, b.content || '', b.affected || '', b.media || null, i]);
      }
    }

    for (const e of cfg.events || []) {
      await c.query(
        `INSERT INTO scheduled_events (id, event_name, clue_round, effective_round, configuration, notes) VALUES ($1, $2, $3, $4, $5, $6)`,
        [e.id, e.name, e.clue_round || null, e.effective_round,
          JSON.stringify({ industries: e.industries || {}, companies: e.companies || {} }), e.notes || '']);
    }
    const scripted = scriptEvents(cfg);
    for (const e of scripted) {
      await c.query(
        `INSERT INTO scheduled_events (id, event_name, clue_round, effective_round, configuration, notes) VALUES ($1, $2, NULL, $3, $4, $5)`,
        [e.id, e.name, e.effective_round, JSON.stringify({ industries: {}, companies: e.companies }), e.notes]);
    }
    await c.query(`INSERT INTO admin_audit_log (action, reason, after_state) VALUES ('seed', 'database seeded from config', $1)`,
      [JSON.stringify({ teams: count, companies: cfg.companies.length, rounds: cfg.rounds.length, events: (cfg.events || []).length,
        scripted_rounds: scripted.length })]);
    return { credentials, adminPassword };
  });
}

module.exports = { seed, buildSettings, sizeCompany, scriptEvents, validDetails };
