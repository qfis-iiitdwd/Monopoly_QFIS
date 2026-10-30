(function () {
  const { api, esc, inr, inrShort, pct, tone, int } = MV;
  const $ = (s) => document.querySelector(s);
  const view = $('#view');

  const S = {
    me: null,
    status: null,
    portfolio: null,
    companies: null,
    filter: 'All',
    lastPhaseKey: '',
    route: '',
    trade: null, // { companyId, side, qty }
    offline: false,
  };

  // ---------------------------------------------------------------- boot & login
  async function boot() {
    try {
      S.me = await api('/api/me');
      start();
    } catch (e) {
      if (e.status === 401) showLogin();
      else setTimeout(boot, 2000);
    }
  }

  function showLogin() {
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    try { $('#l-name').value = localStorage.getItem('mv_member') || ''; } catch (e) { /* storage blocked */ }
  }

  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('button');
    btn.disabled = true;
    $('#login-error').classList.add('hidden');
    try {
      const name = $('#l-name').value.trim();
      try { localStorage.setItem('mv_member', name); } catch (e) { /* ignore */ }
      await api('/api/auth/login', { body: { team_id: $('#l-team').value.trim(), password: $('#l-pass').value, member_name: name } });
      S.me = await api('/api/me');
      $('#login').classList.add('hidden');
      start();
    } catch (e) {
      $('#login-error').textContent = e.message;
      $('#login-error').classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });

  let started = false;
  function start() {
    $('#app').classList.remove('hidden');
    $('#team-name').textContent = S.me.team.name + (S.me.member_name ? ` · ${S.me.member_name}` : '');
    if (started) { route(); return; }
    started = true;
    window.addEventListener('hashchange', route);
    pollStatus();
    setInterval(pollStatus, 2000);
    setInterval(tick, 250);
    setInterval(() => { if (!document.hidden) refreshData(); }, 6000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollStatus(); refreshData(); } });
    if (!location.hash) location.hash = '#/home';
    route();
  }

  // ---------------------------------------------------------------- polling
  async function pollStatus() {
    try {
      const st = await api('/api/market/status');
      MV.syncClock(st.server_time);
      setOffline(false);
      const key = `${st.current_round}|${st.phase}|${st.paused}`;
      const changed = key !== S.lastPhaseKey;
      S.status = st;
      S.lastPhaseKey = key;
      renderTop();
      if (changed) refreshData(true);
    } catch (e) {
      if (e.status === 401) return showLogin();
      setOffline(true);
    }
  }

  async function refreshData(rerender) {
    try {
      const [p, c] = await Promise.all([api('/api/portfolio'), api('/api/companies')]);
      S.portfolio = p;
      S.companies = c;
      setOffline(false);
      // Don't yank the form out from under someone typing a quantity.
      const typing = document.activeElement && document.activeElement.tagName === 'INPUT';
      if (rerender || !typing) route(true);
    } catch (e) {
      if (e.status === 401) return showLogin();
      setOffline(true);
    }
  }

  function setOffline(off) {
    S.offline = off;
    $('#offline-banner').classList.toggle('hidden', !off);
  }

  // ---------------------------------------------------------------- top bar
  function renderTop() {
    const st = S.status;
    const ph = MV.phaseLabel(st);
    const chip = $('#phase-chip');
    chip.className = 'chip ' + ph.tone;
    chip.lastElementChild.textContent = ph.text;
    let label = st.current_round ? `Round ${st.current_round} of ${st.total_rounds}` : `${st.total_rounds} rounds`;
    if (st.phase === 'settled' && st.next_round) label += ` · Round ${st.next_round.id} next`;
    $('#round-label').textContent = label;
    const banner = $('#global-banner');
    const msg = st.paused ? `Trading is paused by the organisers.${st.message ? ' ' + st.message : ''}` : st.message;
    banner.textContent = msg || '';
    banner.classList.toggle('hidden', !msg);
    tick();
  }

  function tick() {
    const st = S.status;
    const el = $('#countdown');
    if (!st || st.phase !== 'trading' || !st.round || st.paused) { el.textContent = ''; return; }
    const c = MV.countdown(st.round.trading_deadline);
    el.textContent = c.text;
    el.classList.toggle('urgent', c.seconds <= 30);
  }

  const tradingOpen = () => S.status && S.status.phase === 'trading' && !S.status.paused &&
    MV.countdown(S.status.round.trading_deadline).seconds > 0;

  // ---------------------------------------------------------------- router
  function route(soft) {
    const hash = location.hash || '#/home';
    const [, name, arg] = hash.split('/');
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (name === 'company' ? 'market' : name)));
    if (!soft || hash !== S.route) window.scrollTo(0, 0);
    if (hash !== S.route) S.trade = null;
    S.route = hash;
    const views = { home: renderHome, market: renderMarket, company: () => renderCompany(Number(arg)), news: renderNews, history: renderHistory, ranks: renderRanks, loans: renderLoans };
    (views[name] || renderHome)();
  }

  function loading() {
    if (!view.innerHTML.trim()) view.innerHTML = '<p class="muted">Loading…</p>';
  }

  // ---------------------------------------------------------------- views
  function renderHome() {
    const p = S.portfolio;
    const st = S.status;
    if (!p || !st) return loading();
    const holdings = p.holdings.map((h) => `
      <li><a href="#/company/${h.company_id}">
        <div><div class="t">${esc(h.ticker)}</div><div class="sub">${int(h.quantity)} shares${h.pledged_quantity ? ` · ${int(h.pledged_quantity)} pledged` : ''}</div></div>
        <div class="pr"><div class="num">${inrShort(h.value)}</div><div class="sub num ${tone(h.unrealized_pnl)}">${MV.signedInr(h.unrealized_pnl)}</div></div>
      </a></li>`).join('');
    const loanWarn = p.loan_due_round && st.current_round >= p.loan_due_round - 1
      ? `<div class="banner down">Loan due by the end of Round ${p.loan_due_round}. Unpaid loans are settled by selling pledged shares.</div>` : '';
    view.innerHTML = `
      <div class="stack">
        ${phaseHelp()}
        ${loanWarn}
        <section class="card hero">
          <div class="label">Net worth</div>
          <div class="big num">${inr(p.net_worth)}</div>
          <div class="num ${tone(p.total_pnl)}">${MV.signedInr(p.total_pnl)} since start (${pct(Math.round((p.total_pnl * 10000) / st.starting_cash))})</div>
        </section>
        <section class="card kv">
          <div><div class="k">Available cash</div><div class="v num">${inr(p.cash)}</div></div>
          <div><div class="k">Shares value</div><div class="v num">${inr(p.holdings_value)}</div></div>
          ${st.loans_enabled || p.debt ? `
          <div><div class="k">Loan principal</div><div class="v num">${inr(p.loan_principal)}</div></div>
          <div><div class="k">Interest accrued</div><div class="v num">${inr(p.loan_interest)}</div></div>` : ''}
          <div><div class="k">Trades this round</div><div class="v num">${p.trades_this_round}${st.max_trades_per_round ? ` / ${st.max_trades_per_round}` : ''}</div></div>
          <div><div class="k">Realised P/L</div><div class="v num ${tone(p.realized_pnl)}">${MV.signedInr(p.realized_pnl)}</div></div>
        </section>
        <section class="card">
          <div class="spread"><h2>Holdings</h2><a href="#/market" class="small">Browse market →</a></div>
          ${holdings ? `<ul class="list">${holdings}</ul>` : '<p class="muted">No shares yet. Holding cash is a valid strategy — or open the Market tab to buy.</p>'}
        </section>
        ${st.loans_enabled ? '<a class="btn" style="display:block;text-align:center;text-decoration:none" href="#/loans">Margin Bank →</a>' : ''}
        <button class="ghost small" id="logout">Log out of this device</button>
      </div>`;
    $('#logout').onclick = async () => {
      if (!confirm('Log out on this device? Your team portfolio is not affected.')) return;
      await api('/api/auth/logout', { body: {} }).catch(() => {});
      location.reload();
    };
  }

  function phaseHelp() {
    const st = S.status;
    const msgs = {
      setup: ['info', 'The market has not opened yet. Company profiles are in the Market tab — study them.'],
      awaiting_open: ['info', 'Waiting for the organisers to open the next round.'],
      trading: ['up', `Round ${st.current_round} trading is open. Orders execute instantly at this round's price.`],
      closed: ['warn', 'Trading is closed. Watch the screen for the news segment.'],
      news: ['warn', 'Breaking news on the big screen! New prices are coming.'],
      settled: ['info', `Round ${st.current_round} prices are in.${st.next_round ? ` Round ${st.next_round.id} opens soon.` : ''}`],
      finished: ['info', 'The game is over. See the final rankings in the Ranks tab.'],
    };
    const m = msgs[st.phase];
    if (!m || st.paused) return '';
    return `<div class="banner ${m[0]}">${esc(m[1])}</div>`;
  }

  function renderMarket() {
    const cs = S.companies;
    if (!cs) return loading();
    const industries = ['All', 'Mine', ...Array.from(new Set(cs.map((c) => c.industry))).sort()];
    const shown = cs.filter((c) => S.filter === 'All' || (S.filter === 'Mine' ? c.held > 0 : c.industry === S.filter));
    view.innerHTML = `
      <div class="stack">
        ${phaseHelp()}
        <div class="filters">${industries.map((i) => `<button class="${i === S.filter ? 'on' : ''}" data-f="${esc(i)}">${esc(i)}</button>`).join('')}</div>
        <section class="card">
          <ul class="list">
            ${shown.map((c) => `
              <li><a href="#/company/${c.id}">
                <div><div class="t">${esc(c.ticker)} ${c.is_tradable ? '' : '<span class="chip warn">Suspended</span>'}</div>
                  <div class="sub">${esc(c.name)} · ${esc(c.industry)}${c.held ? ` · <b>you own ${int(c.held)}</b>` : ''}</div></div>
                <div class="pr"><div class="num">${inr(c.price)}</div><div class="sub num ${tone(c.change_bps)}">${pct(c.change_bps)}</div></div>
              </a></li>`).join('') || '<li class="item muted">Nothing here.</li>'}
          </ul>
        </section>
      </div>`;
    view.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { S.filter = b.dataset.f; renderMarket(); }));
  }

  let companyCache = {};
  async function renderCompany(id) {
    const c = S.companies && S.companies.find((x) => x.id === id);
    if (!c) return loading();
    if (!S.trade || S.trade.companyId !== id) S.trade = { companyId: id, side: 'buy', qty: '' };
    paintCompany(c, companyCache[id]);
    try {
      const detail = await api(`/api/companies/${id}`);
      companyCache[id] = detail;
      if (S.route === `#/company/${id}`) {
        const typing = document.activeElement && document.activeElement.id === 'qty';
        if (!typing) paintCompany(c, detail);
      }
    } catch (e) { /* keep last good */ }
  }

  function paintCompany(c, d) {
    const p = S.portfolio;
    const holding = d ? d.holding : { quantity: c.held, pledged_quantity: c.pledged };
    const free = holding.quantity - holding.pledged_quantity;
    const canTrade = tradingOpen() && c.is_tradable;
    let restriction = '';
    if (!c.is_tradable) restriction = `Trading in ${c.ticker} is suspended${c.suspension_reason ? ': ' + c.suspension_reason : ''}.`;
    else if (!tradingOpen()) restriction = 'Orders can be placed only while a round\'s trading window is open.';

    view.innerHTML = `
      <div class="stack">
        <a href="#/market" class="small">← Market</a>
        <section class="card">
          <div class="spread"><div><h1 class="mono">${esc(c.ticker)}</h1><div>${esc(c.name)}</div></div>
            <div class="pr" style="text-align:right"><div class="num" style="font-size:1.4rem;font-weight:700">${inr(c.price)}</div>
            <div class="num ${tone(c.change_bps)}">${pct(c.change_bps)} <span class="muted small">vs ${inr(c.prev_price)}</span></div></div></div>
          <p class="muted small">${esc(c.industry)}</p>
          <p>${esc(c.description)}</p>
          ${d ? MV.sparkline(d.history) : ''}
          <div class="kv small" style="margin-top:10px">
            <div><div class="k">On exchange</div><div class="v num">${int(c.exchange_inventory)} shares</div></div>
            <div><div class="k">Max per order</div><div class="v num">${int(c.max_order_quantity)} shares</div></div>
            <div><div class="k">You own</div><div class="v num">${int(holding.quantity)}${holding.pledged_quantity ? ` (${int(holding.pledged_quantity)} pledged)` : ''}</div></div>
            <div><div class="k">Your cash</div><div class="v num">${p ? inrShort(p.cash) : '—'}</div></div>
          </div>
        </section>
        <section class="card stack" id="trade-card">
          <h2>Trade</h2>
          ${restriction ? `<div class="banner info small">${esc(restriction)}</div>` : ''}
          <div class="seg"><button data-side="buy" class="buy ${S.trade.side === 'buy' ? 'on' : ''}">Buy</button><button data-side="sell" class="sell ${S.trade.side === 'sell' ? 'on' : ''}">Sell</button></div>
          <div class="qty"><button data-step="-1" aria-label="Decrease">−</button><input id="qty" inputmode="numeric" pattern="[0-9]*" placeholder="Quantity" value="${esc(S.trade.qty)}"><button data-step="1" aria-label="Increase">+</button></div>
          <div class="quick" id="quick"></div>
          <div class="est" id="est"></div>
          <button id="review" class="${S.trade.side}" ${canTrade ? '' : 'disabled'}>Review ${S.trade.side} order</button>
          <p class="muted small">Holding is the default — you never need to submit a "hold".</p>
        </section>
        ${d && d.news.length ? `<section class="card"><h2>Related news</h2>${d.news.map(newsItem).join('')}</section>` : ''}
        ${d && d.trades.length ? `<section class="card"><h2>Your ${esc(c.ticker)} trades</h2><div class="table-wrap"><table>
          <tr><th>Rnd</th><th>Side</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Cash</th></tr>
          ${d.trades.map((t) => `<tr><td>${t.round_id}</td><td class="${t.side === 'buy' ? 'up' : 'down'}">${t.source === 'liquidation' ? 'Bank sale' : t.source === 'reversal' ? `${t.side} (correction)` : t.side}</td><td class="r num">${int(t.quantity)}</td><td class="r num">${inr(t.execution_price)}</td><td class="r num">${inrShort(t.cash_delta)}</td></tr>`).join('')}
        </table></div></section>` : ''}
      </div>`;

    const qtyEl = $('#qty');
    const fee = (gross) => Math.ceil((gross * S.status.fee_bps) / 10000);
    const maxBuy = () => {
      if (!p) return 0;
      let q = Math.floor(p.cash / (c.price * (1 + S.status.fee_bps / 10000)));
      while (q > 0 && q * c.price + fee(q * c.price) > p.cash) q--;
      return Math.max(0, Math.min(q, c.max_order_quantity, c.exchange_inventory));
    };
    const maxSell = () => Math.min(free, c.max_order_quantity);
    const update = () => {
      S.trade.qty = qtyEl.value.replace(/[^0-9]/g, '');
      if (qtyEl.value !== S.trade.qty) qtyEl.value = S.trade.qty;
      const q = Number(S.trade.qty) || 0;
      const gross = q * c.price;
      const f = fee(gross);
      const total = S.trade.side === 'buy' ? gross + f : gross - f;
      const after = p ? (S.trade.side === 'buy' ? p.cash - total : p.cash + total) : null;
      let warn = '';
      if (q > c.max_order_quantity) warn = `Max ${int(c.max_order_quantity)} shares per order.`;
      else if (S.trade.side === 'buy' && after < 0) warn = 'Not enough cash.';
      else if (S.trade.side === 'buy' && q > c.exchange_inventory) warn = 'Not enough shares on the exchange.';
      else if (S.trade.side === 'sell' && q > free) warn = `You can sell at most ${int(free)}.`;
      $('#est').innerHTML = `
        <div class="spread small"><span class="muted">Estimated ${S.trade.side === 'buy' ? 'cost' : 'proceeds'}</span><span class="num">${inr(gross)}</span></div>
        <div class="spread small"><span class="muted">Fee (${(S.status.fee_bps / 100).toFixed(2)}%)</span><span class="num">${inr(f)}</span></div>
        <div class="spread"><b>${S.trade.side === 'buy' ? 'Total to pay' : 'You receive'}</b><b class="num">${inr(total)}</b></div>
        <div class="spread small"><span class="muted">Cash after</span><span class="num ${after < 0 ? 'down' : ''}">${after == null ? '—' : inr(after)}</span></div>
        ${warn ? `<div class="down small" style="margin-top:6px">${warn}</div>` : ''}`;
      $('#review').disabled = !canTrade || q <= 0 || !!warn;
    };
    const quick = S.trade.side === 'buy'
      ? [10, 100, 1000].map((n) => [`${n}`, n]).concat([['Max', maxBuy()]])
      : [['¼', Math.floor(free / 4)], ['½', Math.floor(free / 2)], ['All', maxSell()]];
    $('#quick').innerHTML = quick.map(([l, v]) => `<button data-q="${v}">${l}</button>`).join('');
    $('#quick').querySelectorAll('button').forEach((b) => (b.onclick = () => { qtyEl.value = b.dataset.q; update(); }));
    qtyEl.oninput = update;
    view.querySelectorAll('[data-step]').forEach((b) => (b.onclick = () => {
      qtyEl.value = Math.max(0, (Number(qtyEl.value) || 0) + Number(b.dataset.step));
      update();
    }));
    view.querySelectorAll('[data-side]').forEach((b) => (b.onclick = () => { S.trade.side = b.dataset.side; paintCompany(c, d); }));
    $('#review').onclick = () => openConfirm(c, Number(S.trade.qty), S.trade.side);
    update();
  }

  // ---------------------------------------------------------------- order confirmation
  function openSheet(html) {
    $('#sheet').innerHTML = html;
    $('#sheet').classList.remove('hidden');
    $('#sheet-backdrop').classList.remove('hidden');
  }
  function closeSheet() {
    $('#sheet').classList.add('hidden');
    $('#sheet-backdrop').classList.add('hidden');
  }
  $('#sheet-backdrop').onclick = () => { if (!$('#sheet').dataset.busy) closeSheet(); };

  function openConfirm(c, qty, side) {
    const key = MV.key(); // one key per confirmation: retries of this order can never double-execute
    const gross = qty * c.price;
    const fee = Math.ceil((gross * S.status.fee_bps) / 10000);
    const total = side === 'buy' ? gross + fee : gross - fee;
    openSheet(`
      <div class="stack">
        <h2>Confirm ${side === 'buy' ? 'purchase' : 'sale'}</h2>
        <div class="est">
          <div class="spread"><span class="muted">Company</span><b>${esc(c.ticker)} · ${esc(c.name)}</b></div>
          <div class="spread"><span class="muted">Action</span><b class="${side === 'buy' ? 'up' : 'down'}">${side.toUpperCase()}</b></div>
          <div class="spread"><span class="muted">Quantity</span><b class="num">${int(qty)} shares</b></div>
          <div class="spread"><span class="muted">Price</span><b class="num">${inr(c.price)}</b></div>
          <div class="spread"><span class="muted">Fee</span><span class="num">${inr(fee)}</span></div>
          <div class="spread"><span class="muted">${side === 'buy' ? 'Total cost' : 'Net proceeds'}</span><b class="num">${inr(total)}</b></div>
          <div class="spread"><span class="muted">Cash after (est.)</span><span class="num">${inr(side === 'buy' ? S.portfolio.cash - total : S.portfolio.cash + total)}</span></div>
        </div>
        <div id="order-state"></div>
        <div class="grid2"><button id="c-cancel">Cancel</button><button id="c-submit" class="${side}">Submit order</button></div>
      </div>`);
    $('#c-cancel').onclick = closeSheet;
    $('#c-submit').onclick = () => submitOrder({ company_id: c.id, side, quantity: qty, idempotency_key: key });
  }

  async function submitOrder(body) {
    const sheet = $('#sheet');
    sheet.dataset.busy = '1';
    $('#c-submit').disabled = true;
    $('#c-cancel').disabled = true;
    const state = $('#order-state');
    state.innerHTML = '<div class="banner info status-pill">Pending — sending to the exchange…</div>';
    let result = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 4 && !result; attempt++) {
      try {
        result = await api('/api/orders', { body, allow: [422] });
      } catch (e) {
        lastErr = e;
        if (!e.network && !(e.status >= 500)) break;
        state.innerHTML = `<div class="banner warn">Network hiccup — retrying the same order safely (${attempt + 1}/3)…</div>`;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    delete sheet.dataset.busy;
    if (result && result.order.status === 'executed') {
      const o = result.order;
      state.innerHTML = `<div class="banner up"><div class="status-pill">Executed ✓</div>
        <div class="small">${o.side.toUpperCase()} ${int(o.quantity)} @ ${inr(o.execution_price)} · cash now ${inr(o.cash_after)}</div>
        <div class="small muted">Order #${o.id}${result.duplicate ? ' (already received — not executed twice)' : ''}</div></div>`;
      S.trade.qty = '';
    } else if (result) {
      state.innerHTML = `<div class="banner down"><div class="status-pill">Rejected</div><div class="small">${esc(result.order.rejection_reason)}</div></div>`;
    } else {
      state.innerHTML = `<div class="banner down"><div class="status-pill">Status unknown</div>
        <div class="small">${esc(lastErr ? lastErr.message : 'No response')}. Check the History tab before trying again — the order may have gone through.</div></div>`;
    }
    $('#c-submit').classList.add('hidden');
    $('#c-cancel').disabled = false;
    $('#c-cancel').textContent = 'Done';
    $('#c-cancel').onclick = () => { closeSheet(); refreshData(true); };
    refreshData(false);
  }

  // ---------------------------------------------------------------- other views
  function newsItem(b) {
    return `<div class="news-item"><div class="muted small">Round ${b.round_id}${b.affected ? ' · ' + esc(b.affected) : ''}</div>
      <b>${esc(b.title)}</b>${b.content ? `<div class="small">${esc(b.content)}</div>` : ''}</div>`;
  }

  async function renderNews() {
    loading();
    try {
      const n = await api('/api/news/current');
      if (!S.route.startsWith('#/news')) return;
      view.innerHTML = `
        <div class="stack">
          <section class="card"><h2>Newspapers</h2>
            ${n.papers.length ? `<ul class="list">${n.papers.map((p) => `<li>${p.has_pdf
              ? `<a href="/api/paper/${p.round_id}" target="_blank" rel="noopener"><div><div class="t">Round ${p.round_id}</div><div class="sub">${esc(p.title)}</div></div><span>Open PDF →</span></a>`
              : `<div class="item"><div><div class="t">Round ${p.round_id}</div><div class="sub">${esc(p.title)}</div></div><span class="muted small">Printed copy</span></div>`}</li>`).join('')}</ul>`
              : '<p class="muted">The first newspaper is released when Round 1 opens.</p>'}
          </section>
          <section class="card"><h2>Market news segments</h2>
            ${n.bulletins.length ? n.bulletins.map(newsItem).join('') : '<p class="muted">Announced after each round\'s trading closes.</p>'}
          </section>
        </div>`;
    } catch (e) { view.innerHTML = `<div class="banner down">${esc(e.message)}</div>`; }
  }

  async function renderHistory() {
    loading();
    try {
      const h = await api('/api/transactions');
      if (!S.route.startsWith('#/history')) return;
      view.innerHTML = `
        <div class="stack">
          <section class="card"><h2>Orders &amp; trades</h2>
            ${h.orders.length ? `<div class="table-wrap"><table>
              <tr><th>#</th><th>Rnd</th><th>Order</th><th class="r">Price</th><th class="r">Cash Δ</th></tr>
              ${h.orders.map((o) => `<tr>
                <td class="num small">${o.order_id || o.trade_id}<div class="muted">${MV.time(o.submitted_at)}</div></td>
                <td>${o.round_id || '—'}</td>
                <td><b class="${o.side === 'buy' ? 'up' : 'down'}">${o.source === 'liquidation' ? 'BANK SALE' : o.source === 'reversal' ? `CORRECTION: ${esc(String(o.side).toUpperCase())}` : esc(String(o.side).toUpperCase())}</b> ${int(o.quantity)} ${esc(o.ticker || '')}
                  ${o.status === 'rejected' ? `<div class="down small">Rejected: ${esc(o.rejection_reason)}</div>` : ''}
                  ${o.reversed_reason ? `<div class="down small">Reversed by the organisers: ${esc(o.reversed_reason)}</div>` : ''}
                  ${o.placed_by && o.placed_by !== 'bank' && o.placed_by !== 'organisers' ? `<div class="muted small">by ${esc(o.placed_by)}</div>` : ''}</td>
                <td class="r num">${o.execution_price ? inr(o.execution_price) : '—'}${o.fee ? `<div class="muted small">fee ${inr(o.fee)}</div>` : ''}</td>
                <td class="r num">${o.cash_delta != null ? inrShort(o.cash_delta) : '—'}${o.cash_after != null ? `<div class="muted small">bal ${inrShort(o.cash_after)}</div>` : ''}</td>
              </tr>`).join('')}</table></div>` : '<p class="muted">No orders yet.</p>'}
          </section>
          ${h.other_cash_movements.length ? `<section class="card"><h2>Other cash movements</h2><div class="table-wrap"><table>
            <tr><th>Type</th><th class="r">Amount</th><th class="r">Balance</th></tr>
            ${h.other_cash_movements.map((l) => `<tr><td>${esc(l.transaction_type.replace(/_/g, ' '))}<div class="muted small">${esc(l.memo || '')}</div></td>
              <td class="r num ${tone(l.amount)}">${inrShort(l.amount)}</td><td class="r num">${inrShort(l.balance_after)}</td></tr>`).join('')}
          </table></div></section>` : ''}
        </div>`;
    } catch (e) { view.innerHTML = `<div class="banner down">${esc(e.message)}</div>`; }
  }

  async function renderRanks() {
    loading();
    try {
      const lb = await api('/api/leaderboard');
      if (!S.route.startsWith('#/ranks')) return;
      const myId = S.me.team.id;
      view.innerHTML = `
        <div class="stack">
          ${lb.mine ? `<section class="card hero"><div class="label">${lb.final ? 'Final rank' : 'Your rank'}</div>
            <div class="big">#${lb.mine.rank} <span class="muted" style="font-size:1rem">of ${lb.rows.length}</span></div>
            <div class="num">${inr(lb.mine.net_worth)} · <span class="${tone(lb.mine.total_pnl)}">${MV.signedInr(lb.mine.total_pnl)}</span></div></section>` : ''}
          <section class="card"><div class="spread"><h2>Leaderboard</h2><span class="muted small">${lb.final ? 'Final — frozen' : lb.round_id ? `After Round ${lb.round_id}` : 'Starting positions'}</span></div>
            <p class="muted small">Updated at the end of each round.</p>
            <div class="table-wrap"><table>
              <tr><th>#</th><th>Team</th><th class="r">Net worth</th><th class="r">P/L</th></tr>
              ${lb.rows.map((r) => `<tr class="${r.team_id === myId ? 'me-row' : ''}"><td>${r.rank}${r.tied ? '=' : ''}</td><td>${esc(r.name)}</td>
                <td class="r num">${inrShort(r.net_worth)}</td><td class="r num ${tone(r.total_pnl)}">${MV.signedInr(r.total_pnl)}</td></tr>`).join('')}
            </table></div></section>
        </div>`;
    } catch (e) { view.innerHTML = `<div class="banner down">${esc(e.message)}</div>`; }
  }

  async function renderLoans() {
    loading();
    let L;
    try { L = await api('/api/loans'); } catch (e) { view.innerHTML = `<div class="banner down">${esc(e.message)}</div>`; return; }
    if (!S.route.startsWith('#/loans')) return;
    const r = L.rules;
    const canBorrow = L.enabled && tradingOpen() && L.current_round <= r.last_borrow_round;
    view.innerHTML = `
      <div class="stack">
        <a href="#/home" class="small">← Portfolio</a>
        <section class="card"><h2>Margin Bank</h2>
          ${L.enabled ? '' : '<div class="banner info">The bank is closed for this event.</div>'}
          <ul class="small muted" style="padding-left:18px;margin:6px 0">
            <li>Borrow up to ${(r.ltv_bps / 100).toFixed(0)}% of the value of shares you pledge; max ${inrShort(r.max_loan_per_team)} per team.</li>
            <li>Interest: ${(r.interest_bps_per_round / 100).toFixed(2)}% of principal per round, simple.</li>
            <li>New loans only during trading, until Round ${r.last_borrow_round}. Repay in full by Round ${r.due_round}.</li>
            <li>Unpaid loans are settled at Round ${r.due_round}'s update by selling pledged shares at the official price.</li>
            <li>Pledged shares still count in your net worth but cannot be sold.</li>
          </ul>
          <div class="kv">
            <div><div class="k">Collateral value</div><div class="v num">${inr(L.collateral_value)}</div></div>
            <div><div class="k">Principal</div><div class="v num">${inr(L.outstanding_principal)}</div></div>
            <div><div class="k">Interest accrued</div><div class="v num">${inr(L.interest_accrued)}</div></div>
            <div><div class="k">Can still borrow</div><div class="v num">${inr(L.available_to_borrow)}</div></div>
          </div>
        </section>
        ${canBorrow ? `<section class="card stack"><h2>New loan</h2>
          ${L.holdings.filter((h) => h.loan_eligible && h.free_quantity > 0).map((h) => `
            <div class="spread"><div><b class="mono">${esc(h.ticker)}</b> <span class="muted small">${int(h.free_quantity)} free @ ${inr(h.price)}</span></div>
            <input style="max-width:120px" inputmode="numeric" data-pledge="${h.company_id}" data-price="${h.price}" data-max="${h.free_quantity}" placeholder="0"></div>`).join('') || '<p class="muted">You have no unpledged eligible shares.</p>'}
          <div class="est small" id="pledge-est">Pledge shares to see your borrowing limit.</div>
          <div><label for="loan-amt">Amount to borrow (₹)</label><input id="loan-amt" inputmode="numeric"></div>
          <div id="loan-msg"></div>
          <button class="primary" id="loan-go">Review loan</button></section>` : ''}
        <section class="card"><h2>Your loans</h2>
          ${L.loans.length ? L.loans.map((l) => `<div class="news-item">
            <div class="spread"><b>Loan #${l.id}</b><span class="chip ${l.status === 'active' ? 'warn' : ''}">${esc(l.status)}</span></div>
            <div class="small">Principal ${inr(l.principal)} · interest ${inr(l.interest_due)} · due Round ${l.due_round}</div>
            <div class="small muted">Collateral: ${l.collateral.map((c) => `${int(c.quantity)} ${esc(c.ticker)}`).join(', ')}</div>
            ${l.closing_note ? `<div class="small muted">${esc(l.closing_note)}</div>` : ''}
            ${l.status === 'active' ? `<button class="small" data-repay="${l.id}" data-due="${l.principal + l.interest_due}">Repay ${inr(l.principal + l.interest_due)}</button>` : ''}
          </div>`).join('') : '<p class="muted">No loans.</p>'}
        </section>
      </div>`;

    const pledged = () => Array.from(view.querySelectorAll('[data-pledge]')).map((i) => ({
      company_id: Number(i.dataset.pledge), quantity: Number(i.value) || 0, price: Number(i.dataset.price), max: Number(i.dataset.max) })).filter((x) => x.quantity > 0);
    view.querySelectorAll('[data-pledge]').forEach((i) => (i.oninput = () => {
      const p = pledged();
      const value = p.reduce((a, x) => a + x.quantity * x.price, 0);
      const limit = Math.min(Math.floor((value * r.ltv_bps) / 10000), r.max_loan_per_team - L.outstanding_principal);
      $('#pledge-est').innerHTML = `Pledged value <b class="num">${inr(value)}</b> → borrow up to <b class="num">${inr(Math.max(0, limit))}</b> (estimate; the bank confirms)`;
    }));
    const go = $('#loan-go');
    if (go) {
      const reqKey = MV.key();
      go.onclick = async () => {
        const amount = Math.round(Number($('#loan-amt').value) * 100);
        const collateral = pledged().map(({ company_id, quantity }) => ({ company_id, quantity }));
        if (!(amount > 0) || !collateral.length) { $('#loan-msg').innerHTML = '<div class="banner down small">Enter an amount and pledge at least one holding.</div>'; return; }
        if (!confirm(`Borrow ${inr(amount)} against ${collateral.length} holding(s)? Interest ${(r.interest_bps_per_round / 100).toFixed(2)}%/round. Due by Round ${r.due_round}.`)) return;
        go.disabled = true;
        try {
          await api('/api/loans', { body: { amount, collateral, request_key: reqKey } });
          refreshData(false);
          renderLoans();
        } catch (e) {
          $('#loan-msg').innerHTML = `<div class="banner down small">${esc(e.message)}</div>`;
          go.disabled = false;
        }
      };
    }
    view.querySelectorAll('[data-repay]').forEach((b) => (b.onclick = async () => {
      if (!confirm(`Repay ${inr(Number(b.dataset.due))} now and release the collateral?`)) return;
      b.disabled = true;
      try { await api(`/api/loans/${b.dataset.repay}/repay`, { body: {} }); refreshData(false); renderLoans(); } catch (e) { alert(e.message); b.disabled = false; }
    }));
  }

  boot();
})();
