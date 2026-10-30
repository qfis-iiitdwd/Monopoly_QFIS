import React from 'react';
import { ChevronRight, Megaphone } from 'lucide-react';
import { MarketStatus } from '../shared/types';
import { countdown } from '../shared/format';
import { useCountdown } from '../shared/hooks';

// How the server's phase reads to a player.
export function describe(s: MarketStatus | null): { round: string; label: string; tone: string; step: number; canTrade: boolean; why: string } {
  if (!s) return { round: '—', label: 'Connecting…', tone: 'text-slate-400', step: 0, canTrade: false, why: 'Connecting to the market…' };
  const n = s.current_round;
  const round = n ? `Round ${n}` : 'Round 1';
  switch (s.phase) {
    case 'setup':
      return { round: 'Round 1', label: 'Not started', tone: 'text-slate-400', step: 0, canTrade: false, why: 'The event has not started yet.' };
    case 'awaiting_open':
      return { round, label: 'Opening soon', tone: 'text-sky-400', step: 0, canTrade: false, why: 'The market opens when the organisers start the round.' };
    case 'trading':
      if (s.paused) return { round, label: 'Trading Paused', tone: 'text-amber-400', step: 1, canTrade: false, why: 'Trading is paused by the organisers.' };
      return { round, label: 'Market Open', tone: 'text-emerald-400', step: 1, canTrade: true, why: '' };
    case 'closed':
    case 'news':
      return { round, label: 'Market Closed', tone: 'text-rose-400', step: 2, canTrade: false, why: 'Trading for this round is closed. New prices are coming.' };
    case 'settled':
      return {
        round, label: n < s.total_rounds ? `Round ${n + 1} opens soon` : 'Final round settled', tone: 'text-sky-400', step: 3, canTrade: false,
        why: 'Prices are updated. Wait for the next round to open.',
      };
    case 'finished':
      return { round: 'Final', label: 'Event finished', tone: 'text-slate-300', step: 3, canTrade: false, why: 'The event has finished. Thank you for playing!' };
  }
}

/** Time left in the open round, from the server's deadline and clock. */
export const Countdown: React.FC<{ status: MarketStatus | null; className?: string }> = ({ status, className = '' }) => {
  const open = status?.phase === 'trading' && !status.paused;
  const left = useCountdown(open ? status?.round?.trading_deadline : null, status?.server_time);
  if (!open || left == null) return null;
  const urgent = left < 30000;
  return (
    <span className={`font-mono font-bold ${urgent ? 'text-rose-400' : 'text-white'} ${className}`} aria-label="Time left in this round">
      {countdown(left)}
    </span>
  );
};

export const RoundBadge: React.FC<{ status: MarketStatus | null }> = ({ status }) => {
  const d = describe(status);
  return (
    <div className="flex items-center space-x-2 px-3.5 py-2 rounded-xl bg-[#131417] border border-[#24262b] text-xs font-semibold">
      <span className="text-slate-300">{d.round}</span>
      <span className="text-slate-600">|</span>
      <span className={`${d.tone} font-bold`}>{d.label}</span>
      <Countdown status={status} className="pl-1" />
      <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
    </div>
  );
};

/** The organisers' broadcast message. Hidden when there is none. */
export const AnnouncementCard: React.FC<{ message: string | undefined; className?: string }> = ({ message, className = '' }) => {
  if (!message) return null;
  return (
    <div className={`rounded-xl bg-[#241f17]/80 border border-[#4d3a1f] p-3.5 flex items-start space-x-3 ${className}`}>
      <div className="w-8 h-8 rounded-lg bg-[#3a2c16] flex items-center justify-center shrink-0 text-[#eab308] mt-0.5">
        <Megaphone className="w-4 h-4 fill-[#eab308]" />
      </div>
      <div>
        <div className="text-xs font-bold text-[#eab308] uppercase tracking-wider mb-0.5">From Organisers</div>
        <p className="text-xs text-slate-300 leading-snug whitespace-pre-line">{message}</p>
      </div>
    </div>
  );
};

/** The page heading as a breadcrumb: "Monopoly / Trading", with an optional caption below. */
export const PageTitle: React.FC<{ title: string; caption?: string }> = ({ title, caption }) => (
  <div className="min-w-0">
    <h1 className="text-[26px] sm:text-[30px] font-normal tracking-tight leading-tight">
      <span className="text-slate-500">Monopoly</span>
      <span className="text-slate-600 mx-3 font-light">/</span>
      <span className="text-white">{title}</span>
    </h1>
    {caption && <p className="text-sm text-slate-500 mt-1.5">{caption}</p>}
  </div>
);
