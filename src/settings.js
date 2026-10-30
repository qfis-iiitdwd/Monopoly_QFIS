// Default game parameters. Overridden by config/game.json "settings" at seed time and
// stored in game_state.settings, which is the single source of truth while the event runs.
const RUPEE = 100; // paise
const LAKH = 100000 * RUPEE;
const CRORE = 100 * LAKH;

const DEFAULT_SETTINGS = {
  total_rounds: 10,
  starting_cash: 1 * CRORE,
  fee_bps: 10,                    // 0.10% transaction cost on every buy and sell
  max_trades_per_round: 0,        // 0 = unlimited
  pressure_scale_bps: 300,        // net demand of pressure_ref_qty moves price by 3%
  pressure_cap_bps: 800,          // trading pressure never exceeds ±8% per round
  noise_bps: 50,                  // deterministic noise in [-0.5%, +0.5%]; 0 disables
  noise_seed: 'qfis-marketverse',
  max_move_up_bps: 6000,          // combined move clamped to +60% ...
  max_move_down_bps: 6000,        // ... and -60% per round
  min_price: 1 * RUPEE,
  max_price: 100000 * RUPEE,
  max_reward: 2 * LAKH,           // cap on a single quest/quiz reward
  session_hours: 14,
  players_see_leaderboard: true,  // false: players never see rankings (the admin page always does)
  loans: {
    enabled: false,
    ltv_bps: 5000,                // borrow up to 50% of pledged collateral value
    interest_bps_per_round: 200,  // 2% simple interest on principal per market update
    max_loan_per_team: 50 * LAKH,
    last_borrow_round: 6,
    due_round: 8,                 // unpaid loans are liquidated at this round's market update
  },
};

function mergeSettings(base, override) {
  const out = { ...base, ...(override || {}) };
  out.loans = { ...base.loans, ...((override && override.loans) || {}) };
  return out;
}

function validateSettings(s) {
  const ints = ['total_rounds', 'starting_cash', 'fee_bps', 'max_trades_per_round', 'pressure_scale_bps', 'pressure_cap_bps',
    'noise_bps', 'max_move_up_bps', 'max_move_down_bps', 'min_price', 'max_price', 'max_reward', 'session_hours'];
  for (const k of ints) {
    if (!Number.isSafeInteger(s[k]) || s[k] < 0) throw new Error(`settings.${k} must be a non-negative integer`);
  }
  if (s.max_move_down_bps >= 10000) throw new Error('settings.max_move_down_bps must be < 10000 so prices stay positive');
  if (s.min_price < 1 || s.min_price >= s.max_price) throw new Error('settings.min_price must be >= 1 and < max_price');
  for (const k of ['ltv_bps', 'interest_bps_per_round', 'max_loan_per_team', 'last_borrow_round', 'due_round']) {
    if (!Number.isSafeInteger(s.loans[k]) || s.loans[k] < 0) throw new Error(`settings.loans.${k} must be a non-negative integer`);
  }
  if (typeof s.players_see_leaderboard !== 'boolean') throw new Error('settings.players_see_leaderboard must be true or false');
  if (s.loans.ltv_bps > 10000) throw new Error('settings.loans.ltv_bps cannot exceed 10000');
  return s;
}

module.exports = { DEFAULT_SETTINGS, mergeSettings, validateSettings, RUPEE, LAKH, CRORE };
