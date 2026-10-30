// Administrative operations other than round control. Every change here writes an audit entry
// and, where money moves, a ledger entry. Nothing silently overwrites financial history.

const db = require('./db');
const { GameError } = require('./errors');
const { isPositiveInt, rupees } = require('./money');
const { getGameState, audit, moveCash, currentPrices } = require('./state');
const { validDetails } = require('./seed');

function requireReason(reason) {
  if (typeof reason !== 'string' || reason.trim().length < 5) throw new GameError('A reason (at least 5 characters) is required');
  return reason.trim();
}

async function adjustCash(adminId, teamId, amount, reason) {
  reason = requireReason(reason);
  if (!Number.isSafeInteger(amount) || amount === 0) throw new GameError('Amount must be a non-zero whole number of paise');
  return db.tx(async (c) => {
    await getGameState(c, { lock: 'share' });
    const { rows: [team] } = await c.query('SELECT id, name, cash FROM teams WHERE id = $1 FOR NO KEY UPDATE', [teamId]);
    if (!team) throw new GameError('Team not found', 404, 'not_found');
    if (team.cash + amount < 0) throw new GameError('Adjustment would make cash negative');
    const after = await moveCash(c, teamId, amount, 'adjustment', { referenceType: 'admin', memo: reason, createdBy: `admin:${adminId}` });
    await audit(c, adminId, 'adjust_cash', reason, { team: team.name, cash: team.cash }, { team: team.name, cash: after, amount });
    return { cash: after };
  });
}

// Moves shares between the exchange inventory and a team, keeping the float conserved.
async function adjustHoldings(adminId, teamId, companyId, delta, reason) {
  reason = requireReason(reason);
  if (!Number.isSafeInteger(delta) || delta === 0) throw new GameError('Share delta must be a non-zero whole number');
  return db.tx(async (c) => {
    await getGameState(c, { lock: 'share' });
    const { rows: [team] } = await c.query('SELECT id, name FROM teams WHERE id = $1 FOR NO KEY UPDATE', [teamId]);
    if (!team) throw new GameError('Team not found', 404, 'not_found');
    const { rows: [co] } = await c.query('SELECT * FROM companies WHERE id = $1 FOR NO KEY UPDATE', [companyId]);
    if (!co) throw new GameError('Company not found', 404, 'not_found');
    const { rows: [h] } = await c.query('SELECT * FROM holdings WHERE team_id = $1 AND company_id = $2 FOR NO KEY UPDATE', [teamId, companyId]);
    const before = h ? h.quantity : 0;
    if (before + delta < (h ? h.pledged_quantity : 0)) throw new GameError('Cannot remove shares below the pledged quantity');
    if (delta > 0 && co.exchange_inventory < delta) throw new GameError('Not enough exchange inventory');
    // Cost basis: added shares carry the current official price; removed shares remove basis proportionally.
    const prices = await currentPrices(c);
    const basisDelta = delta > 0 ? delta * prices.get(companyId).price : -Math.round((h.cost_basis * -delta) / h.quantity);
    // Removals must be a plain UPDATE: Postgres checks an INSERT row's constraints before ON CONFLICT.
    await c.query(delta > 0
      ? `INSERT INTO holdings (team_id, company_id, quantity, cost_basis) VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id, company_id) DO UPDATE SET quantity = holdings.quantity + $3, cost_basis = holdings.cost_basis + $4`
      : 'UPDATE holdings SET quantity = quantity + $3, cost_basis = cost_basis + $4 WHERE team_id = $1 AND company_id = $2',
    [teamId, companyId, delta, basisDelta]);
    await c.query('UPDATE companies SET exchange_inventory = exchange_inventory - $2 WHERE id = $1', [companyId, delta]);
    await audit(c, adminId, 'adjust_holdings', reason, { team: team.name, ticker: co.ticker, quantity: before },
      { team: team.name, ticker: co.ticker, quantity: before + delta, delta });
    return { quantity: before + delta };
  });
}

