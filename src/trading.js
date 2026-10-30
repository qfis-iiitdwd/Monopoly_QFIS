// Order execution.
//
// Execution rule (publish this to teams): during an open round every order executes immediately,
// in full or not at all, at that round's official price (the price published at the end of the
// previous round). Prices never move during the window, so submitting first gives no price
// advantage. After the window closes, the round's aggregate net demand feeds the trading-pressure
// component of the next price. Buys also need exchange inventory, which is first-come-first-served.

const db = require('./db');
const { GameError } = require('./errors');

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

async function findOrder(client, teamId, key) {
  const { rows } = await client.query(
    `SELECT o.*, t.execution_price, t.gross, t.fee, t.cash_delta, t.cash_after, t.id AS trade_id
       FROM orders o LEFT JOIN trades t ON t.order_id = o.id
      WHERE o.team_id = $1 AND o.idempotency_key = $2`, [teamId, key]);
  return rows[0] || null;
}

// Returns { order, duplicate }. order.status is 'executed' or 'rejected'.
//
// The work happens in the mv_place_order() database function (src/schema.sql): a single round
// trip, so locks are never held across the network. Rejections are stored with their reason.
async function placeOrder(teamId, input, placedBy) {
  if (typeof input.idempotencyKey !== 'string' || !KEY_RE.test(input.idempotencyKey)) {
    throw new GameError('Missing or invalid idempotency key', 400, 'bad_request');
  }
  // No coercion: anything that isn't already an integer of the right range becomes NULL and is
  // rejected by the function with a clear reason.
  const int = (v, max) => (Number.isSafeInteger(v) && Math.abs(v) <= max ? v : null);
  const params = [
    teamId, input.idempotencyKey, int(input.companyId, 2 ** 31 - 1),
    typeof input.side === 'string' ? input.side.slice(0, 10) : null,
    int(input.quantity, Number.MAX_SAFE_INTEGER), placedBy || null,
  ];
  let result;
  for (let attempt = 1; ; attempt++) {
    try {
      ({ rows: [result] } = await db.query('SELECT duplicate, ord FROM mv_place_order_json($1, $2, $3, $4, $5, $6)', params));
      return { order: result.ord, duplicate: result.duplicate };
    } catch (err) {
      // Deadlock / serialization failure rolled everything back: safe to run again.
      if ((err.code === '40P01' || err.code === '40001') && attempt < 3) continue;
      // A concurrent duplicate won the race on (team_id, idempotency_key).
      if (err.code === '23505') return { order: await findOrder(db, teamId, input.idempotencyKey), duplicate: true };
      throw err;
    }
  }
}

module.exports = { placeOrder, findOrder };
