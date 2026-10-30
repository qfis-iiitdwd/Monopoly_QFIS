const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const market = require('../market');
const adminOps = require('../admin');
const views = require('../views');
const { getGameState, audit } = require('../state');
const { teamValuations, rank } = require('../valuation');
const { GameError } = require('../errors');
const { h, intParam } = require('./util');

const router = express.Router();
// Every admin request runs on the reserved admin connection pool.
router.use((req, res, next) => db.withPriority(next));
const PAPERS_DIR = path.join(__dirname, '..', '..', 'papers');

router.post('/login', h(async (req, res) => {
  const { username, password } = req.body || {};
  const { token, hours, admin } = await auth.loginAdmin(username, password);
  auth.setCookie(res, auth.ADMIN_COOKIE, token, hours * 3600);
  res.json({ admin });
}));

router.use(auth.requireAdmin);

// Any admin write invalidates the read caches so screens reflect it immediately.
router.use((req, res, next) => {
  if (req.method !== 'GET') res.on('finish', views.invalidate);
  next();
});

router.post('/logout', h(async (req, res) => {
  await auth.logout(req, auth.ADMIN_COOKIE);
  auth.setCookie(res, auth.ADMIN_COOKIE, '', 0);
  res.json({ ok: true });
}));
router.get('/me', (req, res) => res.json({ admin: { id: req.admin.admin_id, username: req.admin.username } }));

router.get('/overview', h(async (req, res) => {
  const t0 = Date.now();
  await db.query('SELECT 1');
  const dbLatency = Date.now() - t0;
  const gs = await getGameState();
  const { rows: rounds } = await db.query(
    `SELECT r.*, clock_timestamp() AS now,
            (SELECT COUNT(*)::int FROM orders o WHERE o.round_id = r.id AND o.status = 'executed') AS executed,
            (SELECT COUNT(*)::int FROM orders o WHERE o.round_id = r.id AND o.status = 'rejected') AS rejected,
            (SELECT COUNT(DISTINCT o.team_id)::int FROM orders o WHERE o.round_id = r.id AND o.status = 'executed') AS teams_traded,
            (SELECT COALESCE(SUM(t.gross), 0)::bigint FROM trades t WHERE t.round_id = r.id AND t.source = 'order') AS traded_value,
            (SELECT COALESCE(SUM(t.quantity) FILTER (WHERE t.side = 'buy'), 0)::bigint FROM trades t WHERE t.round_id = r.id AND t.source = 'order') AS bought_shares,
            (SELECT COALESCE(SUM(t.quantity) FILTER (WHERE t.side = 'sell'), 0)::bigint FROM trades t WHERE t.round_id = r.id AND t.source = 'order') AS sold_shares,
            (SELECT COUNT(*)::int FROM news_items n WHERE n.round_id = r.id) AS bulletins,
            (SELECT COUNT(*)::int FROM scheduled_events e WHERE e.effective_round = r.id) AS events
       FROM rounds r ORDER BY r.id`);
  for (const r of rounds) r.pdf_present = !!(r.newspaper_pdf && fs.existsSync(path.join(PAPERS_DIR, path.basename(r.newspaper_pdf))));
  const { rows: [counts] } = await db.query(
    `SELECT (SELECT COUNT(*)::int FROM teams WHERE is_active) AS teams,
            (SELECT COUNT(*)::int FROM teams WHERE NOT is_active) AS teams_disabled,
            (SELECT COUNT(*)::int FROM companies) AS companies,
            (SELECT COUNT(*)::int FROM companies WHERE is_tradable) AS companies_tradable,
            (SELECT COUNT(DISTINCT team_id)::int FROM sessions WHERE kind = 'team' AND expires_at > now()) AS teams_logged_in,
            (SELECT COUNT(*)::int FROM sessions WHERE kind = 'team' AND expires_at > now()) AS sessions`);
  const { rows: auditRows } = await db.query(
    `SELECT l.id, l.action, l.reason, l.created_at, a.username FROM admin_audit_log l LEFT JOIN admins a ON a.id = l.admin_id
      ORDER BY l.id DESC LIMIT 15`);
  const { rows: errors } = await db.query(`SELECT * FROM system_log WHERE level = 'error' ORDER BY id DESC LIMIT 5`);
  const stats = (p) => ({ total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount, max: p.options.max });
  const pool = { ...stats(db.pool), admin: stats(db.adminPool) };
  res.json({ state: gs, rounds, counts, db_latency_ms: dbLatency, pool, server_time: new Date().toISOString(), recent_audit: auditRows, recent_errors: errors });
}));

