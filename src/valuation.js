const db = require('./db');

// Net worth = cash + Σ(shares × official current price) − (outstanding principal + accrued interest).
// Pledged shares are still the team's assets and are included in holdings value.
async function teamValuations(client = db, { teamId, includeInactive } = {}) {
  const params = [];
  let filter = includeInactive ? '' : 'WHERE t.is_active';
  if (teamId !== undefined && teamId !== null) { // 0 is a team id that matches nothing, not "all teams"
    params.push(teamId);
    filter = 'WHERE t.id = $1';
  }
  const { rows } = await client.query(
    `WITH cur AS (
       SELECT DISTINCT ON (company_id) company_id, price FROM stock_prices ORDER BY company_id, round_id DESC
     ), hv AS (
       SELECT h.team_id, SUM(h.quantity * cur.price)::bigint AS value
         FROM holdings h JOIN cur ON cur.company_id = h.company_id GROUP BY h.team_id
     ), debt AS (
       SELECT team_id, SUM(principal + interest_due)::bigint AS debt, SUM(principal)::bigint AS principal,
              SUM(interest_due)::bigint AS interest
         FROM loans WHERE status IN ('active', 'defaulted') GROUP BY team_id
     )
     SELECT t.id AS team_id, t.name, t.cash, t.realized_pnl, t.is_active,
            COALESCE(hv.value, 0)::bigint AS holdings_value,
            COALESCE(debt.debt, 0)::bigint AS debt,
            COALESCE(debt.principal, 0)::bigint AS loan_principal,
            COALESCE(debt.interest, 0)::bigint AS loan_interest,
            (t.cash + COALESCE(hv.value, 0) - COALESCE(debt.debt, 0))::bigint AS net_worth
       FROM teams t LEFT JOIN hv ON hv.team_id = t.id LEFT JOIN debt ON debt.team_id = t.id
     ${filter}`, params);
  return rows;
}

// Published tie-breakers, in order: net worth ↓, debt ↑, cash ↓, realized profit ↓.
// Teams equal on all four share a rank and are flagged as tied.
function rank(valuations) {
  const sorted = [...valuations].sort((a, b) =>
    b.net_worth - a.net_worth || a.debt - b.debt || b.cash - a.cash || b.realized_pnl - a.realized_pnl || a.team_id - b.team_id);
  const key = (v) => `${v.net_worth}|${v.debt}|${v.cash}|${v.realized_pnl}`;
  let prevKey = null;
  let prevRank = 0;
  return sorted.map((v, i) => {
    const k = key(v);
    const r = k === prevKey ? prevRank : i + 1;
    const tied = (i > 0 && key(sorted[i - 1]) === k) || (i + 1 < sorted.length && key(sorted[i + 1]) === k);
    prevKey = k;
    prevRank = r;
    return { ...v, rank: r, tied };
  });
}

async function snapshotLeaderboard(client, roundId) {
  const ranked = rank(await teamValuations(client));
  const col = (k) => ranked.map((v) => v[k]);
  await client.query(
    `INSERT INTO leaderboard_snapshots (round_id, team_id, rank, net_worth, cash, holdings_value, debt, realized_pnl)
     SELECT $1, * FROM unnest($2::int[], $3::int[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::bigint[])
     ON CONFLICT (round_id, team_id) DO NOTHING`,
    [roundId, col('team_id'), col('rank'), col('net_worth'), col('cash'), col('holdings_value'), col('debt'), col('realized_pnl')]);
  return ranked;
}

// The public leaderboard is the latest end-of-round snapshot (or the frozen final ranking),
// so it does not flicker during trading.
async function publishedLeaderboard(client = db) {
  const final = await client.query(
    `SELECT f.*, t.name FROM final_rankings f JOIN teams t ON t.id = f.team_id ORDER BY f.rank, t.name`);
  if (final.rows.length) return { round_id: 'final', final: true, rows: final.rows };
  const { rows } = await client.query(
    `SELECT s.*, t.name FROM leaderboard_snapshots s JOIN teams t ON t.id = s.team_id
      WHERE s.round_id = (SELECT MAX(round_id) FROM leaderboard_snapshots)
      ORDER BY s.rank, t.name`);
  return { round_id: rows[0] ? rows[0].round_id : null, final: false, rows };
}

module.exports = { teamValuations, rank, snapshotLeaderboard, publishedLeaderboard };
