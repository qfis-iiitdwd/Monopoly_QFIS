import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, ChevronUp, History, Search } from 'lucide-react';
import { Company, MarketStatus, Portfolio } from '../../shared/types';
import { formatIndianNumber, inr, pct, qty, rupees } from '../../shared/format';
import { EmptyRow, TickerBadge } from '../../shared/ui';
import { Activity } from '../activity';
import { ActivityTable } from '../ActivityTable';
import { AnnouncementCard, describe, RoundBadge } from '../market';

export function feeFor(gross: number, feeBps: number) {
  return Math.ceil((gross * feeBps) / 10000); // the server rounds fees up
}

export const TradingView: React.FC<{
  status: MarketStatus | null;
  companies: Company[] | null;
  portfolio: Portfolio | null;
  selectedId: number | null;
  onSelect: (id: number) => void;
  orders: Activity[];
  onOpenOrdersHistory: () => void;
  onReview: (company: Company, side: 'buy' | 'sell', quantity: number) => void;
}> = ({ status, companies, portfolio, selectedId, onSelect, orders, onOpenOrdersHistory, onReview }) => {
  const [search, setSearch] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qtyText, setQtyText] = useState('');
  const list = companies || [];
  const selected = list.find((c) => c.id === selectedId) || list[0] || null;

  useEffect(() => {
    if (!selectedId && list[0]) onSelect(list[0].id);
  }, [selectedId, list, onSelect]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return list.filter((c) => c.name.toLowerCase().includes(q) || c.ticker.toLowerCase().includes(q) || c.ceo.toLowerCase().includes(q));
  }, [list, search]);

  const d = describe(status);
  const feeBps = status?.fee_bps ?? 0;
  const cash = portfolio?.cash ?? 0;
  const owned = selected ? selected.held - selected.pledged : 0;
  const quantity = /^\d+$/.test(qtyText) ? Number(qtyText) : 0;
  const gross = selected ? quantity * selected.price : 0;
  const fee = feeFor(gross, feeBps);
  const total = side === 'buy' ? gross + fee : gross - fee;

  // Largest order the server could accept right now (it still checks everything itself).
  const maxQty = !selected ? 0 : side === 'sell'
    ? Math.min(owned, selected.max_order_quantity)
    : Math.max(0, Math.min(selected.max_order_quantity, selected.exchange_inventory,
      Math.floor(cash / (selected.price + Math.ceil((selected.price * feeBps) / 10000)))));

  const step = (delta: number) => setQtyText(String(Math.max(1, Math.min(selected?.max_order_quantity || 1, quantity + delta))));

  let blocked = '';
  if (!d.canTrade) blocked = d.why;
  else if (!selected) blocked = 'Choose a company.';
  else if (!selected.is_tradable) blocked = `${selected.ticker} is suspended${selected.suspension_reason ? `: ${selected.suspension_reason}` : ''}.`;
  else if (quantity < 1) blocked = 'Enter how many shares.';
  else if (quantity > selected.max_order_quantity) blocked = `Maximum order size for ${selected.ticker} is ${qty(selected.max_order_quantity)} shares.`;

  return (
    <div className="space-y-6 pb-12 animate-fadeIn">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Trading</h1>
          <p className="text-sm text-slate-400 mt-1">Place buy or sell orders for any company</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <RoundBadge status={status} />
          <AnnouncementCard message={status?.message} className="!p-2.5 max-w-sm hidden sm:flex" />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-7 rounded-xl bg-[#111622] border border-[#1e2638] overflow-hidden shadow-sm order-2 xl:order-1">
          <div className="p-5 border-b border-[#1b2233]">
            <h2 className="text-base font-bold text-white mb-3">Select a Company</h2>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search company name or symbol..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-[#161d2d] border border-[#222e47] rounded-lg pl-10 pr-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>
          </div>
          <div className="overflow-x-auto max-h-[36rem] overflow-y-auto">
            <table className="w-full text-left border-collapse monopoly-table">
              <thead>
                <tr className="text-xs font-semibold text-slate-400 border-b border-[#1b2233]">
                  <th className="py-3 px-5">Symbol</th>
                  <th className="py-3 px-4">Company</th>
                  <th className="hidden sm:table-cell py-3 px-4">CEO</th>
                  <th className="py-3 px-4">Price (₹)</th>
                  <th className="py-3 px-4">Change</th>
                  <th className="py-3 px-4"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#171e2c] text-sm">
                {!companies && <EmptyRow cols={6} text="Loading prices…" />}
                {filtered.map((c) => {
                  const isSel = selected?.id === c.id;
                  return (
                    <tr key={c.id} onClick={() => onSelect(c.id)} className={`cursor-pointer transition-colors ${isSel ? 'bg-[#182338] border-l-2 border-l-emerald-500' : 'hover:bg-[#151c2a]'}`}>
                      <td className="py-3.5 px-5"><TickerBadge ticker={c.ticker} industry={c.industry} /></td>
                      <td className="py-3.5 px-4 font-semibold text-white whitespace-nowrap">{c.name}</td>
                      <td className="hidden sm:table-cell py-3.5 px-4 text-slate-400 text-xs whitespace-nowrap">{c.ceo || '—'}</td>
                      <td className="py-3.5 px-4 font-mono text-slate-200">{rupees(c.price)}</td>
                      <td className="py-3.5 px-4">
                        <span className={`text-xs font-semibold font-mono ${c.change_bps > 0 ? 'text-[#10b981]' : c.change_bps < 0 ? 'text-[#f87171]' : 'text-slate-400'}`}>{pct(c.change_bps)}</span>
                      </td>
                      <td className="py-3.5 px-4 text-right"><ChevronRight className={`w-4 h-4 inline-block ${isSel ? 'text-white' : 'text-slate-500'}`} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="xl:col-span-5 rounded-xl bg-[#111622] border border-[#1e2638] p-6 space-y-5 shadow-sm order-1 xl:order-2">
          <h2 className="text-base font-bold text-white tracking-wide">Place Order</h2>
          {selected && (
            <>
              <div className="flex items-center justify-between p-3.5 rounded-xl bg-[#141b2a] border border-[#1f293d] gap-3">
                <div className="flex items-center space-x-3 min-w-0">
                  <TickerBadge ticker={selected.ticker} industry={selected.industry} large />
                  <div className="min-w-0">
                    <div className="font-bold text-white text-base leading-tight truncate">{selected.name}</div>
                    <div className="text-xs text-slate-400 mt-0.5 truncate">{selected.ceo ? `CEO: ${selected.ceo}` : selected.industry}</div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[11px] text-slate-400 font-medium uppercase tracking-wider">Current Price</div>
                  <div className="text-lg font-bold font-mono text-white">₹ {rupees(selected.price)}</div>
                  <div className={`text-xs font-semibold font-mono ${selected.change_bps > 0 ? 'text-[#10b981]' : selected.change_bps < 0 ? 'text-[#f87171]' : 'text-slate-400'}`}>{pct(selected.change_bps)}</div>
                </div>
              </div>

              <CompanyInfo company={selected} />

              <div className="grid grid-cols-2 gap-2 p-1 bg-[#0c1018] rounded-xl border border-[#1a2334]">
                <button onClick={() => setSide('buy')} aria-pressed={side === 'buy'} className={`py-2.5 rounded-lg text-sm font-bold transition-all duration-150 ${side === 'buy' ? 'bg-[#10b981] text-white shadow-md shadow-emerald-950/40' : 'text-slate-400 hover:text-white'}`}>Buy</button>
                <button onClick={() => setSide('sell')} aria-pressed={side === 'sell'} className={`py-2.5 rounded-lg text-sm font-bold transition-all duration-150 ${side === 'sell' ? 'bg-[#ef4444] text-white shadow-md shadow-rose-950/40' : 'text-slate-400 hover:text-white'}`}>Sell</button>
              </div>

              <div className="flex justify-between text-xs text-slate-400 px-1 gap-2">
                <span>Available Cash: <strong className="text-slate-200">{portfolio ? inr(cash) : '…'}</strong></span>
                <span>Owned: <strong className="text-slate-200">{qty(selected.held)} shares</strong></span>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="qty" className="text-xs font-medium text-slate-300">Quantity (shares)</label>
                  <button type="button" onClick={() => setQtyText(maxQty > 0 ? String(maxQty) : '')} className="text-[11px] font-semibold text-sky-400 hover:text-sky-300">
                    Max {qty(maxQty)}
                  </button>
                </div>
                <div className="relative flex items-center">
                  <input
                    id="qty"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                    value={qtyText}
                    placeholder="0"
                    onChange={(e) => setQtyText(e.target.value.replace(/[^\d]/g, '').slice(0, 9))}
                    className="w-full bg-[#161d2d] border border-[#222e47] rounded-lg px-4 py-2.5 text-sm font-mono text-white focus:outline-none focus:border-blue-500"
                  />
                  <div className="absolute right-2 flex flex-col space-y-0.5">
                    <button type="button" aria-label="More" onClick={() => step(10)} className="p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-white transition-colors"><ChevronUp className="w-3.5 h-3.5" /></button>
                    <button type="button" aria-label="Fewer" onClick={() => step(-10)} className="p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-white transition-colors"><ChevronDown className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
                <div className="text-[11px] text-slate-500">Max per order {qty(selected.max_order_quantity)} · {qty(selected.exchange_inventory)} left on the exchange</div>
              </div>

              <div className="rounded-xl bg-[#0d121c] border border-[#1b2336] p-4 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400 font-medium">Estimated Order Value</span>
                  <span className="text-xl font-bold font-mono text-white">{inr(total, 2)}</span>
                </div>
                <div className="text-[11px] text-slate-500 text-right">{inr(gross, 2)} {side === 'buy' ? '+' : '−'} fee {inr(fee, 2)} ({(feeBps / 100).toFixed(2)}%)</div>
              </div>

              <p className="text-[11px] text-slate-400 leading-relaxed">
                Estimate only. The server will validate your order, available cash or shares, inventory, market phase and all trading rules.
              </p>
              {blocked && <p className="text-xs text-amber-300">{blocked}</p>}
              <button
                disabled={!!blocked}
                onClick={() => onReview(selected, side, quantity)}
                className="w-full py-3.5 px-4 bg-[#e63946] hover:bg-[#d62839] active:scale-[0.99] text-white font-bold text-sm rounded-xl transition-all shadow-lg shadow-rose-950/40 flex items-center justify-center space-x-2 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                <span>Review Order</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </>
          )}
          {!selected && <p className="text-sm text-slate-400">Loading companies…</p>}
        </div>
      </div>

      <div className="rounded-xl bg-[#111622] border border-[#1e2638] overflow-hidden shadow-sm">
        <div className="px-6 py-4 flex items-center justify-between border-b border-[#1b2233]">
          <div className="flex items-center space-x-2.5">
            <History className="w-5 h-5 text-slate-300" />
            <h2 className="text-base font-bold text-white tracking-wide">Recent Orders</h2>
          </div>
          <button onClick={onOpenOrdersHistory} className="flex items-center space-x-1.5 px-3 py-1.5 text-xs font-semibold text-slate-300 bg-[#161d2b] border border-[#243046] hover:bg-[#1c2538] hover:text-white rounded-lg transition-all">
            <span>View All Orders</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <ActivityTable rows={orders.slice(0, 5)} empty="No orders yet." />
      </div>
    </div>
  );
};

// Story information for the selected company: description and any extra facts from the organisers.
const CompanyInfo: React.FC<{ company: Company }> = ({ company }) => {
  const details = Object.entries(company.details || {});
  return (
    <div className="rounded-xl bg-[#0f1420] border border-[#1b2336] p-3.5 space-y-2.5 text-xs">
      {company.description && <p className="text-slate-300 leading-relaxed whitespace-pre-line">{company.description}</p>}
      {details.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {details.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-[10px] uppercase tracking-wider text-slate-500">{k}</dt>
              <dd className="text-slate-200 font-medium break-words">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 pt-2 border-t border-[#1b2336]">
        <div><dt className="text-[10px] uppercase tracking-wider text-slate-500">Market cap</dt>
          <dd className="text-slate-200 font-medium">₹ {formatIndianNumber((company.price * company.shares_outstanding) / 100 / 1e7, 2)} crore</dd></div>
        <div><dt className="text-[10px] uppercase tracking-wider text-slate-500">Shares outstanding</dt>
          <dd className="text-slate-200 font-medium">{formatIndianNumber(company.shares_outstanding / 1e7, 2)} crore</dd></div>
      </dl>
      <div className="text-[11px] text-slate-500">Previous price ₹ {formatIndianNumber(company.prev_price / 100, 2)} · Sector {company.industry}</div>
    </div>
  );
};
