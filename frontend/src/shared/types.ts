// Response shapes of the MarketVerse API (see docs/API.md). Money is integer paise, percentages are
// integer basis points.

export type Phase = 'setup' | 'awaiting_open' | 'trading' | 'closed' | 'news' | 'settled' | 'finished';
export type RoundStatus = 'pending' | 'open' | 'closed' | 'settled';

export interface StatusRound {
  id: number;
  title: string;
  status: RoundStatus;
  duration_seconds: number;
  trading_deadline: string | null;
  opened_at: string | null;
  closed_at: string | null;
}

export interface MarketStatus {
  status: 'setup' | 'running' | 'finished';
  phase: Phase;
  paused: boolean;
  message: string;
  current_round: number;
  total_rounds: number;
  round: StatusRound | null;
  next_round: StatusRound | null;
  fee_bps: number;
  max_trades_per_round: number;
  starting_cash: number;
  leaderboard_visible: boolean;
  server_time: string;
}

export interface Company {
  id: number;
  ticker: string;
  name: string;
  industry: string;
  description: string;
  ceo: string;
  details: Record<string, string>;
  shares_outstanding: number;
  initial_price: number;
  exchange_inventory: number;
  float_shares: number;
  max_order_quantity: number;
  is_tradable: boolean;
  suspension_reason: string | null;
  price: number;
  prev_price: number;
  change_bps: number;
  price_round: number;
  held: number;
  pledged: number;
}

export interface Holding {
  company_id: number;
  ticker: string;
  name: string;
  industry: string;
  quantity: number;
  pledged_quantity: number;
  cost_basis: number;
  price: number;
  value: number;
  unrealized_pnl: number;
}

export interface Portfolio {
  team: { id: number; name: string; access_identifier: string };
  cash: number;
  holdings_value: number;
  debt: number;
  net_worth: number;
  total_pnl: number;
  realized_pnl: number;
  trades_this_round: number;
  holdings: Holding[];
}

export interface Order {
  id: number;
  team_id: number;
  round_id: number;
  company_id: number;
  side: 'buy' | 'sell';
  quantity: number;
  status: 'executed' | 'rejected';
  idempotency_key: string;
  placed_by: string | null;
  submitted_at: string;
  executed_at: string | null;
  rejection_reason: string | null;
  execution_price?: number | null;
  gross?: number | null;
  fee?: number | null;
  cash_delta?: number | null;
  cash_after?: number | null;
  ticker?: string;
}

export interface OrderResult {
  order: Order;
  duplicate: boolean;
}

// One row of a team's history: its own orders, plus corrections made by the organisers.
export interface TxOrder {
  order_id: number | null;
  trade_id: number | null;
  round_id: number;
  submitted_at: string;
  executed_at: string | null;
  ticker: string;
  side: 'buy' | 'sell';
  quantity: number;
  status: 'executed' | 'rejected';
  rejection_reason: string | null;
  placed_by: string | null;
  execution_price: number | null;
  gross: number | null;
  fee: number | null;
  cash_delta: number | null;
  cash_after: number | null;
  source: 'order' | 'reversal' | 'liquidation';
  reversed_reason: string | null;
}

export interface CashMovement {
  id: number;
  transaction_type: string;
  amount: number;
  balance_after: number;
  memo: string | null;
  created_at: string;
}

export interface Transactions {
  orders: TxOrder[];
  other_cash_movements: CashMovement[];
}

export interface Me {
  team: { id: number; name: string; access_identifier: string };
  member_name: string | null;
}
