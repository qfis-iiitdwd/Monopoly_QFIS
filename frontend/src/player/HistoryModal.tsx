import React, { useState } from 'react';
import { Search } from 'lucide-react';
import { Activity } from './activity';
import { ActivityTable } from './ActivityTable';
import { btn, Modal } from '../shared/ui';

const FILTERS = ['ALL', 'BUY', 'SELL', 'Rejected', 'Correction'] as const;

export const HistoryModal: React.FC<{ rows: Activity[]; onClose: () => void; loading: boolean }> = ({ rows, onClose, loading }) => {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');
  const [search, setSearch] = useState('');
  const q = search.toLowerCase();
  const filtered = rows.filter((a) => {
    const f = filter === 'ALL'
      || (filter === 'Rejected' ? a.status === 'Rejected'
        : filter === 'Correction' ? ['Correction', 'Reward', 'Deposit'].includes(a.type) || a.status === 'Reversed'
          : a.type === filter);
    return f && (a.symbol.toLowerCase().includes(q) || a.details.toLowerCase().includes(q) || (a.sub || '').toLowerCase().includes(q));
  });
  return (
    <Modal wide title="All Order & Transaction History" subtitle="Complete record of your trades, rejections and organiser corrections" onClose={onClose}
      footer={<button onClick={onClose} className={btn.outline + ' px-5'}>Done</button>}>
      <div className="-mx-6 -mt-6 px-6 py-3 border-b border-[#24262b] flex flex-wrap items-center justify-between gap-3 bg-[#0e0f11]">
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${filter === f ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}>
              {f}
            </button>
          ))}
        </div>
        <div className="relative min-w-[200px] flex-1 sm:flex-none">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input type="text" placeholder="Search history..." value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-white/25" />
        </div>
      </div>
      <div className="-mx-6">
        <ActivityTable rows={filtered} empty={loading ? 'Loading…' : 'Nothing matches.'} />
      </div>
    </Modal>
  );
};
