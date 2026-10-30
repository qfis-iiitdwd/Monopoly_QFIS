import React from 'react';
import { clockSeconds } from '../shared/format';
import { btn, EmptyRow, Modal } from '../shared/ui';
import { AUDIT_BADGE, describeAudit } from './actions';
import { AuditRow } from './types';

export const AuditTable: React.FC<{ rows: AuditRow[]; empty?: string }> = ({ rows, empty = 'No activity yet.' }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-left border-collapse monopoly-table">
      <thead>
        <tr className="text-xs font-semibold text-slate-400 border-b border-[#1b2233]">
          <th className="py-3 px-5">Time</th>
          <th className="py-3 px-3">Type</th>
          <th className="py-3 px-4">Details</th>
          <th className="py-3 px-5 text-right">By</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#171e2c] text-sm">
        {rows.length === 0 && <EmptyRow cols={4} text={empty} />}
        {rows.map((a) => {
          const d = describeAudit(a);
          return (
            <tr key={a.id} className="hover:bg-[#151c2a] transition-colors">
              <td className="py-3 px-5 text-slate-400 text-xs font-mono whitespace-nowrap">{clockSeconds(a.created_at)}</td>
              <td className="py-3 px-3">
                <span className={`px-2 py-0.5 text-[10px] font-bold rounded border whitespace-nowrap ${AUDIT_BADGE[d.type]}`}>{d.type}</span>
              </td>
              <td className="py-3 px-4 text-xs font-medium text-slate-200">{d.text}</td>
              <td className="py-3 px-5 text-xs text-slate-400 text-right whitespace-nowrap">{a.username || 'server'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

export const AuditModal: React.FC<{ rows: AuditRow[]; title?: string; onClose: () => void }> = ({ rows, title = 'Organiser activity log', onClose }) => (
  <Modal wide title={title} subtitle={`${rows.length} entries, newest first. Every admin action is recorded here with its reason.`} onClose={onClose}
    footer={<button onClick={onClose} className={btn.outline + ' px-5'}>Close</button>}>
    <div className="-mx-6 -my-6"><AuditTable rows={rows} /></div>
  </Modal>
);
