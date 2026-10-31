import React from 'react';
import { Building2, Code2, Info, Palette, ShieldCheck, Sparkles, TrendingUp } from 'lucide-react';
import { LogoBars } from './ui';

interface Contributor {
  name: string;
  role: string;
  initials: string;
  accent: string;
  badgeBg: string;
  glow: string;
}

const CONTRIBUTORS: Contributor[] = [
  {
    name: 'Prince Jha',
    role: 'Designer & Web Developer',
    initials: 'PJ',
    accent: 'text-sky-400',
    badgeBg: 'bg-sky-500/10 border-sky-500/20 text-sky-300',
    glow: 'from-sky-500/15 via-blue-500/5 to-transparent',
  },
  {
    name: 'Bhavik Kalva',
    role: 'Designer & Web Developer',
    initials: 'BK',
    accent: 'text-emerald-400',
    badgeBg: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300',
    glow: 'from-emerald-500/15 via-teal-500/5 to-transparent',
  },
  {
    name: 'Darsh Chauhan',
    role: 'Designer & Web Developer',
    initials: 'DC',
    accent: 'text-violet-400',
    badgeBg: 'bg-violet-500/10 border-violet-500/20 text-violet-300',
    glow: 'from-violet-500/15 via-purple-500/5 to-transparent',
  },
  {
    name: 'Yash Mathur',
    role: 'Designer & Web Developer',
    initials: 'YM',
    accent: 'text-amber-400',
    badgeBg: 'bg-amber-500/10 border-amber-500/20 text-amber-300',
    glow: 'from-amber-500/15 via-orange-500/5 to-transparent',
  },
];

