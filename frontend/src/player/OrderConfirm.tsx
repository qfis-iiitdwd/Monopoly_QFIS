import React, { useState } from 'react';
import { AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import { ApiError, get, newKey, post } from '../shared/api';
import { Company, Order, OrderResult } from '../shared/types';
import { inr, qty, rupees } from '../shared/format';
import { btn, Modal, Spinner, TickerBadge } from '../shared/ui';
import { feeFor } from './views/Trading';

type Outcome =
  | { kind: 'executed'; order: Order }
  | { kind: 'rejected'; order: Order }
  | { kind: 'error'; message: string }
  | { kind: 'unknown' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Review → Confirm → the server's answer. The idempotency key is made once when this dialog opens
 * and reused for every retry, so a flaky connection can never place the order twice.
 */
export const OrderConfirm: React.FC<{
  company: Company;
  side: 'buy' | 'sell';
  quantity: number;
  cash: number;
  feeBps: number;
  round: number;
  onClose: () => void;
  onSettled: () => void;
}> = ({ company, side, quantity, cash, feeBps, round, onClose, onSettled }) => {
  const [key] = useState(newKey);
  const [sending, setSending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const gross = quantity * company.price;
  const fee = feeFor(gross, feeBps);
  const total = side === 'buy' ? gross + fee : gross - fee;
  const owned = company.held - company.pledged;
  const warn = side === 'buy' && total > cash
    ? `You have ${inr(cash)}, but this order needs about ${inr(total)}.`
    : side === 'sell' && quantity > owned
      ? `You only hold ${qty(owned)} ${company.ticker} shares that you can sell.`
      : '';

  const send = async () => {
    setSending(true);
    const body = { company_id: company.id, side, quantity, idempotency_key: key };
    for (let i = 1; i <= 4; i++) {
      setAttempt(i);
      try {
        const r = await post<OrderResult>('/api/orders', body);
        setOutcome({ kind: 'executed', order: r.order });
        break;
      } catch (e) {
        const err = e as ApiError;
        if (err.status === 422 && err.body && (err.body as OrderResult).order) {
          setOutcome({ kind: 'rejected', order: (err.body as OrderResult).order });
          break;
        }
        if (!(err.retryable || err.status === 429) || i === 4) {
          if (err.retryable || err.status === 429) {
            // Still unsure: ask the server whether this exact order exists.
            try {
              const orders = await get<Order[]>('/api/orders');
              const mine = orders.find((o) => o.idempotency_key === key);
              setOutcome(mine ? { kind: mine.status === 'executed' ? 'executed' : 'rejected', order: mine } : { kind: 'unknown' });
            } catch {
              setOutcome({ kind: 'unknown' });
            }
          } else {
            setOutcome({ kind: 'error', message: err.message });
          }
          break;
        }
        await sleep(500 * 2 ** (i - 1));
      }
    }
    setSending(false);
    onSettled();
  };

  if (outcome) {
    const o = 'order' in outcome ? outcome.order : null;
    return (
      <Modal title={outcome.kind === 'executed' ? 'Order executed' : outcome.kind === 'rejected' ? 'Order rejected' : 'Order not confirmed'} onClose={onClose}
        footer={<button onClick={onClose} className={btn.primary}>Done</button>}>
        {outcome.kind === 'executed' && o && (
          <div className="space-y-3">
            <div className="flex items-center space-x-2 text-emerald-400 font-bold"><CheckCircle className="w-5 h-5" /><span>Executed ✓</span></div>
            <Summary rows={[
              ['Order', `${o.side.toUpperCase()} ${qty(o.quantity)} ${company.ticker}`],
              ['Price per share', `₹ ${rupees(o.execution_price || 0)}`],
              ['Fee', inr(o.fee || 0, 2)],
              [o.side === 'buy' ? 'Total paid' : 'Total received', inr(Math.abs(o.cash_delta || 0), 2)],
              ['Cash now', inr(o.cash_after || 0, 2)],
              ['Order number', `#${o.id}`],
            ]} />
          </div>
        )}
        {outcome.kind === 'rejected' && o && (
          <div className="space-y-3">
            <div className="flex items-center space-x-2 text-rose-400 font-bold"><XCircle className="w-5 h-5" /><span>Rejected</span></div>
            <p className="text-sm text-slate-200">{o.rejection_reason}</p>
            <p className="text-xs text-slate-500">Nothing was bought or sold. Order #{o.id} is recorded in your history with this reason.</p>
          </div>
        )}
        {outcome.kind === 'error' && <p className="text-sm text-rose-300">{outcome.message}</p>}
        {outcome.kind === 'unknown' && (
          <p className="text-sm text-amber-300">
            We could not reach the market server to confirm this order. It has been placed at most once. Check Recent Orders when your connection is back.
          </p>
        )}
      </Modal>
    );
  }

  return (
    <Modal title="Review & Confirm Order" onClose={sending ? () => {} : onClose}
      footer={
        <>
          <button onClick={onClose} disabled={sending} className={btn.ghost}>Cancel</button>
          <button
            onClick={send}
            disabled={sending}
            className={`px-5 py-2 text-sm font-semibold text-white rounded-lg transition-all flex items-center space-x-2 disabled:opacity-60 ${
              side === 'buy' ? 'bg-emerald-600 hover:bg-emerald-500 shadow-lg shadow-emerald-900/30' : 'bg-rose-600 hover:bg-rose-500 shadow-lg shadow-rose-900/30'
            }`}
          >
            {sending ? <Spinner /> : <CheckCircle className="w-4 h-4" />}
            <span>{sending ? (attempt > 1 ? `Retrying (${attempt}/4)…` : 'Sending…') : `Confirm ${side.toUpperCase()} Order`}</span>
          </button>
        </>
      }>
      <div className="flex items-center justify-between pb-3 border-b border-[#1e2638]">
        <div className="flex items-center space-x-3">
          <TickerBadge ticker={company.ticker} industry={company.industry} large />
          <div>
            <div className="font-bold text-white">{company.name}</div>
            {company.ceo && <div className="text-xs text-slate-400">CEO: {company.ceo}</div>}
          </div>
        </div>
        <div className={`px-3 py-1 rounded text-xs font-bold ${side === 'buy' ? 'bg-[#133827] text-[#10b981]' : 'bg-[#3b171c] text-[#f87171]'}`}>{side.toUpperCase()} ORDER</div>
      </div>
      <Summary rows={[
        ['Price per share', `₹ ${rupees(company.price)}`],
        ['Quantity', `${qty(quantity)} shares`],
        [`Fee (${(feeBps / 100).toFixed(2)}%)`, inr(fee, 2)],
      ]} total={['Estimated Value', inr(total, 2)]} />
      {warn && (
        <div className="flex items-start space-x-2 text-amber-300 text-xs bg-amber-950/30 border border-amber-900/60 p-3 rounded-lg">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{warn} The server will reject it unless that has changed.</span>
        </div>
      )}
      <p className="text-[11px] text-slate-400 leading-relaxed">
        By clicking confirm, this market order will be sent to the exchange and executed in full at this round's price, or rejected with a reason. Round {round}.
      </p>
    </Modal>
  );
};

const Summary: React.FC<{ rows: [string, string][]; total?: [string, string] }> = ({ rows, total }) => (
  <div className="space-y-2.5 text-sm bg-[#151c2b] p-4 rounded-xl border border-[#202b40]">
    {rows.map(([k, v]) => (
      <div key={k} className="flex justify-between text-slate-300 gap-4">
        <span>{k}</span>
        <span className="font-mono font-medium text-white text-right">{v}</span>
      </div>
    ))}
    {total && (
      <div className="flex justify-between text-slate-300 pt-2 border-t border-[#232e44]">
        <span className="font-semibold text-white">{total[0]}</span>
        <span className="font-mono font-bold text-lg text-white">{total[1]}</span>
      </div>
    )}
  </div>
);
