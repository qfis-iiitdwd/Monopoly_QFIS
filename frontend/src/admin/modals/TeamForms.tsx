import React, { useState } from 'react';
import { CheckCircle, Minus, Plus } from 'lucide-react';
import { errorMessage, get, post } from '../../shared/api';
import { usePoll } from '../../shared/hooks';
import { inr, parseRupees, qty } from '../../shared/format';
import { btn, ErrorNote, input, Modal, Spinner, useToast } from '../../shared/ui';
import { useAdmin } from '../AdminApp';
import { AdminCompany, AdminTeam } from '../types';

// Forms for team corrections. Each submits one request and reports the server's answer; the
// projected figures are computed from the team's real current numbers.

const useSubmit = (onClose: () => void) => {
  const { refresh } = useAdmin();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      toast(await fn());
      refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
};

const Direction: React.FC<{ value: 'add' | 'deduct'; onChange: (v: 'add' | 'deduct') => void; add: string; deduct: string }> = ({ value, onChange, add, deduct }) => (
  <div className="grid grid-cols-2 gap-2 p-1 bg-[#0c1018] rounded-xl border border-[#1a2334]">
    <button type="button" onClick={() => onChange('add')} aria-pressed={value === 'add'} className={`py-2 rounded-lg text-xs font-bold flex items-center justify-center space-x-1 transition-all ${value === 'add' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-400 hover:text-white'}`}>
      <Plus className="w-3.5 h-3.5" /><span>{add}</span>
    </button>
    <button type="button" onClick={() => onChange('deduct')} aria-pressed={value === 'deduct'} className={`py-2 rounded-lg text-xs font-bold flex items-center justify-center space-x-1 transition-all ${value === 'deduct' ? 'bg-rose-600 text-white shadow-md' : 'text-slate-400 hover:text-white'}`}>
      <Minus className="w-3.5 h-3.5" /><span>{deduct}</span>
    </button>
  </div>
);

const ReasonField: React.FC<{ value: string; onChange: (v: string) => void; placeholder: string }> = ({ value, onChange, placeholder }) => (
  <label className="block space-y-1.5">
    <span className="text-xs font-medium text-slate-300">Reason (required, kept in the audit log)</span>
    <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={input + ' text-xs'} />
  </label>
);

const Footer: React.FC<{ busy: boolean; ok: boolean; label: string; onClose: () => void }> = ({ busy, ok, label, onClose }) => (
  <div className="flex justify-end space-x-3 pt-3">
    <button type="button" onClick={onClose} className={btn.ghost}>Cancel</button>
    <button type="submit" disabled={busy || !ok} className={btn.primary}>
      {busy ? <Spinner className="w-3.5 h-3.5" /> : <CheckCircle className="w-3.5 h-3.5" />}
      <span>{label}</span>
    </button>
  </div>
);