// --- Event and round control -------------------------------------------------------------
router.post('/event/start', h(async (req, res) => res.json(await market.startEvent(req.admin.admin_id))));
router.post('/event/end', h(async (req, res) => res.json(await market.endEvent(req.admin.admin_id))));
router.post('/pause', h(async (req, res) => res.json(await market.setPaused(true, req.admin.admin_id, { reason: req.body && req.body.reason }))));
router.post('/resume', h(async (req, res) => {
  const extend = !(req.body && req.body.extend === false);
  res.json(await market.setPaused(false, req.admin.admin_id, { extend, reason: req.body && req.body.reason }));
}));
router.post('/message', h(async (req, res) => res.json(await market.setMessage(req.body && req.body.message, req.admin.admin_id))));

const roundAction = (fn) => h(async (req, res) => res.json(await fn(intParam(req.params.id, 'round'), req)));
router.post('/rounds/:id/publish-newspaper', roundAction((id, req) => market.publishNewspaper(id, req.admin.admin_id)));
router.post('/rounds/:id/open', roundAction((id, req) => market.openRound(id, req.admin.admin_id)));
router.post('/rounds/:id/close', roundAction((id, req) => market.closeRound(id, req.admin.admin_id)));
router.post('/rounds/:id/extend', roundAction((id, req) =>
  market.extendRound(id, Number(req.body && req.body.seconds), req.admin.admin_id, req.body && req.body.reason)));
router.post('/rounds/:id/reopen', roundAction((id, req) =>
  market.reopenRound(id, Number(req.body && req.body.seconds), req.admin.admin_id, req.body && req.body.reason)));
router.post('/rounds/:id/undo-market-update', roundAction((id, req) => market.undoMarketUpdate(id, req.admin.admin_id, req.body && req.body.reason)));
router.post('/rounds/:id/publish-news', roundAction((id, req) => market.publishBulletin(id, req.admin.admin_id)));
router.get('/rounds/:id/preview', roundAction((id) => market.previewMarketUpdate(id)));
router.post('/rounds/:id/apply-market-update', roundAction((id, req) => market.applyMarketUpdate(id, req.admin.admin_id)));

// Admin-only preview of a newspaper regardless of publication.
router.get('/rounds/:id/paper', h(async (req, res) => {
  const { rows: [r] } = await db.query('SELECT newspaper_pdf FROM rounds WHERE id = $1', [intParam(req.params.id, 'round')]);
  const file = r && r.newspaper_pdf && path.join(PAPERS_DIR, path.basename(r.newspaper_pdf));
  if (!file || !fs.existsSync(file)) throw new GameError('No newspaper file for this round', 404, 'not_found');
  res.sendFile(file);
}));

// Round summary for the presentation slides: prices and changes, top gainers/losers, most traded,
// top teams, this round's headlines, and (after the event) the final results.
router.get('/summary', h(async (req, res) => res.json(await views.roundSummary())));

router.get('/events', h(async (req, res) => {
  const { rows: events } = await db.query('SELECT * FROM scheduled_events ORDER BY effective_round, id');
  const { rows: news } = await db.query('SELECT * FROM news_items ORDER BY round_id, sort_order, id');
  res.json({ events, news });
}));

router.patch('/events/:id', h(async (req, res) => {
  const b = req.body || {};
  res.json(await market.updateEvent(String(req.params.id), b.configuration, req.admin.admin_id, b.reason));
}));

// --- Companies ---------------------------------------------------------------------------
router.get('/companies', h(async (req, res) => {
  const board = await views.priceBoard();
  const { rows } = await db.query(
    `SELECT c.*, COALESCE(SUM(h.quantity), 0)::bigint AS held_by_teams FROM companies c
       LEFT JOIN holdings h ON h.company_id = c.id GROUP BY c.id ORDER BY c.ticker`);
  const price = new Map(board.map((b) => [b.id, b]));
  res.json(rows.map((c) => ({ ...c, price: price.get(c.id).price, change_bps: price.get(c.id).change_bps })));
}));
router.patch('/companies/:id', h(async (req, res) => {
  const { reason, ...patch } = req.body || {};
  res.json(await adminOps.updateCompany(req.admin.admin_id, intParam(req.params.id, 'id'), patch, reason));
}));
router.post('/companies/:id/trading', h(async (req, res) => {
  const b = req.body || {};
  res.json(await adminOps.setTradable(req.admin.admin_id, intParam(req.params.id, 'id'), !!b.tradable, b.reason));
}));

