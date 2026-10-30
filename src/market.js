// Round lifecycle and the market update.
//
//   pending ──open──▶ open ──close (manual or deadline)──▶ closed ──apply market update──▶ settled
//
// Every transition takes the market gate exclusively (getGameState lock 'update'), so transitions
// are serialized against each other and against in-flight orders (which hold it shared).

const db = require('./db');
const { GameError } = require('./errors');
const pricing = require('./pricing');
const loans = require('./loans');
const { getGameState, getRound, audit } = require('./state');
const { snapshotLeaderboard, teamValuations, rank } = require('./valuation');

async function startEvent(adminId) {
  return db.tx(async (c) => {
    const gs = await getGameState(c, { lock: 'update' });
    if (gs.status !== 'setup') throw new GameError(`Event already ${gs.status}`, 409, 'conflict');
    const { rows: [{ missing }] } = await c.query(
      `SELECT COUNT(*)::int AS missing FROM companies co
        WHERE NOT EXISTS (SELECT 1 FROM stock_prices sp WHERE sp.company_id = co.id AND sp.round_id = 0)`);
    if (missing) throw new GameError(`${missing} companies have no initial price`, 409, 'conflict');
    await c.query(`UPDATE game_state SET status = 'running', started_at = now(), updated_at = now() WHERE id = 1`);
    await snapshotLeaderboard(c, 0);
    await audit(c, adminId, 'start_event', null, { status: gs.status }, { status: 'running' });
    return { status: 'running' };
  });
}

async function publishNewspaper(roundId, adminId) {
  return db.tx(async (c) => {
    const gs = await getGameState(c, { lock: 'update' });
    if (gs.status !== 'running') throw new GameError('Start the event first', 409, 'conflict');
    if (roundId > gs.current_round + 1) throw new GameError(`Round ${roundId} is not next`, 409, 'conflict');
    const round = await getRound(c, roundId, { lock: 'update' });
    if (round.newspaper_published_at) return { already: true, round };
    const { rows: [r] } = await c.query('UPDATE rounds SET newspaper_published_at = now() WHERE id = $1 RETURNING *', [roundId]);
    await audit(c, adminId, 'publish_newspaper', null, null, { round: roundId, pdf: round.newspaper_pdf });
    return { already: false, round: r };
  });
}

async function openRound(roundId, adminId) {
  return db.tx(async (c) => {
    const gs = await getGameState(c, { lock: 'update' });
    if (gs.status !== 'running') throw new GameError('Start the event first', 409, 'conflict');
    if (gs.paused) throw new GameError('Resume the event before opening a round', 409, 'conflict');
    if (roundId !== gs.current_round + 1) throw new GameError(`The next round to open is ${gs.current_round + 1}`, 409, 'conflict');
    if (roundId > gs.settings.total_rounds) throw new GameError('All rounds are complete', 409, 'conflict');
    if (gs.current_round > 0) {
      const prev = await getRound(c, gs.current_round);
      if (prev.status !== 'settled') throw new GameError(`Apply Round ${prev.id}'s market update first`, 409, 'conflict');
    }
    const round = await getRound(c, roundId, { lock: 'update' });
    if (round.status !== 'pending') throw new GameError(`Round ${roundId} is already ${round.status}`, 409, 'conflict');
    const { rows: [r] } = await c.query(
      `UPDATE rounds SET status = 'open', opened_at = now(),
              trading_deadline = now() + make_interval(secs => duration_seconds),
              newspaper_published_at = COALESCE(newspaper_published_at, now())
        WHERE id = $1 RETURNING *`, [roundId]);
    await c.query('UPDATE game_state SET current_round = $1, updated_at = now() WHERE id = 1', [roundId]);
    await audit(c, adminId, 'open_round', null, { current_round: gs.current_round }, { current_round: roundId, deadline: r.trading_deadline });
    return r;
  });
}