export const AdjustCashModal: React.FC<{ team: AdminTeam; onClose: () => void }> = ({ team, onClose }) => {
  const [direction, setDirection] = useState<'add' | 'deduct'>('add');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const { busy, error, run } = useSubmit(onClose);
  const paise = parseRupees(amount);
  const signed = paise == null ? 0 : direction === 'add' ? paise : -paise;
  const projected = team.cash + signed;
  const ok = !!paise && reason.trim().length >= 5;

  return (
    <Modal title="Adjust Cash Balance" subtitle={`Participant: ${team.name}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); run(async () => {
        const r = await post<{ cash: number }>(`/api/admin/teams/${team.team_id}/adjust-cash`, { amount: signed, reason: reason.trim() });
        return `${team.name}: cash is now ${inr(r.cash)}`;
      }); }} className="space-y-4">
        <div className="flex justify-between items-center bg-[#151c2b] p-3 rounded-xl border border-[#202b40] text-xs">
          <span className="text-slate-400">Current cash:</span>
          <span className="font-mono font-bold text-white text-sm">{inr(team.cash, 2)}</span>
        </div>
        <Direction value={direction} onChange={setDirection} add="Credit (+)" deduct="Debit (-)" />
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-300">Amount (₹)</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 50000" className={input + ' font-mono'} />
        </label>
        <ReasonField value={reason} onChange={setReason} placeholder="e.g. Penalty for rule 4, Manual correction" />
        <div className="flex justify-between items-center pt-2 border-t border-[#1e2638] text-xs">
          <span className="text-slate-400">Projected cash:</span>
          <span className={`font-mono font-bold text-sm ${projected < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{inr(projected, 2)}</span>
        </div>
        <p className="text-[11px] text-slate-500">For quiz prizes use Reward instead: it can only be given once per team per quiz.</p>
        <ErrorNote text={error} />
        <Footer busy={busy} ok={ok} label="Confirm Adjustment" onClose={onClose} />
      </form>
    </Modal>
  );
};

export const AdjustHoldingsModal: React.FC<{ team: AdminTeam; holdings: { company_id: number; quantity: number; pledged_quantity: number }[]; onClose: () => void }> = ({ team, holdings, onClose }) => {
  const companies = usePoll(() => get<AdminCompany[]>('/api/admin/companies'), 0);
  const [companyId, setCompanyId] = useState<number | ''>('');
  const [direction, setDirection] = useState<'add' | 'deduct'>('add');
  const [count, setCount] = useState('');
  const [reason, setReason] = useState('');
  const { busy, error, run } = useSubmit(onClose);
  const co = companies.data?.find((c) => c.id === companyId);
  const held = holdings.find((h) => h.company_id === companyId)?.quantity ?? 0;
  const n = /^\d+$/.test(count) ? Number(count) : 0;
  const delta = direction === 'add' ? n : -n;
  const ok = !!co && n > 0 && reason.trim().length >= 5;

  return (
    <Modal title="Adjust Holdings" subtitle={`Participant: ${team.name}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); run(async () => {
        const r = await post<{ quantity: number }>(`/api/admin/teams/${team.team_id}/adjust-holdings`, { company_id: companyId, delta, reason: reason.trim() });
        return `${team.name} now holds ${qty(r.quantity)} ${co!.ticker}`;
      }); }} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-300">Company</span>
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value ? Number(e.target.value) : '')} className={input}>
            <option value="">{companies.data ? 'Choose a company…' : 'Loading…'}</option>
            {companies.data?.map((c) => <option key={c.id} value={c.id}>{c.ticker} · {c.name}</option>)}
          </select>
        </label>
        {co && (
          <div className="grid grid-cols-2 gap-2 text-xs bg-[#151c2b] p-3 rounded-xl border border-[#202b40]">
            <span className="text-slate-400">Team holds</span><span className="font-mono text-white text-right">{qty(held)}</span>
            <span className="text-slate-400">Left on exchange</span><span className="font-mono text-white text-right">{qty(co.exchange_inventory)}</span>
          </div>
        )}
        <Direction value={direction} onChange={setDirection} add="Give shares" deduct="Take shares" />
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-300">Number of shares</span>
          <input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))} className={input + ' font-mono'} />
        </label>
        <ReasonField value={reason} onChange={setReason} placeholder="e.g. Correcting a mis-keyed order" />
        <p className="text-[11px] text-slate-500">Shares move between the team and the exchange, so the total supply stays the same. Cash is not changed.</p>
        <ErrorNote text={error} />
        <Footer busy={busy} ok={ok} label="Confirm Adjustment" onClose={onClose} />
      </form>
    </Modal>
  );
};

export const RewardModal: React.FC<{ teams: AdminTeam[]; initial: number[]; maxReward: number; onClose: () => void }> = ({ teams, initial, maxReward, onClose }) => {
  const [selected, setSelected] = useState<number[]>(initial);
  const [quest, setQuest] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const { busy, error, run } = useSubmit(onClose);
  const paise = parseRupees(amount);
  const ok = selected.length > 0 && quest.trim() && !!paise && paise <= maxReward && reason.trim().length >= 5;
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <Modal title="Give a reward" subtitle="Quiz or quest prize. Each team can receive a given quiz's prize only once." onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); run(async () => {
        const r = await post<{ team_id: number; skipped?: string }[]>('/api/admin/rewards', { team_ids: selected, quest: quest.trim(), amount: paise, reason: reason.trim() });
        const skipped = r.filter((x) => x.skipped).length;
        return `Reward given to ${r.length - skipped} team(s)${skipped ? `; ${skipped} already had it` : ''}`;
      }); }} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-300">Quiz / quest name</span>
          <input value={quest} onChange={(e) => setQuest(e.target.value)} placeholder="e.g. Round 3 quiz" className={input + ' text-xs'} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-300">Amount per team (₹, max {inr(maxReward)})</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={input + ' font-mono'} />
        </label>
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-slate-300">Teams ({selected.length} selected)</span>
          <div className="max-h-40 overflow-y-auto grid grid-cols-2 gap-1 bg-[#0c1018] border border-[#1a2334] rounded-lg p-2">
            {teams.filter((t) => t.is_active).map((t) => (
              <label key={t.team_id} className="flex items-center space-x-2 text-xs text-slate-300 cursor-pointer">
                <input type="checkbox" checked={selected.includes(t.team_id)} onChange={() => toggle(t.team_id)} className="accent-rose-500" />
                <span className="truncate">{t.name}</span>
              </label>
            ))}
          </div>
        </div>
        <ReasonField value={reason} onChange={setReason} placeholder="e.g. Winners of the Round 3 quiz" />
        <ErrorNote text={error} />
        <Footer busy={busy} ok={!!ok} label="Give reward" onClose={onClose} />
      </form>
    </Modal>
  );
};
