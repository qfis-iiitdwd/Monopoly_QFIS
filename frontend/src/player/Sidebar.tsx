import React from 'react';
import { ArrowLeftRight, Home, Landmark, LogOut } from 'lucide-react';
import { LogoBars, Spinner } from '../shared/ui';

export type NavTab = 'dashboard' | 'trading' | 'markets';

const NAV = [
  { id: 'dashboard' as NavTab, label: 'Dashboard', icon: Home },
  { id: 'trading' as NavTab, label: 'Trading', icon: ArrowLeftRight },
  { id: 'markets' as NavTab, label: 'Markets', icon: Landmark },
];

export const Sidebar: React.FC<{
  currentTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  teamName: string;
  playerName: string | null;
  onLogout: () => void;
  loggingOut: boolean;
}> = ({ currentTab, onTabChange, teamName, playerName, onLogout, loggingOut }) => {
  const initials = (playerName || teamName).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <aside className="w-64 bg-[#0d121c] border-r border-[#1a2336] flex flex-col justify-between shrink-0 select-none min-h-screen">
      <div>
        <div className="p-6 pb-8 flex items-center space-x-3">
          <LogoBars />
          <div>
            <div className="font-extrabold tracking-wider text-xl leading-none text-white">MONOPOLY</div>
            <div className="text-[9px] tracking-wider whitespace-nowrap text-slate-400 font-semibold uppercase mt-1">FINANCE • STRATEGY • MARKETS</div>
          </div>
        </div>
        <nav className="px-3 space-y-1.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = currentTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-all duration-150 ${
                  active ? 'bg-[#371920] text-white border border-[#58212a] shadow-sm' : 'text-slate-300 hover:text-white hover:bg-[#161f30]'
                }`}
              >
                <Icon className={`w-5 h-5 mr-3.5 ${active ? 'text-[#f87171]' : 'text-slate-400'}`} />
                <span className="font-semibold text-[15px]">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
      <div className="p-4 border-t border-[#1a2336] space-y-3">
        <div className="flex items-center space-x-3 p-2">
          <div className="w-9 h-9 rounded-full bg-[#334155] border border-slate-600 flex items-center justify-center font-bold text-xs text-slate-200">{initials}</div>
          <div className="min-w-0">
            <div className="text-sm font-bold text-white leading-tight truncate">{teamName}</div>
            {playerName && <div className="text-xs text-slate-400 truncate">{playerName}</div>}
          </div>
        </div>
        <button
          onClick={onLogout}
          disabled={loggingOut}
          className="w-full flex items-center px-3 py-2 text-sm text-slate-400 hover:text-white hover:bg-[#161f30] rounded-lg transition-colors disabled:opacity-50"
        >
          {loggingOut ? <Spinner className="w-4 h-4 mr-3" /> : <LogOut className="w-4 h-4 mr-3" />}
          <span>Logout</span>
        </button>
      </div>
    </aside>
  );
};
