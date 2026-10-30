import { Transactions } from '../shared/types';
import { qty, rupees } from '../shared/format';

// One line of a team's history, built only from GET /api/transactions.
export interface Activity {
  key: string;
  at: string;
  type: 'BUY' | 'SELL' | 'Correction' | 'Reward' | 'Deposit';
  symbol: string;
  details: string;
  amount: number | null; // paise; null when no money moved (rejected orders)
  status: 'Executed' | 'Rejected' | 'Reversed' | 'Manual';
  sub?: string;
}

const TYPE_LABEL: Record<string, Activity['type']> = {
  initial_deposit: 'Deposit',
  quest_reward: 'Reward',
  adjustment: 'Correction',
  loan_disbursement: 'Correction',
  loan_repayment: 'Correction',
};

export function toActivities(tx: Transactions | null, includeCash = true): Activity[] {
  if (!tx) return [];
  const out: Activity[] = tx.orders.map((o) => {
    const side = o.side === 'buy' ? 'BUY' : 'SELL';
    if (o.source === 'reversal') {
      return {
        key: `t${o.trade_id}`, at: o.submitted_at, type: 'Correction', symbol: o.ticker,
        details: `Undo of a ${o.side === 'buy' ? 'SELL' : 'BUY'} of ${qty(o.quantity)} shares`,
        amount: o.cash_delta, status: 'Manual', sub: 'by organisers',
      };
    }
    if (o.source === 'liquidation') {
      return {
        key: `t${o.trade_id}`, at: o.submitted_at, type: 'Correction', symbol: o.ticker,
        details: `Bank sale of ${qty(o.quantity)} pledged shares`, amount: o.cash_delta, status: 'Manual', sub: 'Margin Bank',
      };
    }
    if (o.status === 'rejected') {
      return {
        key: `o${o.order_id}`, at: o.submitted_at, type: side, symbol: o.ticker, details: `${qty(o.quantity)} shares`,
        amount: null, status: 'Rejected', sub: o.rejection_reason || undefined,
      };
    }
    return {
      key: `o${o.order_id}`, at: o.executed_at || o.submitted_at, type: side, symbol: o.ticker,
      details: `${qty(o.quantity)} shares @ ${rupees(o.execution_price || 0)} · fee ${rupees(o.fee || 0)}`,
      amount: o.cash_delta,
      status: o.reversed_reason ? 'Reversed' : 'Executed',
      sub: o.reversed_reason ? `by organisers: ${o.reversed_reason}` : o.placed_by || undefined,
    };
  });
  if (includeCash) {
    for (const m of tx.other_cash_movements) {
      out.push({
        key: `l${m.id}`, at: m.created_at, type: TYPE_LABEL[m.transaction_type] || 'Correction', symbol: '—',
        details: m.memo || m.transaction_type.replace(/_/g, ' '), amount: m.amount, status: 'Manual',
        sub: m.transaction_type === 'initial_deposit' ? undefined : 'by organisers',
      });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
