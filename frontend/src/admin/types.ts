// Admin API response shapes (see docs/API.md). Money in paise, percentages in basis points.
import { RoundStatus } from '../shared/types';

export interface AdminRound {
  id: number;
  title: string;
  status: RoundStatus;
  duration_seconds: number;
  newspaper_published_at: string | null;
  bulletin_published_at: string | null;
  opened_at: string | null;
  trading_deadline: string | null;
  closed_at: string | null;
  market_update_status: 'none' | 'done';
  completed_at: string | null;
  now: string;
  executed: number;
  rejected: number;
  teams_traded: number;
  traded_value: number;
  bought_shares: number;
  sold_shares: number;
}

export interface GameState {
  status: 'setup' | 'running' | 'finished';
  current_round: number;
  paused: boolean;
  paused_at: string | null;
  message: string;
  started_at: string | null;
  finished_at: string | null;
  settings: { total_rounds: number; starting_cash: number; fee_bps: number; max_reward: number; pressure_scale_bps: number; pressure_cap_bps: number; players_see_leaderboard: boolean };
}

export interface AuditRow {
  id: number;
  action: string;
  reason: string | null;
  created_at: string;
  username: string | null;
  before_state?: Record<string, unknown> | null;
  after_state?: Record<string, unknown> | null;
}

export interface Overview {
  state: GameState;
  rounds: AdminRound[];
  counts: { teams: number; teams_disabled: number; companies: number; companies_tradable: number; teams_logged_in: number; sessions: number };
  db_latency_ms: number;
  pool: { total: number; idle: number; waiting: number; max: number };
  server_time: string;
  recent_audit: AuditRow[];
  recent_errors: { id: number; message: string; created_at: string }[];
}

export interface AdminTeam {
  team_id: number;
  name: string;
  access_identifier: string;
  cash: number;
  holdings_value: number;
  debt: number;
  net_worth: number;
  total_pnl: number;
  realized_pnl: number;
  is_active: boolean;
  rank: number | null;
  tied: boolean;
  members: string[];
  executed_orders: number;
  sessions: number;
}

export interface LedgerRow {
  id: number;
  team_id: number;
  team_name?: string;
  transaction_type: string;
  amount: number;
  balance_after: number;
  reference_type: string | null;
  reference_id: string | null;
  memo: string | null;
  created_at: string;
  created_by: string;
  round_id?: number | null;
  ticker?: string | null;
  side?: 'buy' | 'sell' | null;
  quantity?: number | null;
  price?: number | null;
  fee?: number | null;
  order_id?: number | null;
}

export interface AdminOrder {
  id: number;
  team_id: number;
  team_name: string;
  round_id: number;
  company_id: number;
  ticker: string;
  side: 'buy' | 'sell';
  quantity: number;
  status: 'executed' | 'rejected';
  placed_by: string | null;
  submitted_at: string;
  executed_at: string | null;
  rejection_reason: string | null;
  execution_price: number | null;
  cash_delta: number | null;
  reversed_at: string | null;
  reversal_reason: string | null;
}

export interface Duplicate {
  first_order: number;
  second_order: number;
  team_name: string;
  ticker: string;
  side: string;
  quantity: number;
  round_id: number;
  seconds_apart: string;
}

export interface PreviewRow {
  company_id: number;
  ticker: string;
  name: string;
  industry: string;
  prev_price: number;
  price: number;
  fundamental_bps: number;
  trading_bps: number;
  noise_bps: number;
  total_bps: number;
  net_demand: number;
}

export interface ScheduledEvent {
  id: string;
  event_name: string;
  effective_round: number;
  configuration: { companies: Record<string, number>; industries: Record<string, number> };
  is_applied: boolean;
}

export interface AdminCompany {
  id: number;
  ticker: string;
  name: string;
  industry: string;
  description: string;
  ceo: string;
  details: Record<string, string>;
  initial_price: number;
  float_shares: number;
  exchange_inventory: number;
  max_order_quantity: number;
  is_tradable: boolean;
  suspension_reason: string | null;
  held_by_teams: number;
  price: number;
  change_bps: number;
}

export interface TeamDetail {
  portfolio: import('../shared/types').Portfolio;
  orders: import('../shared/types').TxOrder[];
  ledger: LedgerRow[];
}

export interface TeamHistory {
  starting_cash: number;
  rounds: { round_id: number; rank: number; net_worth: number; cash: number; holdings_value: number }[];
  now: { net_worth: number; cash: number; holdings_value: number };
}

export interface Summary {
  status: { current_round: number; phase: string };
  gainers: { ticker: string; name: string; change_bps: number; price: number }[];
  losers: { ticker: string; name: string; change_bps: number; price: number }[];
  most_active: { round: number | null; rows: { ticker: string; name: string; volume: number }[] };
  top_teams: { rank: number; name: string; net_worth: number; total_pnl: number }[];
  leaderboard_round: number | 'final' | null;
  final?: { winner: { name: string; net_worth: number } | null };
}
