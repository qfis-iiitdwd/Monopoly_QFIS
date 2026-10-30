const db = require('./db');
const { GameError } = require('./errors');

// Market gate. Orders and other team actions take it shared; round/pause/event transitions take it
// exclusively, so a transition waits only for in-flight orders and no order straddles one.
// This is an advisory lock rather than a row lock because the lock manager queues fairly: once
// Pause is waiting, new orders queue behind it. With FOR SHARE row locks, a continuous stream of
// overlapping orders can starve Pause/Close indefinitely (seen in scripts/stress.js).
const MARKET_GATE = 7310001;

async function getGameState(client = db, { lock } = {}) {
  if (lock === 'update') await client.query('SELECT pg_advisory_xact_lock($1)', [MARKET_GATE]);
  else if (lock === 'share') await client.query('SELECT pg_advisory_xact_lock_shared($1)', [MARKET_GATE]);
  // Read after the gate in a fresh statement, so it sees any transition that committed while we waited.
  const { rows } = await client.query('SELECT * FROM game_state WHERE id = 1' + (lock === 'update' ? ' FOR NO KEY UPDATE' : ''));
  if (!rows[0]) throw new GameError('Game has not been seeded', 503, 'not_seeded');
  return rows[0];
}

// Rounds change only under the exclusive market gate, so a holder of the shared gate needs no row lock.
async function getRound(client, id, { lock } = {}) {
  const suffix = lock === 'update' ? ' FOR NO KEY UPDATE' : '';
  const { rows } = await client.query('SELECT * FROM rounds WHERE id = $1' + suffix, [id]);
  if (!rows[0]) throw new GameError(`Round ${id} does not exist`, 404, 'not_found');
  return rows[0];
}

// Latest official price of every company (the price trading executes at during an open round).
async function currentPrices(client = db) {
  const { rows } = await client.query(
    `SELECT DISTINCT ON (company_id) company_id, round_id, price, prev_price, total_bps
       FROM stock_prices ORDER BY company_id, round_id DESC`);
  return new Map(rows.map((r) => [r.company_id, r]));
}

async function audit(client, adminId, action, reason, before, after) {
  await client.query(
    'INSERT INTO admin_audit_log (admin_id, action, reason, before_state, after_state) VALUES ($1, $2, $3, $4, $5)',
    [adminId || null, action, reason || null, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after)]);
}

// Appends a ledger entry and moves the team's cash in one statement. Caller must hold the team row lock.
async function moveCash(client, teamId, amount, type, { referenceType, referenceId, memo, createdBy, realizedPnl = 0 } = {}) {
  const { rows } = await client.query(
    `WITH t AS (UPDATE teams SET cash = cash + $2, realized_pnl = realized_pnl + $8 WHERE id = $1 RETURNING cash)
     INSERT INTO ledger_entries (team_id, transaction_type, amount, balance_after, reference_type, reference_id, memo, created_by)
     SELECT $1, $3, $2, t.cash, $4, $5, $6, $7 FROM t RETURNING balance_after`,
    [teamId, amount, type, referenceType || null, referenceId == null ? null : String(referenceId), memo || null, createdBy || 'system', realizedPnl]);
  if (!rows[0]) throw new GameError('Team not found', 404, 'not_found');
  return rows[0].balance_after;
}

module.exports = { getGameState, getRound, currentPrices, audit, moveCash };
