import React, { useState } from 'react';
import { CheckCircle } from 'lucide-react';
import { errorMessage } from '../shared/api';
import { btn, ErrorNote, input, Modal, Spinner, useToast } from '../shared/ui';

export interface ActionValues {
  reason: string;
  seconds: number;
  checked: boolean;
}

export interface ActionSpec {
  title: string;
  subtitle?: string;
  body?: React.ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'green';
  /** 'required' = server needs ≥ 5 characters. */
  reason?: 'required' | 'optional';
  reasonPlaceholder?: string;
  seconds?: { label: string; initial: number };
  checkbox?: { label: string; initial: boolean };
  /** Runs the API call. The returned text is shown as the success toast. */
  run: (v: ActionValues) => Promise<string | void>;
  /** Shown instead of closing, e.g. a new password that is only returned once. */
  keepOpenWith?: (result: string) => React.ReactNode;
}

/**
 * Confirmation for every admin write: collects what the server needs (reason, seconds), sends it,
 * and only reports success when the server said so. Server refusals are shown verbatim.
 */
export const ActionDialog: React.FC<{ spec: ActionSpec; onClose: () => void; onDone: () => void }> = ({ spec, onClose, onDone }) => {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [seconds, setSeconds] = useState(String(spec.seconds?.initial ?? 60));
  const [checked, setChecked] = useState(spec.checkbox?.initial ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kept, setKept] = useState<React.ReactNode>(null);

  const reasonOk = spec.reason !== 'required' || reason.trim().length >= 5;
  const secondsOk = !spec.seconds || (/^\d+$/.test(seconds) && Number(seconds) >= 1 && Number(seconds) <= 3600);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const msg = await spec.run({ reason: reason.trim(), seconds: Number(seconds), checked });
      onDone();
      if (spec.keepOpenWith && typeof msg === 'string') {
        setKept(spec.keepOpenWith(msg));
      } else {
        if (msg) toast(msg);
        onClose();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (kept) {
    return (
      <Modal title={spec.title} subtitle={spec.subtitle} onClose={onClose} footer={<button onClick={onClose} className={btn.primary}>Done</button>}>
        {kept}
      </Modal>
    );
  }

  return (
    <Modal title={spec.title} subtitle={spec.subtitle} onClose={busy ? () => {} : onClose}>
      <form onSubmit={submit} className="space-y-4 text-xs">
        {spec.body && <div className="text-sm text-slate-300 space-y-2">{spec.body}</div>}
        {spec.seconds && (
          <label className="block space-y-1.5">
            <span className="font-semibold text-slate-300">{spec.seconds.label}</span>
            <input className={input} inputMode="numeric" value={seconds} onChange={(e) => setSeconds(e.target.value.replace(/\D/g, ''))} />
          </label>
        )}
        {spec.checkbox && (
          <label className="flex items-center space-x-2 text-slate-300 cursor-pointer">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="accent-rose-500" />
            <span>{spec.checkbox.label}</span>
          </label>
        )}
        {spec.reason && (
          <label className="block space-y-1.5">
            <span className="font-semibold text-slate-300">Reason {spec.reason === 'required' ? '(required, kept in the audit log)' : '(optional)'}</span>
            <textarea rows={2} className={input + ' resize-none text-xs'} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={spec.reasonPlaceholder || 'Why is this being done?'} />
          </label>
        )}
        <ErrorNote text={error} />
        <div className="flex justify-end space-x-3 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className={btn.ghost}>Cancel</button>
          <button type="submit" disabled={busy || !reasonOk || !secondsOk} className={spec.tone === 'green' ? btn.green : btn.primary}>
            {busy ? <Spinner className="w-3.5 h-3.5" /> : <CheckCircle className="w-3.5 h-3.5" />}
            <span>{spec.confirmLabel}</span>
          </button>
        </div>
      </form>
    </Modal>
  );
};
