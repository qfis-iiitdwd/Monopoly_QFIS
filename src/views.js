// Read models assembled for the three interfaces. Nothing here mutates state.
// Participant- and public-facing functions must never expose scheduled_events or unpublished news.

const db = require('./db');
const { getGameState, currentPrices } = require('./state');
const { teamValuations, publishedLeaderboard } = require('./valuation');

// Short-lived memo for hot read endpoints (250 phones and laptops polling).
// Single-flight: when an entry expires under load, one request recomputes it and the rest await
// that same promise instead of all hitting the database at once.
const memo = new Map();
let generation = 0;
function cached(key, ms, fn) {
  const hit = memo.get(key);
  const now = Date.now();
  if (hit && (hit.pending || hit.until > now)) return hit.promise;
  const gen = generation;
  const entry = { pending: true, until: 0 };
  entry.promise = fn().then(
    (value) => { entry.pending = false; entry.until = Date.now() + ms; if (gen !== generation) memo.delete(key); return value; },
    (err) => { if (memo.get(key) === entry) memo.delete(key); throw err; });
  memo.set(key, entry);
  return entry.promise;
}
// Called after admin writes. A computation already in flight may have read pre-write state, so
// it isn't cached once it finishes.
function invalidate() { generation++; memo.clear(); }

// Offset between this server's clock and the database's, which owns every deadline.
let dbClockOffset = 0;

function phaseOf(gs, round) {
  if (gs.status === 'setup') return 'setup';
  if (gs.status === 'finished') return 'finished';
  if (!round) return 'awaiting_open';
  if (round.status === 'open') return 'trading';
  if (round.status === 'closed') return round.bulletin_published_at ? 'news' : 'closed';
  return 'settled';
}

async function marketStatus() {
  const body = await cached('status', 500, async () => {
    const t0 = Date.now();
    const { rows: [clock] } = await db.query('SELECT clock_timestamp() AS now');
    dbClockOffset = new Date(clock.now).getTime() - (t0 + Date.now()) / 2;
    const gs = await getGameState();
    const { rows: rounds } = await db.query(
      'SELECT id, title, status, duration_seconds, newspaper_published_at, bulletin_published_at, opened_at, trading_deadline, closed_at, completed_at FROM rounds ORDER BY id');
    const round = rounds.find((r) => r.id === gs.current_round) || null;
    const next = rounds.find((r) => r.id === gs.current_round + 1) || null;
    const pub = (r) => r && {
      id: r.id,
      title: r.newspaper_published_at ? r.title : `Round ${r.id}`,
      status: r.status,
      duration_seconds: r.duration_seconds,
      trading_deadline: r.trading_deadline,
      opened_at: r.opened_at,
      closed_at: r.closed_at,
      newspaper_available: !!r.newspaper_published_at,
      bulletin_published: !!r.bulletin_published_at,
    };
    return {
      status: gs.status,
      phase: phaseOf(gs, round),
      paused: gs.paused,
      message: gs.message,
      current_round: gs.current_round,
      total_rounds: gs.settings.total_rounds,
      round: pub(round),
      next_round: pub(next),
      fee_bps: gs.settings.fee_bps,
      max_trades_per_round: gs.settings.max_trades_per_round,
      loans_enabled: !!gs.settings.loans.enabled,
      starting_cash: gs.settings.starting_cash,
      leaderboard_visible: gs.settings.players_see_leaderboard !== false,
    };
  });
  // The database is the authoritative clock (deadlines are enforced there); clients compute their
  // offset from this. Matters when the app and a managed database run on different hosts.
  return { ...body, server_time: new Date(Date.now() + dbClockOffset).toISOString() };
}

async function priceBoard() {
  return cached('prices', 1000, async () => {
    const prices = await currentPrices();
    const { rows: companies } = await db.query(
      'SELECT id, ticker, name, industry, description, ceo, details, shares_outstanding, initial_price, exchange_inventory, float_shares, max_order_quantity, is_tradable, suspension_reason, loan_eligible FROM companies ORDER BY ticker');
    return companies.map((c) => {
      const p = prices.get(c.id);
      return {
        ...c,
        price: p.price,
        prev_price: p.prev_price == null ? p.price : p.prev_price,
        change_bps: p.round_id === 0 ? 0 : p.total_bps,
        price_round: p.round_id,
      };
    });
  });
}

