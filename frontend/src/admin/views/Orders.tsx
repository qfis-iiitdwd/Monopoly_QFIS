import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, CheckCircle2, Download, FileText, RotateCcw, Search, XCircle } from 'lucide-react';
import { get } from '../../shared/api';
import { usePoll } from '../../shared/hooks';
import { clockSeconds, dateTime, downloadCsv, inr, pctOf, qty, rupees } from '../../shared/format';
import { btn, card, Dot, EmptyRow, paginate, Pager, SideBadge, Spinner } from '../../shared/ui';
import { useAdmin } from '../AdminApp';
import { actions } from '../actions';
import { Kpi, PageHeader } from '../common';
import { AdminOrder, Duplicate } from '../types';

const PER_PAGE = 20;
const statusOf = (o: AdminOrder) => (o.reversed_at ? 'Reversed' : o.status === 'executed' ? 'Executed' : 'Rejected');

export const OrdersView: React.FC = () => {
  const { overview, act, version } = useAdmin();
  const o = overview.data!;
  const [round, setRound] = useState<string>(o.state.current_round ? String(o.state.current_round) : 'all');
  const [search, setSearch] = useState('');
  const [type, setType] = useState('All Types');
  const [status, setStatus] = useState('All Status');
  const [company, setCompany] = useState('All Companies');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const orders = usePoll(() => get<AdminOrder[]>(`/api/admin/orders?limit=20000${round === 'all' ? '' : `&round=${round}`}`), 5000, [round, version]);
  const dups = usePoll(() => get<Duplicate[]>('/api/admin/orders/suspected-duplicates'), 10000, [version]);
  const all = orders.data || [];

  const tickers = useMemo(() => Array.from(new Set(all.map((x) => x.ticker).filter(Boolean))).sort(), [all]);
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return all.filter((x) =>
      (type === 'All Types' || x.side === type.toLowerCase()) &&
      (status === 'All Status' || statusOf(x) === status) &&
      (company === 'All Companies' || x.ticker === company) &&
      (!q || x.team_name.toLowerCase().includes(q) || (x.ticker || '').toLowerCase().includes(q) || String(x.id) === q.replace('#', '') || (x.placed_by || '').toLowerCase().includes(q)));
  }, [all, search, type, status, company]);
  const pg = paginate(filtered, page, PER_PAGE);
  useEffect(() => setPage(1), [search, type, status, company, round]);
  const selected = filtered.find((x) => x.id === selectedId) || pg.slice[0] || null;

  const executed = all.filter((x) => x.status === 'executed' && !x.reversed_at);
  const rejected = all.filter((x) => x.status === 'rejected');
  const reversed = all.filter((x) => x.reversed_at);
  const buys = executed.filter((x) => x.side === 'buy');
  const sells = executed.filter((x) => x.side === 'sell');
  const value = executed.reduce((a, x) => a + Math.abs(x.cash_delta || 0), 0);
  const scope = round === 'all' ? 'All rounds' : `Round ${round}`;

  const reverse = (x: AdminOrder) => act(actions.reverseOrder({
    id: x.id, team: x.team_name, side: x.side, quantity: x.quantity, ticker: x.ticker, price: x.execution_price,
    settled: o.rounds.find((r) => r.id === x.round_id)?.status === 'settled',
  }));

  const exportCsv = () => downloadCsv(`orders-${round}-${new Date().toISOString().slice(0, 16)}.csv`, [
    ['order_id', 'round', 'submitted_at', 'team', 'placed_by', 'side', 'ticker', 'quantity', 'price_rupees', 'cash_change_rupees', 'status', 'rejection_reason', 'reversal_reason'],
    ...filtered.map((x) => [x.id, x.round_id, x.submitted_at, x.team_name, x.placed_by, x.side, x.ticker, x.quantity,
      x.execution_price != null ? x.execution_price / 100 : '', x.cash_delta != null ? x.cash_delta / 100 : '', statusOf(x), x.rejection_reason, x.reversal_reason]),
  ]);

  return (
    <div className="space-y-6 pb-12 animate-fadeIn">
      <PageHeader title="Orders" subtitle="Every order teams placed, executed or rejected, with its reason." o={o} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi icon={<FileText className="w-5 h-5" />} tint="bg-indigo-500/10 border-indigo-500/20 text-indigo-400" label={`Total Orders (${scope})`} value={qty(all.length)} sub={<span className="text-slate-500">{inr(value)} traded</span>} />
        <Kpi icon={<CheckCircle2 className="w-5 h-5" />} tint="bg-emerald-500/10 border-emerald-500/20 text-emerald-400" label="Executed" value={qty(executed.length)} sub={<span className="text-emerald-400">{pctOf(executed.length, all.length)}</span>} onClick={() => setStatus('Executed')} />
        <Kpi icon={<XCircle className="w-5 h-5" />} tint="bg-rose-500/10 border-rose-500/20 text-rose-400" label="Rejected" value={qty(rejected.length)} sub={<span className="text-rose-400">{pctOf(rejected.length, all.length)}</span>} onClick={() => setStatus('Rejected')} />
        <Kpi icon={<RotateCcw className="w-5 h-5" />} tint="bg-amber-500/10 border-amber-500/20 text-amber-400" label="Reversed by organisers" value={qty(reversed.length)} sub={<span className="text-amber-400">{pctOf(reversed.length, all.length)}</span>} onClick={() => setStatus('Reversed')} />
      </div>

      <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by team, member, symbol, order ID..."
            className="w-full bg-[#111622] border border-[#1e2638] rounded-xl pl-10 pr-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500" />
        </div>
        <Select value={type} onChange={setType} options={['All Types', 'BUY', 'SELL']} />
        <Select value={status} onChange={setStatus} options={['All Status', 'Executed', 'Rejected', 'Reversed']} />
        <Select value={company} onChange={setCompany} options={['All Companies', ...tickers]} />
        <select value={round} onChange={(e) => setRound(e.target.value)} className="bg-[#111622] border border-[#1e2638] rounded-xl px-3.5 py-2 text-xs font-medium text-slate-200">
          <option value="all">All rounds</option>
          {o.rounds.filter((r) => r.status !== 'pending').map((r) => <option key={r.id} value={r.id}>Round {r.id}{r.id === o.state.current_round ? ' (current)' : ''}</option>)}
        </select>
        <button onClick={() => { setSearch(''); setType('All Types'); setStatus('All Status'); setCompany('All Companies'); }} className={btn.small}>Reset</button>
        <button onClick={exportCsv} disabled={!filtered.length} className={btn.small}><Download className="w-3.5 h-3.5" /><span>Export CSV</span></button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className={`xl:col-span-8 ${card} overflow-hidden`}>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse monopoly-table">
              <thead>
                <tr className="text-xs font-semibold text-slate-400 border-b border-[#1b2233]">
                  <th className="py-3 px-4">Order</th>
                  <th className="py-3 px-3">Time</th>
                  <th className="py-3 px-3">Team</th>
                  <th className="py-3 px-3">Type</th>
                  <th className="py-3 px-3">Symbol</th>
                  <th className="py-3 px-3 text-right">Qty</th>
                  <th className="py-3 px-3 text-right">Price (₹)</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#171e2c] text-sm">
                {!orders.data && <EmptyRow cols={9} text="Loading…" />}
                {orders.data && pg.slice.length === 0 && <EmptyRow cols={9} text={all.length ? 'No order matches.' : `No orders in ${scope.toLowerCase()} yet.`} />}
                {pg.slice.map((x) => {
                  const st = statusOf(x);
                  return (
                    <tr key={x.id} onClick={() => setSelectedId(x.id)} className={`cursor-pointer transition-colors ${selected?.id === x.id ? 'bg-[#182338]' : 'hover:bg-[#161d2d]'}`}>
                      <td className="py-3 px-4 font-mono text-xs text-slate-400">#{x.id}</td>
                      <td className="py-3 px-3 font-mono text-xs text-slate-400 whitespace-nowrap">{clockSeconds(x.submitted_at)}</td>
                      <td className="py-3 px-3 text-white font-semibold whitespace-nowrap">{x.team_name}</td>
                      <td className="py-3 px-3"><SideBadge side={x.side} /></td>
                      <td className="py-3 px-3 font-bold text-white">{x.ticker || '—'}</td>
                      <td className="py-3 px-3 text-right font-mono text-slate-300">{qty(x.quantity)}</td>
                      <td className="py-3 px-3 text-right font-mono text-slate-300">{x.execution_price != null ? rupees(x.execution_price) : '—'}</td>
                      <td className="py-3 px-4"><span className="flex items-center space-x-1.5 text-xs text-slate-200"><Dot tone={st === 'Executed' ? 'green' : st === 'Rejected' ? 'red' : 'amber'} /><span>{st}</span></span></td>
                      <td className="py-3 px-3 text-right">
                        {st === 'Executed' && (
                          <button onClick={(e) => { e.stopPropagation(); reverse(x); }} className="text-[11px] font-semibold text-rose-300 hover:text-rose-200">Reverse</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={pg.page} pages={pg.pages} total={filtered.length} perPage={PER_PAGE} onPage={setPage} label="orders" />
        </div>

        <div className="xl:col-span-4 space-y-6">
          <div className={`${card} p-5 space-y-4`}>
            <h2 className="text-sm font-bold text-white">Order Details</h2>
            {!selected ? <p className="text-xs text-slate-500">Select an order.</p> : (
              <>
                <div className="space-y-2 text-xs">
                  {([
                    ['Order', `#${selected.id} · Round ${selected.round_id}`],
                    ['Team', selected.team_name],
                    ['Placed by', selected.placed_by || '—'],
                    ['Order', `${selected.side.toUpperCase()} ${qty(selected.quantity)} ${selected.ticker || ''}`],
                    ['Submitted', dateTime(selected.submitted_at)],
                    ['Executed', dateTime(selected.executed_at)],
                    ['Execution price', selected.execution_price != null ? inr(selected.execution_price, 2) : '—'],
                    ['Cash change', selected.cash_delta != null ? inr(selected.cash_delta, 2) : '—'],
                    ['Status', statusOf(selected)],
                  ] as [string, string][]).map(([k, v], i) => (
                    <div key={i} className="flex justify-between gap-3"><span className="text-slate-400">{k}</span><span className="text-slate-200 font-medium text-right">{v}</span></div>
                  ))}
                </div>
                {selected.rejection_reason && <Note tone="rose" title="Rejection reason" text={selected.rejection_reason} />}
                {selected.reversal_reason && <Note tone="amber" title={`Reversed ${dateTime(selected.reversed_at)}`} text={selected.reversal_reason} />}
                <button onClick={() => reverse(selected)} disabled={statusOf(selected) !== 'Executed'} className={`${btn.primary} w-full py-2.5`}>
                  <RotateCcw className="w-3.5 h-3.5" /><span>Reverse Order</span>
                </button>
              </>
            )}
          </div>

          <div className={`${card} p-5 space-y-4`}>
            <div className="flex items-center space-x-2"><BarChart3 className="w-4 h-4 text-rose-400" /><h2 className="text-sm font-bold text-white">Order Statistics ({scope})</h2></div>
            <Bar label="Buy Orders" n={buys.length} total={executed.length} colour="bg-emerald-500" />
            <Bar label="Sell Orders" n={sells.length} total={executed.length} colour="bg-rose-500" />
            <div className="flex justify-between text-xs pt-2 border-t border-[#1b2233]">
              <span className="text-slate-400">Average Order Value</span>
              <span className="font-mono text-white">{executed.length ? inr(value / executed.length) : '—'}</span>
            </div>
          </div>

          <div className={`${card} p-5 space-y-3`}>
            <div className="flex items-center space-x-2"><AlertTriangle className="w-4 h-4 text-amber-400" /><h2 className="text-sm font-bold text-white">Likely double taps</h2></div>
            <p className="text-[11px] text-slate-500">Same team, company, side and size within 15 s. Check with the team before reversing.</p>
            {!dups.data && <Spinner />}
            {dups.data?.length === 0 && <p className="text-xs text-emerald-400">None found.</p>}
            {dups.data?.slice(0, 10).map((p) => (
              <div key={`${p.first_order}-${p.second_order}`} className="flex items-center justify-between text-xs py-1.5 border-b border-[#171e2c]">
                <span className="text-slate-300">{p.team_name}: {p.side.toUpperCase()} {qty(p.quantity)} {p.ticker} <span className="text-slate-500">({p.seconds_apart}s apart, R{p.round_id})</span></span>
                <button className="text-[11px] font-semibold text-rose-300 hover:text-rose-200 shrink-0 ml-2" onClick={() => {
                  const second = all.find((x) => x.id === p.second_order);
                  act(actions.reverseOrder({
                    id: p.second_order, team: p.team_name, side: p.side, quantity: p.quantity, ticker: p.ticker, price: second?.execution_price ?? null,
                    settled: o.rounds.find((r) => r.id === p.round_id)?.status === 'settled',
                  }));
                }}>Reverse #{p.second_order}</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const Select: React.FC<{ value: string; onChange: (v: string) => void; options: string[] }> = ({ value, onChange, options }) => (
  <select value={value} onChange={(e) => onChange(e.target.value)} className="bg-[#111622] border border-[#1e2638] rounded-xl px-3.5 py-2 text-xs font-medium text-slate-200 focus:outline-none cursor-pointer">
    {options.map((x) => <option key={x}>{x}</option>)}
  </select>
);

const Bar: React.FC<{ label: string; n: number; total: number; colour: string }> = ({ label, n, total, colour }) => (
  <div className="space-y-1.5 text-xs">
    <div className="flex justify-between text-slate-300"><span>{label}</span><span className="font-mono font-medium">{qty(n)} ({pctOf(n, total)})</span></div>
    <div className="h-2 rounded-full bg-slate-800 overflow-hidden"><div className={`h-full ${colour} rounded-full`} style={{ width: total ? `${(n * 100) / total}%` : '0%' }} /></div>
  </div>
);

const Note: React.FC<{ tone: 'rose' | 'amber'; title: string; text: string }> = ({ tone, title, text }) => (
  <div className={`text-xs p-3 rounded-lg border ${tone === 'rose' ? 'bg-rose-950/30 border-rose-900/60 text-rose-200' : 'bg-amber-950/30 border-amber-900/60 text-amber-200'}`}>
    <div className="font-bold mb-0.5">{title}</div>
    <div>{text}</div>
  </div>
);

export { Select };