// --- Teams -------------------------------------------------------------------------------
router.get('/teams', h(async (req, res) => {
  const all = await teamValuations(db, { includeInactive: true });
  const ranked = [...rank(all.filter((v) => v.is_active)), ...all.filter((v) => !v.is_active).map((v) => ({ ...v, rank: null, tied: false }))];
  const { rows: s } = await db.query(
    `SELECT team_id, COUNT(*)::int AS sessions FROM sessions WHERE kind = 'team' AND expires_at > now() GROUP BY team_id`);
  const sessions = new Map(s.map((r) => [r.team_id, r.sessions]));
  const { rows: ids } = await db.query(
    `SELECT t.id, t.access_identifier,
            (SELECT array_agg(DISTINCT o.placed_by) FROM orders o WHERE o.team_id = t.id AND o.placed_by IS NOT NULL) AS members,
            (SELECT COUNT(*)::int FROM orders o WHERE o.team_id = t.id AND o.status = 'executed') AS executed_orders
       FROM teams t`);
  const ident = new Map(ids.map((r) => [r.id, r]));
  const gs = await getGameState();
  res.json(ranked.map((v) => ({
    ...v, access_identifier: ident.get(v.team_id).access_identifier, members: ident.get(v.team_id).members || [],
    executed_orders: ident.get(v.team_id).executed_orders, total_pnl: v.net_worth - gs.settings.starting_cash,
    sessions: sessions.get(v.team_id) || 0,
  })));
}));
router.get('/teams/:id', h(async (req, res) => {
  const id = intParam(req.params.id, 'id');
  const { rows: [exists] } = await db.query('SELECT 1 FROM teams WHERE id = $1', [id]);
  if (!exists) throw new GameError('Team not found', 404, 'not_found');
  const portfolio = await views.portfolio(id);
  const tx = await views.transactions(id, 1000);
  const { rows: ledger } = await db.query('SELECT * FROM ledger_entries WHERE team_id = $1 ORDER BY id DESC', [id]);
  const { rows: loans } = await db.query('SELECT * FROM loans WHERE team_id = $1 ORDER BY id DESC', [id]);
  res.json({ portfolio, orders: tx.orders, ledger, loans });
}));
// Net worth after each settled round (from the end-of-round snapshots), plus now.
router.get('/teams/:id/history', h(async (req, res) => {
  const id = intParam(req.params.id, 'id');
  const gs = await getGameState();
  const { rows } = await db.query(
    'SELECT round_id, rank, net_worth, cash, holdings_value FROM leaderboard_snapshots WHERE team_id = $1 ORDER BY round_id', [id]);
  const [now] = await teamValuations(db, { teamId: id });
  if (!now) throw new GameError('Team not found', 404, 'not_found');
  res.json({ starting_cash: gs.settings.starting_cash, rounds: rows, now: { net_worth: now.net_worth, cash: now.cash, holdings_value: now.holdings_value } });
}));
router.post('/teams/:id/active', h(async (req, res) => {
  const b = req.body || {};
  const id = intParam(req.params.id, 'id');
  const out = await adminOps.setTeamActive(req.admin.admin_id, id, b.active, b.reason);
  auth.forgetTeamSessions(id);
  res.json(out);
}));
router.post('/teams/:id/adjust-cash', h(async (req, res) => {
  const b = req.body || {};
  res.json(await adminOps.adjustCash(req.admin.admin_id, intParam(req.params.id, 'id'), Number(b.amount), b.reason));
}));
router.post('/teams/:id/adjust-holdings', h(async (req, res) => {
  const b = req.body || {};
  res.json(await adminOps.adjustHoldings(req.admin.admin_id, intParam(req.params.id, 'id'), Number(b.company_id), Number(b.delta), b.reason));
}));
router.post('/orders/:id/reverse', h(async (req, res) => {
  res.json(await adminOps.reverseOrder(req.admin.admin_id, intParam(req.params.id, 'id'), req.body && req.body.reason));
}));
router.post('/teams/:id/reset-password', h(async (req, res) => {
  const id = intParam(req.params.id, 'id');
  const password = crypto.randomBytes(4).toString('hex');
  await db.tx(async (c) => {
    const { rowCount } = await c.query('UPDATE teams SET password = $2 WHERE id = $1', [id, password]);
    if (!rowCount) throw new GameError('Team not found', 404, 'not_found');
    await c.query(`DELETE FROM sessions WHERE team_id = $1`, [id]);
    await audit(c, req.admin.admin_id, 'reset_team_password', req.body && req.body.reason, null, { team_id: id });
  });
  auth.forgetTeamSessions(id);
  res.json({ password });
}));
router.post('/rewards', h(async (req, res) => {
  const b = req.body || {};
  res.json(await adminOps.grantReward(req.admin.admin_id, b.team_ids, b.quest, Number(b.amount), b.reason));
}));