async function priceHistory() {
  return cached('history', 1000, async () => {
    const { rows } = await db.query(
      `SELECT sp.company_id, c.ticker, sp.round_id, sp.price FROM stock_prices sp JOIN companies c ON c.id = sp.company_id
        ORDER BY c.ticker, sp.round_id`);
    const out = {};
    for (const r of rows) (out[r.ticker] = out[r.ticker] || []).push({ round: r.round_id, price: r.price });
    return out;
  });
}

async function publishedNews() {
  return cached('news', 1000, async () => {
    const { rows: papers } = await db.query(
      `SELECT id AS round_id, title, newspaper_published_at, newspaper_pdf IS NOT NULL AS has_pdf
         FROM rounds WHERE newspaper_published_at IS NOT NULL ORDER BY id DESC`);
    const { rows: bulletins } = await db.query(
      `SELECT id, round_id, title, content, affected, media_url, published_at FROM news_items
        WHERE is_published ORDER BY round_id DESC, sort_order, id`);
    return { papers, bulletins };
  });
}

// Game state changes only through admin actions, which invalidate the cache.
const gameState = () => cached('gs', 500, () => getGameState());

// Two queries, run in parallel: this is the most-polled authenticated endpoint.
async function portfolio(teamId) {
  const gs = await gameState();
  const [[val], { rows: [extra] }, prices] = await Promise.all([
    teamValuations(db, { teamId }),
    db.query(
      `SELECT (SELECT json_build_object('id', id, 'name', name, 'access_identifier', access_identifier) FROM teams WHERE id = $1) AS team,
              (SELECT COUNT(*)::int FROM orders WHERE team_id = $1 AND round_id = $2 AND status = 'executed') AS n,
              (SELECT MIN(due_round) FROM loans WHERE team_id = $1 AND status = 'active') AS next_due,
              COALESCE((SELECT json_agg(x ORDER BY x.ticker) FROM (
                 SELECT h.company_id, c.ticker, c.name, c.industry, h.quantity, h.pledged_quantity, h.cost_basis
                   FROM holdings h JOIN companies c ON c.id = h.company_id WHERE h.team_id = $1 AND h.quantity > 0) x), '[]') AS holdings`,
      [teamId, gs.current_round]),
    cached('current_prices', 1000, () => currentPrices()),
  ]);
  const holdings = extra.holdings;
  for (const h of holdings) {
    const p = prices.get(h.company_id);
    h.price = p.price;
    h.value = h.quantity * p.price;
    h.unrealized_pnl = h.value - h.cost_basis;
  }
  return {
    team: extra.team,
    cash: val.cash,
    holdings_value: val.holdings_value,
    loan_principal: val.loan_principal,
    loan_interest: val.loan_interest,
    debt: val.debt,
    net_worth: val.net_worth,
    total_pnl: val.net_worth - gs.settings.starting_cash,
    realized_pnl: val.realized_pnl,
    trades_this_round: extra.n,
    loan_due_round: extra.next_due,
    holdings,
  };
}

async function transactions(teamId, limit = 300) {
  const { rows } = await db.query(
    `SELECT o.id AS order_id, t.id AS trade_id, o.round_id, o.submitted_at, COALESCE(t.executed_at, o.executed_at) AS executed_at,
            c.ticker, o.side, o.quantity, o.status, o.rejection_reason, o.placed_by,
            t.execution_price, t.gross, t.fee, t.cash_delta, t.cash_after, 'order' AS source, rv.reason AS reversed_reason
       FROM orders o LEFT JOIN trades t ON t.order_id = o.id LEFT JOIN companies c ON c.id = o.company_id
       LEFT JOIN order_reversals rv ON rv.order_id = o.id
      WHERE o.team_id = $1
     UNION ALL
     SELECT NULL, t.id, t.round_id, t.executed_at, t.executed_at, c.ticker, t.side, t.quantity, 'executed', NULL,
            CASE t.source WHEN 'reversal' THEN 'organisers' ELSE 'bank' END,
            t.execution_price, t.gross, t.fee, t.cash_delta, t.cash_after, t.source, NULL
       FROM trades t JOIN companies c ON c.id = t.company_id WHERE t.team_id = $1 AND t.source <> 'order'
     ORDER BY submitted_at DESC LIMIT $2`, [teamId, limit]);
  const { rows: ledger } = await db.query(
    `SELECT id, transaction_type, amount, balance_after, memo, created_at FROM ledger_entries
      WHERE team_id = $1 AND transaction_type NOT IN ('trade_buy', 'trade_sell', 'trade_reversal') ORDER BY id DESC`, [teamId]);
  return { orders: rows, other_cash_movements: ledger };
}

