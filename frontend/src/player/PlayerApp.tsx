import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Menu, PauseCircle, WifiOff, X } from 'lucide-react';
import { ApiError, get, post, setUnauthorizedHandler } from '../shared/api';
import { Company, MarketStatus, Me, Portfolio, Transactions } from '../shared/types';
import { usePoll } from '../shared/hooks';
import { LogoBars, Spinner, ToastProvider } from '../shared/ui';
import { Login } from './Login';
import { NavTab, Sidebar } from './Sidebar';
import { DashboardView } from './views/Dashboard';
import { TradingView } from './views/Trading';
import { MarketsView } from './views/Markets';
import { OrderConfirm } from './OrderConfirm';
import { HistoryModal } from './HistoryModal';
import { toActivities } from './activity';
import { describe } from './market';
import { Footer } from '../shared/Footer';

const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

type Auth = { state: 'checking' } | { state: 'out' } | { state: 'in'; me: Me };

export const PlayerApp: React.FC = () => {
  const [auth, setAuth] = useState<Auth>({ state: 'checking' });

  const check = useCallback(async () => {
    try {
      setAuth({ state: 'in', me: await get<Me>('/api/me') });
    } catch (e) {
      // Offline at load: keep checking rather than showing a login form that cannot work.
      if (e instanceof ApiError && e.offline) setTimeout(check, 3000);
      else setAuth({ state: 'out' });
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth({ state: 'out' }));
    check();
  }, [check]);

  return (
    <div className="mv-player min-h-screen text-slate-100 relative">
      <Backdrop />
      {auth.state === 'checking' && <div className="min-h-screen flex items-center justify-center text-slate-400"><Spinner className="w-6 h-6" /></div>}
      {auth.state === 'out' && <ToastProvider><Login onDone={check} /></ToastProvider>}
      {auth.state === 'in' && <ToastProvider><Shell me={auth.me} onLoggedOut={() => setAuth({ state: 'out' })} /></ToastProvider>}
    </div>
  );
};

// The page lighting: a soft spotlight from the top left, with grain so the gradient never bands.
const Backdrop: React.FC = () => (
  <div className="fixed inset-0 pointer-events-none z-0" aria-hidden>
    <div className="absolute inset-0 mv-spotlight" />
    <div className="absolute inset-0 mv-grain" />
  </div>
);

