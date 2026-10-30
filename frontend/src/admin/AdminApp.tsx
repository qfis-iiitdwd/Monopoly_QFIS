import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ArrowLeftRight, Building2, FileText, History, Home, LogIn, LogOut, Menu, Users, WifiOff, X } from 'lucide-react';
import { ApiError, errorMessage, get, post, setUnauthorizedHandler } from '../shared/api';
import { Polled, usePoll } from '../shared/hooks';
import { btn, ErrorNote, input, LogoBars, Spinner, ToastProvider } from '../shared/ui';
import { ActionDialog, ActionSpec } from './ActionDialog';
import { AdminTeam, Overview } from './types';
import { OverviewView } from './views/Overview';
import { RoundsView } from './views/Rounds';
import { ParticipantsView } from './views/Participants';
import { OrdersView } from './views/Orders';
import { TransactionsView } from './views/Transactions';
import { CompaniesView } from './views/Companies';

export type AdminTab = 'overview' | 'rounds' | 'participants' | 'orders' | 'transactions' | 'companies';

interface AdminCtx {
  overview: Polled<Overview>;
  teams: Polled<AdminTeam[]>;
  /** Opens the confirm dialog for an admin write; screens refresh when it succeeds. */
  act: (spec: ActionSpec) => void;
  /** Bumps after every successful write so open screens refetch. */
  version: number;
  /** Call after a write made outside ActionDialog. */
  refresh: () => void;
  go: (tab: AdminTab, teamId?: number) => void;
  focusTeam: number | null;
}
const Ctx = createContext<AdminCtx | null>(null);
export const useAdmin = () => useContext(Ctx)!;

export const AdminApp: React.FC = () => {
  const [state, setState] = useState<'checking' | 'out' | 'in'>('checking');
  const check = useCallback(async () => {
    try {
      await get('/api/admin/me');
      setState('in');
    } catch (e) {
      if (e instanceof ApiError && e.offline) setTimeout(check, 3000);
      else setState('out');
    }
  }, []);
  useEffect(() => {
    setUnauthorizedHandler(() => setState('out'));
    check();
  }, [check]);
  return (
    <ToastProvider>
      {state === 'checking' && <div className="min-h-screen flex items-center justify-center text-slate-400"><Spinner className="w-6 h-6" /></div>}
      {state === 'out' && <AdminLogin onDone={check} />}
      {state === 'in' && <Shell onLoggedOut={() => setState('out')} />}
    </ToastProvider>
  );
};

const AdminLogin: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/admin/login', { username, password });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-[#111622] border border-[#1e2638] p-7 shadow-2xl space-y-5">
        <div className="flex items-center space-x-3">
          <LogoBars />
          <div>
            <div className="font-extrabold tracking-wider text-xl leading-none text-white">MONOPOLY</div>
            <div className="text-[10px] tracking-widest text-slate-400 font-semibold uppercase mt-1">ADMIN PANEL</div>
          </div>
        </div>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-300">Username</span>
          <input className={input} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-300">Password</span>
          <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <ErrorNote text={error} />
        <button type="submit" disabled={busy || !password} className={`${btn.primary} w-full py-3 text-sm`}>
          {busy ? <Spinner /> : <LogIn className="w-4 h-4" />}
          <span>Log in</span>
        </button>
      </form>
    </div>
  );
};

const NAV = [
  { id: 'overview' as AdminTab, label: 'Overview', icon: Home },
  { id: 'rounds' as AdminTab, label: 'Rounds', icon: History },
  { id: 'participants' as AdminTab, label: 'Participants', icon: Users },
  { id: 'orders' as AdminTab, label: 'Orders', icon: ArrowLeftRight },
  { id: 'transactions' as AdminTab, label: 'Transactions', icon: FileText },
  { id: 'companies' as AdminTab, label: 'Companies', icon: Building2 },
];