async function closeRound(roundId, adminId, { auto = false } = {}) {
  return db.tx(async (c) => {
    await getGameState(c, { lock: 'update' });
    const round = await getRound(c, roundId, { lock: 'update' });
    if (round.status !== 'open') {
      if (auto) return null;
      if (round.status === 'closed' || round.status === 'settled') return round; // idempotent
      throw new GameError(`Round ${roundId} is not open`, 409, 'conflict');
    }
    const { rows: [r] } = await c.query(`UPDATE rounds SET status = 'closed', closed_at = clock_timestamp() WHERE id = $1 RETURNING *`, [roundId]);
    await audit(c, auto ? null : adminId, auto ? 'auto_close_round' : 'close_round', auto ? 'Deadline reached' : null, null, { round: roundId });
    return r;
  });
}

// Called every second by the server. Never closes while paused: the admin decides on resume.
async function autoCloseExpired() {
  const { rows } = await db.query(
    `SELECT r.id FROM rounds r, game_state g
      WHERE r.status = 'open' AND r.trading_deadline <= clock_timestamp() AND g.status = 'running' AND NOT g.paused`);
  for (const r of rows) await closeRound(r.id, null, { auto: true });
  return rows.length;
}

// Undo an accidental Close: the round trades again until now + seconds. Not allowed once the news
// segment is out (teams would trade on the answers) or once the market update has run.
async function reopenRound(roundId, seconds, adminId, reason) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 3600) throw new GameError('Reopen for 1–3600 seconds');
  if (typeof reason !== 'string' || reason.trim().length < 5) throw new GameError('A reason (at least 5 characters) is required');
  return db.tx(async (c) => {
    const gs = await getGameState(c, { lock: 'update' });
    if (gs.status !== 'running') throw new GameError('The event is not running', 409, 'conflict');
    if (roundId !== gs.current_round) throw new GameError(`Only the current round (${gs.current_round}) can be reopened`, 409, 'conflict');
    const round = await getRound(c, roundId, { lock: 'update' });
    if (round.status === 'open') return round;
    if (round.status !== 'closed') throw new GameError(`Round ${roundId} is ${round.status} and cannot be reopened`, 409, 'conflict');
    if (round.bulletin_published_at) throw new GameError('The news segment for this round is already public, so trading cannot reopen', 409, 'conflict');
    const { rows: [r] } = await c.query(
      `UPDATE rounds SET status = 'open', closed_at = NULL, trading_deadline = clock_timestamp() + make_interval(secs => $2)
        WHERE id = $1 RETURNING *`, [roundId, seconds]);
    await audit(c, adminId, 'reopen_round', reason.trim(), { status: round.status, closed_at: round.closed_at },
      { status: 'open', deadline: r.trading_deadline });
    return r;
  });
}

async function extendRound(roundId, seconds, adminId, reason) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 3600) throw new GameError('Extension must be 1–3600 seconds');
  return db.tx(async (c) => {
    await getGameState(c, { lock: 'update' });
    const round = await getRound(c, roundId, { lock: 'update' });
    if (round.status !== 'open') throw new GameError('Only an open round can be extended', 409, 'conflict');
    const { rows: [r] } = await c.query(
      `UPDATE rounds SET trading_deadline = GREATEST(trading_deadline, clock_timestamp()) + make_interval(secs => $2) WHERE id = $1 RETURNING *`,
      [roundId, seconds]);
    await audit(c, adminId, 'extend_round', reason, { deadline: round.trading_deadline }, { deadline: r.trading_deadline });
    return r;
  });
}

async function setPaused(paused, adminId, { extend = true, reason } = {}) {
  return db.tx(async (c) => {
    const gs = await getGameState(c, { lock: 'update' });
    if (gs.paused === paused) return gs;
    let extendedBy = null;
    if (!paused && extend && gs.current_round) {
      const { rows } = await c.query(
        `UPDATE rounds SET trading_deadline = trading_deadline + (clock_timestamp() - $2::timestamptz)
          WHERE id = $1 AND status = 'open' RETURNING trading_deadline`, [gs.current_round, gs.paused_at]);
      if (rows[0]) extendedBy = 'pause duration';
    }
    const { rows: [updated] } = await c.query(
      `UPDATE game_state SET paused = $1, paused_at = CASE WHEN $1 THEN clock_timestamp() ELSE NULL END, updated_at = now()
        WHERE id = 1 RETURNING *`, [paused]);
    await audit(c, adminId, paused ? 'pause' : 'resume', reason, { paused: gs.paused }, { paused, deadline_extended: extendedBy });
    return updated;
  });
}

