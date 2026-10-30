import React, { useState } from 'react';
import { Activity, ArrowRight, Building2, Clock, FileText, Flag, IndianRupee, Pause, Play, PlusCircle, Send, ShieldCheck, Square, Trophy, Users } from 'lucide-react';
import { errorMessage, get, post } from '../../shared/api';
import { usePoll } from '../../shared/hooks';
import { formatIndianNumber, inr, signedInr } from '../../shared/format';
import { btn, card, Spinner, useToast } from '../../shared/ui';
import { useAdmin } from '../AdminApp';
import { actions } from '../actions';
import { AuditModal, AuditTable } from '../AuditTable';
import { delta, Kpi, marketState, PageHeader, RoundCountdown, SectionTitle, StateText } from '../common';
import { AuditRow, Overview } from '../types';

/** The one thing the organiser should do next, with the button that does it. */
export function nextStep(o: Overview, act: (s: ReturnType<typeof actions.startEvent>) => void, goRounds: () => void) {
  const s = o.state;
  const r = o.rounds.find((x) => x.id === s.current_round);
  const total = s.settings.total_rounds;
  if (s.status === 'setup') return { text: 'Start the event so teams can log in and see prices.', label: 'Start event', icon: <Play className="w-4 h-4 fill-white" />, onClick: () => act(actions.startEvent()) };
  if (s.status === 'finished') return { text: 'The event is over. Final rankings are frozen.', label: null, onClick: null };
  if (!r || (r.status === 'settled' && r.id < total)) {
    const next = o.rounds.find((x) => x.id === s.current_round + 1)!;
    return { text: `Round ${next.id} is ready to open.`, label: `Open Round ${next.id}`, icon: <Play className="w-4 h-4 fill-white" />, onClick: () => act(actions.openRound(next)) };
  }
  if (r.status === 'open') return { text: s.paused ? 'Trading is paused.' : `Round ${r.id} is trading. It closes automatically at the deadline.`, label: null, onClick: null };
  if (r.status === 'closed') return { text: `Round ${r.id} is closed. Review the new prices, then apply them.`, label: 'Review & apply prices', icon: <ArrowRight className="w-4 h-4" />, onClick: goRounds };
  return { text: `All ${total} rounds are settled. End the event to freeze the final rankings.`, label: 'End event', icon: <Flag className="w-4 h-4" />, onClick: () => act(actions.endEvent()) };
}

