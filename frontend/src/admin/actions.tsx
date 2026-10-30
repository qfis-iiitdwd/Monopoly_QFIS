import React from 'react';
import { post } from '../shared/api';
import { inr, qty } from '../shared/format';
import { ActionSpec } from './ActionDialog';
import { AdminRound, AuditRow } from './types';

// Every admin write the screens can make, as dialog specs. Each one calls exactly one endpoint.

export const actions = {
  startEvent: (): ActionSpec => ({
    title: 'Start the event',
    body: <p>Teams can log in and see prices. Company setup freezes. Then open Round 1 from the Rounds page.</p>,
    confirmLabel: 'Start event', tone: 'green',
    run: async () => { await post('/api/admin/event/start'); return 'Event started'; },
  }),
  endEvent: (): ActionSpec => ({
    title: 'End the event',
    body: <p>Freezes the final rankings. Trading cannot resume and corrections are no longer possible. Do this only after the last round is settled.</p>,
    confirmLabel: 'End event and freeze rankings',
    run: async () => { await post('/api/admin/event/end'); return 'Event ended. Final rankings frozen.'; },
  }),
  pause: (): ActionSpec => ({
    title: 'Pause trading',
    body: <p>All orders are refused until you resume. Teams see a "paused" banner within 2 seconds.</p>,
    confirmLabel: 'Pause trading', reason: 'optional',
    run: async (v) => { await post('/api/admin/pause', { reason: v.reason || undefined }); return 'Trading paused'; },
  }),
  resume: (): ActionSpec => ({
    title: 'Resume trading',
    checkbox: { label: 'Add the paused time to the deadline (recommended)', initial: true },
    confirmLabel: 'Resume trading', tone: 'green', reason: 'optional',
    run: async (v) => { await post('/api/admin/resume', { extend: v.checked, reason: v.reason || undefined }); return 'Trading resumed'; },
  }),
  openRound: (r: AdminRound): ActionSpec => ({
    title: `Open Round ${r.id}`,
    body: <p>Trading starts now and closes automatically after {Math.round(r.duration_seconds / 60)} min {r.duration_seconds % 60 ? `${r.duration_seconds % 60} s` : ''}.</p>,
    confirmLabel: `Open Round ${r.id}`, tone: 'green',
    run: async () => { await post(`/api/admin/rounds/${r.id}/open`); return `Round ${r.id} is open`; },
  }),
  closeRound: (id: number): ActionSpec => ({
    title: `Close Round ${id} now`,
    body: <p>Trading stops immediately, before the deadline. You can reopen it until you apply the market update.</p>,
    confirmLabel: 'Close market',
    run: async () => { await post(`/api/admin/rounds/${id}/close`); return `Round ${id} closed`; },
  }),
  extend: (id: number): ActionSpec => ({
    title: `Extend Round ${id}`,
    seconds: { label: 'Extra seconds (1–3600)', initial: 60 }, reason: 'required',
    confirmLabel: 'Extend',
    run: async (v) => { await post(`/api/admin/rounds/${id}/extend`, { seconds: v.seconds, reason: v.reason }); return `Round ${id} extended by ${v.seconds} s`; },
  }),
  reopen: (id: number): ActionSpec => ({
    title: `Reopen Round ${id}`,
    body: <p>For an accidental close. Trading reopens for the time you choose.</p>,
    seconds: { label: 'Trading time (seconds)', initial: 120 }, reason: 'required',
    confirmLabel: 'Reopen trading', tone: 'green',
    run: async (v) => { await post(`/api/admin/rounds/${id}/reopen`, { seconds: v.seconds, reason: v.reason }); return `Round ${id} reopened`; },
  }),
  apply: (id: number, preview: React.ReactNode): ActionSpec => ({
    title: `Apply market update for Round ${id}`,
    body: <>{preview}<p>New prices go live for every team at once. It can be undone only until the next round opens.</p></>,
    confirmLabel: 'Apply new prices', tone: 'green',
    run: async () => { await post(`/api/admin/rounds/${id}/apply-market-update`); return `Round ${id} prices applied`; },
  }),
  undo: (id: number): ActionSpec => ({
    title: `Undo market update for Round ${id}`,
    body: <p>Removes the new prices and returns the round to "closed". Then fix the price plan and apply again.</p>,
    reason: 'required', confirmLabel: 'Undo update',
    run: async (v) => { await post(`/api/admin/rounds/${id}/undo-market-update`, { reason: v.reason }); return `Round ${id} update undone`; },
  }),
  reverseOrder: (o: { id: number; team: string; side: string; quantity: number; ticker: string; price: number | null; settled: boolean }): ActionSpec => ({
    title: `Reverse order #${o.id}`,
    subtitle: o.team,
    body: (
      <>
        <p>Undo {o.side.toUpperCase()} {qty(o.quantity)} {o.ticker}{o.price != null ? ` @ ${inr(o.price, 2)}` : ''} exactly: shares, cash (including the fee) and its effect on the next price.</p>
        {o.settled && <p className="text-amber-300">This order's round is already settled. The team made later decisions knowing this trade; consider a cash adjustment instead.</p>}
        <p className="text-slate-400 text-xs">The server refuses if the team has since used those shares or that cash, and says why.</p>
      </>
    ),
    reason: 'required', reasonPlaceholder: 'e.g. Team pressed buy twice by mistake (confirmed with captain)',
    confirmLabel: 'Reverse order',
    run: async (v) => { await post(`/api/admin/orders/${o.id}/reverse`, { reason: v.reason }); return `Order #${o.id} reversed`; },
  }),
  resetPassword: (teamId: number, name: string): ActionSpec => ({
    title: `Reset password: ${name}`,
    body: <p>Creates a new password and logs out every device of this team. Give the new password to the team in person.</p>,
    reason: 'required', confirmLabel: 'Create new password',
    run: async (v) => (await post<{ password: string }>(`/api/admin/teams/${teamId}/reset-password`, { reason: v.reason })).password,
    keepOpenWith: (password) => (
      <div className="space-y-3 text-sm">
        <p className="text-slate-300">New password for <strong>{name}</strong>. It is shown only once:</p>
        <div className="font-mono text-2xl text-center text-white bg-[#0c1018] border border-[#232f48] rounded-xl py-4 select-all">{password}</div>
      </div>
    ),
  }),
  setActive: (teamId: number, name: string, active: boolean): ActionSpec => ({
    title: `${active ? 'Enable' : 'Disable'} ${name}`,
    body: active
      ? <p>The team can log in and trade again, and returns to the rankings.</p>
      : <p>Logs out every device of this team immediately. It cannot log in or trade and is left out of the rankings. Holdings and history are kept; you can enable it again.</p>,
    reason: 'required', confirmLabel: active ? 'Enable team' : 'Disable team', tone: active ? 'green' : 'danger',
    run: async (v) => { await post(`/api/admin/teams/${teamId}/active`, { active, reason: v.reason }); return `${name} ${active ? 'enabled' : 'disabled'}`; },
  }),
  setTradable: (companyId: number, ticker: string, tradable: boolean): ActionSpec => ({
    title: `${tradable ? 'Resume' : 'Suspend'} trading in ${ticker}`,
    body: tradable ? <p>Teams can trade {ticker} again.</p> : <p>Orders for {ticker} are refused. Teams see the reason you give.</p>,
    reason: 'required', confirmLabel: tradable ? 'Resume trading' : 'Suspend trading', tone: tradable ? 'green' : 'danger',
    run: async (v) => { await post(`/api/admin/companies/${companyId}/trading`, { tradable, reason: v.reason }); return `${ticker} ${tradable ? 'resumed' : 'suspended'}`; },
  }),
};

// ---- Audit log, made readable ----------------------------------------------------------------
export type AuditType = 'Market' | 'Price Update' | 'Participant' | 'Announcement' | 'Company' | 'System';

const AUDIT: Record<string, [AuditType, string]> = {
  seed: ['System', 'Database set up from the game file'],
  admin_login: ['System', 'Admin logged in'],
  start_event: ['Market', 'Event started'],
  end_event: ['Market', 'Event ended, rankings frozen'],
  open_round: ['Market', 'Round opened'],
  close_round: ['Market', 'Round closed by organiser'],
  auto_close_round: ['Market', 'Round closed at the deadline'],
  reopen_round: ['Market', 'Round reopened'],
  extend_round: ['Market', 'Round extended'],
  pause: ['Market', 'Trading paused'],
  resume: ['Market', 'Trading resumed'],
  publish_newspaper: ['Market', 'Round newspaper released'],
  publish_bulletin: ['Market', 'Round news released'],
  apply_market_update: ['Price Update', 'New prices applied'],
  undo_market_update: ['Price Update', 'Price update undone'],
  update_event: ['Price Update', 'Price plan edited'],
  set_message: ['Announcement', 'Message to all teams'],
  adjust_cash: ['Participant', 'Cash adjusted'],
  adjust_holdings: ['Participant', 'Holdings adjusted'],
  reverse_order: ['Participant', 'Order reversed'],
  grant_reward: ['Participant', 'Reward granted'],
  reset_team_password: ['Participant', 'Team password reset'],
  disable_team: ['Participant', 'Team disabled'],
  enable_team: ['Participant', 'Team enabled'],
  update_company: ['Company', 'Company details edited'],
  suspend_company: ['Company', 'Company suspended'],
  resume_company: ['Company', 'Company resumed'],
};

export function describeAudit(a: AuditRow): { type: AuditType; text: string } {
  const [type, base] = AUDIT[a.action] || ['System', a.action.replace(/_/g, ' ')];
  const after = (a.after_state || {}) as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof after.current_round === 'number' && a.action === 'open_round') bits.push(`Round ${after.current_round}`);
  if (typeof after.round === 'number') bits.push(`Round ${after.round}`);
  if (typeof after.team === 'string') bits.push(after.team);
  if (typeof after.ticker === 'string') bits.push(after.ticker);
  if (a.action === 'set_message') bits.push(after.message ? `"${String(after.message).slice(0, 60)}"` : '(cleared)');
  if (a.action === 'adjust_cash' && typeof after.amount === 'number') bits.push(inr(after.amount));
  if (a.action === 'grant_reward' && typeof after.quest === 'string') bits.push(`${after.quest}, ${inr(Number(after.amount))} each`);
  const text = [base, bits.join(' · ')].filter(Boolean).join(': ');
  return { type, text: a.reason ? `${text} (${a.reason})` : text };
}

export const AUDIT_BADGE: Record<AuditType, string> = {
  Market: 'bg-teal-950/60 text-teal-400 border-teal-800/40',
  'Price Update': 'bg-slate-800 text-slate-300 border-slate-700',
  Participant: 'bg-emerald-950/60 text-emerald-400 border-emerald-800/40',
  Announcement: 'bg-amber-950/60 text-amber-400 border-amber-800/40',
  Company: 'bg-blue-950/60 text-blue-400 border-blue-800/40',
  System: 'bg-[#1b2333] text-slate-400 border-slate-700',
};
