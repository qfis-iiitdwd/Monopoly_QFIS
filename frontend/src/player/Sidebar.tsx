import React from 'react';
import { ArrowLeftRight, Home, Landmark, LogOut } from 'lucide-react';
import { Spinner } from '../shared/ui';

export type NavTab = 'dashboard' | 'trading' | 'markets';

export const NAV = [
  { id: 'dashboard' as NavTab, label: 'Dashboard', icon: Home },
  { id: 'trading' as NavTab, label: 'Trading', icon: ArrowLeftRight },
  { id: 'markets' as NavTab, label: 'Market', icon: Landmark },
];

const link = 'w-full flex items-center px-3 py-2.5 rounded-xl text-[15px] transition-colors duration-150';

export const Sidebar: React.FC<{
  currentTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  teamName: string;
  playerName: string | null;
  onLogout: () => void;
  loggingOut: boolean;
}> = ({ currentTab, onTabChange, teamName, playerName, onLogout, loggingOut }) => (
  <aside className="w-64 flex flex-col shrink-0 select-none min-h-screen px-6 pt-10 pb-8">
    <div className="px-1 flex flex-col items-start">
      <div className="relative group mb-3.5">
        <div className="absolute -inset-1 rounded-2xl bg-gradient-to-tr from-red-600/30 via-red-500/10 to-amber-500/20 blur-md opacity-70 group-hover:opacity-100 transition duration-300" />
        <img
          src="/monopoly-icon.png"
          alt="Monopoly Icon"
          className="relative w-16 h-16 rounded-2xl object-cover shadow-lg shadow-red-950/40 border border-red-500/25 transition-transform duration-200 group-hover:scale-105"
        />
      </div>
      <div>
        <div className="font-semibold tracking-[0.18em] text-sm leading-none text-white">MONOPOLY</div>
        <div className="text-[9px] tracking-wider whitespace-nowrap text-slate-500 font-medium uppercase mt-1.5">Finance • Strategy • Markets</div>
      </div>
    </div>

    <nav className="mt-8 space-y-1">
      {NAV.map((item) => {
        const Icon = item.icon;
        const active = currentTab === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onTabChange(item.id)}
            aria-current={active ? 'page' : undefined}
            className={`${link} ${active ? 'text-white bg-white/[0.04]' : 'text-slate-400 hover:text-slate-100 hover:bg-white/[0.03]'}`}
          >
            <Icon className={`w-[18px] h-[18px] mr-3.5 ${active ? 'text-white' : 'text-slate-500'}`} strokeWidth={active ? 2.4 : 2} />
            <span className={active ? 'font-medium' : ''}>{item.label}</span>
          </button>
        );
      })}
    </nav>

    <div className="my-6 h-px bg-white/[0.07]" />

    <div className="space-y-1">
      <div className="flex items-center px-3 py-2.5 text-[15px] text-slate-400 min-w-0">
        <span className="w-[18px] h-[18px] mr-3.5 rounded-full bg-slate-600 text-[9px] font-bold text-white flex items-center justify-center shrink-0">
          {(playerName || teamName).trim().charAt(0).toUpperCase()}
        </span>
        <span className="truncate">{playerName ? `${playerName} · ${teamName}` : teamName}</span>
      </div>
      <button onClick={onLogout} disabled={loggingOut} className={`${link} text-slate-400 hover:text-slate-100 hover:bg-white/[0.03] disabled:opacity-50`}>
        {loggingOut ? <Spinner className="w-[18px] h-[18px] mr-3.5" /> : <LogOut className="w-[18px] h-[18px] mr-3.5 text-slate-500" />}
        <span>Logout</span>
      </button>
    </div>

    <div className="mt-auto pt-6 border-t border-white/[0.06] text-[11px] text-slate-500 leading-relaxed px-1">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-0.5">Created By</div>
      <div className="text-slate-300 font-medium text-xs">Prince, Bhavik, Darsh & Yash</div>
      <div className="text-[10px] text-slate-500 mt-0.5">Designers & Web Developers</div>
    </div>
  </aside>
);
