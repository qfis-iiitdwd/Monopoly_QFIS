import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, BarChart3, Building2, Clock, Info, Pause, Play, PlusCircle, RotateCcw, Save, Square, TrendingUp, Undo2 } from 'lucide-react';
import { get, patch } from '../../shared/api';
import { usePoll } from '../../shared/hooks';
import { dateTime, formatIndianNumber, inr, pct, rupees } from '../../shared/format';
import { btn, card, EmptyRow, Modal, Spinner, TickerBadge } from '../../shared/ui';
import { useAdmin } from '../AdminApp';
import { actions } from '../actions';
import { AuditModal, AuditTable } from '../AuditTable';
import { PageHeader, SectionTitle, StateText } from '../common';
import { AdminRound, AuditRow, PreviewRow, ScheduledEvent, Summary } from '../types';
import { Company } from '../../shared/types';

const ROUND_LABEL: Record<string, [string, string]> = {
  open: ['Live', 'bg-rose-950 text-rose-400'],
  closed: ['Closed', 'bg-amber-950 text-amber-400'],
  settled: ['Completed', 'bg-slate-800 text-slate-400'],
  pending: ['Upcoming', 'bg-slate-900 text-slate-500'],
};

export const RoundsView: React.FC = () => {
  const { overview, act, version } = useAdmin();
  const o = overview.data!;
  const [selected, setSelected] = useState<number>(o.state.current_round || 1);
  const [showSummary, setShowSummary] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const round = o.rounds.find((r) => r.id === selected)!;
  const s = o.state;
  const isCurrent = selected === s.current_round;
  const isNext = s.status === 'running' && selected === s.current_round + 1 &&
    (s.current_round === 0 || o.rounds.find((r) => r.id === s.current_round)?.status === 'settled');
  const laterOpened = o.rounds.some((r) => r.id > selected && r.status !== 'pending');

  const audit = usePoll(() => get<AuditRow[]>('/api/admin/audit-log'), 10000, [version]);
  const roundAudit = useMemo(() => {
    if (!audit.data || round.status === 'pending') return [];
    const prev = o.rounds.find((r) => r.id === selected - 1);
    const from = prev?.completed_at || s.started_at || '1970-01-01';
    const to = round.completed_at || '9999-12-31';
    return audit.data.filter((a) => {
      const tagged = (a.after_state as { round?: number; current_round?: number } | null) || {};
      const r = tagged.round ?? (a.action === 'open_round' ? tagged.current_round : undefined);
      if (r !== undefined) return r === selected;
      return a.created_at > from && a.created_at <= to && a.action !== 'admin_login';
    });
  }, [audit.data, round, selected, o.rounds, s.started_at]);

  const statusTone = round.status === 'open' ? (s.paused ? 'amber' : 'green') : round.status === 'closed' ? 'red' : round.status === 'settled' ? 'blue' : 'grey';
  const statusText = round.status === 'open' ? (s.paused ? 'Open · Paused' : 'Open') : round.status === 'closed' ? 'Closed' : round.status === 'settled' ? 'Settled' : 'Not opened';

  return (
    <div className="space-y-6 pb-12 animate-fadeIn">
      <PageHeader title="Rounds" subtitle="Run each round, check the price plan and apply new prices." o={o} />

      <div className="flex items-center space-x-2.5 overflow-x-auto pb-2">
        {o.rounds.map((r) => {
          const [label, tone] = ROUND_LABEL[r.status];
          return (
            <button key={r.id} onClick={() => setSelected(r.id)} aria-pressed={selected === r.id}
              className={`px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap flex items-center space-x-2 transition-all ${
                selected === r.id ? 'bg-[#351820] border border-[#742330] text-white shadow-sm' : 'bg-[#111622] border border-[#1e2638] text-slate-400 hover:text-white hover:bg-[#161d2d]'}`}>
              <span>Round {r.id}</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-bold ${tone}`}>{label}</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-8 space-y-6">
          <div className={`${card} p-6`}>
            <div className="flex items-center justify-between pb-4 border-b border-[#1b2233] gap-3">
              <SectionTitle icon={<BarChart3 className="w-4 h-4" />} title={`Round ${selected} — Market Control`} subtitle={round.title} />
              <button onClick={() => setShowSummary(true)} className="text-xs font-semibold text-slate-300 hover:text-white flex items-center space-x-1 whitespace-nowrap">
                <span>View Round Summary</span><ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 mt-5">
              <div className="md:col-span-4">
                <label className="text-xs font-medium text-slate-400 block mb-1.5">Market Status</label>
                <div className="bg-[#161d2d] border border-[#222e47] rounded-lg px-3.5 py-2.5 text-sm font-semibold"><StateText tone={statusTone}>{statusText}</StateText></div>
              </div>
              <div className="md:col-span-8">
                <label className="text-xs font-medium text-slate-400 block mb-1.5">Actions</label>
                <div className="flex flex-wrap gap-2.5">
                  {s.status === 'setup' && <button onClick={() => act(actions.startEvent())} className={btn.green}><Play className="w-3.5 h-3.5 fill-white" /><span>Start event first</span></button>}
                  {isNext && <button onClick={() => act(actions.openRound(round))} className={btn.green}><Play className="w-3.5 h-3.5 fill-white" /><span>Open Round {round.id}</span></button>}
                  {isCurrent && round.status === 'open' && (
                    <>
                      <button onClick={() => act(s.paused ? actions.resume() : actions.pause())} className={s.paused ? btn.green : btn.primary}>
                        {s.paused ? <Play className="w-3.5 h-3.5 fill-white" /> : <Pause className="w-3.5 h-3.5 fill-white" />}
                        <span>{s.paused ? 'Resume Trading' : 'Pause Trading'}</span>
                      </button>
                      <button onClick={() => act(actions.closeRound(round.id))} className={btn.outline}><Square className="w-3.5 h-3.5" /><span>Close Market</span></button>
                      <button onClick={() => act(actions.extend(round.id))} className={btn.outline}><PlusCircle className="w-3.5 h-3.5" /><span>Extend</span></button>
                    </>
                  )}
                  {isCurrent && round.status === 'closed' && !round.bulletin_published_at && (
                    <button onClick={() => act(actions.reopen(round.id))} className={btn.outline}><RotateCcw className="w-3.5 h-3.5" /><span>Reopen trading</span></button>
                  )}
                  {isCurrent && round.status === 'settled' && !laterOpened && s.status === 'running' && (
                    <button onClick={() => act(actions.undo(round.id))} className={btn.outline}><Undo2 className="w-3.5 h-3.5" /><span>Undo market update</span></button>
                  )}
                  {!isNext && !isCurrent && s.status !== 'setup' && (
                    <span className="text-xs text-slate-500 py-2">
                      {round.status === 'pending' ? `Opens after Round ${selected - 1} is settled.` : 'This round is finished. Corrections: Orders or Participants.'}
                    </span>
                  )}
                  {isCurrent && round.status === 'closed' && <span className="text-xs text-slate-400 py-2">Then apply the new prices below.</span>}
                </div>
              </div>
            </div>
            <div className="mt-5 pt-4 border-t border-[#1b2233] grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <Info2 k="Duration" v={`${Math.floor(round.duration_seconds / 60)} min${round.duration_seconds % 60 ? ` ${round.duration_seconds % 60} s` : ''}`} />
              <Info2 k="Opened" v={dateTime(round.opened_at)} />
              <Info2 k={round.closed_at ? 'Closed' : 'Deadline'} v={dateTime(round.closed_at || round.trading_deadline)} />
              <Info2 k="Prices applied" v={dateTime(round.completed_at)} />
              <Info2 k="Executed orders" v={formatIndianNumber(round.executed)} />
              <Info2 k="Rejected orders" v={formatIndianNumber(round.rejected)} />
              <Info2 k="Teams that traded" v={String(round.teams_traded)} />
              <Info2 k="Traded value" v={inr(round.traded_value)} />
            </div>
          </div>

          <PricePlan round={round} isCurrent={isCurrent} />

          <div className={`${card} overflow-hidden`}>
            <div className="p-5 border-b border-[#1b2233] flex items-center justify-between">
              <div className="flex items-center space-x-2.5">
                <Clock className="w-5 h-5 text-slate-300" />
                <div>
                  <h2 className="text-sm font-bold text-white">Round History</h2>
                  <p className="text-[11px] text-slate-400">Organiser actions during Round {selected}.</p>
                </div>
              </div>
              <button onClick={() => setShowAudit(true)} disabled={!audit.data} className={btn.small}><span>View All Events</span><ArrowRight className="w-3.5 h-3.5" /></button>
            </div>
            <AuditTable rows={roundAudit} empty={round.status === 'pending' ? 'This round has not started.' : 'No organiser actions in this round.'} />
          </div>
        </div>

        <div className="xl:col-span-4 space-y-6">
          <div className={`${card} p-5 space-y-3 text-xs`}>
            <div className="flex items-center space-x-2.5">
              <Info className="w-5 h-5 text-rose-400" />
              <h2 className="text-sm font-bold text-white">How the new price is set</h2>
            </div>
            <p className="text-slate-300 leading-relaxed">New price = current price × (1 + <strong>script move</strong> + <strong>trading pressure</strong>).</p>
            <ul className="text-slate-400 space-y-1.5 list-disc pl-4">
              <li>Script move: from your price plan (the spreadsheet). Edit it below until the round is applied.</li>
              <li>Trading pressure: net buying pushes up, net selling pushes down, up to ±{(s.settings.pressure_cap_bps / 100).toFixed(1)}%.</li>
              <li>Fee on every trade: {(s.settings.fee_bps / 100).toFixed(2)}%.</li>
            </ul>
          </div>
          <LiveSummary />
        </div>
      </div>

      {showSummary && <SummaryModal onClose={() => setShowSummary(false)} />}
      {showAudit && audit.data && <AuditModal rows={audit.data} onClose={() => setShowAudit(false)} />}
    </div>
  );
};

const Info2: React.FC<{ k: string; v: string }> = ({ k, v }) => (
  <div>
    <div className="text-slate-500">{k}</div>
    <div className="text-slate-200 font-semibold mt-0.5">{v}</div>
  </div>
);

// ---- Price plan: script moves (editable until applied) + live preview of the new prices --------
const PricePlan: React.FC<{ round: AdminRound; isCurrent: boolean }> = ({ round, isCurrent }) => {
  const { act, version, overview } = useAdmin();
  const started = overview.data!.state.status !== 'setup';
  const eventId = `SCRIPT-R${String(round.id).padStart(2, '0')}`;
  const events = usePoll(() => get<{ events: ScheduledEvent[] }>('/api/admin/events'), 0, [version]);
  const live = isCurrent && (round.status === 'open' || round.status === 'closed');
  const preview = usePoll(() => (live ? get<{ rows: PreviewRow[] }>(`/api/admin/rounds/${round.id}/preview`) : Promise.resolve(null)), live && round.status === 'open' ? 5000 : 0, [round.id, live, version, round.status]);
  const board = usePoll(() => get<Company[]>('/api/market/prices'), 0, [version]);
  const history = usePoll(() => get<Record<string, { round: number; price: number }[]>>('/api/market/history'), 0, [version, round.status]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  useEffect(() => setEdits({}), [round.id, version]);

  const ev = events.data?.events.find((e) => e.id === eventId);
  const otherEvents = (events.data?.events || []).filter((e) => e.effective_round === round.id && e.id !== eventId);
  const editable = !!ev && !ev.is_applied;
  const settled = round.status === 'settled';

  const rows = useMemo(() => {
    const companies = board.data || [];
    const prev = new Map(preview.data?.rows.map((r) => [r.ticker, r]) || []);
    return companies.map((c) => {
      const script = ev?.configuration.companies[c.ticker] ?? 0;
      const h = history.data?.[c.ticker] || [];
      const before = h.find((x) => x.round === round.id - 1)?.price;
      const after = h.find((x) => x.round === round.id)?.price;
      return { c, script, p: prev.get(c.ticker), before, after };
    });
  }, [board.data, preview.data, ev, history.data, round.id]);

  const changed = Object.entries(edits).filter(([t, v]) => {
    const bps = Math.round(Number(v) * 100);
    return v !== '' && Number.isFinite(bps) && bps !== (ev?.configuration.companies[t] ?? 0);
  });
  const invalid = Object.values(edits).some((v) => v !== '' && !/^-?\d+(\.\d{1,2})?$/.test(v));

  const save = () => act({
    title: `Save price plan for Round ${round.id}`,
    body: <p>{changed.length} change(s): {changed.map(([t, v]) => `${t} ${Number(v) > 0 ? '+' : ''}${v}%`).join(', ')}</p>,
    reason: started ? 'required' : 'optional', confirmLabel: 'Save price plan', tone: 'green',
    run: async (v) => {
      const companies = { ...ev!.configuration.companies };
      for (const [t, val] of changed) {
        const bps = Math.round(Number(val) * 100);
        if (bps === 0) delete companies[t]; else companies[t] = bps;
      }
      await patch(`/api/admin/events/${eventId}`, { configuration: { companies, industries: ev!.configuration.industries }, reason: v.reason || undefined });
      return `Round ${round.id} price plan saved`;
    },
  });

  const apply = () => {
    const pr = preview.data?.rows || [];
    const up = pr.filter((r) => r.total_bps > 0).length;
    const down = pr.filter((r) => r.total_bps < 0).length;
    const big = [...pr].sort((a, b) => Math.abs(b.total_bps) - Math.abs(a.total_bps)).slice(0, 3);
    act(actions.apply(round.id, (
      <p>{up} companies go up, {down} go down. Biggest moves: {big.map((r) => `${r.ticker} ${pct(r.total_bps)}`).join(', ')}.</p>
    )));
  };

  return (
    <div className={`${card} overflow-hidden`}>
      <div className="p-5 border-b border-[#1b2233] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <SectionTitle icon={<Building2 className="w-4 h-4" />} title={`Company Price Update — Round ${round.id}`}
          subtitle={settled ? 'Applied. Prices before and after this round.' : live ? 'Live preview: script move + trading so far.' : 'Script moves for this round. Trading pressure is added when the round runs.'} />
        <div className="flex items-center space-x-2.5">
          {editable && (
            <button onClick={save} disabled={!changed.length || invalid} className={btn.outline}>
              <Save className="w-3.5 h-3.5" /><span>Save Changes{changed.length ? ` (${changed.length})` : ''}</span>
            </button>
          )}
          {isCurrent && round.status === 'closed' && (
            <button onClick={apply} disabled={!preview.data || changed.length > 0} className={btn.green} title={changed.length ? 'Save or discard your edits first' : ''}>
              <TrendingUp className="w-3.5 h-3.5" /><span>Apply Market Update</span>
            </button>
          )}
        </div>
      </div>
      {otherEvents.length > 0 && (
        <div className="px-5 py-2 text-[11px] text-amber-300 bg-amber-950/20 border-b border-[#1b2233]">
          Also applied this round: {otherEvents.map((e) => e.event_name).join(', ')} (included in the preview).
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse monopoly-table">
          <thead>
            <tr className="text-xs font-semibold text-slate-400 border-b border-[#1b2233]">
              <th className="py-3 px-5">Symbol</th>
              <th className="py-3 px-4">Company</th>
              <th className="py-3 px-4">{settled ? 'Before (₹)' : 'Current Price (₹)'}</th>
              <th className="py-3 px-4">Script Move (%)</th>
              {!settled && <th className="py-3 px-4">Trading</th>}
              <th className="py-3 px-4">{settled ? 'After (₹)' : 'New Price (₹)'}</th>
              <th className="py-3 px-5 text-right">Change (%)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#171e2c] text-sm">
            {!board.data && <EmptyRow cols={7} text="Loading…" />}
            {rows.map(({ c, script, p, before, after }) => {
              const edit = edits[c.ticker];
              const newPrice = settled ? after : p?.price;
              const change = settled && before && after ? Math.round(((after - before) * 10000) / before) : p?.total_bps;
              return (
                <tr key={c.id} className="hover:bg-[#151c2a] transition-colors">
                  <td className="py-3 px-5"><TickerBadge ticker={c.ticker} industry={c.industry} /></td>
                  <td className="py-3 px-4 font-semibold text-white whitespace-nowrap">{c.name}</td>
                  <td className="py-3 px-4 font-mono text-slate-300">{settled ? (before ? rupees(before) : '—') : rupees(p?.prev_price ?? c.price)}</td>
                  <td className="py-3 px-4">
                    {editable ? (
                      <input value={edit ?? (script / 100).toFixed(2)} onChange={(e) => setEdits({ ...edits, [c.ticker]: e.target.value.trim() })}
                        inputMode="decimal" aria-label={`${c.ticker} script move percent`}
                        className={`w-24 bg-[#161d2d] border rounded-lg px-2.5 py-1.5 font-mono text-sm text-white focus:outline-none focus:border-blue-500 ${
                          edit !== undefined && edit !== (script / 100).toFixed(2) ? 'border-amber-500' : 'border-[#232f48]'}`} />
                    ) : (
                      <span className="font-mono text-slate-300">{pct(script)}</span>
                    )}
                  </td>
                  {!settled && <td className="py-3 px-4 font-mono text-xs text-slate-400">{p ? `${pct(p.trading_bps)} (${p.net_demand > 0 ? '+' : ''}${formatIndianNumber(p.net_demand)})` : '—'}</td>}
                  <td className="py-3 px-4 font-mono text-slate-200">{newPrice ? rupees(newPrice) : '—'}</td>
                  <td className="py-3 px-5 text-right">
                    {change != null ? <span className={`text-xs font-semibold font-mono ${change > 0 ? 'text-[#10b981]' : change < 0 ? 'text-[#f87171]' : 'text-slate-400'}`}>{pct(change)}</span> : <span className="text-slate-600">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!live && !settled && <p className="px-5 py-3 text-[11px] text-slate-500 border-t border-[#1b2233]">New prices appear here once this round opens.</p>}
    </div>
  );
};

// ---- Latest settled round, for the presentation --------------------------------------------
const LiveSummary: React.FC = () => {
  const { version } = useAdmin();
  const s = usePoll(() => get<Summary>('/api/admin/summary'), 0, [version]);
  if (!s.data) return <div className={`${card} p-5 flex justify-center`}><Spinner /></div>;
  return (
    <div className={`${card} p-5 space-y-3 text-xs`}>
      <h2 className="text-sm font-bold text-white">Latest prices: movers</h2>
      <MoverList title="Top gainers" rows={s.data.gainers} />
      <MoverList title="Top losers" rows={s.data.losers} />
    </div>
  );
};

const MoverList: React.FC<{ title: string; rows: Summary['gainers'] }> = ({ title, rows }) => (
  <div>
    <div className="text-slate-500 mb-1">{title}</div>
    {rows.length === 0 && <div className="text-slate-600">None yet</div>}
    {rows.map((r) => (
      <div key={r.ticker} className="flex justify-between py-0.5">
        <span className="text-slate-200 font-semibold">{r.ticker} <span className="text-slate-500 font-normal">{r.name}</span></span>
        <span className={`font-mono ${r.change_bps > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{pct(r.change_bps)}</span>
      </div>
    ))}
  </div>
);

const SummaryModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const s = usePoll(() => get<Summary>('/api/admin/summary'), 0);
  const d = s.data;
  return (
    <Modal wide title="Round summary (for your slides)" subtitle={d ? `Prices after Round ${d.most_active.round ?? '—'} · rankings ${d.leaderboard_round === 'final' ? 'final' : `after Round ${d.leaderboard_round ?? '—'}`}` : undefined}
      onClose={onClose} footer={<button onClick={onClose} className={btn.outline + ' px-5'}>Close</button>}>
      {!d ? <div className="flex justify-center py-8"><Spinner /></div> : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
          <MoverList title="Top gainers" rows={d.gainers} />
          <MoverList title="Top losers" rows={d.losers} />
          <div>
            <div className="text-slate-500 mb-1">Most traded (shares)</div>
            {d.most_active.rows.length === 0 && <div className="text-slate-600">None yet</div>}
            {d.most_active.rows.map((r) => (
              <div key={r.ticker} className="flex justify-between py-0.5"><span className="text-slate-200 font-semibold">{r.ticker} <span className="text-slate-500 font-normal">{r.name}</span></span><span className="font-mono">{formatIndianNumber(Number(r.volume))}</span></div>
            ))}
          </div>
          <div>
            <div className="text-slate-500 mb-1">Top 5 teams</div>
            {d.top_teams.length === 0 && <div className="text-slate-600">After the first round is settled</div>}
            {d.top_teams.map((t) => (
              <div key={t.name} className="flex justify-between py-0.5"><span className="text-slate-200 font-semibold">{t.rank}. {t.name}</span><span className="font-mono">{inr(t.net_worth)}</span></div>
            ))}
            {d.final?.winner && <div className="mt-2 text-amber-300 font-bold">Winner: {d.final.winner.name}</div>}
          </div>
        </div>
      )}
    </Modal>
  );
};
