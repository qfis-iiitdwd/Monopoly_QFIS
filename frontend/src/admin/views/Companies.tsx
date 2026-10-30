import React, { useMemo, useState } from 'react';
import { Building2, CheckCircle, Edit3, Pause, Play, Plus, Search, Trash2 } from 'lucide-react';
import { errorMessage, get, patch } from '../../shared/api';
import { usePoll } from '../../shared/hooks';
import { pct, qty, rupees } from '../../shared/format';
import { btn, card, EmptyRow, ErrorNote, input, Modal, Spinner, TickerBadge, useToast } from '../../shared/ui';
import { useAdmin } from '../AdminApp';
import { actions } from '../actions';
import { Kpi, PageHeader } from '../common';
import { AdminCompany } from '../types';

export const CompaniesView: React.FC = () => {
  const { overview, act, version } = useAdmin();
  const o = overview.data!;
  const companies = usePoll(() => get<AdminCompany[]>('/api/admin/companies'), 5000, [version]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<AdminCompany | null>(null);
  const list = companies.data || [];
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return list.filter((c) => c.ticker.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) || c.ceo.toLowerCase().includes(q) || c.industry.toLowerCase().includes(q));
  }, [list, search]);
  const missingCeo = list.filter((c) => !c.ceo).length;
  const placeholder = list.filter((c) => /placeholder/i.test(c.description)).length;

  return (
    <div className="space-y-6 pb-12 animate-fadeIn">
      <PageHeader title="Companies" subtitle="Company story details shown to teams, and trading suspension." o={o} />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Kpi icon={<Building2 className="w-5 h-5" />} tint="bg-blue-500/10 border-blue-500/20 text-blue-400" label="Companies" value={list.length}
          sub={<span className="text-slate-400">{list.filter((c) => c.is_tradable).length} tradable</span>} />
        <Kpi icon={<Edit3 className="w-5 h-5" />} tint="bg-amber-500/10 border-amber-500/20 text-amber-400" label="Missing CEO name" value={missingCeo}
          sub={<span className={missingCeo ? 'text-amber-400' : 'text-emerald-400'}>{missingCeo ? 'fill in before the event' : 'all filled in'}</span>} />
        <Kpi icon={<Edit3 className="w-5 h-5" />} tint="bg-rose-500/10 border-rose-500/20 text-rose-400" label="Placeholder descriptions" value={placeholder}
          sub={<span className={placeholder ? 'text-amber-400' : 'text-emerald-400'}>{placeholder ? 'replace with the story text' : 'all filled in'}</span>} />
      </div>

      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ticker, company, CEO or sector..."
          className="w-full bg-[#111622] border border-[#1e2638] rounded-xl pl-10 pr-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500" />
      </div>

      <div className={`${card} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse monopoly-table">
            <thead>
              <tr className="text-xs font-semibold text-slate-400 border-b border-[#1b2233]">
                <th className="py-3 px-5">Symbol</th>
                <th className="py-3 px-3">Company</th>
                <th className="py-3 px-3">CEO</th>
                <th className="py-3 px-3">Sector</th>
                <th className="py-3 px-3 text-right">Price (₹)</th>
                <th className="py-3 px-3 text-right">Change</th>
                <th className="py-3 px-3 text-right">On exchange</th>
                <th className="py-3 px-3 text-right">Held by teams</th>
                <th className="py-3 px-3">Trading</th>
                <th className="py-3 px-4"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#171e2c] text-sm">
              {!companies.data && <EmptyRow cols={10} text="Loading…" />}
              {filtered.map((c) => (
                <tr key={c.id} className="hover:bg-[#151c2a]">
                  <td className="py-3 px-5"><TickerBadge ticker={c.ticker} industry={c.industry} /></td>
                  <td className="py-3 px-3 font-semibold text-white whitespace-nowrap">{c.name}</td>
                  <td className="py-3 px-3 text-xs whitespace-nowrap">{c.ceo ? <span className="text-slate-300">{c.ceo}</span> : <span className="text-amber-400">missing</span>}</td>
                  <td className="py-3 px-3 text-xs text-slate-400 whitespace-nowrap">{c.industry}</td>
                  <td className="py-3 px-3 text-right font-mono text-slate-200">{rupees(c.price)}</td>
                  <td className={`py-3 px-3 text-right font-mono text-xs ${c.change_bps > 0 ? 'text-emerald-400' : c.change_bps < 0 ? 'text-rose-400' : 'text-slate-400'}`}>{pct(c.change_bps)}</td>
                  <td className="py-3 px-3 text-right font-mono text-slate-300">{qty(c.exchange_inventory)}</td>
                  <td className="py-3 px-3 text-right font-mono text-slate-300">{qty(c.held_by_teams)}</td>
                  <td className="py-3 px-3">
                    {c.is_tradable
                      ? <span className="text-xs text-emerald-400 font-semibold">Open</span>
                      : <span className="text-xs text-amber-400 font-semibold" title={c.suspension_reason || ''}>Suspended</span>}
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => setEditing(c)} className={btn.small}><Edit3 className="w-3 h-3" /><span>Edit</span></button>
                      <button onClick={() => act(actions.setTradable(c.id, c.ticker, !c.is_tradable))} className={btn.small} disabled={o.state.status === 'finished'}>
                        {c.is_tradable ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}<span>{c.is_tradable ? 'Suspend' : 'Resume'}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {editing && <EditCompany company={editing} setup={o.state.status === 'setup'} onClose={() => setEditing(null)} />}
    </div>
  );
};

const EditCompany: React.FC<{ company: AdminCompany; setup: boolean; onClose: () => void }> = ({ company, setup, onClose }) => {
  const { refresh } = useAdmin();
  const toast = useToast();
  const [name, setName] = useState(company.name);
  const [industry, setIndustry] = useState(company.industry);
  const [ceo, setCeo] = useState(company.ceo);
  const [description, setDescription] = useState(company.description);
  const [details, setDetails] = useState<[string, string][]>(Object.entries(company.details || {}));
  const [maxQty, setMaxQty] = useState(String(company.max_order_quantity));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanDetails = Object.fromEntries(details.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v.trim()]));
  const body: Record<string, unknown> = {};
  if (setup && name !== company.name) body.name = name.trim();
  if (setup && industry !== company.industry) body.industry = industry.trim();
  if (ceo !== company.ceo) body.ceo = ceo.trim();
  if (description !== company.description) body.description = description;
  if (JSON.stringify(cleanDetails) !== JSON.stringify(company.details || {})) body.details = cleanDetails;
  if (maxQty !== String(company.max_order_quantity)) body.max_order_quantity = Number(maxQty);
  const changes = Object.keys(body).length;
  const ok = changes > 0 && (setup || reason.trim().length >= 5) && /^\d+$/.test(maxQty) && Number(maxQty) > 0;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await patch(`/api/admin/companies/${company.id}`, { ...body, reason: reason.trim() || undefined });
      toast(`${company.ticker} saved. Teams see it within a few seconds.`);
      refresh();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Edit ${company.ticker}`} subtitle={setup ? 'Before the event: every field can change.' : 'During the event: story text and max order size only.'} onClose={onClose}>
      <form onSubmit={save} className="space-y-4 text-xs">
        <label className="block space-y-1.5"><span className="font-semibold text-slate-300">Company name</span>
          <input className={input} value={name} disabled={!setup} onChange={(e) => setName(e.target.value)} /></label>
        <label className="block space-y-1.5"><span className="font-semibold text-slate-300">Sector</span>
          <input className={input} value={industry} disabled={!setup} onChange={(e) => setIndustry(e.target.value)} /></label>
        <label className="block space-y-1.5"><span className="font-semibold text-slate-300">CEO</span>
          <input className={input} value={ceo} onChange={(e) => setCeo(e.target.value)} placeholder="e.g. Rohan Mehta" /></label>
        <label className="block space-y-1.5"><span className="font-semibold text-slate-300">Description (shown on the Trading page)</span>
          <textarea rows={3} className={input + ' resize-y text-xs'} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <div className="space-y-1.5">
          <span className="font-semibold text-slate-300">Additional details (label → value)</span>
          {details.map(([k, v], i) => (
            <div key={i} className="flex gap-2">
              <input className={input + ' text-xs w-2/5'} value={k} maxLength={40} placeholder="e.g. Founded" onChange={(e) => setDetails(details.map((d, j) => (j === i ? [e.target.value, d[1]] : d)))} />
              <input className={input + ' text-xs flex-1'} value={v} maxLength={500} placeholder="e.g. 1998" onChange={(e) => setDetails(details.map((d, j) => (j === i ? [d[0], e.target.value] : d)))} />
              <button type="button" aria-label="Remove" onClick={() => setDetails(details.filter((_, j) => j !== i))} className="text-slate-500 hover:text-rose-400"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          {details.length < 20 && (
            <button type="button" onClick={() => setDetails([...details, ['', '']])} className={btn.small}><Plus className="w-3 h-3" /><span>Add detail</span></button>
          )}
        </div>
        <label className="block space-y-1.5"><span className="font-semibold text-slate-300">Max shares per order</span>
          <input className={input + ' font-mono'} inputMode="numeric" value={maxQty} onChange={(e) => setMaxQty(e.target.value.replace(/\D/g, ''))} /></label>
        {!setup && (
          <label className="block space-y-1.5"><span className="font-semibold text-slate-300">Reason (required during the event)</span>
            <input className={input + ' text-xs'} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. CEO name received late" /></label>
        )}
        <ErrorNote text={error} />
        <div className="flex justify-end space-x-3 pt-2">
          <button type="button" onClick={onClose} className={btn.ghost}>Cancel</button>
          <button type="submit" disabled={busy || !ok} className={btn.primary}>
            {busy ? <Spinner className="w-3.5 h-3.5" /> : <CheckCircle className="w-3.5 h-3.5" />}<span>Save{changes ? ` (${changes})` : ''}</span>
          </button>
        </div>
      </form>
    </Modal>
  );
};
