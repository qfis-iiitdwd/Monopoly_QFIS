// Margin Bank: loans secured by pledged shares. Disabled unless settings.loans.enabled.
//
// Rules (publish these to teams before the event):
//  - Borrow only while a round's trading window is open, up to and including last_borrow_round.
//  - Max borrowing for a request = value of the newly pledged shares × LTV, rounded down.
//  - Total outstanding principal per team is capped at max_loan_per_team.
//  - Simple interest: interest_bps_per_round × principal is added at every market update while the loan is active.
//  - Repayment is in full (principal + interest) and releases all of that loan's collateral.
//  - Loans still active at the due_round market update (and at final settlement) are liquidated:
//    pledged shares are sold at the new official price until the debt is covered, then remaining
//    cash pays any shortfall. Debt that still cannot be covered stays as a defaulted liability.

const db = require('./db');
const { GameError } = require('./errors');
const { divRound, ceilBps, isPositiveInt } = require('./money');
const { getGameState, getRound, currentPrices, moveCash } = require('./state');

function assertLoansEnabled(settings) {
  if (!settings.loans.enabled) throw new GameError('The Margin Bank is not open in this event', 403, 'loans_disabled');
}

async function listLoans(teamId, client = db) {
  const { rows: loans } = await client.query('SELECT * FROM loans WHERE team_id = $1 ORDER BY id DESC', [teamId]);
  const { rows: coll } = await client.query(
    `SELECT c.loan_id, c.company_id, c.quantity, c.released, co.ticker FROM collateral c
       JOIN companies co ON co.id = c.company_id WHERE c.team_id = $1`, [teamId]);
  for (const l of loans) l.collateral = coll.filter((c) => c.loan_id === l.id);
  return loans;
}

async function loanSummary(teamId) {
  const gs = await getGameState();
  const s = gs.settings.loans;
  const prices = await currentPrices();
  const { rows: holdings } = await db.query(
    `SELECT h.company_id, h.quantity, h.pledged_quantity, c.ticker, c.name, c.loan_eligible
       FROM holdings h JOIN companies c ON c.id = h.company_id WHERE h.team_id = $1 AND h.quantity > 0 ORDER BY c.ticker`, [teamId]);
  const loans = await listLoans(teamId);
  const active = loans.filter((l) => l.status === 'active');
  let pledgedValue = 0;
  let freeEligibleValue = 0;
  const eligible = holdings.map((h) => {
    const price = prices.get(h.company_id).price;
    const free = h.quantity - h.pledged_quantity;
    pledgedValue += h.pledged_quantity * price;
    if (h.loan_eligible) freeEligibleValue += free * price;
    return { ...h, price, free_quantity: free, max_borrow_against_free: h.loan_eligible ? Math.floor((free * price * s.ltv_bps) / 10000) : 0 };
  });
  const principal = active.reduce((a, l) => a + l.principal, 0);
  const capRemaining = Math.max(0, s.max_loan_per_team - principal);
  const ltvCapacity = Math.floor((freeEligibleValue * s.ltv_bps) / 10000);
  return {
    enabled: s.enabled,
    rules: s,
    current_round: gs.current_round,
    holdings: eligible,
    collateral_value: pledgedValue,
    outstanding_principal: principal,
    interest_accrued: active.reduce((a, l) => a + l.interest_due, 0),
    available_to_borrow: Math.min(capRemaining, ltvCapacity),
    loans,
  };
}

