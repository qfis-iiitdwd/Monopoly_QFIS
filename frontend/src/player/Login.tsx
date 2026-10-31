import React, { useState } from 'react';
import { LogIn } from 'lucide-react';
import { post, errorMessage } from '../shared/api';
import { btn, ErrorNote, input, LogoBars, Spinner } from '../shared/ui';
import { Footer } from '../shared/Footer';

export const Login: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [teamId, setTeamId] = useState('');
  const [password, setPassword] = useState('');
  const [member, setMember] = useState(() => {
    try { return localStorage.getItem('mv_member') || ''; } catch { return ''; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/login', { team_id: teamId.trim(), password, member_name: member.trim() });
      try { localStorage.setItem('mv_member', member.trim()); } catch { /* private mode */ }
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-between relative z-10">
      <div className="flex-1 flex items-center justify-center p-4 sm:p-6 my-auto">
        <form onSubmit={submit} className="w-full max-w-sm mv-glow relative z-10 rounded-[1.75rem] bg-white/[0.03] border border-white/[0.07] backdrop-blur-xl p-8 shadow-2xl space-y-5">
          <div className="flex items-center space-x-3">
            <LogoBars />
            <div>
              <div className="font-semibold tracking-[0.18em] text-sm leading-none text-white">MONOPOLY</div>
              <div className="text-[9px] tracking-wider whitespace-nowrap text-slate-400 font-semibold uppercase mt-1">FINANCE • STRATEGY • MARKETS</div>
            </div>
          </div>
          <div>
            <h1 className="text-2xl font-normal text-white tracking-tight">Team login</h1>
            <p className="text-xs text-slate-400 mt-1">Use the team ID and password from your slip. Every member of a team can log in at once.</p>
          </div>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-300">Team ID</span>
            <input className={input} value={teamId} onChange={(e) => setTeamId(e.target.value)} autoComplete="username" autoCapitalize="none" placeholder="e.g. team07" required />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-300">Password</span>
            <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-300">Your name <span className="text-slate-500">(optional, shown on your team's trades)</span></span>
            <input className={input} value={member} onChange={(e) => setMember(e.target.value)} maxLength={40} placeholder="e.g. Priya" />
          </label>
          <ErrorNote text={error} />
          <button type="submit" disabled={busy || !teamId || !password} className={`${btn.light} w-full py-3 text-sm`}>
            {busy ? <Spinner /> : <LogIn className="w-4 h-4" />}
            <span>{busy ? 'Logging in…' : 'Log in'}</span>
          </button>
        </form>
      </div>
      <Footer />
    </div>
  );
};