// --- Inspection --------------------------------------------------------------------------
router.get('/orders', h(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.status) { params.push(String(req.query.status)); where.push(`o.status = $${params.length}`); }
  if (req.query.round) { params.push(intParam(req.query.round, 'round')); where.push(`o.round_id = $${params.length}`); }
  params.push(Math.min(Math.max(req.query.limit ? intParam(req.query.limit, 'limit') : 500, 1), 20000));
  const { rows } = await db.query(
    `SELECT o.*, c.ticker, tm.name AS team_name, t.execution_price, t.cash_delta, rv.created_at AS reversed_at, rv.reason AS reversal_reason
       FROM orders o JOIN teams tm ON tm.id = o.team_id LEFT JOIN companies c ON c.id = o.company_id LEFT JOIN trades t ON t.order_id = o.id
       LEFT JOIN order_reversals rv ON rv.order_id = o.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.id DESC LIMIT $${params.length}`, params);
  res.json(rows);
}));

// Same team, company, side and quantity within 15 seconds under different idempotency keys:
// probably a human double-submission rather than a retry. Shown for review, not auto-reversed.
router.get('/orders/suspected-duplicates', h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT a.id AS first_order, b.id AS second_order, tm.name AS team_name, c.ticker, a.side, a.quantity, a.round_id,
            EXTRACT(EPOCH FROM (b.submitted_at - a.submitted_at))::numeric(6,2) AS seconds_apart
       FROM orders a JOIN orders b ON b.team_id = a.team_id AND b.company_id = a.company_id AND b.side = a.side
            AND b.quantity = a.quantity AND b.id > a.id AND b.submitted_at - a.submitted_at < interval '15 seconds'
       JOIN teams tm ON tm.id = a.team_id JOIN companies c ON c.id = a.company_id
      WHERE a.status = 'executed' AND b.status = 'executed'
        AND NOT EXISTS (SELECT 1 FROM order_reversals rv WHERE rv.order_id IN (a.id, b.id))
      ORDER BY a.id DESC LIMIT 200`);
  res.json(rows);
}));

// Every cash movement of every team, newest first. Paginate with ?before=<id>.
// round = the round that was current when the entry was written (from the linked trade where there is one).
const LEDGER_TYPES = ['initial_deposit', 'trade_buy', 'trade_sell', 'trade_reversal', 'adjustment', 'quest_reward',
  'loan_disbursement', 'loan_repayment', 'liquidation'];
router.get('/ledger', h(async (req, res) => {
  const params = [];
  const where = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.team) add('l.team_id = ?', intParam(req.query.team, 'team'));
  if (req.query.type) {
    if (!LEDGER_TYPES.includes(String(req.query.type))) throw new GameError('Unknown transaction type');
    add('l.transaction_type = ?', String(req.query.type));
  }
  if (req.query.before) add('l.id < ?', intParam(req.query.before, 'before'));
  if (req.query.round) add('COALESCE(tr.round_id, rv.round_id) = ?', intParam(req.query.round, 'round'));
  params.push(Math.min(Math.max(req.query.limit ? intParam(req.query.limit, 'limit') : 500, 1), 5000));
  const { rows } = await db.query(
    `SELECT l.id, l.team_id, tm.name AS team_name, l.transaction_type, l.amount, l.balance_after, l.reference_type, l.reference_id,
            l.memo, l.created_at, l.created_by, COALESCE(tr.round_id, rv.round_id) AS round_id,
            c.ticker, COALESCE(tr.side, rv.side) AS side, COALESCE(tr.quantity, rv.quantity) AS quantity,
            COALESCE(tr.execution_price, rv.execution_price) AS price, tr.fee, tr.order_id
       FROM ledger_entries l JOIN teams tm ON tm.id = l.team_id
       LEFT JOIN trades tr ON l.reference_type = 'order' AND tr.order_id::text = l.reference_id
       LEFT JOIN trades rv ON l.reference_type = 'reversal' AND rv.source = 'reversal'
            AND rv.id = (SELECT trade_id FROM order_reversals WHERE order_id::text = l.reference_id)
       LEFT JOIN companies c ON c.id = COALESCE(tr.company_id, rv.company_id)
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.id DESC LIMIT $${params.length}`, params);
  const { rows: totals } = await db.query(
    'SELECT transaction_type, COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::bigint AS amount FROM ledger_entries GROUP BY transaction_type');
  res.json({ rows, totals });
}));

router.get('/audit-log', h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT l.*, a.username FROM admin_audit_log l LEFT JOIN admins a ON a.id = l.admin_id ORDER BY l.id DESC LIMIT 500`);
  res.json(rows);
}));
router.get('/system-log', h(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM system_log ORDER BY id DESC LIMIT 200');
  res.json(rows);
}));
router.get('/integrity', h(async (req, res) => res.json({ problems: await adminOps.integrityCheck(), checked_at: new Date().toISOString() })));

router.use((req, res) => res.status(404).json({ error: 'Not found', code: 'not_found' }));

module.exports = router;