async function setMessage(message, adminId) {
  return db.tx(async (c) => {
    const gs = await getGameState(c, { lock: 'update' });
    await c.query('UPDATE game_state SET message = $1, updated_at = now() WHERE id = 1', [String(message || '').slice(0, 500)]);
    await audit(c, adminId, 'set_message', null, { message: gs.message }, { message });
    return { message };
  });
}

async function publishBulletin(roundId, adminId) {
  return db.tx(async (c) => {
    await getGameState(c, { lock: 'update' });
    const round = await getRound(c, roundId, { lock: 'update' });
    if (round.status === 'pending' || round.status === 'open') {
      throw new GameError('Close trading before publishing the news segment', 409, 'conflict');
    }
    if (round.bulletin_published_at) return { already: true };
    await c.query('UPDATE news_items SET is_published = true, published_at = now() WHERE round_id = $1 AND NOT is_published', [roundId]);
    await c.query('UPDATE rounds SET bulletin_published_at = now() WHERE id = $1', [roundId]);
    await audit(c, adminId, 'publish_bulletin', null, null, { round: roundId });
    return { already: false };
  });
}

async function gatherInputs(c, roundId) {
  const { rows: companies } = await c.query('SELECT id, ticker, name, industry, pressure_ref_qty FROM companies ORDER BY id');
  const { rows: prev } = await c.query('SELECT company_id, price FROM stock_prices WHERE round_id = $1', [roundId - 1]);
  // A reversal is an opposite-side trade in the original order's round, so it cancels that order's pressure.
  const { rows: demand } = await c.query(
    `SELECT company_id, SUM(CASE WHEN side = 'buy' THEN quantity ELSE -quantity END)::bigint AS net
       FROM trades WHERE round_id = $1 AND source IN ('order', 'reversal') GROUP BY company_id`, [roundId]);
  const { rows: events } = await c.query(
    'SELECT id, event_name, configuration FROM scheduled_events WHERE effective_round = $1 AND NOT is_applied ORDER BY id', [roundId]);
  return {
    companies,
    prevPrices: new Map(prev.map((r) => [r.company_id, r.price])),
    netDemand: new Map(demand.map((r) => [r.company_id, r.net])),
    events,
  };
}

// Read-only: exactly what apply would compute right now.
async function previewMarketUpdate(roundId) {
  const gs = await getGameState();
  const round = await getRound(db, roundId);
  const inputs = await gatherInputs(db, roundId);
  const rows = pricing.computeRound({ roundId, settings: gs.settings, ...inputs });
  const names = new Map(inputs.companies.map((co) => [co.id, co]));
  return {
    round,
    events: inputs.events,
    rows: rows.map((r) => ({ ...r, name: names.get(r.company_id).name, industry: names.get(r.company_id).industry })),
  };
}