const Shell: React.FC<{ me: Me; onLoggedOut: () => void }> = ({ me, onLoggedOut }) => {
  const [tab, setTab] = useState<NavTab>('dashboard');
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pending, setPending] = useState<{ company: Company; side: 'buy' | 'sell'; quantity: number } | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  // Live state. Status every 2 s (cheap, cached server-side); the rest every 5 s and whenever the
  // round or phase changes, so new prices appear the moment the organisers apply them.
  const status = usePoll(() => get<MarketStatus>('/api/market/status'), 2000);
  const phaseKey = status.data ? `${status.data.current_round}:${status.data.phase}:${status.data.paused}` : '';
  const portfolio = usePoll(() => get<Portfolio>('/api/portfolio'), 5000, [phaseKey]);
  const companies = usePoll(() => get<Company[]>('/api/companies'), 5000, [phaseKey]);
  const tx = usePoll(() => get<Transactions>('/api/transactions'), 10000, [phaseKey]);

  const activities = useMemo(() => toActivities(tx.data), [tx.data]);
  const orders = useMemo(() => toActivities(tx.data, false), [tx.data]);
  const offline = status.error?.offline || status.error?.status === 503;

  const refreshAll = () => {
    portfolio.reload();
    companies.reload();
    tx.reload();
  };

  const logout = async () => {
    setLoggingOut(true);
    try {
      await post('/api/auth/logout');
    } catch {
      /* the session ends on the server or expires; either way show the login */
    }
    onLoggedOut();
  };

  const openHistory = () => {
    tx.reload(); // always show the latest, including corrections made a moment ago
    setHistoryOpen(true);
  };
  const go = (t: NavTab) => {
    setTab(t);
    setMenuOpen(false);
  };
  const trade = (id: number) => {
    setSelectedId(id);
    go('trading');
  };

  const sidebar = (
    <Sidebar currentTab={tab} onTabChange={go} teamName={me.team.name} playerName={me.member_name} onLogout={logout} loggingOut={loggingOut} />
  );
  const d = describe(status.data);

  return (
    <div className="min-h-screen flex flex-col relative overflow-x-hidden bg-[#0b0f17]">

      <div className="md:hidden fixed top-0 left-0 right-0 z-40 bg-[#0e0f11]/80 backdrop-blur-xl border-b border-white/[0.06] px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-2.5">
          <LogoBars small />
          <div>
            <span className="font-semibold text-white text-sm tracking-[0.18em]">MONOPOLY</span>
            <span className="text-[9px] text-slate-400 block font-semibold leading-none">{me.team.name}</span>
          </div>
        </div>
        <div className="flex items-center space-x-3">
          <span className={`text-[11px] font-bold ${d.tone}`}>{d.label}</span>
          <button onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu" className="p-1.5 rounded-lg bg-white/[0.06] border border-white/[0.08] text-slate-300">
            {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      <div className="flex-1 flex w-full min-w-0">
        <div className="hidden md:block sticky top-0 h-screen z-20 overflow-y-auto">{sidebar}</div>
        {menuOpen && (
          <div className="fixed inset-0 z-50 md:hidden flex">
            <div className="w-64 bg-[#111214] border-r border-white/[0.06] h-full shadow-2xl relative z-10 overflow-y-auto">{sidebar}</div>
            <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={() => setMenuOpen(false)} />
          </div>
        )}

        <div className="flex-1 flex flex-col min-w-0">
          <main className="flex-1 p-4 sm:p-6 md:p-10 pt-20 md:pt-10 relative z-10 max-w-7xl mx-auto w-full min-w-0">
            <div className="hidden md:flex justify-end mb-2">
              <div className="flex items-center space-x-3">
                <span className="w-9 h-9 rounded-full bg-gradient-to-br from-slate-500 to-slate-700 ring-2 ring-white/10 flex items-center justify-center text-xs font-semibold text-white">
                  {initials(me.member_name || me.team.name)}
                </span>
                <div className="leading-tight">
                  <div className="text-[15px] text-slate-100">{me.member_name || me.team.name}</div>
                  {me.member_name && <div className="text-xs text-slate-500">{me.team.name}</div>}
                </div>
              </div>
            </div>
            {offline && (
              <div className="mb-4 flex items-center space-x-2 rounded-xl bg-rose-950/50 border border-rose-900/70 px-4 py-2.5 text-sm text-rose-200">
                <WifiOff className="w-4 h-4 shrink-0" />
                <span>Connection lost. Reconnecting… Your completed trades are safe on the server.</span>
              </div>
            )}
            {status.data?.paused && status.data.phase === 'trading' && (
              <div className="mb-4 flex items-center space-x-2 rounded-xl bg-amber-950/40 border border-amber-800/60 px-4 py-2.5 text-sm text-amber-200">
                <PauseCircle className="w-4 h-4 shrink-0" />
                <span>Trading is paused by the organisers. The countdown resumes when trading does.</span>
              </div>
            )}

            {tab === 'dashboard' && (
              <DashboardView status={status.data} portfolio={portfolio.data} activities={activities} onOpenTransactions={openHistory} onTrade={trade} />
            )}
            {tab === 'trading' && (
              <TradingView
                status={status.data}
                companies={companies.data}
                portfolio={portfolio.data}
                selectedId={selectedId}
                onSelect={setSelectedId}
                orders={orders}
                onOpenOrdersHistory={openHistory}
                onReview={(company, side, quantity) => setPending({ company, side, quantity })}
              />
            )}
            {tab === 'markets' && <MarketsView status={status.data} companies={companies.data} onSelect={trade} />}
          </main>
        </div>
      </div>

      <Footer />

      {historyOpen && <HistoryModal rows={activities} loading={tx.loading} onClose={() => setHistoryOpen(false)} />}
      {pending && (
        <OrderConfirm
          company={pending.company}
          side={pending.side}
          quantity={pending.quantity}
          cash={portfolio.data?.cash ?? 0}
          feeBps={status.data?.fee_bps ?? 0}
          round={status.data?.current_round ?? 0}
          onClose={() => setPending(null)}
          onSettled={refreshAll}
        />
      )}
    </div>
  );
};
