import React, { createContext, useCallback, useContext, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';

// ---- Logo -----------------------------------------------------------------------------------
export const LogoBars: React.FC<{ small?: boolean; className?: string }> = ({ small, className = '' }) => (
  <img
    src="/monopoly-icon.png"
    alt="Monopoly"
    className={`${small ? 'w-8 h-8 rounded-lg' : 'w-11 h-11 rounded-xl'} shrink-0 object-cover shadow-md shadow-red-950/40 border border-red-500/25 ${className}`}
  />
);

// ---- Ticker badge: colour derived from the industry so a sector reads as one colour ----------
const BADGE_COLOURS = [
  'bg-emerald-500', 'bg-blue-600', 'bg-rose-500', 'bg-lime-600', 'bg-amber-500',
  'bg-violet-600', 'bg-cyan-600', 'bg-orange-500', 'bg-pink-600', 'bg-teal-600',
];
export function industryColour(industry: string): string {
  let h = 0;
  for (const ch of industry || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BADGE_COLOURS[h % BADGE_COLOURS.length];
}
export const TickerBadge: React.FC<{ ticker: string; industry: string; large?: boolean }> = ({ ticker, industry, large }) => (
  <span
    className={`${large ? 'min-w-[2.75rem] h-10 text-sm rounded-lg' : 'min-w-[2.5rem] h-7 text-[11px] rounded'} px-1.5 inline-flex items-center justify-center font-bold text-white ${industryColour(industry)}`}
  >
    {ticker}
  </span>
);

export const SideBadge: React.FC<{ side: string }> = ({ side }) =>
  side === 'buy' || side === 'BUY' ? (
    <span className="px-2.5 py-1 text-[11px] font-bold rounded bg-[#133827] text-[#10b981] border border-[#1b5e3f]/40">BUY</span>
  ) : side === 'sell' || side === 'SELL' ? (
    <span className="px-2.5 py-1 text-[11px] font-bold rounded bg-[#3b171c] text-[#f87171] border border-[#6b222d]/40">SELL</span>
  ) : (
    <span className="px-2.5 py-1 text-[11px] font-bold rounded bg-[var(--mv-raised,#20293a)] text-slate-300 border border-slate-700 whitespace-nowrap">{side}</span>
  );

export const Dot: React.FC<{ tone: 'green' | 'red' | 'amber' | 'blue' | 'grey' }> = ({ tone }) => (
  <span
    className={`w-2 h-2 rounded-full inline-block shrink-0 ${
      { green: 'bg-[#10b981]', red: 'bg-[#ef4444]', amber: 'bg-amber-400', blue: 'bg-[#3b82f6]', grey: 'bg-slate-500' }[tone]
    }`}
  />
);

export const Spinner: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <Loader2 className={`${className} animate-spin`} />
);

// ---- Toasts -----------------------------------------------------------------------------------
interface Toast { id: number; text: string; tone: 'ok' | 'error' }
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + toasts.length;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4000);
  }, [toasts.length]);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-6 right-4 left-4 sm:left-auto z-[60] flex flex-col items-end space-y-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto max-w-md flex items-start space-x-3 bg-[var(--mv-deep,#111726)] border ${
              t.tone === 'ok' ? 'border-emerald-500/50' : 'border-rose-500/60'
            } text-white px-4 py-3 rounded-xl shadow-2xl`}
          >
            {t.tone === 'ok' ? <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" /> : <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />}
            <span className="text-sm font-medium">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
};

// ---- Modal shell --------------------------------------------------------------------------------
export const Modal: React.FC<{
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}> = ({ title, subtitle, onClose, children, footer, wide }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className={`bg-[var(--mv-card,#111622)] border border-[var(--mv-line,#1e2638)] rounded-2xl w-full ${wide ? 'max-w-4xl' : 'max-w-md'} overflow-hidden shadow-2xl flex flex-col max-h-[90vh]`}>
      <div className="px-6 py-4 border-b border-[var(--mv-line,#1e2638)] flex items-center justify-between bg-[var(--mv-raised,#151c2c)]">
        <div>
          <h3 className="text-base font-bold text-white">{title}</h3>
          {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
        </div>
        <button onClick={onClose} aria-label="Close" className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors">
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="p-6 space-y-4 overflow-y-auto">{children}</div>
      {footer && <div className="px-6 py-4 bg-[var(--mv-deep,#0d121c)] border-t border-[var(--mv-line,#1e2638)] flex items-center justify-end space-x-3">{footer}</div>}
    </div>
  </div>
);

export const btn = {
  primary: 'px-5 py-2 text-xs font-bold text-white bg-[#e63946] hover:bg-[#d62839] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-all flex items-center justify-center space-x-1.5 shadow-md shadow-rose-950/30',
  // The player app's main action: a light pill, as on the trading screens.
  light: 'px-5 py-2 text-xs font-semibold text-[#111214] bg-gradient-to-b from-white to-slate-300 hover:to-slate-200 border border-white/60 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl transition-all flex items-center justify-center space-x-1.5 shadow-[0_0_0_3px_rgba(255,255,255,0.06)]',
  green: 'px-5 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-all flex items-center justify-center space-x-1.5',
  ghost: 'px-4 py-2 text-xs text-slate-300 hover:text-white rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50',
  outline: 'py-2 px-3 bg-[var(--mv-raised,#161d2d)] hover:bg-[var(--mv-hover,#1f293d)] border border-[var(--mv-edge,#232f48)] rounded-lg text-xs font-semibold text-slate-200 flex items-center justify-center space-x-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
  small: 'flex items-center space-x-1.5 px-3 py-1.5 text-xs font-semibold text-slate-300 bg-[var(--mv-raised,#161d2b)] border border-[var(--mv-edge,#243046)] hover:bg-[var(--mv-hover,#1c2538)] hover:text-white rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed',
};
export const input = 'w-full bg-[var(--mv-raised,#161d2d)] border border-[var(--mv-edge,#222e47)] rounded-lg px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';
export const card = 'rounded-xl bg-[#111622] border border-[#1e2638] shadow-sm';

export const ErrorNote: React.FC<{ text: string | null | undefined }> = ({ text }) =>
  text ? (
    <div className="flex items-start space-x-2 text-rose-300 text-xs bg-rose-950/40 border border-rose-900/60 p-3 rounded-lg">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <span>{text}</span>
    </div>
  ) : null;

// ---- Simple pager ---------------------------------------------------------------------------
export const Pager: React.FC<{ page: number; pages: number; total: number; perPage: number; onPage: (p: number) => void; label?: string }> = ({
  page, pages, total, perPage, onPage, label = 'rows',
}) => {
  if (total === 0) return null;
  const from = (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  const nums = Array.from(new Set([1, page - 1, page, page + 1, pages])).filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  return (
    <div className="px-5 py-3 border-t border-[var(--mv-rule,#1b2233)] flex items-center justify-between text-xs text-slate-400">
      <span>Showing {from}–{to} of {total} {label}</span>
      <div className="flex items-center space-x-1">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)} className="p-1.5 rounded hover:bg-slate-800 disabled:opacity-30" aria-label="Previous page">
          <ChevronLeft className="w-4 h-4" />
        </button>
        {nums.map((n, i) => (
          <React.Fragment key={n}>
            {i > 0 && n - nums[i - 1] > 1 && <span className="px-1">…</span>}
            <button onClick={() => onPage(n)} aria-current={n === page ? 'page' : undefined} className={`min-w-[1.75rem] h-7 rounded font-semibold ${n === page ? 'bg-[var(--mv-active,#371920)] text-white border border-[var(--mv-active-line,#58212a)]' : 'hover:bg-slate-800'}`}>
              {n}
            </button>
          </React.Fragment>
        ))}
        <button disabled={page >= pages} onClick={() => onPage(page + 1)} className="p-1.5 rounded hover:bg-slate-800 disabled:opacity-30" aria-label="Next page">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export function paginate<T>(rows: T[], page: number, perPage: number) {
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  const p = Math.min(Math.max(1, page), pages);
  return { page: p, pages, slice: rows.slice((p - 1) * perPage, p * perPage) };
}

export const EmptyRow: React.FC<{ cols: number; text: string }> = ({ cols, text }) => (
  <tr>
    <td colSpan={cols} className="py-10 text-center text-sm text-slate-500">{text}</td>
  </tr>
);
