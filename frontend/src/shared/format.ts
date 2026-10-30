// Display formatting. The API sends integer paise and basis points; nothing here does money
// arithmetic beyond converting for display.

/** 1245600 -> "12,45,600" (Indian grouping). */
export function formatIndianNumber(value: number, decimals = 0): string {
  const negative = value < 0;
  const [intPart, decPart] = Math.abs(value).toFixed(decimals).split('.');
  const lastThree = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree : lastThree;
  return (negative ? '-' : '') + grouped + (decPart ? '.' + decPart : '');
}

/** Paise -> "₹ 12,45,600" (whole rupees) or with paise when `decimals` is 2. */
export function inr(paise: number, decimals = 0): string {
  const s = formatIndianNumber(Math.abs(paise) / 100, decimals);
  return paise < 0 ? `- ₹ ${s}` : `₹ ${s}`;
}

/** Paise -> "12,45,600.00" without the symbol, for table cells headed (₹). */
export function rupees(paise: number, decimals = 2): string {
  return formatIndianNumber(paise / 100, decimals);
}

/** Signed money: "+ ₹ 1,200" / "- ₹ 1,200". */
export function signedInr(paise: number, decimals = 0): string {
  return (paise > 0 ? '+ ' : '') + inr(paise, decimals);
}

/** Basis points -> "+3.10%". */
export function pct(bps: number): string {
  const v = (bps / 100).toFixed(2);
  return bps > 0 ? `+${v}%` : `${v}%`;
}

export function pctOf(part: number, whole: number): string {
  if (!whole) return '0.0%';
  return `${((part * 100) / whole).toFixed(1)}%`;
}

export const qty = (n: number) => formatIndianNumber(n);

export function clock(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function clockSeconds(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Rupee text typed by an admin -> paise. Returns null for anything that is not a plain amount. */
export function parseRupees(text: string): number | null {
  const t = text.replace(/[,₹\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export function csv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((r) => r.map((v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
    .join('\n');
}

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const blob = new Blob([csv(rows)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