export const Footer: React.FC<{ className?: string }> = ({ className = '' }) => {
  return (
    <footer className={`w-full mt-auto border-t border-white/[0.08] bg-[#07090e]/95 backdrop-blur-xl text-slate-400 relative z-10 selection:bg-sky-500/30 selection:text-white ${className}`}>
      {/* Decorative top gradient accent bar */}
      <div className="h-px w-full bg-gradient-to-r from-transparent via-sky-500/40 via-amber-500/30 to-transparent" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14 space-y-10">
        {/* Brand & Top Status Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-5 pb-8 border-b border-white/[0.07]">
          <div className="flex items-center space-x-3.5">
            <LogoBars />
            <div>
              <div className="flex items-center space-x-2.5">
                <span className="font-extrabold tracking-[0.2em] text-lg leading-none text-white font-sans">
                  MONOPOLY
                </span>
                <span className="text-[10px] uppercase font-bold tracking-widest px-2 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/20 text-sky-400">
                  Simulation
                </span>
              </div>
              <p className="text-[10px] tracking-wider text-slate-400 font-medium uppercase mt-1">
                Quantitative & Financial Investment Systems Society (Q-FIS) • IIIT Dharwad
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center space-x-2 bg-white/[0.03] border border-white/[0.08] px-3.5 py-1.5 rounded-full">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-slate-300 font-medium">Real-Time Engine Active</span>
            </div>
            <div className="flex items-center space-x-1.5 text-slate-400 bg-white/[0.02] border border-white/[0.06] px-3.5 py-1.5 rounded-full">
              <ShieldCheck className="w-3.5 h-3.5 text-sky-400" />
              <span>Zero-Rounding Integer Ledger</span>
            </div>
          </div>
        </div>

        {/* Main Content Grid: About + Platform Architecture + Contributors */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10">
          {/* Column 1: About Platform & Event (5 Cols) */}
          <div className="lg:col-span-5 space-y-4">
            <div className="flex items-center space-x-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              <Info className="w-4 h-4 text-sky-400" />
              <span className="text-white font-medium">About Monopoly</span>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed">
              Monopoly is a high-octane, newspaper-driven stock market simulation developed for classroom and club trading events. Teams analyze satirical publications to uncover real market signals, forecast price trajectories, and execute strategic orders across dynamic trading rounds.
            </p>
            <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.06] space-y-2">
              <div className="flex items-center space-x-2 text-xs font-semibold text-slate-200">
                <Building2 className="w-3.5 h-3.5 text-amber-400" />
                <span>Q-FIS Society • IIIT Dharwad</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Organized under the Quantitative & Financial Investment Systems Society at the Indian Institute of Information Technology, Dharwad. Driving excellence in algorithmic trading, financial engineering, and distributed market infrastructure.
              </p>
            </div>
          </div>

          {/* Column 2: System & Simulation Highlights (3 Cols) */}
          <div className="lg:col-span-3 space-y-4">
            <div className="flex items-center space-x-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              <span className="text-white font-medium">Simulation Mechanics</span>
            </div>
            <ul className="space-y-2.5 text-xs text-slate-400">
              <li className="flex items-start space-x-2">
                <span className="text-sky-400 font-bold leading-none mt-0.5">•</span>
                <span><strong className="text-slate-300">Newspaper Signals:</strong> Satirical news clues determine fundamental company trajectories.</span>
              </li>
              <li className="flex items-start space-x-2">
                <span className="text-emerald-400 font-bold leading-none mt-0.5">•</span>
                <span><strong className="text-slate-300">Order Pressure:</strong> Participant aggregate buying and selling pressure influences live clearing prices.</span>
              </li>
              <li className="flex items-start space-x-2">
                <span className="text-amber-400 font-bold leading-none mt-0.5">•</span>
                <span><strong className="text-slate-300">Atomic Execution:</strong> Strict row-level database locks ensure idempotency and fair play.</span>
              </li>
            </ul>
          </div>

          {/* Column 3: Designers & Web Developers (4 Cols) */}
          <div className="lg:col-span-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span className="text-white font-medium">Website Designers & Developers</span>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">Core Team</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {CONTRIBUTORS.map((c) => (
                <div
                  key={c.name}
                  className="group relative rounded-xl bg-white/[0.02] hover:bg-white/[0.06] border border-white/[0.07] hover:border-white/[0.16] p-3 transition-all duration-200 overflow-hidden"
                >
                  <div className={`absolute inset-0 bg-gradient-to-br ${c.glow} opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none`} />
                  <div className="relative flex items-center space-x-3">
                    <div className="w-9 h-9 rounded-lg bg-[#0e121a] border border-white/10 flex items-center justify-center shrink-0 shadow-inner group-hover:scale-105 group-hover:border-white/20 transition-all duration-200">
                      <span className={`text-xs font-bold tracking-wider ${c.accent}`}>
                        {c.initials}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-slate-200 group-hover:text-white transition-colors truncate">
                        {c.name}
                      </div>
                      <div className="text-[10px] text-slate-400 truncate mt-0.5">
                        {c.role}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center space-x-2 text-[11px] text-slate-400 pt-1">
              <Palette className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <Code2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span>Full-stack architecture & intuitive interface design</span>
            </div>
          </div>
        </div>

        {/* Bottom Section: All Copyrights & Simulation Disclaimer */}
        <div className="pt-8 border-t border-white/[0.07] space-y-4 text-xs">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4 text-slate-400">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-center md:text-left">
              <span className="font-semibold text-slate-300">
                © {new Date().getFullYear()} Monopoly Simulation Platform.
              </span>
              <span className="text-slate-600 hidden sm:inline">•</span>
              <span>All Rights Reserved.</span>
              <span className="text-slate-600 hidden sm:inline">•</span>
              <span>Quantitative & Financial Investment Systems Society (Q-FIS), IIIT Dharwad.</span>
            </div>

            <div className="text-slate-400 text-center md:text-right shrink-0">
              Designed & Developed by{' '}
              <span className="text-slate-300 font-medium">Prince Jha, Bhavik Kalva, Darsh Chauhan & Yash Mathur</span>
            </div>
          </div>

          <div className="rounded-lg bg-white/[0.015] border border-white/[0.05] p-3 text-[11px] text-slate-500 leading-relaxed">
            <strong className="text-slate-400">Educational Simulation Copyright & Disclaimer:</strong> All company names, stock tickers, financial valuations, newspapers, and market events presented within this platform are entirely fictional and designed solely for academic and competitive event simulations. No real financial instruments, fiat deposits, or regulated investment advice are provided or conducted.
          </div>
        </div>
      </div>
    </footer>
  );
};