async function borrow(teamId, { amount, collateral, requestKey }) {
  if (typeof requestKey !== 'string' || requestKey.length < 8 || requestKey.length > 100) {
    throw new GameError('Missing or invalid request key');
  }
  const existing = await db.query('SELECT * FROM loans WHERE team_id = $1 AND request_key = $2', [teamId, requestKey]);
  if (existing.rows[0]) return { loan: existing.rows[0], duplicate: true };

  return db.tx(async (c) => {
    const gs = await getGameState(c, { lock: 'share' });
    const s = gs.settings.loans;
    assertLoansEnabled(gs.settings);
    if (gs.status !== 'running' || gs.paused) throw new GameError('Trading is not active');
    const round = await getRound(c, gs.current_round || 1, { lock: 'share' });
    if (round.status !== 'open') throw new GameError('Loans can only be taken while the trading window is open');
    if (gs.current_round > s.last_borrow_round) throw new GameError(`New loans closed after Round ${s.last_borrow_round}`);
    if (!isPositiveInt(amount)) throw new GameError('Loan amount must be a positive whole number of paise');
    if (!Array.isArray(collateral) || collateral.length === 0) throw new GameError('Pledge at least one holding as collateral');

    await c.query('SELECT id FROM teams WHERE id = $1 FOR NO KEY UPDATE', [teamId]);
    const dup = await c.query('SELECT * FROM loans WHERE team_id = $1 AND request_key = $2', [teamId, requestKey]);
    if (dup.rows[0]) return { loan: dup.rows[0], duplicate: true };

    const prices = await currentPrices(c);
    const seen = new Set();
    let value = 0;
    for (const item of collateral) {
      const cid = Number(item.company_id);
      const q = Number(item.quantity);
      if (seen.has(cid)) throw new GameError('Each company may appear only once in the collateral list');
      seen.add(cid);
      if (!isPositiveInt(q)) throw new GameError('Collateral quantities must be positive whole numbers');
      const { rows } = await c.query(
        `SELECT h.quantity, h.pledged_quantity, co.loan_eligible, co.ticker FROM holdings h
           JOIN companies co ON co.id = h.company_id WHERE h.team_id = $1 AND h.company_id = $2`, [teamId, cid]);
      const h = rows[0];
      if (!h) throw new GameError('You do not own shares of that company');
      if (!h.loan_eligible) throw new GameError(`${h.ticker} is not eligible as collateral`);
      if (h.quantity - h.pledged_quantity < q) throw new GameError(`Only ${h.quantity - h.pledged_quantity} unpledged ${h.ticker} shares available`);
      value += q * prices.get(cid).price;
    }
    const maxBorrow = Math.floor((value * s.ltv_bps) / 10000);
    if (amount > maxBorrow) throw new GameError(`Collateral supports at most ₹${(maxBorrow / 100).toFixed(2)}`);
    const { rows: [{ outstanding }] } = await c.query(
      `SELECT COALESCE(SUM(principal), 0)::bigint AS outstanding FROM loans WHERE team_id = $1 AND status = 'active'`, [teamId]);
    if (outstanding + amount > s.max_loan_per_team) {
      throw new GameError(`Loan would exceed the per-team limit of ₹${(s.max_loan_per_team / 100).toFixed(2)}`);
    }

    const { rows: [loan] } = await c.query(
      `INSERT INTO loans (team_id, principal, status, issued_round, due_round, request_key)
       VALUES ($1, $2, 'active', $3, $4, $5) RETURNING *`, [teamId, amount, gs.current_round, s.due_round, requestKey]);
    for (const item of collateral) {
      await c.query('INSERT INTO collateral (loan_id, team_id, company_id, quantity) VALUES ($1, $2, $3, $4)',
        [loan.id, teamId, Number(item.company_id), Number(item.quantity)]);
      await c.query('UPDATE holdings SET pledged_quantity = pledged_quantity + $3 WHERE team_id = $1 AND company_id = $2',
        [teamId, Number(item.company_id), Number(item.quantity)]);
    }
    await moveCash(c, teamId, amount, 'loan_disbursement', { referenceType: 'loan', referenceId: loan.id });
    return { loan, duplicate: false };
  });
}

async function releaseCollateral(c, loan) {
  const { rows } = await c.query('SELECT * FROM collateral WHERE loan_id = $1 AND NOT released', [loan.id]);
  for (const col of rows) {
    await c.query('UPDATE holdings SET pledged_quantity = pledged_quantity - $3 WHERE team_id = $1 AND company_id = $2',
      [loan.team_id, col.company_id, col.quantity]);
  }
  await c.query('UPDATE collateral SET released = true WHERE loan_id = $1', [loan.id]);
  return rows;
}

async function repay(teamId, loanId) {
  return db.tx(async (c) => {
    const gs = await getGameState(c, { lock: 'share' });
    assertLoansEnabled(gs.settings);
    if (gs.status !== 'running' || gs.paused) throw new GameError('The bank is closed right now');
    await c.query('SELECT id FROM teams WHERE id = $1 FOR NO KEY UPDATE', [teamId]);
    const { rows: [loan] } = await c.query('SELECT * FROM loans WHERE id = $1 AND team_id = $2 FOR NO KEY UPDATE', [loanId, teamId]);
    if (!loan) throw new GameError('Loan not found', 404, 'not_found');
    if (loan.status !== 'active') return { loan, duplicate: true };
    const due = loan.principal + loan.interest_due;
    const { rows: [team] } = await c.query('SELECT cash FROM teams WHERE id = $1', [teamId]);
    if (team.cash < due) throw new GameError(`Repayment needs ₹${(due / 100).toFixed(2)} in cash; you have ₹${(team.cash / 100).toFixed(2)}`);
    await moveCash(c, teamId, -due, 'loan_repayment', { referenceType: 'loan', referenceId: loan.id });
    await releaseCollateral(c, loan);
    const { rows: [updated] } = await c.query(
      `UPDATE loans SET status = 'repaid', repaid_at = now(), closing_note = 'Repaid in full' WHERE id = $1 RETURNING *`, [loan.id]);
    return { loan: updated, duplicate: false };
  });
}

