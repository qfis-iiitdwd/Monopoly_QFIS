import React, { useEffect, useMemo, useState } from 'react';
import { BarChart2, Download, Gift, Key, LogIn, PlusCircle, RotateCcw, Search, Shield, ShieldOff, User, Users, Wallet, X } from 'lucide-react';
import { get } from '../../shared/api';
import { usePoll } from '../../shared/hooks';
import { clock, downloadCsv, formatIndianNumber, inr, qty, rupees, signedInr } from '../../shared/format';
import { btn, card, EmptyRow, paginate, Pager, SideBadge, Spinner, TickerBadge } from '../../shared/ui';
import { useAdmin } from '../AdminApp';
import { actions } from '../actions';
import { Kpi, PageHeader } from '../common';
import { AdjustCashModal, AdjustHoldingsModal, RewardModal } from '../modals/TeamForms';
import { AdminTeam, TeamDetail } from '../types';
import { RankBadge } from './Overview';

const PER_PAGE = 15;
type DetailTab = 'overview' | 'portfolio' | 'orders' | 'transactions';

const LEDGER_LABEL: Record<string, string> = {
  initial_deposit: 'Starting capital', trade_buy: 'Trade Buy', trade_sell: 'Trade Sell', trade_reversal: 'Reversal',
  adjustment: 'Adjustment', quest_reward: 'Reward', loan_disbursement: 'Loan', loan_repayment: 'Loan repayment', liquidation: 'Liquidation',
};
export const ledgerLabel = (t: string) => LEDGER_LABEL[t] || t;

