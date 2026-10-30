import React from 'react';
import { Activity } from './activity';
import { clock, formatIndianNumber } from '../shared/format';
import { Dot, EmptyRow, SideBadge } from '../shared/ui';

const tone = (s: Activity['status']) => (s === 'Executed' ? 'green' : s === 'Rejected' ? 'red' : s === 'Reversed' ? 'amber' : 'blue');

export const ActivityTable: React.FC<{ rows: Activity[]; empty: string; header?: string }> = ({ rows, empty, header = 'bg-transparent' }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-left border-collapse monopoly-table">
      <thead>
        <tr className={`text-xs font-medium text-slate-500 border-b border-white/[0.06] ${header}`}>
          <th className="py-3 px-6">Time</th>
          <th className="py-3 px-4">Type</th>
          <th className="py-3 px-4">Company</th>
          <th className="py-3 px-4">Details</th>
          <th className="py-3 px-6 text-right">Amount (₹)</th>
          <th className="py-3 px-6 text-right">Status</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-white/[0.04] text-sm">
        {rows.length === 0 && <EmptyRow cols={6} text={empty} />}
        {rows.map((a) => (
          <tr key={a.key} className="hover:bg-white/[0.03] transition-colors">
            <td className="py-3.5 px-6 text-slate-400 text-xs font-mono whitespace-nowrap">{clock(a.at)}</td>
            <td className="py-3.5 px-4"><SideBadge side={a.type} /></td>
            <td className="py-3.5 px-4 font-bold text-white tracking-wide">{a.symbol}</td>
            <td className="py-3.5 px-4 text-slate-300 text-xs whitespace-nowrap">{a.details}</td>
            <td className={`py-3.5 px-6 font-mono font-medium text-right whitespace-nowrap ${a.amount != null && a.amount > 0 ? 'text-[#10b981]' : 'text-slate-200'}`}>
              {a.amount == null ? '—' : `${a.amount > 0 ? '+' : ''}${formatIndianNumber(a.amount / 100, 2)}`}
            </td>
            <td className="py-3.5 px-6 text-right">
              <div className="flex items-center justify-end space-x-2">
                <Dot tone={tone(a.status)} />
                <div className="text-right">
                  <div className="text-xs font-medium text-slate-200">{a.status}</div>
                  {a.sub && <div className="text-[10px] text-slate-400 leading-tight mt-0.5 max-w-[16rem] ml-auto">{a.sub}</div>}
                </div>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
