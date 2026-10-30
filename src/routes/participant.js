const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const views = require('../views');
const trading = require('../trading');
const loans = require('../loans');
const { GameError } = require('../errors');
const { h, intParam } = require('./util');

const router = express.Router();

router.post('/auth/login', h(async (req, res) => {
  const { team_id, password, member_name } = req.body || {};
  const { token, hours, team } = await auth.loginTeam(team_id, password, member_name);
  auth.setCookie(res, auth.TEAM_COOKIE, token, hours * 3600);
  res.json({ team });
}));

router.post('/auth/logout', h(async (req, res) => {
  await auth.logout(req, auth.TEAM_COOKIE);
  auth.setCookie(res, auth.TEAM_COOKIE, '', 0);
  res.json({ ok: true });
}));

// Public market information. No team data, no unreleased configuration.
router.get('/market/status', h(async (req, res) => res.json(await views.marketStatus())));
router.get('/market/prices', h(async (req, res) => res.json(await views.priceBoard())));
router.get('/market/history', h(async (req, res) => res.json(await views.priceHistory())));
router.get('/news/current', h(async (req, res) => res.json(await views.publishedNews())));

// Everything below needs a team session.
router.use(auth.requireTeam);

// Newspaper PDFs are served only after publication. Before that, they do not exist as far as
// players are concerned (papers/ is not a static directory). Logged-in players only.
const PAPERS_DIR = path.join(__dirname, '..', '..', 'papers');
router.get('/paper/:round', h(async (req, res) => {
  const { rows: [r] } = await db.query(
    'SELECT newspaper_pdf FROM rounds WHERE id = $1 AND newspaper_published_at IS NOT NULL', [intParam(req.params.round, 'round')]);
  if (!r || !r.newspaper_pdf) return res.status(404).json({ error: 'Not published', code: 'not_found' });
  const file = path.join(PAPERS_DIR, path.basename(r.newspaper_pdf));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Newspaper file missing on server', code: 'not_found' });
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.sendFile(file);
}));

router.get('/me', (req, res) => {
  res.json({ team: { id: req.session.team_id, name: req.session.team_name, access_identifier: req.session.access_identifier }, member_name: req.session.member_name });
});
router.get('/team', h(async (req, res) => res.json(await views.portfolio(req.session.team_id))));
router.get('/portfolio', h(async (req, res) => res.json(await views.portfolio(req.session.team_id))));
router.get('/transactions', h(async (req, res) => res.json(await views.transactions(req.session.team_id))));
router.get('/leaderboard', h(async (req, res) => {
  if ((await views.marketStatus()).leaderboard_visible === false) throw new GameError('Rankings are not shown to teams', 404, 'not_found');
  res.json(await views.leaderboardFor(req.session.team_id));
}));

router.get('/companies', h(async (req, res) => {
  const board = await views.priceBoard();
  const { rows } = await db.query('SELECT company_id, quantity, pledged_quantity FROM holdings WHERE team_id = $1', [req.session.team_id]);
  const mine = new Map(rows.map((r) => [r.company_id, r]));
  res.json(board.map((c) => ({ ...c, held: mine.get(c.id) ? mine.get(c.id).quantity : 0, pledged: mine.get(c.id) ? mine.get(c.id).pledged_quantity : 0 })));
}));

router.get('/companies/:id', h(async (req, res) => {
  const id = intParam(req.params.id, 'id');
  const board = await views.priceBoard();
  const company = board.find((c) => c.id === id);
  if (!company) throw new GameError('Company not found', 404, 'not_found');
  const history = (await views.priceHistory())[company.ticker] || [];
  const { rows: [holding] } = await db.query('SELECT quantity, pledged_quantity, cost_basis FROM holdings WHERE team_id = $1 AND company_id = $2', [req.session.team_id, id]);
  const { rows: trades } = await db.query(
    `SELECT id, round_id, side, quantity, execution_price, fee, cash_delta, executed_at, source FROM trades
      WHERE team_id = $1 AND company_id = $2 ORDER BY id DESC`, [req.session.team_id, id]);
  const news = (await views.publishedNews()).bulletins.filter((b) =>
    b.affected.split(',').map((s) => s.trim().toLowerCase()).some((a) => a === company.ticker.toLowerCase() || a === company.industry.toLowerCase()));
  res.json({ company, history, holding: holding || { quantity: 0, pledged_quantity: 0, cost_basis: 0 }, trades, news });
}));

// Per-team token bucket for writes. Five people tapping fast never get near it; a script
// hammering the endpoint gets 429s instead of filling the orders table and slowing everyone.
const BUCKET = { capacity: 30, perSecond: 10 };
const buckets = new Map();
function takeToken(teamId) {
  const now = Date.now();
  const b = buckets.get(teamId) || { tokens: BUCKET.capacity, at: now };
  b.tokens = Math.min(BUCKET.capacity, b.tokens + ((now - b.at) / 1000) * BUCKET.perSecond);
  b.at = now;
  buckets.set(teamId, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
const TOO_FAST = { error: 'Too many requests too quickly. Wait a moment and try again.', code: 'rate_limited' };
const throttle = (req, res, next) => (takeToken(req.session.team_id) ? next() : res.status(429).json(TOO_FAST));

router.post('/orders', h(async (req, res) => {
  const b = req.body || {};
  if (!takeToken(req.session.team_id)) {
    // A throttled retry of an order we already have still learns what happened to it.
    const k = b.idempotency_key;
    const prior = typeof k === 'string' && k.length <= 100 ? await trading.findOrder(db, req.session.team_id, k) : null;
    if (!prior) return res.status(429).json(TOO_FAST);
    return res.status(prior.status === 'executed' ? 200 : 422).json({ order: prior, duplicate: true });
  }
  // No coercion: "10", true or "0x10" are not quantities. The app always sends numbers.
  const result = await trading.placeOrder(req.session.team_id, {
    companyId: b.company_id,
    side: b.side,
    quantity: b.quantity,
    idempotencyKey: b.idempotency_key,
  }, req.session.member_name);
  res.status(result.order.status === 'executed' ? 200 : 422).json(result);
}));

router.get('/orders', h(async (req, res) => {
  const { rows } = await db.query(
    `SELECT o.*, c.ticker FROM orders o LEFT JOIN companies c ON c.id = o.company_id WHERE o.team_id = $1 ORDER BY o.id DESC LIMIT 300`,
    [req.session.team_id]);
  res.json(rows);
}));

router.get('/orders/:id', h(async (req, res) => {
  const { rows: [o] } = await db.query(
    `SELECT o.*, c.ticker, t.execution_price, t.gross, t.fee, t.cash_delta, t.cash_after FROM orders o
       LEFT JOIN companies c ON c.id = o.company_id LEFT JOIN trades t ON t.order_id = o.id
      WHERE o.id = $1 AND o.team_id = $2`, [intParam(req.params.id, 'id'), req.session.team_id]);
  if (!o) throw new GameError('Order not found', 404, 'not_found');
  res.json(o);
}));

router.get('/loans', h(async (req, res) => res.json(await loans.loanSummary(req.session.team_id))));
router.post('/loans', throttle, h(async (req, res) => {
  const b = req.body || {};
  res.json(await loans.borrow(req.session.team_id, { amount: Number(b.amount), collateral: b.collateral, requestKey: b.request_key }));
}));
router.post('/loans/:id/repay', throttle, h(async (req, res) => {
  res.json(await loans.repay(req.session.team_id, intParam(req.params.id, 'id')));
}));

module.exports = router;
