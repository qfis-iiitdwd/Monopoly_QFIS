import React, { useEffect, useMemo, useState } from 'react';
import { Download, Gift, PlusCircle, RotateCcw, Search, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { errorMessage, get } from '../../shared/api';
import { usePoll } from '../../shared/hooks';
import { clockSeconds, dateTime, downloadCsv, inr, qty, rupees } from '../../shared/format';
import { btn, card, EmptyRow, ErrorNote, paginate, Pager, Spinner } from '../../shared/ui';
import { useAdmin } from '../AdminApp';
import { actions } from '../actions';
import { Kpi, PageHeader } from '../common';
import { LedgerRow, TeamHistory } from '../types';
import { ledgerLabel } from './Participants';

const PER_PAGE = 20;
const BATCH = 2000;
const TYPES = ['trade_buy', 'trade_sell', 'trade_reversal', 'adjustment', 'quest_reward', 'initial_deposit', 'loan_disbursement', 'loan_repayment', 'liquidation'];

interface LedgerResponse { rows: LedgerRow[]; totals: { transaction_type: string; n: number; amount: number }[] }

export const TransactionsView: React.FC = () => {
  const { overview, teams, act, version } = useAdmin();
  const o = overview.data!;
  const [type, setType] = useState('');
  const [team, setTeam] = useState('');
  const [round, setRound] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [older, setOlder] = useState<LedgerRow[]>([]);
  const [moreState, setMoreState] = useState<{ busy: boolean; done: boolean; error: string | null }>({ busy: false, done: false, error: null });

  const qs = `limit=${BATCH}${type ? `&type=${type}` : ''}${team ? `&team=${team}` : ''}${round ? `&round=${round}` : ''}`;
  const ledger = usePoll(() => get<LedgerResponse>(`/api/admin/ledger?${qs}`), 10000, [qs, version]);
  useEffect(() => { setOlder([]); setMoreState({ busy: false, done: false, error: null }); setPage(1); }, [qs]);

  const rows = useMemo(() => {
    const seen = new Set<number>();
    return [...(ledger.data?.rows || []), ...older].filter((r) => !seen.has(r.id) && seen.add(r.id));
  }, [ledger.data, older]);
  const filtered = useMemo(() => {
    const q = search.toLowerCase().replace('#', '');
    return q ? rows.filter((r) => (r.team_name || '').toLowerCase().includes(q) || String(r.id) === q || (r.ticker || '').toLowerCase().includes(q) || (r.memo || '').toLowerCase().includes(q)) : rows;
  }, [rows, search]);
  const pg = paginate(filtered, page, PER_PAGE);
  const selected = filtered.find((r) => r.id === selectedId) || pg.slice[0] || null;
  const canLoadMore = (ledger.data?.rows.length || 0) >= BATCH && !moreState.done;

  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setMoreState({ busy: true, done: false, error: null });
    try {
      const r = await get<LedgerResponse>(`/api/admin/ledger?${qs}&before=${last.id}`);
      setOlder((x) => [...x, ...r.rows]);
      setMoreState({ busy: false, done: r.rows.length < BATCH, error: null });
    } catch (e) {
      setMoreState({ busy: false, done: false, error: errorMessage(e) });
    }
  };

  const total = (t: string) => ledger.data?.totals.find((x) => x.transaction_type === t);
  const all = (ledger.data?.totals || []).reduce((a, x) => a + x.n, 0);
  const corrections = ['adjustment', 'quest_reward', 'trade_reversal'].reduce((a, t) => a + (total(t)?.n || 0), 0);

  const exportCsv = () => downloadCsv(`transactions-${new Date().toISOString().slice(0, 16)}.csv`, [
    ['entry_id', 'time', 'round', 'team', 'type', 'ticker', 'side', 'quantity', 'price_rupees', 'fee_rupees', 'amount_rupees', 'balance_after_rupees', 'by', 'memo'],
    ...filtered.map((r) => [r.id, r.created_at, r.round_id, r.team_name, ledgerLabel(r.transaction_type), r.ticker, r.side, r.quantity,
      r.price != null ? r.price / 100 : '', r.fee != null ? r.fee / 100 : '', r.amount / 100, r.balance_after / 100, r.created_by, r.memo]),
  ]);

  return (
    <div className="space-y-6 pb-12 animate-fadeIn">
      <PageHeader title="Transactions" subtitle="Every cash movement of every team. Entries are never edited; corrections are new entries." o={o} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi icon={<Wallet className="w-5 h-5" />} tint="bg-indigo-500/10 border-indigo-500/20 text-indigo-400" label="All Transactions" value={qty(all)} sub={<span className="text-slate-500">all teams, all rounds</span>} onClick={() => setType('')} />
        <Kpi icon={<TrendingUp className="w-5 h-5" />} tint="bg-emerald-500/10 border-emerald-500/20 text-emerald-400" label="Trade Buys" value={qty(total('trade_buy')?.n || 0)} sub={<span className="text-slate-400">{inr(-(total('trade_buy')?.amount || 0))} spent</span>} onClick={() => setType('trade_buy')} />
        <Kpi icon={<TrendingDown className="w-5 h-5" />} tint="bg-rose-500/10 border-rose-500/20 text-rose-400" label="Trade Sells" value={qty(total('trade_sell')?.n || 0)} sub={<span className="text-slate-400">{inr(total('trade_sell')?.amount || 0)} received</span>} onClick={() => setType('trade_sell')} />
        <Kpi icon={<Gift className="w-5 h-5" />} tint="bg-amber-500/10 border-amber-500/20 text-amber-400" label="Organiser Corrections" value={qty(corrections)} sub={<span className="text-slate-400">adjustments, rewards, reversals</span>} onClick={() => setType('adjustment')} />
      </div>

      <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search by team, entry ID, symbol, note..."
            className="w-full bg-[#111622] border border-[#1e2638] rounded-xl pl-10 pr-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500" />
        </div>
        <select value={type} onChange={(e) => setType(e.target.value)} className="bg-[#111622] border border-[#1e2638] rounded-xl px-3.5 py-2 text-xs font-medium text-slate-200">
          <option value="">All Types</option>
          {TYPES.map((t) => <option key={t} value={t}>{ledgerLabel(t)}</option>)}
        </select>
        <select value={team} onChange={(e) => setTeam(e.target.value)} className="bg-[#111622] border border-[#1e2638] rounded-xl px-3.5 py-2 text-xs font-medium text-slate-200">
          <option value="">All Teams</option>
          {(teams.data || []).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((t) => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
        </select>
        <select value={round} onChange={(e) => setRound(e.target.value)} className="bg-[#111622] border border-[#1e2638] rounded-xl px-3.5 py-2 text-xs font-medium text-slate-200">
          <option value="">All Rounds</option>
          {o.rounds.filter((r) => r.status !== 'pending').map((r) => <option key={r.id} value={r.id}>Round {r.id}</option>)}
        </select>
        <button onClick={() => { setType(''); setTeam(''); setRound(''); setSearch(''); }} className={btn.small}>Reset</button>
        <button onClick={exportCsv} disabled={!filtered.length} className={btn.small}><Download className="w-3.5 h-3.5" /><span>Export CSV</span></button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className={`xl:col-span-8 ${card} overflow-hidden`}>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse monopoly-table">
              <thead>
                <tr className="text-xs font-semibold text-slate-400 border-b border-[#1b2233]">
                  <th className="py-3 px-4">Entry</th>
                  <th className="py-3 px-3">Time</th>
                  <th className="py-3 px-3">Team</th>
                  <th className="py-3 px-3">Type</th>
                  <th className="py-3 px-3">Details</th>
                  <th className="py-3 px-3 text-right">Amount (₹)</th>
                  <th className="py-3 px-4 text-right">Balance (₹)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#171e2c] text-sm">
                {!ledger.data && <EmptyRow cols={7} text="Loading…" />}
                {ledger.data && pg.slice.length === 0 && <EmptyRow cols={7} text="No transactions match." />}
                {pg.slice.map((r) => (
                  <tr key={r.id} onClick={() => setSelectedId(r.id)} className={`cursor-pointer transition-colors ${selected?.id === r.id ? 'bg-[#182338]' : 'hover:bg-[#161d2d]'}`}>
                    <td className="py-3 px-4 font-mono text-xs text-slate-400">#{r.id}</td>
                    <td className="py-3 px-3 font-mono text-xs text-slate-400 whitespace-nowrap">{clockSeconds(r.created_at)}</td>
                    <td className="py-3 px-3 text-white font-semibold whitespace-nowrap">{r.team_name}</td>
                    <td className="py-3 px-3"><TypeBadge t={r.transaction_type} /></td>
                    <td className="py-3 px-3 text-xs text-slate-300 whitespace-nowrap">{details(r)}</td>
                    <td className={`py-3 px-3 text-right font-mono ${r.amount > 0 ? 'text-emerald-400' : 'text-slate-200'}`}>{r.amount > 0 ? '+' : ''}{rupees(r.amount)}</td>
                    <td className="py-3 px-4 text-right font-mono text-slate-400">{rupees(r.balance_after, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={pg.page} pages={pg.pages} total={filtered.length} perPage={PER_PAGE} onPage={setPage} label="entries" />
          {(canLoadMore || moreState.error) && (
            <div className="px-5 pb-4 space-y-2">
              <ErrorNote text={moreState.error} />
              <button onClick={loadMore} disabled={moreState.busy} className={btn.small}>
                {moreState.busy && <Spinner className="w-3.5 h-3.5" />}<span>Load older entries</span>
              </button>
            </div>
          )}
        </div>

        <div className="xl:col-span-4 space-y-6">
          <div className={`${card} p-5 space-y-4`}>
            <h2 className="text-sm font-bold text-white">Transaction Details</h2>
            {!selected ? <p className="text-xs text-slate-500">Select an entry.</p> : (
              <>
                <div className="space-y-2 text-xs">
                  {([
                    ['Entry', `#${selected.id}`],
                    ['Time', dateTime(selected.created_at)],
                    ['Team', selected.team_name || ''],
                    ['Type', ledgerLabel(selected.transaction_type)],
                    ['Round', selected.round_id != null ? `Round ${selected.round_id}` : '—'],
                    ...(selected.ticker ? [['Trade', `${(selected.side || '').toUpperCase()} ${qty(selected.quantity || 0)} ${selected.ticker} @ ${inr(selected.price || 0, 2)}`]] : []),
                    ...(selected.fee != null ? [['Fee', inr(selected.fee, 2)]] : []),
                    ['Amount', inr(selected.amount, 2)],
                    ['Cash after', inr(selected.balance_after, 2)],
                    ['By', byLabel(selected.created_by)],
                  ] as [string, string][]).map(([k, v], i) => (
                    <div key={i} className="flex justify-between gap-3"><span className="text-slate-400">{k}</span><span className="text-slate-200 font-medium text-right">{v}</span></div>
                  ))}
                  {selected.memo && <div className="pt-2 border-t border-[#1b2233] text-slate-300">{selected.memo}</div>}
                </div>
                {selected.order_id && (selected.transaction_type === 'trade_buy' || selected.transaction_type === 'trade_sell') ? (
                  <button className={`${btn.primary} w-full py-2.5`} onClick={() => act(actions.reverseOrder({
                    id: selected.order_id!, team: selected.team_name || '', side: selected.side || '', quantity: selected.quantity || 0, ticker: selected.ticker || '', price: selected.price ?? null,
                    settled: o.rounds.find((r) => r.id === selected.round_id)?.status === 'settled',
                  }))}>
                    <RotateCcw className="w-3.5 h-3.5" /><span>Reverse this trade (order #{selected.order_id})</span>
                  </button>
                ) : (
                  <p className="text-[11px] text-slate-500 flex items-start space-x-1.5"><PlusCircle className="w-3.5 h-3.5 shrink-0" /><span>Entries are permanent. To correct this one, use Adjust Cash on the team (Participants).</span></p>
                )}
              </>
            )}
          </div>
          {selected && <BalanceChart teamId={selected.team_id} teamName={selected.team_name || ''} />}
        </div>
      </div>
    </div>
  );
};

function details(r: LedgerRow): string {
  if (r.ticker && r.quantity) return `${(r.side || '').toUpperCase()} ${qty(r.quantity)} ${r.ticker} @ ${rupees(r.price || 0)}`;
  return r.memo || '';
}
function byLabel(by: string): string {
  if (by.startsWith('admin:')) return 'Organiser';
  if (by.startsWith('team:')) return by.slice(5);
  return by === 'team' ? 'Team' : by === 'system' ? 'System' : by;
}

const BADGE: Record<string, string> = {
  trade_buy: 'bg-[#133827] text-[#10b981] border-[#1b5e3f]/40',
  trade_sell: 'bg-[#3b171c] text-[#f87171] border-[#6b222d]/40',
  quest_reward: 'bg-amber-950/60 text-amber-400 border-amber-800/40',
  adjustment: 'bg-blue-950/60 text-blue-400 border-blue-800/40',
  trade_reversal: 'bg-violet-950/60 text-violet-300 border-violet-800/40',
};
const TypeBadge: React.FC<{ t: string }> = ({ t }) => (
  <span className={`px-2 py-0.5 text-[10px] font-bold rounded border whitespace-nowrap ${BADGE[t] || 'bg-slate-800 text-slate-300 border-slate-700'}`}>{ledgerLabel(t)}</span>
);

// Net worth after each settled round, plus now, for one team. Drawn from /teams/:id/history.
const BalanceChart: React.FC<{ teamId: number; teamName: string }> = ({ teamId, teamName }) => {
  const { version } = useAdmin();
  const h = usePoll(() => get<TeamHistory>(`/api/admin/teams/${teamId}/history`), 0, [teamId, version]);
  const pts = useMemo(() => {
    if (!h.data) return [];
    const p = h.data.rounds.map((r) => ({ label: r.round_id === 0 ? 'Start' : `R${r.round_id}`, v: r.net_worth }));
    if (!p.length) p.push({ label: 'Start', v: h.data.starting_cash });
    p.push({ label: 'Now', v: h.data.now.net_worth });
    return p;
  }, [h.data]);
  const W = 260, H = 110, PAD = 8;
  const min = Math.min(...pts.map((p) => p.v)), max = Math.max(...pts.map((p) => p.v));
  const span = max - min || 1;
  const xy = pts.map((p, i) => [PAD + (i * (W - 2 * PAD)) / Math.max(1, pts.length - 1), H - PAD - ((p.v - min) * (H - 2 * PAD)) / span]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const up = pts.length > 1 && pts[pts.length - 1].v >= pts[0].v;

  return (
    <div className={`${card} p-5 space-y-3`}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-white">Net Worth History</h2>
        <span className="text-xs text-slate-400">{teamName}</span>
      </div>
      {!h.data ? <div className="flex justify-center py-6"><Spinner /></div> : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-32" role="img" aria-label={`Net worth of ${teamName} by round`}>
            <path d={`${line} L ${xy[xy.length - 1][0]} ${H - PAD} L ${xy[0][0]} ${H - PAD} Z`} fill={up ? 'rgba(16,185,129,0.12)' : 'rgba(244,63,94,0.12)'} />
            <path d={line} fill="none" stroke={up ? '#10b981' : '#f43f5e'} strokeWidth="2" strokeLinejoin="round" />
            {xy.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="2.5" fill={up ? '#10b981' : '#f43f5e'} />)}
          </svg>
          <div className="flex justify-between text-[10px] text-slate-500 font-mono">{pts.map((p, i) => <span key={i}>{p.label}</span>)}</div>
          <div className="flex justify-between text-xs">
            <span className="text-slate-400">Low {inr(min)}</span>
            <span className="text-slate-400">High {inr(max)}</span>
          </div>
        </>
      )}
    </div>
  );
};
