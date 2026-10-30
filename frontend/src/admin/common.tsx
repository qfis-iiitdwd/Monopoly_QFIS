import React from 'react';
import { AdminRound, GameState, Overview } from './types';
import { countdown } from '../shared/format';
import { useCountdown } from '../shared/hooks';

// Market state as the admin sees it: one label used by every header badge and control card.
export function marketState(o: Overview): { label: string; tone: 'green' | 'amber' | 'red' | 'grey' | 'blue'; round: AdminRound | null } {
  const s = o.state;
  const round = o.rounds.find((r) => r.id === s.current_round) || null;
  if (s.status === 'setup') return { label: 'Not started', tone: 'grey', round };
  if (s.status === 'finished') return { label: 'Event finished', tone: 'grey', round };
  if (!round) return { label: 'Waiting for Round 1', tone: 'blue', round };
  if (round.status === 'open') return s.paused ? { label: 'Paused', tone: 'amber', round } : { label: 'Open', tone: 'green', round };
  if (round.status === 'closed') return { label: 'Closed', tone: 'red', round };
  return { label: round.id < s.settings.total_rounds ? `Settled · Round ${round.id + 1} next` : 'Settled', tone: 'blue', round };
}

const TONE_TEXT = { green: 'text-emerald-400', amber: 'text-amber-400', red: 'text-rose-400', grey: 'text-slate-400', blue: 'text-sky-400' };
const TONE_DOT = { green: 'bg-emerald-400', amber: 'bg-amber-400', red: 'bg-rose-400', grey: 'bg-slate-500', blue: 'bg-sky-400' };

export const StateText: React.FC<{ tone: keyof typeof TONE_TEXT; children: React.ReactNode; className?: string }> = ({ tone, children, className = '' }) => (
  <span className={`flex items-center space-x-1.5 ${TONE_TEXT[tone]} ${className}`}>
    <span className={`w-2 h-2 rounded-full ${TONE_DOT[tone]}`} />
    <span>{children}</span>
  </span>
);

export const RoundCountdown: React.FC<{ round: AdminRound | null; state: GameState }> = ({ round, state }) => {
  const active = round?.status === 'open' && !state.paused;
  const left = useCountdown(active ? round?.trading_deadline : null, round?.now);
  if (!active || left == null) return null;
  return <span className={`font-mono font-bold ${left < 30000 ? 'text-rose-400' : 'text-white'}`}>{countdown(left)}</span>;
};

export const HeaderBadge: React.FC<{ o: Overview }> = ({ o }) => {
  const m = marketState(o);
  return (
    <div className="flex items-center space-x-2.5 px-4 py-2 rounded-xl bg-[#111622] border border-[#1e2638] text-xs font-semibold self-start md:self-auto">
      <span className="text-slate-300">Round {o.state.current_round || '—'} of {o.state.settings.total_rounds}</span>
      <span className="text-slate-600">|</span>
      <StateText tone={m.tone}>Market {m.label}</StateText>
      <RoundCountdown round={m.round} state={o.state} />
    </div>
  );
};

export const PageHeader: React.FC<{ title: string; subtitle: string; o: Overview; children?: React.ReactNode }> = ({ title, subtitle, o, children }) => (
  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
    <div>
      <h1 className="text-2xl font-bold text-white tracking-tight">{title}</h1>
      <p className="text-sm text-slate-400 mt-1">{subtitle}</p>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      {children}
      <HeaderBadge o={o} />
    </div>
  </div>
);

export const Kpi: React.FC<{ icon: React.ReactNode; tint: string; label: string; value: React.ReactNode; sub?: React.ReactNode; onClick?: () => void }> = ({
  icon, tint, label, value, sub, onClick,
}) => (
  <div onClick={onClick} className={`rounded-xl bg-[#111622] border border-[#1e2638] p-5 shadow-sm ${onClick ? 'cursor-pointer hover:border-[#2b374e]' : ''}`}>
    <div className="flex items-center space-x-3 mb-2">
      <div className={`w-9 h-9 rounded-lg border flex items-center justify-center ${tint}`}>{icon}</div>
      <span className="text-xs font-medium text-slate-400">{label}</span>
    </div>
    <div className="mt-2">
      <div className="text-2xl font-extrabold text-white">{value}</div>
      {sub && <div className="text-xs font-medium mt-1">{sub}</div>}
    </div>
  </div>
);

export const SectionTitle: React.FC<{ icon: React.ReactNode; title: string; subtitle?: string }> = ({ icon, title, subtitle }) => (
  <div className="flex items-center space-x-3">
    <div className="w-8 h-8 rounded-lg bg-rose-950/60 border border-rose-800/40 flex items-center justify-center text-rose-400">{icon}</div>
    <div>
      <h2 className="text-base font-bold text-white">{title}</h2>
      {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
    </div>
  </div>
);

/** "+18% vs last round" from two real numbers; nothing when there is no previous round. */
export function delta(now: number, before: number | undefined): React.ReactNode {
  if (before === undefined) return <span className="text-slate-500">first round</span>;
  if (!before) return <span className="text-slate-500">none last round</span>;
  const p = ((now - before) * 100) / before;
  return <span className={p >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{p >= 0 ? '+' : ''}{p.toFixed(0)}% vs last round</span>;
}