async function grantReward(adminId, teamIds, questKey, amount, reason) {
  reason = requireReason(reason);
  if (typeof questKey !== 'string' || !questKey.trim()) throw new GameError('Quest name is required');
  if (!Array.isArray(teamIds) || !teamIds.length) throw new GameError('Choose at least one team');
  return db.tx(async (c) => {
    const gs = await getGameState(c, { lock: 'share' });
    if (!isPositiveInt(amount)) throw new GameError('Reward must be a positive whole number of paise');
    if (amount > gs.settings.max_reward) throw new GameError(`Reward exceeds the cap of ₹${gs.settings.max_reward / 100}`);
    const results = [];
    for (const teamId of [...new Set(teamIds.map(Number))].sort((a, b) => a - b)) {
      await c.query('SELECT id FROM teams WHERE id = $1 FOR NO KEY UPDATE', [teamId]);
      const { rows } = await c.query(
        `INSERT INTO quest_awards (team_id, quest_key, amount) VALUES ($1, $2, $3)
         ON CONFLICT (team_id, quest_key) DO NOTHING RETURNING id`, [teamId, questKey.trim(), amount]);
      if (!rows[0]) { results.push({ team_id: teamId, skipped: 'already rewarded for this quest' }); continue; }
      const cash = await moveCash(c, teamId, amount, 'quest_reward',
        { referenceType: 'quest', referenceId: rows[0].id, memo: questKey.trim(), createdBy: `admin:${adminId}` });
      results.push({ team_id: teamId, cash });
    }
    await audit(c, adminId, 'grant_reward', reason, null, { quest: questKey, amount, results });
    return results;
  });
}

async function setTradable(adminId, companyId, tradable, reason) {
  reason = requireReason(reason);
  return db.tx(async (c) => {
    const { rows: [co] } = await c.query('SELECT * FROM companies WHERE id = $1 FOR NO KEY UPDATE', [companyId]);
    if (!co) throw new GameError('Company not found', 404, 'not_found');
    await c.query('UPDATE companies SET is_tradable = $2, suspension_reason = $3 WHERE id = $1', [companyId, !!tradable, tradable ? null : reason]);
    await audit(c, adminId, tradable ? 'resume_company' : 'suspend_company', reason, { ticker: co.ticker, is_tradable: co.is_tradable }, { ticker: co.ticker, is_tradable: !!tradable });
    return { ticker: co.ticker, is_tradable: !!tradable };
  });
}