export const ParticipantsView: React.FC = () => {
  const { overview, teams, focusTeam, go } = useAdmin();
  const o = overview.data!;
  const list = teams.data || [];
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('All Status');
  const [sort, setSort] = useState('Sort by Net Worth');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<number | null>(focusTeam);
  const [reward, setReward] = useState<number[] | null>(null);

  useEffect(() => { if (focusTeam) setSelectedId(focusTeam); }, [focusTeam]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const rows = list.filter((t) => {
      const st = status === 'All Status' || (status === 'Active' && t.is_active) || (status === 'Disabled' && !t.is_active)
        || (status === 'Logged in' && t.sessions > 0) || (status === 'Not logged in' && t.sessions === 0 && t.is_active);
      return st && (t.name.toLowerCase().includes(q) || t.access_identifier.toLowerCase().includes(q) || t.members.some((m) => m.toLowerCase().includes(q)));
    });
    const by: Record<string, (a: AdminTeam, b: AdminTeam) => number> = {
      'Sort by Net Worth': (a, b) => b.net_worth - a.net_worth,
      'Sort by P&L': (a, b) => b.total_pnl - a.total_pnl,
      'Sort by Cash': (a, b) => b.cash - a.cash,
      'Sort by Name': (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    };
    return [...rows].sort(by[sort]);
  }, [list, search, status, sort]);
  const pg = paginate(filtered, page, PER_PAGE);
  const selected = list.find((t) => t.team_id === selectedId) || null;
  const active = list.filter((t) => t.is_active);
  const loggedIn = list.filter((t) => t.sessions > 0).length;
  const avg = active.length ? active.reduce((a, t) => a + t.net_worth, 0) / active.length : 0;

  const exportCsv = () => downloadCsv(`teams-${new Date().toISOString().slice(0, 16)}.csv`, [
    ['rank', 'team', 'team_id', 'status', 'members', 'net_worth_rupees', 'cash_rupees', 'holdings_rupees', 'total_pnl_rupees', 'executed_orders', 'devices_logged_in'],
    ...filtered.map((t) => [t.rank ?? '', t.name, t.access_identifier, t.is_active ? 'active' : 'disabled', t.members.join(' / '), t.net_worth / 100, t.cash / 100, t.holdings_value / 100, t.total_pnl / 100, t.executed_orders, t.sessions]),
  ]);

  return (
    <div className="space-y-6 pb-12 animate-fadeIn">
      <PageHeader title="Participants" subtitle="Every team's live position. Corrections are logged with a reason." o={o} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi icon={<Users className="w-5 h-5" />} tint="bg-rose-500/10 border-rose-500/20 text-rose-400" label="Total Teams" value={list.length}
          sub={<span className="text-slate-400">{active.length} active</span>} onClick={() => setStatus('All Status')} />
        <Kpi icon={<LogIn className="w-5 h-5" />} tint="bg-sky-500/10 border-sky-500/20 text-sky-400" label="Logged in now" value={loggedIn}
          sub={<span className="text-slate-400">{list.length - loggedIn} without a device</span>} onClick={() => setStatus('Not logged in')} />
        <Kpi icon={<Wallet className="w-5 h-5" />} tint="bg-emerald-500/10 border-emerald-500/20 text-emerald-400" label="Average Net Worth" value={inr(avg)}
          sub={<span className={avg >= o.state.settings.starting_cash ? 'text-emerald-400' : 'text-rose-400'}>{signedInr(avg - o.state.settings.starting_cash)} vs start</span>} />
        <Kpi icon={<ShieldOff className="w-5 h-5" />} tint="bg-amber-500/10 border-amber-500/20 text-amber-400" label="Disabled" value={list.length - active.length}
          sub={<span className="text-slate-400">click to show</span>} onClick={() => setStatus('Disabled')} />
      </div>

      <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search team name, member, or ID..."
            className="w-full bg-[#111622] border border-[#1e2638] rounded-xl pl-10 pr-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500" />
        </div>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="bg-[#111622] border border-[#1e2638] rounded-xl px-3.5 py-2 text-xs font-medium text-slate-200">
          {['All Status', 'Active', 'Logged in', 'Not logged in', 'Disabled'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} className="bg-[#111622] border border-[#1e2638] rounded-xl px-3.5 py-2 text-xs font-medium text-slate-200">
          {['Sort by Net Worth', 'Sort by P&L', 'Sort by Cash', 'Sort by Name'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <button onClick={() => { setSearch(''); setStatus('All Status'); setSort('Sort by Net Worth'); setPage(1); }} className={btn.small}>Reset</button>
        <button onClick={() => setReward([])} className={btn.small}><Gift className="w-3.5 h-3.5" /><span>Reward</span></button>
        <button onClick={exportCsv} disabled={!filtered.length} className={btn.small}><Download className="w-3.5 h-3.5" /><span>Export CSV</span></button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className={`${selected ? 'xl:col-span-7' : 'xl:col-span-12'} ${card} overflow-hidden`}>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse monopoly-table">
              <thead>
                <tr className="text-xs font-semibold text-slate-400 border-b border-[#1b2233]">
                  <th className="py-3 px-4">#</th>
                  <th className="py-3 px-3">Team</th>
                  <th className="py-3 px-3">Members</th>
                  <th className="py-3 px-4 text-right">Net Worth (₹)</th>
                  <th className="py-3 px-4 text-right">Cash (₹)</th>
                  <th className="py-3 px-4 text-right">P&L (₹)</th>
                  <th className="py-3 px-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#171e2c] text-sm">
                {!teams.data && <EmptyRow cols={7} text="Loading…" />}
                {teams.data && pg.slice.length === 0 && <EmptyRow cols={7} text="No team matches." />}
                {pg.slice.map((t) => (
                  <tr key={t.team_id} onClick={() => setSelectedId(t.team_id)} className={`cursor-pointer transition-colors ${selectedId === t.team_id ? 'bg-[#182338]' : 'hover:bg-[#161d2d]'}`}>
                    <td className="py-3 px-4"><RankBadge rank={t.rank} /></td>
                    <td className="py-3 px-3">
                      <div className="font-semibold text-white whitespace-nowrap">{t.name}</div>
                      <div className="text-[11px] text-slate-500 font-mono">{t.access_identifier}</div>
                    </td>
                    <td className="py-3 px-3 text-xs text-slate-400 max-w-[12rem] truncate">{t.members.length ? t.members.join(', ') : '—'}</td>
                    <td className="py-3 px-4 text-right font-mono text-slate-200">{formatIndianNumber(t.net_worth / 100)}</td>
                    <td className="py-3 px-4 text-right font-mono text-slate-300">{formatIndianNumber(t.cash / 100)}</td>
                    <td className={`py-3 px-4 text-right font-mono ${t.total_pnl > 0 ? 'text-emerald-400' : t.total_pnl < 0 ? 'text-rose-400' : 'text-slate-400'}`}>{t.total_pnl > 0 ? '+' : ''}{formatIndianNumber(t.total_pnl / 100)}</td>
                    <td className="py-3 px-4"><TeamStatus t={t} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={pg.page} pages={pg.pages} total={filtered.length} perPage={PER_PAGE} onPage={setPage} label="teams" />
        </div>
        {selected && (
          <div className="xl:col-span-5">
            <TeamPanel team={selected} onClose={() => setSelectedId(null)} onReward={() => setReward([selected.team_id])} onOrders={() => go('orders')} />
          </div>
        )}
      </div>
      {reward && <RewardModal teams={list} initial={reward} maxReward={o.state.settings.max_reward} onClose={() => setReward(null)} />}
    </div>
  );
};

const TeamStatus: React.FC<{ t: AdminTeam }> = ({ t }) =>
  !t.is_active ? <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-950/60 text-amber-400 border border-amber-800/40">Disabled</span>
    : t.sessions > 0 ? <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950/60 text-emerald-400 border border-emerald-800/40 whitespace-nowrap">{t.sessions} device{t.sessions > 1 ? 's' : ''}</span>
      : <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700 whitespace-nowrap">Not logged in</span>;

const TeamPanel: React.FC<{ team: AdminTeam; onClose: () => void; onReward: () => void; onOrders: () => void }> = ({ team, onClose, onReward }) => {
  const { act, version, overview } = useAdmin();
  const [tab, setTab] = useState<DetailTab>('overview');
  const [modal, setModal] = useState<'cash' | 'holdings' | null>(null);
  const detail = usePoll(() => get<TeamDetail>(`/api/admin/teams/${team.team_id}`), 5000, [team.team_id, version]);
  const d = detail.data;
  const currentRound = overview.data!.state.current_round;
  const roundSettled = (r: number) => overview.data!.rounds.find((x) => x.id === r)?.status === 'settled';

  return (
    <div className={`${card} overflow-hidden`}>
      <div className="p-5 border-b border-[#1b2233] flex items-start justify-between">
        <div>
          <div className="flex items-center space-x-2">
            <Shield className="w-5 h-5 text-amber-400" />
            <h2 className="text-base font-bold text-white">{team.name}</h2>
            <TeamStatus t={team} />
          </div>
          <div className="text-xs text-slate-500 mt-1 font-mono">Login ID {team.access_identifier}</div>
        </div>
        <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
      </div>
      <div className="px-5 flex space-x-5 border-b border-[#1b2233] text-xs font-semibold">
        {(['overview', 'portfolio', 'orders', 'transactions'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} aria-pressed={tab === t} className={`py-3 capitalize ${tab === t ? 'text-white border-b-2 border-rose-500' : 'text-slate-400 hover:text-white'}`}>{t}</button>
        ))}
      </div>
      {!d ? <div className="py-12 flex justify-center text-slate-500"><Spinner /></div> : (
        <div className="p-5 space-y-5">
          {tab === 'overview' && (
            <>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <Stat k="Net Worth" v={inr(d.portfolio.net_worth)} />
                <Stat k="Cash" v={inr(d.portfolio.cash)} />
                <Stat k="Total P&L" v={signedInr(d.portfolio.total_pnl)} tone={d.portfolio.total_pnl > 0 ? 'text-emerald-400' : d.portfolio.total_pnl < 0 ? 'text-rose-400' : ''} />
                <Stat k="Rank" v={team.rank ? `${team.rank} of ${overview.data!.counts.teams}` : '—'} />
                <Stat k={`Trades in Round ${currentRound || '—'}`} v={String(d.portfolio.trades_this_round)} />
                <Stat k="Devices logged in" v={String(team.sessions)} />
              </div>
              <div>
                <div className="text-xs font-semibold text-slate-300 mb-2">Members (names typed at login)</div>
                {team.members.length === 0 && <div className="text-xs text-slate-500">No trades yet.</div>}
                <div className="flex flex-wrap gap-2">
                  {team.members.map((m) => (
                    <span key={m} className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-[#161d2d] border border-[#222e47] text-xs text-slate-200"><User className="w-3.5 h-3.5 text-slate-400" /><span>{m}</span></span>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <button onClick={() => setModal('cash')} className={btn.outline}><PlusCircle className="w-3.5 h-3.5 text-slate-400" /><span>Adjust Cash</span></button>
                <button onClick={() => setModal('holdings')} className={btn.outline}><BarChart2 className="w-3.5 h-3.5 text-slate-400" /><span>Adjust Holdings</span></button>
                <button onClick={() => act(actions.resetPassword(team.team_id, team.name))} className={btn.outline}><Key className="w-3.5 h-3.5 text-slate-400" /><span>Reset Password</span></button>
                <button onClick={onReward} className={btn.outline}><Gift className="w-3.5 h-3.5 text-slate-400" /><span>Reward</span></button>
                <button onClick={() => setTab('orders')} className={btn.outline}><RotateCcw className="w-3.5 h-3.5 text-slate-400" /><span>Reverse an Order</span></button>
                <button onClick={() => act(actions.setActive(team.team_id, team.name, !team.is_active))}
                  className={team.is_active ? 'py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center space-x-2 bg-rose-950/40 border border-rose-900/60 text-rose-300 hover:bg-rose-900/40' : btn.green}>
                  {team.is_active ? <ShieldOff className="w-3.5 h-3.5" /> : <Shield className="w-3.5 h-3.5" />}
                  <span>{team.is_active ? 'Disable Team' : 'Enable Team'}</span>
                </button>
              </div>
            </>
          )}
          {tab === 'portfolio' && (
            <table className="w-full text-left text-xs monopoly-table">
              <thead><tr className="text-slate-400"><th className="py-2">Company</th><th className="py-2 text-right">Shares</th><th className="py-2 text-right">Value (₹)</th><th className="py-2 text-right">Gain (₹)</th></tr></thead>
              <tbody>
                {d.portfolio.holdings.length === 0 && <EmptyRow cols={4} text="No holdings." />}
                {d.portfolio.holdings.map((h) => (
                  <tr key={h.company_id}>
                    <td className="py-2"><TickerBadge ticker={h.ticker} industry={h.industry} /></td>
                    <td className="py-2 text-right font-mono">{qty(h.quantity)}</td>
                    <td className="py-2 text-right font-mono">{rupees(h.value, 0)}</td>
                    <td className={`py-2 text-right font-mono ${h.unrealized_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{rupees(h.unrealized_pnl, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {tab === 'orders' && (
            <div className="space-y-2 max-h-[28rem] overflow-y-auto -mx-1 px-1">
              {d.orders.length === 0 && <div className="text-xs text-slate-500">No orders.</div>}
              {d.orders.map((x) => (
                <div key={x.order_id ? `o${x.order_id}` : `t${x.trade_id}`} className="flex items-center justify-between gap-2 py-2 border-b border-[#171e2c] text-xs">
                  <div className="flex items-center space-x-2 min-w-0">
                    <SideBadge side={x.source === 'reversal' ? 'Correction' : x.side} />
                    <div className="min-w-0">
                      <div className="text-slate-200 font-semibold truncate">{qty(x.quantity)} {x.ticker} {x.execution_price ? `@ ${rupees(x.execution_price)}` : ''}</div>
                      <div className="text-[10px] text-slate-500 truncate">
                        R{x.round_id} · {clock(x.submitted_at)} · {x.status === 'rejected' ? `Rejected: ${x.rejection_reason}` : x.reversed_reason ? `Reversed: ${x.reversed_reason}` : x.source === 'reversal' ? 'by organisers' : x.placed_by || ''}
                      </div>
                    </div>
                  </div>
                  {x.source === 'order' && x.status === 'executed' && !x.reversed_reason && x.order_id && (
                    <button className={btn.small} onClick={() => act(actions.reverseOrder({
                      id: x.order_id!, team: team.name, side: x.side, quantity: x.quantity, ticker: x.ticker, price: x.execution_price, settled: roundSettled(x.round_id),
                    }))}>
                      <RotateCcw className="w-3 h-3" /><span>Reverse</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {tab === 'transactions' && (
            <div className="space-y-1 max-h-[28rem] overflow-y-auto">
              {d.ledger.map((l) => (
                <div key={l.id} className="flex items-center justify-between gap-2 py-2 border-b border-[#171e2c] text-xs">
                  <div className="min-w-0">
                    <div className="text-slate-200 font-semibold">{ledgerLabel(l.transaction_type)}</div>
                    <div className="text-[10px] text-slate-500 truncate">{clock(l.created_at)} · {l.memo}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`font-mono ${l.amount > 0 ? 'text-emerald-400' : 'text-slate-200'}`}>{l.amount > 0 ? '+' : ''}{rupees(l.amount)}</div>
                    <div className="text-[10px] text-slate-500 font-mono">bal {rupees(l.balance_after, 0)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {modal === 'cash' && <AdjustCashModal team={team} onClose={() => setModal(null)} />}
      {modal === 'holdings' && d && <AdjustHoldingsModal team={team} holdings={d.portfolio.holdings} onClose={() => setModal(null)} />}
    </div>
  );
};

const Stat: React.FC<{ k: string; v: string; tone?: string }> = ({ k, v, tone = 'text-white' }) => (
  <div className="rounded-lg bg-[#141b2a] border border-[#1f293d] p-3">
    <div className="text-[11px] text-slate-400">{k}</div>
    <div className={`font-mono font-bold mt-0.5 ${tone || 'text-white'}`}>{v}</div>
  </div>
);
