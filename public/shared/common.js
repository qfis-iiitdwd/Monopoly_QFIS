// Shared client helpers. The browser never computes authoritative balances: every number shown
// comes from the server; estimates are labelled as estimates.
(function () {
  const MV = {};

  // Server-clock offset so countdowns follow the server, not the phone.
  MV.clockOffset = 0;
  MV.syncClock = function (serverTime) {
    if (serverTime) MV.clockOffset = new Date(serverTime).getTime() - Date.now();
  };
  MV.now = () => Date.now() + MV.clockOffset;

  MV.api = async function (path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) {
      init.method = opts.method || 'POST';
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      const err = new Error('Network problem — check your connection');
      err.network = true;
      throw err;
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok && !(opts.allow || []).includes(res.status)) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  };

  MV.key = function () {
    if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  };

  // ₹ with Indian digit grouping. paise → "₹1,23,456.78"
  MV.inr = function (paise, { decimals = 2 } = {}) {
    if (paise == null || isNaN(paise)) return '—';
    const neg = paise < 0;
    const v = Math.abs(paise) / 100;
    const s = v.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return (neg ? '−₹' : '₹') + s;
  };
  // Compact: ₹1.02 Cr, ₹45.3 L, ₹12,345
  MV.inrShort = function (paise) {
    if (paise == null || isNaN(paise)) return '—';
    const neg = paise < 0;
    const r = Math.abs(paise) / 100;
    let s;
    if (r >= 1e7) s = (r / 1e7).toFixed(r >= 1e9 ? 1 : 2) + ' Cr';
    else if (r >= 1e5) s = (r / 1e5).toFixed(2) + ' L';
    else s = r.toLocaleString('en-IN', { maximumFractionDigits: r < 100 ? 2 : 0 });
    return (neg ? '−₹' : '₹') + s;
  };
  MV.signedInr = (p) => (p > 0 ? '+' : '') + MV.inrShort(p).replace('−', '−');
  MV.pct = function (bps) {
    if (bps == null) return '—';
    const v = bps / 100;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + '%';
  };
  MV.tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
  MV.int = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN'));

  MV.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };
  MV.time = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');

  MV.countdown = function (deadline) {
    if (!deadline) return null;
    const ms = new Date(deadline).getTime() - MV.now();
    const s = Math.max(0, Math.ceil(ms / 1000));
    return { seconds: s, text: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` };
  };

  MV.phaseLabel = function (st) {
    if (!st) return { text: 'Connecting…', tone: 'flat' };
    if (st.paused) return { text: 'Paused', tone: 'warn' };
    return ({
      setup: { text: 'Not started', tone: 'flat' },
      awaiting_open: { text: 'Waiting for round', tone: 'flat' },
      trading: { text: 'Trading open', tone: 'up' },
      closed: { text: 'Trading closed', tone: 'warn' },
      news: { text: 'Breaking news', tone: 'warn' },
      settled: { text: 'Market updated', tone: 'flat' },
      finished: { text: 'Final results', tone: 'flat' },
    })[st.phase] || { text: st.phase, tone: 'flat' };
  };

  // Tiny SVG sparkline from [{round, price}].
  MV.sparkline = function (points, { w = 280, h = 80 } = {}) {
    if (!points || points.length < 2) return '<div class="muted small">Price history appears after Round 1.</div>';
    const ys = points.map((p) => p.price);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = 6;
    const x = (i) => pad + (i * (w - 2 * pad)) / (points.length - 1);
    const y = (v) => (hi === lo ? h / 2 : pad + ((hi - v) * (h - 2 * pad)) / (hi - lo));
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
    const up = ys[ys.length - 1] >= ys[0];
    const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.price).toFixed(1)}" r="2.5"><title>R${p.round}: ${MV.inr(p.price)}</title></circle>`).join('');
    return `<svg class="spark ${up ? 'up' : 'down'}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Price history">
      <path d="${d}" fill="none" stroke-width="2" vector-effect="non-scaling-stroke"/>${dots}</svg>`;
  };

  window.MV = MV;
})();