async function leaderboardFor(teamId) {
  const lb = await cached('leaderboard', 1000, publishedLeaderboard);
  const gs = await gameState();
  const rows = lb.rows.map((r) => ({
    rank: r.rank,
    team_id: r.team_id,
    name: r.name,
    net_worth: r.net_worth,
    total_pnl: r.net_worth - gs.settings.starting_cash,
    tied: !!r.tied,
  }));
  return { round_id: lb.round_id, final: lb.final, rows, mine: teamId ? rows.find((r) => r.team_id === teamId) || null : null };
}

function indexOf(board, key) {
  if (!board.length) return 0;
  const sum = board.reduce((a, c) => a + c[key] / c.initial_price, 0);
  return Math.round((1000 * sum) / board.length * 100) / 100;
}

// Everything the presentation slides need for a round, in one call (admin only).
async function roundSummary() {
  return cached('round_summary', 1000, async () => {
    const status = await marketStatus();
    const board = await priceBoard();
    const lastSettled = (await db.query(`SELECT MAX(id) AS id FROM rounds WHERE status = 'settled'`)).rows[0].id;
    const { rows: active } = lastSettled ? await db.query(
      `SELECT c.ticker, c.name, SUM(t.quantity)::bigint AS volume FROM trades t JOIN companies c ON c.id = t.company_id
        WHERE t.round_id = $1 AND t.source = 'order' GROUP BY c.id ORDER BY volume DESC LIMIT 5`, [lastSettled]) : { rows: [] };
    const moved = board.filter((c) => c.price_round > 0);
    const byChange = [...moved].sort((a, b) => b.change_bps - a.change_bps);
    const lb = await leaderboardFor(null);
    const news = await publishedNews();
    const showRound = status.phase === 'trading' || status.phase === 'awaiting_open' ? null : status.current_round;
    const out = {
      status,
      index: { value: indexOf(board, 'price'), previous: indexOf(board, 'prev_price') },
      rising: moved.filter((c) => c.change_bps > 0).length,
      falling: moved.filter((c) => c.change_bps < 0).length,
      prices: board.map(({ ticker, name, industry, price, prev_price, change_bps, is_tradable, price_round }) =>
        ({ ticker, name, industry, price, prev_price, change_bps, is_tradable, price_round })),
      gainers: byChange.filter((c) => c.change_bps > 0).slice(0, 5).map((c) => ({ ticker: c.ticker, name: c.name, change_bps: c.change_bps, price: c.price })),
      losers: byChange.filter((c) => c.change_bps < 0).reverse().slice(0, 5).map((c) => ({ ticker: c.ticker, name: c.name, change_bps: c.change_bps, price: c.price })),
      most_active: { round: lastSettled, rows: active },
      top_teams: lb.rows.slice(0, 5),
      leaderboard_round: lb.round_id,
      bulletins: showRound ? news.bulletins.filter((b) => b.round_id === showRound) : [],
    };
    if (status.status === 'finished') out.final = await finalSummary(board);
    return out;
  });
}

async function finalSummary(board) {
  const lb = await leaderboardFor(null);
  const perf = board.map((c) => ({ ticker: c.ticker, name: c.name, change_bps: Math.round(((c.price - c.initial_price) * 10000) / c.initial_price) }))
    .sort((a, b) => b.change_bps - a.change_bps);
  const { rows: [best] } = await db.query(
    `SELECT t.realized_pnl, t.quantity, t.round_id, c.ticker, tm.name AS team FROM trades t
       JOIN companies c ON c.id = t.company_id JOIN teams tm ON tm.id = t.team_id
      WHERE t.side = 'sell' AND t.source = 'order' AND NOT EXISTS (SELECT 1 FROM order_reversals rv WHERE rv.order_id = t.order_id)
      ORDER BY t.realized_pnl DESC LIMIT 1`);
  return {
    rankings: lb.rows,
    winner: lb.rows[0] || null,
    best_company: perf[0] || null,
    worst_company: perf[perf.length - 1] || null,
    largest_realized_trade: best && best.realized_pnl > 0 ? best : null,
  };
}

module.exports = {
  cached, invalidate, marketStatus, priceBoard, priceHistory, publishedNews, portfolio, transactions, leaderboardFor, roundSummary,
};