export const OverviewView: React.FC = () => {
  const { overview, teams, act, go, version } = useAdmin();
  const o = overview.data!;
  const toast = useToast();
  const audit = usePoll(() => get<AuditRow[]>('/api/admin/audit-log'), 10000, [version]);
  const [showAudit, setShowAudit] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [integrity, setIntegrity] = useState<{ state: 'idle' | 'running' | 'ok' | 'bad'; detail?: string }>({ state: 'idle' });

  const m = marketState(o);
  const cur = o.rounds.find((r) => r.id === o.state.current_round);
  const prev = o.rounds.find((r) => r.id === o.state.current_round - 1);
  const step = nextStep(o, act, () => go('rounds'));
  const isOpen = cur?.status === 'open';

  const sendMessage = async (message: string) => {
    setSending(true);
    try {
      await post('/api/admin/message', { message });
      toast(message ? 'Message is now showing on every team screen' : 'Message cleared');
      setText('');
      overview.reload();
      audit.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSending(false);
    }
  };

  const runIntegrity = async () => {
    setIntegrity({ state: 'running' });
    try {
      const r = await get<{ problems: { check: string }[] }>('/api/admin/integrity');
      setIntegrity(r.problems.length ? { state: 'bad', detail: `${r.problems.length} problem(s): ${[...new Set(r.problems.map((p) => p.check))].join(', ')}` } : { state: 'ok' });
    } catch (e) {
      setIntegrity({ state: 'bad', detail: errorMessage(e) });
    }
  };

  const top = (teams.data || []).filter((t) => t.is_active).slice(0, 10);

  return (
    <div className="space-y-6 pb-12 animate-fadeIn">
      <PageHeader title="Overview" subtitle="Monitor the simulation, manage activity and control the event." o={o} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi icon={<Users className="w-5 h-5" />} tint="bg-rose-500/10 border-rose-500/20 text-rose-400" label="Teams" value={o.counts.teams}
          sub={<span className="text-emerald-400">{o.counts.teams_logged_in} logged in now{o.counts.teams_disabled ? <span className="text-slate-500"> · {o.counts.teams_disabled} disabled</span> : null}</span>}
          onClick={() => go('participants')} />
        <Kpi icon={<Building2 className="w-5 h-5" />} tint="bg-blue-500/10 border-blue-500/20 text-blue-400" label="Companies" value={o.counts.companies}
          sub={<StateText tone={o.counts.companies_tradable === o.counts.companies ? 'green' : 'amber'}>{o.counts.companies_tradable} tradable</StateText>}
          onClick={() => go('companies')} />
        <Kpi icon={<FileText className="w-5 h-5" />} tint="bg-indigo-500/10 border-indigo-500/20 text-indigo-400"
          label={cur ? `Orders (Round ${cur.id})` : 'Orders'} value={formatIndianNumber(cur?.executed ?? 0)}
          sub={cur ? <>{delta(cur.executed, prev?.executed)}<span className="text-slate-500"> · {cur.rejected} rejected</span></> : <span className="text-slate-500">no round yet</span>}
          onClick={() => go('orders')} />
        <Kpi icon={<IndianRupee className="w-5 h-5" />} tint="bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
          label={cur ? `Traded Value (Round ${cur.id})` : 'Traded Value'} value={inr(cur?.traded_value ?? 0)}
          sub={cur ? delta(cur.traded_value, prev?.traded_value) : <span className="text-slate-500">no round yet</span>}
          onClick={() => go('transactions')} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        <div className={`${card} p-6 flex flex-col justify-between`}>
          <div>
            <SectionTitle icon={<Building2 className="w-4 h-4" />} title="Round Control" subtitle="Manage the current round and market status." />
            <div className="grid grid-cols-2 gap-4 mt-6">
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">Current Round</label>
                <div className="w-full bg-[#161d2d] border border-[#222e47] rounded-lg px-3.5 py-2 text-sm text-white font-medium flex justify-between">
                  <span>{o.state.current_round ? `Round ${o.state.current_round}` : 'Not started'}</span>
                  <RoundCountdown round={m.round} state={o.state} />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 block mb-1.5">Market Status</label>
                <div className="bg-[#161d2d] border border-[#222e47] rounded-lg px-3.5 py-2 text-sm font-semibold">
                  <StateText tone={m.tone}>{m.label}</StateText>
                </div>
              </div>
            </div>
            <p className="text-xs text-slate-400 mt-4">{step.text}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5">
            {isOpen ? (
              <>
                <button onClick={() => act(o.state.paused ? actions.resume() : actions.pause())}
                  className={`py-2.5 px-3 rounded-lg text-xs font-bold flex items-center justify-center space-x-2 transition-all text-white ${o.state.paused ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-[#e63946] hover:bg-[#d62839]'}`}>
                  {o.state.paused ? <Play className="w-4 h-4 fill-white" /> : <Pause className="w-4 h-4 fill-white" />}
                  <span>{o.state.paused ? 'Resume Trading' : 'Pause Trading'}</span>
                </button>
                <button onClick={() => act(actions.closeRound(cur!.id))} className={btn.outline}><Square className="w-3.5 h-3.5" /><span>Close Market</span></button>
                <button onClick={() => act(actions.extend(cur!.id))} className={btn.outline}><PlusCircle className="w-3.5 h-3.5" /><span>Extend Round</span></button>
              </>
            ) : step.label ? (
              <button onClick={step.onClick!} className="sm:col-span-3 py-2.5 px-3 rounded-lg text-xs font-bold flex items-center justify-center space-x-2 bg-emerald-600 hover:bg-emerald-500 text-white">
                {step.icon}<span>{step.label}</span>
              </button>
            ) : null}
          </div>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) sendMessage(text.trim()); }} className={`${card} p-6 flex flex-col justify-between`}>
          <div>
            <SectionTitle icon={<Send className="w-4 h-4" />} title="Quick Announcement" subtitle="A banner on every team's screen within 2 seconds." />
            {o.state.message && (
              <div className="mt-4 rounded-lg bg-[#241f17]/80 border border-[#4d3a1f] px-3 py-2 text-xs text-slate-200 flex items-start justify-between gap-3">
                <span><span className="font-bold text-[#eab308]">Showing now: </span>{o.state.message}</span>
                <button type="button" disabled={sending} onClick={() => sendMessage('')} className="text-rose-300 hover:text-rose-200 font-semibold shrink-0">Clear</button>
              </div>
            )}
            <div className="mt-4 relative">
              <textarea rows={3} maxLength={500} placeholder="Type your announcement..." value={text} onChange={(e) => setText(e.target.value)}
                className="w-full bg-[#161d2d] border border-[#222e47] rounded-lg p-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-rose-500 resize-none" />
              <span className="absolute bottom-2.5 right-3 text-[10px] text-slate-500 font-mono">{text.length}/500</span>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button type="submit" disabled={!text.trim() || sending} className={btn.primary}>
              {sending ? <Spinner className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
              <span>{o.state.message ? 'Replace message' : 'Publish'}</span>
            </button>
          </div>
        </form>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className={`lg:col-span-7 ${card} overflow-hidden`}>
          <div className="p-5 border-b border-[#1b2233] flex items-center justify-between">
            <div className="flex items-center space-x-2.5">
              <div className="w-7 h-7 rounded-full bg-rose-950/60 border border-rose-800/40 flex items-center justify-center text-rose-400"><Clock className="w-4 h-4" /></div>
              <div>
                <h2 className="text-sm font-bold text-white">Recent Activity</h2>
                <p className="text-[11px] text-slate-400">Organiser actions and automatic round events.</p>
              </div>
            </div>
            <button onClick={() => setShowAudit(true)} className={btn.small}><span>View All</span><ArrowRight className="w-3.5 h-3.5" /></button>
          </div>
          {audit.data ? <AuditTable rows={audit.data.slice(0, 8)} /> : <div className="py-10 flex justify-center text-slate-500"><Spinner /></div>}
        </div>

        <div className={`lg:col-span-5 ${card} overflow-hidden`}>
          <div className="p-5 border-b border-[#1b2233] flex items-center justify-between">
            <div className="flex items-center space-x-2.5">
              <Trophy className="w-5 h-5 text-amber-400" />
              <div>
                <h2 className="text-sm font-bold text-white">Top Participants</h2>
                <p className="text-[11px] text-slate-400">Live net worth (teams don't see this).</p>
              </div>
            </div>
            <button onClick={() => go('participants')} className={btn.small}><span>View All</span><ArrowRight className="w-3.5 h-3.5" /></button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse monopoly-table">
              <thead>
                <tr className="text-xs font-semibold text-slate-400 border-b border-[#1b2233]">
                  <th className="py-3 px-4">#</th>
                  <th className="py-3 px-3">Team</th>
                  <th className="py-3 px-4 text-right">Net Worth (₹)</th>
                  <th className="py-3 px-4 text-right">Total P&L (₹)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#171e2c] text-sm">
                {top.map((t) => (
                  <tr key={t.team_id} onClick={() => go('participants', t.team_id)} className="hover:bg-[#161d2d] transition-colors cursor-pointer group">
                    <td className="py-3 px-4"><RankBadge rank={t.rank} /></td>
                    <td className="py-3 px-3 font-semibold text-white group-hover:text-rose-400 transition-colors whitespace-nowrap">{t.name}</td>
                    <td className="py-3 px-4 text-right font-mono text-slate-200">{formatIndianNumber(t.net_worth / 100)}</td>
                    <td className={`py-3 px-4 text-right font-mono font-medium ${t.total_pnl > 0 ? 'text-emerald-400' : t.total_pnl < 0 ? 'text-rose-400' : 'text-slate-400'}`}>
                      {signedInr(t.total_pnl).replace('₹ ', '')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className={`${card} p-5`}>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <SectionTitle icon={<Activity className="w-4 h-4" />} title="System health" subtitle="Live from the server." />
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-slate-300">
            <span>Database <strong className={o.db_latency_ms > 50 ? 'text-amber-400' : 'text-emerald-400'}>{o.db_latency_ms} ms</strong></span>
            <span>Connections <strong>{o.pool.total - o.pool.idle}/{o.pool.max}</strong> busy{o.pool.waiting ? <strong className="text-amber-400"> · {o.pool.waiting} waiting</strong> : null}</span>
            <span>Devices logged in <strong>{o.counts.sessions}</strong></span>
            <span>Server errors <strong className={o.recent_errors.length ? 'text-rose-400' : 'text-emerald-400'}>{o.recent_errors.length ? `${o.recent_errors.length} recent` : 'none'}</strong></span>
          </div>
          <div className="flex items-center gap-3">
            {integrity.state === 'ok' && <span className="text-xs text-emerald-400 font-semibold">Books balance ✓</span>}
            {integrity.state === 'bad' && <span className="text-xs text-rose-400 font-semibold max-w-xs">{integrity.detail}</span>}
            <button onClick={runIntegrity} disabled={integrity.state === 'running'} className={btn.small}>
              {integrity.state === 'running' ? <Spinner className="w-3.5 h-3.5" /> : <ShieldCheck className="w-3.5 h-3.5" />}
              <span>Check books</span>
            </button>
          </div>
        </div>
        {o.recent_errors.length > 0 && (
          <ul className="mt-3 text-[11px] text-rose-300/90 space-y-1 font-mono">
            {o.recent_errors.map((e) => <li key={e.id}>{new Date(e.created_at).toLocaleTimeString()} {e.message}</li>)}
          </ul>
        )}
      </div>

      {showAudit && audit.data && <AuditModal rows={audit.data} onClose={() => setShowAudit(false)} />}
    </div>
  );
};

export const RankBadge: React.FC<{ rank: number | null }> = ({ rank }) => {
  if (rank == null) return <span className="text-xs text-slate-500">—</span>;
  const medal = ['bg-amber-400/20 border-amber-400 text-amber-300', 'bg-slate-300/20 border-slate-300 text-slate-200', 'bg-amber-700/20 border-amber-600 text-amber-500'][rank - 1];
  return medal
    ? <span className={`w-5 h-5 rounded-full border font-bold text-xs flex items-center justify-center ${medal}`}>{rank}</span>
    : <span className="text-xs font-mono text-slate-500 pl-1.5">{rank}</span>;
};
