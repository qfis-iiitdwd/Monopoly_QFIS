import React, { useMemo, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { Company, MarketStatus } from '../../shared/types';
import { pct, rupees } from '../../shared/format';
import { EmptyRow, TickerBadge } from '../../shared/ui';
import { AnnouncementCard, RoundBadge, PageTitle } from '../market';

export const MarketsView: React.FC<{
  status: MarketStatus | null;
  companies: Company[] | null;
  onSelect: (companyId: number) => void;
}> = ({ status, companies, onSelect }) => {
  const [search, setSearch] = useState('');
  const [sector, setSector] = useState('All Sectors');
  const list = companies || [];

  const sectors = useMemo(() => ['All Sectors', ...Array.from(new Set(list.map((c) => c.industry))).sort()], [list]);
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return list.filter((c) =>
      (sector === 'All Sectors' || c.industry === sector) &&
      (c.name.toLowerCase().includes(q) || c.ticker.toLowerCase().includes(q) || c.ceo.toLowerCase().includes(q)));
  }, [list, search, sector]);

  return (
    <div className="space-y-6 pb-12 animate-fadeIn">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <PageTitle title="Markets" caption="All companies participating in the simulation" />
        <div className="flex flex-wrap items-center gap-3">
          <RoundBadge status={status} />
          <AnnouncementCard message={status?.message} className="!p-2.5 max-w-sm hidden sm:flex" />
        </div>
      </div>

      <div className="flex flex-col lg:flex-row lg:items-center gap-4">
        <div role="tablist" aria-label="Sector" className="flex items-center gap-1 overflow-x-auto -mx-1 px-1 py-1 min-w-0 lg:flex-1">
          {sectors.map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={sector === s}
              onClick={() => setSector(s)}
              className={`px-5 py-2 rounded-full text-[15px] whitespace-nowrap transition-colors ${
                sector === s ? 'border-2 border-white text-white font-medium' : 'border-2 border-transparent text-slate-400 hover:text-white'
              }`}
            >
              {s === 'All Sectors' ? 'All' : s}
            </button>
          ))}
        </div>
        <div className="relative w-full lg:w-80 shrink-0">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search company name, symbol or CEO..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-white/25 focus:bg-white/[0.06] transition-colors"
          />
        </div>
      </div>

      <div className="rounded-2xl bg-white/[0.025] border border-white/[0.07] backdrop-blur-sm overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse monopoly-table">
            <thead>
              <tr className="text-xs font-medium text-slate-500 border-b border-white/[0.06]">
                <th className="py-3.5 px-6">Symbol</th>
                <th className="py-3.5 px-5">Company</th>
                <th className="hidden sm:table-cell py-3.5 px-5">CEO</th>
                <th className="hidden sm:table-cell py-3.5 px-5">Sector</th>
                <th className="py-3.5 px-5">Current Price (₹)</th>
                <th className="py-3.5 px-5">Change</th>
                <th className="py-3.5 px-6"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04] text-sm">
              {companies && filtered.length === 0 && <EmptyRow cols={7} text="No company matches your search." />}
              {!companies && <EmptyRow cols={7} text="Loading prices…" />}
              {filtered.map((c) => (
                <tr key={c.id} onClick={() => onSelect(c.id)} className="hover:bg-white/[0.03] transition-colors cursor-pointer group">
                  <td className="py-3.5 px-6"><TickerBadge ticker={c.ticker} industry={c.industry} /></td>
                  <td className="py-3.5 px-5 font-semibold text-white whitespace-nowrap group-hover:text-emerald-400 transition-colors">
                    {c.name}
                    {!c.is_tradable && <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-950/60 text-amber-400 border border-amber-800/40">SUSPENDED</span>}
                  </td>
                  <td className="hidden sm:table-cell py-3.5 px-5 text-slate-400 text-xs whitespace-nowrap">{c.ceo || '—'}</td>
                  <td className="hidden sm:table-cell py-3.5 px-5 text-slate-400 text-xs whitespace-nowrap">{c.industry}</td>
                  <td className="py-3.5 px-5 font-mono text-slate-200">{rupees(c.price)}</td>
                  <td className="py-3.5 px-5">
                    <span className={`text-xs font-semibold font-mono ${c.change_bps > 0 ? 'text-[#10b981]' : c.change_bps < 0 ? 'text-[#f87171]' : 'text-slate-400'}`}>{pct(c.change_bps)}</span>
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
    </div>
  );
};
