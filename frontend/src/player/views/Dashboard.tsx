import React from 'react';
import { ArrowRight, BarChart3, ChevronRight, Coins, History, PieChart, Radio, Wallet } from 'lucide-react';
import { MarketStatus, Portfolio } from '../../shared/types';
import { formatIndianNumber, rupees } from '../../shared/format';
import { EmptyRow, Spinner, TickerBadge } from '../../shared/ui';
import { Activity } from '../activity';
import { ActivityTable } from '../ActivityTable';
import { AnnouncementCard, Countdown, describe } from '../market';

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
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Dashboard</h1>
        <p className="text-sm text-slate-400 mt-1">Your portfolio, market status and recent activity</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        <div className="xl:col-span-8 flex flex-col">
          <div className="flex items-center space-x-2.5 mb-3 text-slate-200">
            <Wallet className="w-5 h-5 text-rose-400" />
            <h2 className="text-base font-bold tracking-wide">Portfolio Summary</h2>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 content-start">
            <div className="rounded-xl bg-[#0f191f] border border-[#164e3f]/60 p-4 flex flex-col justify-between shadow-lg shadow-emerald-950/20">
              <div className="flex items-center space-x-2 mb-2">
                <Coins className="w-4 h-4 text-emerald-400" />
                <span className="text-xs text-slate-400 font-medium">Net Worth</span>
              </div>
              <div>
                <div className="text-base sm:text-lg 2xl:text-xl font-bold font-mono text-white tracking-tight whitespace-nowrap">{money(portfolio?.net_worth)}</div>
                {portfolio && <div className={`text-[11px] font-medium mt-1 ${pnlTone}`}>{signed} {pctText}</div>}
              </div>
            </div>
            <div className="rounded-xl bg-[#111622] border border-[#1e2638] p-4 flex flex-col justify-between shadow-sm">
              <div className="flex items-center space-x-2 mb-2">
                <Wallet className="w-4 h-4 text-sky-400" />
                <span className="text-xs text-slate-400 font-medium">Available Cash</span>
              </div>
              <div className="text-base sm:text-lg 2xl:text-xl font-bold font-mono text-white tracking-tight whitespace-nowrap">{money(portfolio?.cash)}</div>
            </div>
            <div className="rounded-xl bg-[#111622] border border-[#1e2638] p-4 flex flex-col justify-between shadow-sm">
              <div className="flex items-center space-x-2 mb-2">
                <PieChart className="w-4 h-4 text-blue-400" />
                <span className="text-xs text-slate-400 font-medium">Holdings Value</span>
              </div>
              <div className="text-base sm:text-lg 2xl:text-xl font-bold font-mono text-white tracking-tight whitespace-nowrap">{money(portfolio?.holdings_value)}</div>
            </div>
            <div className="rounded-xl bg-[#111622] border border-[#1e2638] p-4 flex flex-col justify-between shadow-sm">
              <div className="flex items-center space-x-2 mb-2">
                <BarChart3 className="w-4 h-4 text-rose-400" />
                <span className="text-xs text-slate-400 font-medium">Total Profit / Loss</span>
              </div>
              {portfolio ? (
                <div>
                  <div className={`text-sm font-bold font-mono tracking-tight leading-tight ${pnlTone}`}>{signed}</div>
                  <div className={`text-xs font-semibold mt-0.5 ${pnlTone}`}>{pctText}</div>
                </div>
              ) : (
                <Spinner className="w-5 h-5 text-slate-500" />
              )}
            </div>
          </div>
        </div>

        <div className="xl:col-span-4 rounded-xl bg-[#111622] border border-[#1e2638] p-5 flex flex-col justify-between shadow-sm space-y-4">
          <div>
            <div className="flex items-center space-x-2 mb-4">
              <div className="relative flex items-center justify-center">
                {d.canTrade && <span className="w-3 h-3 rounded-full bg-rose-500/30 animate-ping absolute" />}
                <Radio className="w-4 h-4 text-rose-500 relative" />
              </div>
              <h2 className="text-sm font-bold text-white tracking-wide">Market Status</h2>
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
                      className={`rounded-full border-2 border-[#111622] ${
                        i === d.step ? 'w-4 h-4 bg-emerald-500 ring-4 ring-emerald-500/20' : i < d.step ? 'w-3.5 h-3.5 bg-emerald-500' : 'w-3.5 h-3.5 bg-[#1b2333] !border-slate-600'
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

      <div className="rounded-xl bg-[#111622] border border-[#1e2638] overflow-hidden shadow-sm">
        <div className="px-6 py-4 flex items-center space-x-2.5 border-b border-[#1b2233]">
          <PieChart className="w-5 h-5 text-blue-400" />
          <h2 className="text-base font-bold text-white tracking-wide">Your Holdings</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse monopoly-table">
            <thead>
              <tr className="text-xs font-semibold text-slate-400 border-b border-[#1b2233]">
                <th className="py-3 px-4 sm:px-6">Company</th>
                <th className="py-3 px-6">Shares</th>
                <th className="hidden sm:table-cell py-3 px-6">Current Price (₹)</th>
                <th className="py-3 px-6">Position Value (₹)</th>
                <th className="hidden sm:table-cell py-3 px-6">Gain / Loss (₹)</th>
                <th className="py-3 px-6"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#171e2c] text-sm">
              {portfolio && portfolio.holdings.length === 0 && <EmptyRow cols={6} text="No shares yet. Buy from the Trading page." />}
              {portfolio?.holdings.map((h) => (
                <tr key={h.company_id} onClick={() => onTrade(h.company_id)} className="hover:bg-[#161d2d] transition-colors cursor-pointer group">
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

      <div className="rounded-xl bg-[#111622] border border-[#1e2638] overflow-hidden shadow-sm">
        <div className="px-6 py-4 flex items-center justify-between border-b border-[#1b2233]">
          <div className="flex items-center space-x-2.5">
            <History className="w-5 h-5 text-slate-300" />
            <h2 className="text-base font-bold text-white tracking-wide">Recent Activity</h2>
          </div>
          <button onClick={onOpenTransactions} className="flex items-center space-x-1.5 px-3 py-1.5 text-xs font-semibold text-slate-300 bg-[#161d2b] border border-[#243046] hover:bg-[#1c2538] hover:text-white rounded-lg transition-all">
            <span>View All Transactions</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <ActivityTable rows={activities.slice(0, 5)} empty="Nothing yet. Your orders will appear here." />
      </div>
    </div>
  );
};
