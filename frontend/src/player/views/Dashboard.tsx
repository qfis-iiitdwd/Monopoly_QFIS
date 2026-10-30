import React from 'react';
import { ArrowRight, BarChart3, ChevronRight, History, PieChart, Radio, Wallet } from 'lucide-react';
import { MarketStatus, Portfolio } from '../../shared/types';
import { formatIndianNumber, rupees } from '../../shared/format';
import { EmptyRow, Spinner, TickerBadge } from '../../shared/ui';
import { Activity } from '../activity';
import { ActivityTable } from '../ActivityTable';
import { AnnouncementCard, Countdown, describe, PageTitle } from '../market';

const STEPS = ['Preparation', 'Open', 'Closing', 'Settled'];

export const DashboardView: React.FC<{
  status: MarketStatus | null;
  portfolio: Portfolio | null;
  activities: Activity[];
  onOpenTransactions: () => void;
  onTrade: (companyId: number) => void;
}> = ({ status, portfolio, activities, onOpenTransactions, onTrade }) => {
  const d = describe(status);
  const start = status?.starting_cash || 0;
  const pnl = portfolio?.total_pnl ?? 0;
  const pnlPct = start ? (pnl * 100) / start : 0;
  const up = pnl >= 0;
  const pnlTone = pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-rose-400' : 'text-slate-300';
  const signed = `${pnl > 0 ? '+ ' : pnl < 0 ? '- ' : ''}₹ ${formatIndianNumber(Math.abs(pnl) / 100)}`;
  const pctText = `(${up ? '+' : ''}${pnlPct.toFixed(2)}%)`;
  const money = (v: number | undefined) => (v == null ? <Spinner className="w-5 h-5 text-slate-500" /> : `₹ ${formatIndianNumber(v / 100)}`);

  return (
    <div className="space-y-6 pb-12 animate-fadeIn">
      <PageTitle title="Dashboard" caption="Your portfolio, market status and recent activity" />

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        <div className="xl:col-span-8 mv-glow rounded-[1.75rem] bg-white/[0.025] border border-white/[0.07] backdrop-blur-sm p-6 sm:p-8 flex flex-col justify-between min-h-[17rem]">
          <div className="flex items-start justify-between gap-3">
            <span className="inline-flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-sky-500/10 text-sky-400 text-sm font-medium">
              <span className="w-5 h-5 rounded-full bg-gradient-to-br from-orange-400 via-white to-emerald-500 ring-1 ring-white/20" aria-hidden />
              <span>INR</span>
            </span>
            <span className="text-sm text-slate-400 text-right">{d.round} · <span className={d.tone}>{d.label}</span></span>
          </div>
          <div className="mt-10">
            <div className="text-xs uppercase tracking-[0.16em] text-slate-500 mb-2">Net Worth</div>
            <div className="text-[34px] sm:text-[44px] leading-none font-medium text-white tracking-tight whitespace-nowrap">{money(portfolio?.net_worth)}</div>
            {portfolio && <div className={`text-base sm:text-lg font-medium mt-3 ${pnlTone}`}>{signed} {pctText}</div>}
          </div>
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-1 sm:gap-2 p-1.5 rounded-2xl bg-black/20 border border-white/[0.05]">
            <Stat label="Available Cash" icon={<Wallet className="w-3.5 h-3.5" />}>{money(portfolio?.cash)}</Stat>
            <Stat label="Holdings Value" icon={<PieChart className="w-3.5 h-3.5" />}>{money(portfolio?.holdings_value)}</Stat>
            <Stat label="Total P&L" icon={<BarChart3 className="w-3.5 h-3.5" />} tone={pnlTone}>{portfolio ? signed : money(undefined)}</Stat>
          </div>
        </div>

        <div className="xl:col-span-4 rounded-2xl bg-white/[0.025] border border-white/[0.07] backdrop-blur-sm p-5 flex flex-col justify-between shadow-sm space-y-4">
          <div>
            <div className="flex items-center space-x-2 mb-4">
              <div className="relative flex items-center justify-center">
                {d.canTrade && <span className="w-3 h-3 rounded-full bg-rose-500/30 animate-ping absolute" />}
                <Radio className="w-4 h-4 text-rose-500 relative" />
              </div>
              <h2 className="text-base font-medium text-white tracking-tight">Market Status</h2>
            </div>
            <div className="text-center my-2">
              <div className="text-xl font-extrabold text-white">{d.round}</div>
              <div className={`text-sm font-semibold mt-0.5 ${d.tone}`}>{d.label}</div>
              {d.canTrade && (
                <div className="text-xs text-slate-400 mt-1">
                  Closes in <Countdown status={status} className="text-base" />
                </div>
              )}
              {!d.canTrade && d.why && <div className="text-[11px] text-slate-500 mt-1">{d.why}</div>}
            </div>
            <div className="my-5 px-2">
              <div className="flex items-center justify-between relative">
                <div className="absolute top-1/2 left-4 right-4 -translate-y-1/2 h-[2px] bg-slate-800 z-0">
                  <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(d.step / (STEPS.length - 1)) * 100}%` }} />
                </div>
                {STEPS.map((name, i) => (
                  <div key={name} className="relative z-10 flex flex-col items-center">
                    <div
                      className={`rounded-full border-2 border-[#16171a] ${
                        i === d.step ? 'w-4 h-4 bg-emerald-500 ring-4 ring-emerald-500/20' : i < d.step ? 'w-3.5 h-3.5 bg-emerald-500' : 'w-3.5 h-3.5 bg-[#1a1b1f] !border-slate-600'
                      }`}
                    />
                    <span className={`text-[10px] mt-2 ${i === d.step ? 'text-emerald-400 font-bold' : 'text-slate-400 font-medium'}`}>{name}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <AnnouncementCard message={status?.message} />
        </div>
      </div>

      <div className="rounded-2xl bg-white/[0.025] border border-white/[0.07] backdrop-blur-sm overflow-hidden shadow-sm">
        <div className="px-6 py-4 flex items-center space-x-2.5 border-b border-white/[0.06]">
          <PieChart className="w-5 h-5 text-blue-400" />
          <h2 className="text-lg font-medium text-white tracking-tight">Your Holdings</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse monopoly-table">
            <thead>
              <tr className="text-xs font-medium text-slate-500 border-b border-white/[0.06]">
                <th className="py-3 px-4 sm:px-6">Company</th>
                <th className="py-3 px-6">Shares</th>
                <th className="hidden sm:table-cell py-3 px-6">Current Price (₹)</th>
                <th className="py-3 px-6">Position Value (₹)</th>
                <th className="hidden sm:table-cell py-3 px-6">Gain / Loss (₹)</th>
                <th className="py-3 px-6"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04] text-sm">
              {portfolio && portfolio.holdings.length === 0 && <EmptyRow cols={6} text="No shares yet. Buy from the Trading page." />}
              {portfolio?.holdings.map((h) => (
                <tr key={h.company_id} onClick={() => onTrade(h.company_id)} className="hover:bg-white/[0.03] transition-colors cursor-pointer group">
                  <td className="py-3.5 px-6">
                    <div className="flex items-center space-x-3">
                      <TickerBadge ticker={h.ticker} industry={h.industry} />
                      <span className="hidden sm:inline font-semibold text-white group-hover:text-emerald-400 transition-colors whitespace-nowrap">{h.name}</span>
                    </div>
                  </td>
                  <td className="py-3.5 px-6 font-mono text-slate-300">{formatIndianNumber(h.quantity)}</td>
                  <td className="hidden sm:table-cell py-3.5 px-6 font-mono text-slate-300">{rupees(h.price)}</td>
                  <td className="py-3.5 px-6 font-mono text-slate-200 font-semibold">{rupees(h.value)}</td>
                  <td className={`hidden sm:table-cell py-3.5 px-6 font-mono ${h.unrealized_pnl > 0 ? 'text-emerald-400' : h.unrealized_pnl < 0 ? 'text-rose-400' : 'text-slate-400'}`}>
                    {h.unrealized_pnl > 0 ? '+' : ''}{rupees(h.unrealized_pnl)}
                  </td>
                  <td className="py-3.5 px-6 text-right">
                    <ChevronRight className="w-4 h-4 text-slate-500 group-hover:text-white transition-colors inline-block" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl bg-white/[0.025] border border-white/[0.07] backdrop-blur-sm overflow-hidden shadow-sm">
        <div className="px-6 py-4 flex items-center justify-between border-b border-white/[0.06]">
          <div className="flex items-center space-x-2.5">
            <History className="w-5 h-5 text-slate-300" />
            <h2 className="text-lg font-medium text-white tracking-tight">Recent Activity</h2>
          </div>
          <button onClick={onOpenTransactions} className="flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-transparent border border-white/15 hover:bg-white/[0.06] hover:text-white rounded-xl transition-all">
            <span>View All Transactions</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <ActivityTable rows={activities.slice(0, 5)} empty="Nothing yet. Your orders will appear here." />
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; icon: React.ReactNode; tone?: string; children: React.ReactNode }> = ({ label, icon, tone = 'text-white', children }) => (
  <div className="rounded-xl px-3 py-2.5 sm:px-4 hover:bg-white/[0.04] transition-colors min-w-0">
    <div className="flex items-center space-x-1.5 text-slate-500 text-[11px] sm:text-xs">
      {icon}
      <span className="truncate">{label}</span>
    </div>
    <div className={`mt-1 text-sm sm:text-base font-medium tracking-tight truncate ${tone}`}>{children}</div>
  </div>
);