// Undoes an executed order as if it had never happened: shares go back to (or come from) the
// exchange, the full cash amount including the fee is returned, and realised P&L is restored.
// Recorded as an offsetting 'reversal' trade plus a ledger entry; the original order is untouched.
// Refused, with the reason, when the team no longer has the shares or cash to undo it.
async function reverseOrder(adminId, orderId, reason) {
  reason = requireReason(reason);
  return db.tx(async (c) => {
    const gs = await getGameState(c, { lock: 'share' });
    if (gs.status === 'finished') throw new GameError('The event has finished; rankings are frozen', 409, 'conflict');
    const { rows: [o] } = await c.query(
      `SELECT o.*, t.id AS trade_id, t.execution_price, t.gross, t.fee, t.cash_delta, t.realized_pnl
         FROM orders o LEFT JOIN trades t ON t.order_id = o.id WHERE o.id = $1`, [orderId]);
    if (!o) throw new GameError('Order not found', 404, 'not_found');
    if (o.status !== 'executed') throw new GameError('Only executed orders can be reversed');
    const { rows: [team] } = await c.query('SELECT id, name, cash FROM teams WHERE id = $1 FOR NO KEY UPDATE', [o.team_id]);
    const { rows: [done] } = await c.query('SELECT * FROM order_reversals WHERE order_id = $1', [orderId]);
    if (done) throw new GameError(`Order #${orderId} was already reversed`, 409, 'conflict');
    const { rows: [co] } = await c.query('SELECT * FROM companies WHERE id = $1 FOR NO KEY UPDATE', [o.company_id]);
    const { rows: [h] } = await c.query('SELECT * FROM holdings WHERE team_id = $1 AND company_id = $2 FOR NO KEY UPDATE', [o.team_id, o.company_id]);

    const cashDelta = -o.cash_delta;
    let basisDelta;
    if (o.side === 'buy') {
      const free = h ? h.quantity - h.pledged_quantity : 0;
      if (free < o.quantity) {
        throw new GameError(`${team.name} now has only ${free} unpledged ${co.ticker} shares, so this buy of ${o.quantity} cannot be undone. ` +
          'Reverse their later sells of this stock first, or use Adjust holdings / Adjust cash.', 409, 'conflict');
      }
      // Remove what this buy added (gross + fee), but never more than is there; zero once no shares remain.
      basisDelta = h.quantity === o.quantity ? -h.cost_basis : -Math.min(h.cost_basis, -o.cash_delta);
    } else {
      if (team.cash < o.cash_delta) {
        throw new GameError(`${team.name} has ${rupees(team.cash)} but undoing this sale takes back ${rupees(o.cash_delta)}. ` +
          'Reverse their later buys first, or use Adjust holdings / Adjust cash.', 409, 'conflict');
      }
      if (co.exchange_inventory < o.quantity) {
        throw new GameError(`Only ${co.exchange_inventory} ${co.ticker} shares are left on the exchange; other teams bought the rest`, 409, 'conflict');
      }
      basisDelta = o.cash_delta - o.realized_pnl; // the basis this sale removed
    }
    const qtyDelta = o.side === 'buy' ? -o.quantity : o.quantity;
    // The holding row exists: the original buy created it, or the original sale needed it (rows are never deleted).
    await c.query('UPDATE holdings SET quantity = quantity + $3, cost_basis = cost_basis + $4 WHERE team_id = $1 AND company_id = $2',
      [o.team_id, o.company_id, qtyDelta, basisDelta]);
    await c.query('UPDATE companies SET exchange_inventory = exchange_inventory - $2 WHERE id = $1', [o.company_id, qtyDelta]);
    const memo = `Reversal of order #${o.id}: ${o.side.toUpperCase()} ${o.quantity} ${co.ticker} @ ${o.execution_price}`;
    const cash = await moveCash(c, o.team_id, cashDelta, 'trade_reversal',
      { referenceType: 'reversal', referenceId: o.id, memo, createdBy: `admin:${adminId}`, realizedPnl: -o.realized_pnl });
    const { rows: [t] } = await c.query(
      `INSERT INTO trades (team_id, round_id, company_id, side, source, quantity, execution_price, gross, fee, cash_delta, cash_after, realized_pnl)
       VALUES ($1, $2, $3, $4, 'reversal', $5, $6, $7, 0, $8, $9, $10) RETURNING id`,
      [o.team_id, o.round_id, o.company_id, o.side === 'buy' ? 'sell' : 'buy', o.quantity, o.execution_price, o.gross, cashDelta, cash, -o.realized_pnl]);
    await c.query('INSERT INTO order_reversals (order_id, trade_id, admin_id, reason) VALUES ($1, $2, $3, $4)', [o.id, t.id, adminId, reason]);
    await audit(c, adminId, 'reverse_order', reason,
      { order: o.id, team: team.name, side: o.side, ticker: co.ticker, quantity: o.quantity, cash: team.cash, round: o.round_id },
      { team: team.name, cash, reversal_trade: t.id });
    return { order_id: o.id, reversal_trade_id: t.id, team: team.name, cash };
  });
}

const EDITABLE = ['name', 'industry', 'description', 'ceo', 'details', 'max_order_quantity', 'pressure_ref_qty', 'loan_eligible'];
const EDITABLE_LIVE = ['description', 'ceo', 'details', 'max_order_quantity'];

