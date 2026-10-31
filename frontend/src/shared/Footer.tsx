import React from 'react';
import { Code2, Palette, Sparkles } from 'lucide-react';

interface Contributor {
  name: string;
  role: string;
  initials: string;
  accent: string;
  glow: string;
}

const CONTRIBUTORS: Contributor[] = [
  {
    name: 'Prince Jha',
    role: 'Designer & Web Developer',
    initials: 'PJ',
    accent: 'text-sky-400',
    glow: 'from-sky-500/20 to-blue-500/5',
  },
  {
    name: 'Bhavik Kalva',
    role: 'Designer & Web Developer',
    initials: 'BK',
    accent: 'text-emerald-400',
    glow: 'from-emerald-500/20 to-teal-500/5',
  },
  {
    name: 'Darsh Chauhan',
    role: 'Designer & Web Developer',
    initials: 'DC',
    accent: 'text-violet-400',
    glow: 'from-violet-500/20 to-purple-500/5',
  },
  {
    name: 'Yash Mathur',
    role: 'Designer & Web Developer',
    initials: 'YM',
    accent: 'text-amber-400',
    glow: 'from-amber-500/20 to-orange-500/5',
  },
];

export const Footer: React.FC<{ className?: string }> = ({ className = '' }) => {
  return (
    <footer className={`relative z-10 w-full border-t border-white/[0.08] bg-[#090b10]/80 backdrop-blur-md mt-auto ${className}`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 md:px-10 py-8 sm:py-10">
        {/* Top Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-white/[0.06]">
          <div className="space-y-1">
            <div className="flex items-center space-x-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              <span className="flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-white/[0.05] border border-white/[0.08] text-slate-300">
                <Palette className="w-3.5 h-3.5 text-sky-400" />
                <Code2 className="w-3.5 h-3.5 text-indigo-400" />
                <span>Credits & Creators</span>
              </span>
              <span className="text-slate-600 hidden sm:inline">•</span>
              <span className="hidden sm:inline text-slate-400 font-normal">Design & Engineering</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold text-white tracking-tight flex items-center gap-2">
              Website Designers & Developers
              <Sparkles className="w-4 h-4 text-amber-400/80" />
            </h3>
            <p className="text-xs text-slate-400 max-w-xl">
              Engineered and designed with focus on real-time market simulation, high performance, and intuitive experience.
            </p>
          </div>

          <div className="hidden lg:flex items-center space-x-2 text-xs text-slate-400 bg-white/[0.02] border border-white/[0.06] px-3.5 py-2 rounded-xl">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-mono text-slate-300">MONOPOLY</span>
            <span className="text-slate-600">|</span>
            <span>Finance • Strategy • Markets</span>
          </div>
        </div>

        {/* Team Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 pt-6">
          {CONTRIBUTORS.map((c) => (
            <div
              key={c.name}
              className="group relative rounded-2xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.06] hover:border-white/[0.14] p-3.5 transition-all duration-200 overflow-hidden"
            >
              <div className={`absolute inset-0 bg-gradient-to-br ${c.glow} opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none`} />
              <div className="relative flex items-center space-x-3.5">
                <div className="w-10 h-10 rounded-xl bg-slate-900/90 border border-white/10 flex items-center justify-center shrink-0 shadow-inner group-hover:scale-105 group-hover:border-white/20 transition-all duration-200">
                  <span className={`text-xs font-bold tracking-wider ${c.accent}`}>
                    {c.initials}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-slate-200 group-hover:text-white transition-colors truncate">
                    {c.name}
                  </div>
                  <div className="text-[11px] text-slate-400 truncate mt-0.5">
                    {c.role}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Bottom Bar */}
        <div className="mt-8 pt-6 border-t border-white/[0.06] flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500">
          <div className="flex items-center space-x-2">
            <span>© {new Date().getFullYear()} Monopoly Simulation.</span>
            <span>All rights reserved.</span>
          </div>
          <div className="flex items-center space-x-3 text-slate-400">
            <span>Designed & Developed by Prince Jha, Bhavik Kalva, Darsh Chauhan & Yash Mathur</span>
          </div>
        </div>
      </div>
    </footer>
  );
};