const Shell: React.FC<{ onLoggedOut: () => void }> = ({ onLoggedOut }) => {
  const [tab, setTab] = useState<AdminTab>('overview');
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<ActionSpec | null>(null);
  const [version, setVersion] = useState(0);
  const [focusTeam, setFocusTeam] = useState<number | null>(null);

  const overview = usePoll(() => get<Overview>('/api/admin/overview'), 3000);
  const teams = usePoll(() => get<AdminTeam[]>('/api/admin/teams'), 5000, [version]);

  const done = () => {
    setVersion((v) => v + 1);
    overview.reload();
  };
  const go = (t: AdminTab, teamId?: number) => {
    setTab(t);
    setMenuOpen(false);
    if (teamId !== undefined) setFocusTeam(teamId);
  };
  const logout = async () => {
    try { await post('/api/admin/logout'); } catch { /* expired anyway */ }
    onLoggedOut();
  };

  const sidebar = (
    <aside className="w-64 bg-[#0d121c] border-r border-[#1a2336] flex flex-col justify-between shrink-0 select-none min-h-screen">
      <div>
        <div className="p-6 pb-8 flex items-center space-x-3">
          <LogoBars />
          <div>
            <div className="font-extrabold tracking-wider text-xl leading-none text-white">MONOPOLY</div>
            <div className="text-[10px] tracking-widest text-slate-400 font-semibold uppercase mt-1">ADMIN PANEL</div>
          </div>
        </div>
        <nav className="px-3 space-y-1.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button key={item.id} onClick={() => go(item.id)} aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-all duration-150 ${active ? 'bg-[#371920] text-white border border-[#58212a] shadow-sm' : 'text-slate-300 hover:text-white hover:bg-[#161f30]'}`}>
                <Icon className={`w-5 h-5 mr-3.5 ${active ? 'text-[#f87171]' : 'text-slate-400'}`} />
                <span className="font-semibold text-[15px]">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
      <div className="p-4 border-t border-[#1a2336]">
        <button onClick={logout} className="w-full flex items-center px-3 py-2 text-sm text-slate-400 hover:text-white hover:bg-[#161f30] rounded-lg transition-colors">
          <LogOut className="w-4 h-4 mr-3" />
          <span>Logout</span>
        </button>
      </div>
    </aside>
  );

  const offline = overview.error?.offline || overview.error?.status === 503;
  return (
    <Ctx.Provider value={{ overview, teams, act: setDialog, version, refresh: done, go, focusTeam }}>
      <div className="min-h-screen bg-[#0b0f17] text-slate-100 flex relative overflow-x-hidden font-sans">
        <div className="fixed inset-0 pointer-events-none z-0">
          <div className="absolute -bottom-24 -left-24 w-96 h-96 bg-red-900/10 rounded-full blur-3xl" />
          <div className="absolute top-1/4 -right-24 w-96 h-96 bg-blue-900/10 rounded-full blur-3xl" />
        </div>
        <div className="md:hidden fixed top-0 left-0 right-0 z-40 bg-[#0d121c] border-b border-[#1a2336] px-4 py-3 flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <LogoBars small />
            <div>
              <span className="font-extrabold text-white text-base tracking-wide">MONOPOLY</span>
              <span className="text-[9px] text-slate-400 block font-semibold leading-none">ADMIN PANEL</span>
            </div>
          </div>
          <button onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu" className="p-1.5 rounded-lg bg-[#161f30] text-slate-300">
            {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
        <div className="hidden md:block sticky top-0 h-screen z-20 overflow-y-auto">{sidebar}</div>
        {menuOpen && (
          <div className="fixed inset-0 z-50 md:hidden flex">
            <div className="w-64 bg-[#0d121c] h-full shadow-2xl relative z-10 overflow-y-auto">{sidebar}</div>
            <div className="flex-1 bg-black/60" onClick={() => setMenuOpen(false)} />
          </div>
        )}
        <main className="flex-1 p-4 sm:p-6 md:p-8 pt-20 md:pt-8 relative z-10 max-w-7xl mx-auto w-full min-w-0">
          {offline && (
            <div className="mb-4 flex items-center space-x-2 rounded-xl bg-rose-950/50 border border-rose-900/70 px-4 py-2.5 text-sm text-rose-200">
              <WifiOff className="w-4 h-4 shrink-0" />
              <span>Cannot reach the server. Showing the last known data; retrying…</span>
            </div>
          )}
          {!overview.data ? (
            <div className="py-24 flex justify-center text-slate-400"><Spinner className="w-6 h-6" /></div>
          ) : (
            <>
              {tab === 'overview' && <OverviewView />}
              {tab === 'rounds' && <RoundsView />}
              {tab === 'participants' && <ParticipantsView />}
              {tab === 'orders' && <OrdersView />}
              {tab === 'transactions' && <TransactionsView />}
              {tab === 'companies' && <CompaniesView />}
            </>
          )}
        </main>
        {dialog && <ActionDialog spec={dialog} onClose={() => setDialog(null)} onDone={done} />}
      </div>
    </Ctx.Provider>
  );
};