// Company configuration is frozen once the event starts, except the story text players read
// (description, CEO, details) and max order size, which can be changed as logged corrections.
async function updateCompany(adminId, companyId, patch, reason) {
  return db.tx(async (c) => {
    const gs = await getGameState(c, { lock: 'share' });
    const { rows: [co] } = await c.query('SELECT * FROM companies WHERE id = $1 FOR NO KEY UPDATE', [companyId]);
    if (!co) throw new GameError('Company not found', 404, 'not_found');
    const allowed = gs.status === 'setup' ? EDITABLE : EDITABLE_LIVE;
    if (gs.status !== 'setup') reason = requireReason(reason);
    const sets = [];
    const vals = [companyId];
    for (const k of Object.keys(patch || {})) {
      if (!allowed.includes(k)) throw new GameError(`${k} cannot be changed ${gs.status === 'setup' ? '' : 'after the event starts'}`.trim());
      if ((k === 'max_order_quantity' || k === 'pressure_ref_qty') && !isPositiveInt(patch[k])) throw new GameError(`${k} must be a positive integer`);
      if (['name', 'industry', 'description', 'ceo'].includes(k) && (typeof patch[k] !== 'string' || patch[k].length > 2000)) throw new GameError(`${k} must be text`);
      if (k === 'details' && !validDetails(patch[k])) throw new GameError('details must be an object of short text values');
      vals.push(k === 'details' ? JSON.stringify(patch[k]) : patch[k]);
      sets.push(`${k} = $${vals.length}`);
    }
    if (!sets.length) return co;
    const { rows: [updated] } = await c.query(`UPDATE companies SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    await audit(c, adminId, 'update_company', reason || 'pre-event configuration', co, updated);
    return updated;
  });
}

// Cross-checks that the books balance. Returns a list of problems (empty = healthy).
async function integrityCheck() {
  const problems = [];
  const q = async (sql, label) => {
    const { rows } = await db.query(sql);
    for (const r of rows) problems.push({ check: label, detail: r });
  };
  await q(`SELECT c.ticker, c.float_shares, c.exchange_inventory, COALESCE(SUM(h.quantity), 0)::bigint AS held
             FROM companies c LEFT JOIN holdings h ON h.company_id = c.id
            GROUP BY c.id HAVING c.exchange_inventory + COALESCE(SUM(h.quantity), 0) <> c.float_shares`, 'share supply conserved');
  await q(`SELECT t.id, t.name, t.cash, COALESCE(SUM(l.amount), 0)::bigint AS ledger_sum
             FROM teams t LEFT JOIN ledger_entries l ON l.team_id = t.id
            GROUP BY t.id HAVING t.cash <> COALESCE(SUM(l.amount), 0)`, 'cash equals ledger total');
  await q(`SELECT h.team_id, h.company_id, h.pledged_quantity, COALESCE(x.q, 0)::bigint AS collateral
             FROM holdings h LEFT JOIN (
               SELECT c.team_id, c.company_id, SUM(c.quantity) AS q FROM collateral c JOIN loans l ON l.id = c.loan_id
                WHERE l.status = 'active' AND NOT c.released GROUP BY c.team_id, c.company_id) x
               ON x.team_id = h.team_id AND x.company_id = h.company_id
            WHERE h.pledged_quantity <> COALESCE(x.q, 0)`, 'pledged shares match active collateral');
  await q(`SELECT o.id, o.team_id FROM orders o LEFT JOIN trades t ON t.order_id = o.id
            WHERE o.status = 'executed' AND t.id IS NULL`, 'every executed order has a trade');
  await q(`SELECT t.id AS trade_id FROM trades t LEFT JOIN ledger_entries l
               ON l.reference_type = 'order' AND l.reference_id = t.order_id::text
            WHERE t.source = 'order' AND l.id IS NULL`, 'every trade has a ledger entry');
  await q(`SELECT r.id AS round_id, COUNT(sp.company_id)::int AS priced
             FROM rounds r LEFT JOIN stock_prices sp ON sp.round_id = r.id
            WHERE r.market_update_status = 'done' GROUP BY r.id
           HAVING COUNT(sp.company_id) <> (SELECT COUNT(*) FROM companies)`, 'settled rounds priced every company');
  await q(`SELECT company_id, round_id, price FROM stock_prices WHERE price <= 0`, 'prices positive');
  return problems;
}

// A disabled team cannot log in or trade, and drops out of the rankings. Its holdings and history
// stay untouched, so re-enabling restores it exactly.
async function setTeamActive(adminId, teamId, active, reason) {
  reason = requireReason(reason);
  if (typeof active !== 'boolean') throw new GameError('active must be true or false');
  return db.tx(async (c) => {
    const { rows: [team] } = await c.query('SELECT id, name, is_active FROM teams WHERE id = $1 FOR NO KEY UPDATE', [teamId]);
    if (!team) throw new GameError('Team not found', 404, 'not_found');
    await c.query('UPDATE teams SET is_active = $2 WHERE id = $1', [teamId, active]);
    if (!active) await c.query(`DELETE FROM sessions WHERE team_id = $1`, [teamId]);
    await audit(c, adminId, active ? 'enable_team' : 'disable_team', reason, { team: team.name, is_active: team.is_active }, { team: team.name, is_active: active });
    return { team_id: teamId, name: team.name, is_active: active };
  });
}

module.exports = { setTeamActive, adjustCash, adjustHoldings, reverseOrder, grantReward, setTradable, updateCompany, integrityCheck };