// The single, controlled market update. Safe to call twice: the second call reports the existing result.
async function applyMarketUpdate(roundId, adminId) {
  return db.tx(async (c) => {
    const gs = await getGameState(c, { lock: 'update' });
    const round = await getRound(c, roundId, { lock: 'update' });
    if (round.market_update_status === 'done') {
      const { rows } = await c.query('SELECT * FROM stock_prices WHERE round_id = $1 ORDER BY company_id', [roundId]);
      return { alreadyApplied: true, rows };
    }
    if (round.status !== 'closed') throw new GameError(`Round ${roundId} must be closed before its market update (it is ${round.status})`, 409, 'conflict');

    const inputs = await gatherInputs(c, roundId);
    const rows = pricing.computeRound({ roundId, settings: gs.settings, ...inputs });
    // One statement for all companies (one round trip, not twenty).
    const col = (k) => rows.map((r) => r[k]);
    await c.query(
      `INSERT INTO stock_prices (company_id, round_id, price, prev_price, fundamental_bps, trading_bps, noise_bps, total_bps, net_demand)
       SELECT company_id, $1, price, prev_price, f, t, n, total, nd
         FROM unnest($2::int[], $3::bigint[], $4::bigint[], $5::int[], $6::int[], $7::int[], $8::int[], $9::bigint[])
              AS x(company_id, price, prev_price, f, t, n, total, nd)`,
      [roundId, col('company_id'), col('price'), col('prev_price'), col('fundamental_bps'), col('trading_bps'), col('noise_bps'), col('total_bps'), col('net_demand')]);
    if (inputs.events.length) {
      await c.query('UPDATE scheduled_events SET is_applied = true, applied_at = now() WHERE id = ANY($1)', [inputs.events.map((e) => e.id)]);
    }
    let liquidations = [];
    if (gs.settings.loans.enabled) {
      await loans.accrueInterest(c, roundId, gs.settings);
      liquidations = await loans.liquidateLoans(c, roundId, { onlyDue: true });
    }
    // The news segment is always public once the market reflects it.
    await c.query('UPDATE news_items SET is_published = true, published_at = COALESCE(published_at, now()) WHERE round_id = $1', [roundId]);
    await c.query(
      `UPDATE rounds SET status = 'settled', market_update_status = 'done', completed_at = now(),
              bulletin_published_at = COALESCE(bulletin_published_at, now()) WHERE id = $1`, [roundId]);
    await snapshotLeaderboard(c, roundId);
    await audit(c, adminId, 'apply_market_update', null, null, {
      round: roundId,
      events: inputs.events.map((e) => e.id),
      prices: rows.map((r) => ({ t: r.ticker, from: r.prev_price, to: r.price, bps: r.total_bps })),
      liquidations,
    });
    return { alreadyApplied: false, rows, liquidations };
  });
}

// Emergency correction of a market update that used wrong inputs (for example a typo in the price
// script, found right after applying). Puts the round back to 'closed' so the inputs can be fixed
// and the update applied again. Only before the next round opens, and not once loans have been
// touched by the update (interest and liquidations are not undoable). The removed prices are kept
// in the audit log.
async function undoMarketUpdate(roundId, adminId, reason) {
  if (typeof reason !== 'string' || reason.trim().length < 5) throw new GameError('A reason (at least 5 characters) is required');
  return db.tx(async (c) => {
    const gs = await getGameState(c, { lock: 'update' });
    if (gs.status !== 'running') throw new GameError('The event is not running', 409, 'conflict');
    if (roundId !== gs.current_round) {
      throw new GameError(`Only the latest round (${gs.current_round}) can be undone, before the next round opens`, 409, 'conflict');
    }
    const round = await getRound(c, roundId, { lock: 'update' });
    if (round.market_update_status !== 'done') throw new GameError(`Round ${roundId} has no market update to undo`, 409, 'conflict');
    const { rows: [loanTouch] } = await c.query(
      `SELECT EXISTS (SELECT 1 FROM loans WHERE issued_round <= $1 AND (repaid_at IS NULL OR repaid_at > $2)) AS accrued,
              EXISTS (SELECT 1 FROM trades WHERE round_id = $1 AND source = 'liquidation') AS liquidated`,
      [roundId, round.completed_at]);
    if (gs.settings.loans.enabled && (loanTouch.accrued || loanTouch.liquidated)) {
      throw new GameError('This update charged loan interest or liquidated loans, which cannot be undone. Correct balances with Adjust cash instead.', 409, 'conflict');
    }
    const { rows: removed } = await c.query(
      `SELECT co.ticker, sp.prev_price, sp.price, sp.total_bps FROM stock_prices sp JOIN companies co ON co.id = sp.company_id
        WHERE sp.round_id = $1 ORDER BY co.id`, [roundId]);
    await c.query(`SELECT set_config('mv.undo_round', $1, true)`, [String(roundId)]);
    await c.query('DELETE FROM stock_prices WHERE round_id = $1', [roundId]);
    await c.query(`SELECT set_config('mv.undo_round', '', true)`);
    await c.query('DELETE FROM leaderboard_snapshots WHERE round_id = $1', [roundId]);
    await c.query('UPDATE scheduled_events SET is_applied = false, applied_at = NULL WHERE effective_round = $1', [roundId]);
    await c.query(`UPDATE rounds SET status = 'closed', market_update_status = 'none', completed_at = NULL WHERE id = $1`, [roundId]);
    await audit(c, adminId, 'undo_market_update', reason.trim(), { round: roundId, prices: removed }, { round: roundId, status: 'closed' });
    return { round: roundId, status: 'closed', removed_prices: removed.length };
  });
}