// Called inside the market-update transaction.
async function accrueInterest(c, roundId, settings) {
  const rate = settings.loans.interest_bps_per_round;
  if (!rate) return;
  const { rows } = await c.query(`SELECT id, principal FROM loans WHERE status = 'active' AND issued_round <= $1`, [roundId]);
  for (const l of rows) {
    await c.query('UPDATE loans SET interest_due = interest_due + $2 WHERE id = $1', [l.id, ceilBps(l.principal, rate)]);
  }
}

// Liquidate every active loan (or only those due by roundId). Called inside a transaction that
// already holds the game_state lock, after the round's new prices have been written.
async function liquidateLoans(c, roundId, { onlyDue }) {
  const { rows: loans } = await c.query(
    `SELECT * FROM loans WHERE status = 'active' ${onlyDue ? 'AND due_round <= $1' : 'AND $1::int IS NOT NULL'} ORDER BY team_id, id`, [roundId]);
  if (!loans.length) return [];
  const prices = await currentPrices(c);
  const results = [];
  for (const loan of loans) {
    await c.query('SELECT id FROM teams WHERE id = $1 FOR NO KEY UPDATE', [loan.team_id]);
    let debt = loan.principal + loan.interest_due;
    const released = await releaseCollateral(c, loan);
    let { rows: [{ cash }] } = await c.query('SELECT cash FROM teams WHERE id = $1', [loan.team_id]);
    const sold = [];
    for (const col of released) {
      if (debt <= 0) break;
      const price = prices.get(col.company_id).price;
      const qty = Math.min(col.quantity, Math.ceil(debt / price));
      if (qty <= 0) continue;
      const { rows: [h] } = await c.query('SELECT * FROM holdings WHERE team_id = $1 AND company_id = $2 FOR NO KEY UPDATE', [loan.team_id, col.company_id]);
      const proceeds = qty * price;
      const basisOut = Number(divRound(BigInt(h.cost_basis) * BigInt(qty), BigInt(h.quantity)));
      const realized = proceeds - basisOut;
      await c.query('UPDATE holdings SET quantity = quantity - $3, cost_basis = cost_basis - $4 WHERE team_id = $1 AND company_id = $2',
        [loan.team_id, col.company_id, qty, basisOut]);
      await c.query('UPDATE companies SET exchange_inventory = exchange_inventory + $2 WHERE id = $1', [col.company_id, qty]);
      await c.query('UPDATE teams SET realized_pnl = realized_pnl + $2 WHERE id = $1', [loan.team_id, realized]);
      cash = await moveCash(c, loan.team_id, proceeds, 'liquidation', { referenceType: 'loan', referenceId: loan.id, memo: `Sold ${qty} pledged shares` });
      await c.query(
        `INSERT INTO trades (team_id, round_id, company_id, side, source, quantity, execution_price, gross, fee, cash_delta, cash_after, realized_pnl)
         VALUES ($1, $2, $3, 'sell', 'liquidation', $4, $5, $6, 0, $6, $7, $8)`,
        [loan.team_id, roundId, col.company_id, qty, price, proceeds, cash, realized]);
      sold.push({ company_id: col.company_id, quantity: qty, price });
      debt -= proceeds;
    }
    // Proceeds sit in cash; now pay the debt from cash.
    const totalDebt = loan.principal + loan.interest_due;
    const payable = Math.min(totalDebt, cash);
    if (payable > 0) await moveCash(c, loan.team_id, -payable, 'loan_repayment', { referenceType: 'loan', referenceId: loan.id, memo: 'Forced settlement' });
    const shortfall = totalDebt - payable;
    if (shortfall > 0) {
      await c.query(`UPDATE loans SET status = 'defaulted', principal = $2, interest_due = 0, closing_note = $3 WHERE id = $1`,
        [loan.id, shortfall, `Defaulted in round ${roundId}; shortfall remains a liability`]);
    } else {
      await c.query(`UPDATE loans SET status = 'liquidated', repaid_at = now(), closing_note = $2 WHERE id = $1`,
        [loan.id, `Collateral liquidated in round ${roundId}`]);
    }
    results.push({ loan_id: loan.id, team_id: loan.team_id, debt: totalDebt, paid: payable, shortfall, sold });
  }
  return results;
}

module.exports = { listLoans, loanSummary, borrow, repay, accrueInterest, liquidateLoans };