// Changes a scheduled event's (or a scripted round's) per-company / per-industry impacts before it is
// applied. After the event starts this is a logged emergency correction and needs a reason.
async function updateEvent(eventId, configuration, adminId, reason) {
  const cfg = configuration;
  const isMap = (v) => v == null || (typeof v === 'object' && !Array.isArray(v));
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || !isMap(cfg.companies) || !isMap(cfg.industries)
      || Object.keys(cfg).some((k) => k !== 'companies' && k !== 'industries')) {
    throw new GameError('configuration must be { "companies": { TICKER: bps }, "industries": { Industry: bps } }');
  }
  return db.tx(async (c) => {
    const gs = await getGameState(c, { lock: 'update' });
    if (gs.status !== 'setup' && (typeof reason !== 'string' || reason.trim().length < 5)) {
      throw new GameError('A reason (at least 5 characters) is required once the event has started');
    }
    const { rows: [ev] } = await c.query('SELECT * FROM scheduled_events WHERE id = $1 FOR NO KEY UPDATE', [eventId]);
    if (!ev) throw new GameError('Event not found', 404, 'not_found');
    if (ev.is_applied) throw new GameError('This event is already applied. Undo that round\'s market update first.', 409, 'conflict');
    const { rows: cos } = await c.query('SELECT ticker, industry FROM companies');
    const tickers = new Set(cos.map((r) => r.ticker));
    const industries = new Set(cos.map((r) => r.industry));
    const limit = Math.max(gs.settings.max_move_up_bps, gs.settings.max_move_down_bps);
    const clean = { industries: {}, companies: {} };
    for (const [kind, known] of [['companies', tickers], ['industries', industries]]) {
      for (const [k, v] of Object.entries(cfg[kind] || {})) {
        if (!known.has(k)) throw new GameError(`Unknown ${kind === 'companies' ? 'ticker' : 'industry'} ${k}`);
        if (!Number.isSafeInteger(v) || Math.abs(v) > limit) throw new GameError(`${k}: impact must be whole basis points within ±${limit}`);
        clean[kind][k] = v;
      }
    }
    await c.query('UPDATE scheduled_events SET configuration = $2 WHERE id = $1', [eventId, JSON.stringify(clean)]);
    await audit(c, adminId, 'update_event', reason ? reason.trim() : 'pre-event configuration',
      { id: eventId, configuration: ev.configuration }, { id: eventId, configuration: clean });
    return { ...ev, configuration: clean };
  });
}

// Final settlement: liquidate outstanding loans at final official prices, freeze the rankings.
async function endEvent(adminId) {
  return db.tx(async (c) => {
    const gs = await getGameState(c, { lock: 'update' });
    if (gs.status === 'finished') return { already: true };
    if (gs.status !== 'running') throw new GameError('The event is not running', 409, 'conflict');
    const last = await getRound(c, gs.settings.total_rounds);
    if (last.status !== 'settled') throw new GameError(`Apply Round ${last.id}'s market update first`, 409, 'conflict');
    const liquidations = await loans.liquidateLoans(c, last.id, { onlyDue: false });
    const ranked = rank(await teamValuations(c));
    for (const v of ranked) {
      await c.query(
        `INSERT INTO final_rankings (team_id, rank, net_worth, cash, holdings_value, debt, realized_pnl, tied)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [v.team_id, v.rank, v.net_worth, v.cash, v.holdings_value, v.debt, v.realized_pnl, v.tied]);
    }
    await c.query(`UPDATE game_state SET status = 'finished', finished_at = now(), paused = false, updated_at = now() WHERE id = 1`);
    await audit(c, adminId, 'end_event', null, null, { winner: ranked[0] && ranked[0].name, liquidations });
    return { already: false, winner: ranked[0] };
  });
}

module.exports = {
  startEvent, publishNewspaper, openRound, closeRound, reopenRound, autoCloseExpired, extendRound, setPaused, setMessage,
  publishBulletin, previewMarketUpdate, applyMarketUpdate, undoMarketUpdate, updateEvent, endEvent,
};
