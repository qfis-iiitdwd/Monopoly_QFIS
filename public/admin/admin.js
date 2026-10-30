(function () {
  const { api, esc, inr, inrShort, pct, tone, int } = MV;
  const $ = (s) => document.querySelector(s);
  const main = $('#main');
  const A = { tab: 'control', ov: null, selectedTeam: null, updateRound: null, preview: null };

  function toast(msg, ms = 3500) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast.h);
    toast.h = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // Runs an admin action with confirmation, button locking and a visible result.
  async function act(btn, label, fn, confirmText) {
    if (confirmText && !confirm(confirmText)) return null;
    if (btn) btn.disabled = true;
    try {
      const r = await fn();
      toast(`${label}: done`);
      await refreshOverview();
      return r;
    } catch (e) {
      alert(`${label} failed:\n${e.message}`);
      return null;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- login
  async function boot() {
    try { await api('/api/admin/me'); start(); } catch (e) {
      if (e.status === 401) { $('#login').classList.remove('hidden'); $('#a-pass').focus(); } else setTimeout(boot, 2000);
    }
  }
  $('#login-form').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/admin/login', { body: { username: $('#a-user').value, password: $('#a-pass').value } });
      $('#login').classList.add('hidden');
      start();
    } catch (e) {
      $('#login-error').textContent = e.message;
      $('#login-error').classList.remove('hidden');
    }
  };

  function start() {
    $('#app').classList.remove('hidden');
    document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => {
      A.tab = b.dataset.tab;
      document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
      render();
    }));
    refreshOverview().then(render);
    setInterval(() => refreshOverview().then(() => { if (A.tab === 'control') renderControl(); }), 2000);
    setInterval(tick, 250);
  }

  async function refreshOverview() {
    try {
      A.ov = await api('/api/admin/overview');
      MV.syncClock(A.ov.server_time);
      const s = A.ov.state;
      const chip = $('#hdr-state');
      chip.textContent = `${s.status}${s.paused ? ' · PAUSED' : ''} · round ${s.current_round}`;
      chip.className = 'chip ' + (s.paused ? 'down' : s.status === 'running' ? 'up' : '');
    } catch (e) {
      if (e.status === 401) location.reload();
      $('#hdr-state').textContent = 'SERVER UNREACHABLE';
      $('#hdr-state').className = 'chip down';
    }
  }

  function tick() {
    $('#hdr-clock').textContent = 'server ' + new Date(MV.now()).toLocaleTimeString('en-IN');
    const el = $('#round-timer');
    if (!el || !A.ov) return;
    const r = A.ov.rounds.find((x) => x.id === A.ov.state.current_round);
    if (r && r.status === 'open') {
      const c = MV.countdown(r.trading_deadline);
      el.textContent = A.ov.state.paused ? `${c.text} (paused)` : c.text;
      el.className = 'timer ' + (c.seconds <= 30 ? 'down' : '');
    } else el.textContent = '';
  }

  function render() {
    ({ control: renderControl, update: renderUpdate, teams: renderTeams, companies: renderCompanies, orders: renderOrders,
      events: renderEvents, money: renderMoney, health: renderHealth })[A.tab]();
  }

  // ---------------------------------------------------------------- control
  function renderControl() {
    const ov = A.ov;
    if (!ov) return;
    const s = ov.state;
    const total = s.settings.total_rounds;
    const cur = ov.rounds.find((r) => r.id === s.current_round);
    const next = ov.rounds.find((r) => r.id === s.current_round + 1);
    const focus = document.activeElement && document.activeElement.id;
    const msgDraft = $('#msg-input') ? $('#msg-input').value : s.message;

    const steps = [];
    if (s.status === 'setup') {
      steps.push(`<div class="step now"><b>Before the event</b><p class="small muted">Check Companies and Events tabs, run the integrity check, take a backup. Then start.</p>
        <button class="primary" data-a="start">Start event</button></div>`);
    } else if (s.status === 'running') {
      if (cur && cur.status === 'open') {
        steps.push(`<div class="step now"><b>Round ${cur.id}: trading open</b><div id="round-timer" class="timer"></div>
          <p class="small muted">${cur.executed} executed / ${cur.rejected} rejected orders · ${cur.teams_traded} teams traded. Closes automatically at the deadline.</p>
          <div class="actions"><button data-a="extend" data-s="60">+1 min</button><button data-a="extend" data-s="30">+30 s</button>
          <button class="danger" data-a="close">Close trading now</button></div></div>`);
      }
      if (cur && cur.status === 'closed') {
        steps.push(`<div class="step ${cur.bulletin_published_at ? 'done' : 'now'}"><b>Round ${cur.id}: news segment</b>
          <p class="small muted">Makes ${cur.bulletins} headline(s) visible in the players' News tab. Play the segment on the presentation.</p>
          <button data-a="bulletin" ${cur.bulletin_published_at ? 'disabled' : ''}>${cur.bulletin_published_at ? 'Published' : 'Publish news segment'}</button></div>`);
        steps.push(`<div class="step now"><b>Round ${cur.id}: market update</b>
          <p class="small muted">${cur.events} scheduled event(s). Preview first, then apply once.</p>
          <div class="actions"><button data-a="goto-update">Preview update →</button><button class="primary" data-a="apply">Apply market update</button></div></div>`);
        if (!cur.bulletin_published_at) {
          steps.push(`<div class="step"><b>Closed by mistake?</b><p class="small muted">Reopen Round ${cur.id} trading. Possible until the news segment is published.</p>
            <button data-a="reopen">Reopen trading…</button></div>`);
        }
      }
      if (cur && cur.status === 'settled') {
        steps.push(`<div class="step"><b>Wrong prices in Round ${cur.id}'s update?</b><p class="small muted">Undo it, fix the price script on the Events tab, then apply again. Only before Round ${cur.id + 1} opens.</p>
          <button class="danger" data-a="undo-update">Undo Round ${cur.id} market update…</button></div>`);
      }
      if ((!cur || cur.status === 'settled') && next) {
        steps.push(`<div class="step now"><b>Round ${next.id}: ${esc(next.title)}</b>
          <p class="small muted">Newspaper: ${next.newspaper_pdf ? esc(next.newspaper_pdf) : 'none'} ${next.newspaper_pdf ? (next.pdf_present ? '✓ file present' : '<b class="down">✗ file missing in papers/</b>') : ''}
          · ${next.duration_seconds}s window</p>
          <div class="actions">
            ${next.pdf_present ? `<a class="btn" href="/api/admin/rounds/${next.id}/paper" target="_blank" rel="noopener">Preview newspaper</a>` : ''}
            <button data-a="paper" ${next.newspaper_published_at ? 'disabled' : ''}>${next.newspaper_published_at ? 'Newspaper published' : 'Publish newspaper'}</button>
            <button class="primary" data-a="open">Open trading for Round ${next.id}</button></div>
          <p class="small muted">Opening also publishes the newspaper if you haven't yet.</p></div>`);
      }
      if (cur && cur.status === 'settled' && !next) {
        steps.push(`<div class="step now"><b>All ${total} rounds settled</b><p class="small muted">Final settlement liquidates any outstanding loans and freezes the rankings.</p>
          <button class="primary" data-a="end">End event &amp; freeze final rankings</button></div>`);
      }
    } else {
      steps.push('<div class="step done"><b>Event finished.</b> Final rankings are frozen and shown to every team.</div>');
    }

    main.innerHTML = `
      <div class="stack">
        ${ov.recent_errors.length ? `<div class="banner down">Recent server errors — see Audit &amp; health. Latest: ${esc(ov.recent_errors[0].message)}</div>` : ''}
        <div class="stats">
          <div class="stat"><div class="k">Event</div><div class="v">${esc(s.status)}${s.paused ? ' <span class="down">PAUSED</span>' : ''}</div></div>
          <div class="stat"><div class="k">Round</div><div class="v">${s.current_round} / ${total}</div></div>
          <div class="stat"><div class="k">Round status</div><div class="v">${cur ? esc(cur.status) : '—'}</div></div>
          <div class="stat"><div class="k">Teams logged in</div><div class="v">${ov.counts.teams_logged_in} / ${ov.counts.teams}</div></div>
          <div class="stat"><div class="k">Sessions</div><div class="v">${ov.counts.sessions}</div></div>
          <div class="stat"><div class="k">DB latency</div><div class="v ${ov.db_latency_ms > 100 ? 'down' : ''}">${ov.db_latency_ms} ms</div></div>
          ${ov.pool ? `<div class="stat"><div class="k">DB connections</div><div class="v ${ov.pool.waiting > 20 ? 'down' : ''}">${ov.pool.total}/${ov.pool.max}${ov.pool.waiting ? ` · ${ov.pool.waiting} waiting` : ''}</div></div>` : ''}
        </div>
        <div class="cols">
          <section class="card stack"><h2>Next step</h2>${steps.join('')}</section>
          <section class="card stack"><h2>Emergency</h2>
            <div class="actions">${s.paused
              ? '<button class="primary" data-a="resume-extend">Resume (extend deadline by pause)</button><button data-a="resume-noextend">Resume (keep deadline)</button>'
              : `<button class="danger" data-a="pause" ${s.status !== 'running' ? 'disabled' : ''}>Pause all trading</button>`}</div>
            <div><label for="msg-input">Message on every screen</label>
              <div class="row"><input id="msg-input" value="${esc(msgDraft)}" maxlength="500" style="flex:1"><button data-a="msg">Set</button><button data-a="msg-clear">Clear</button></div></div>
            <p class="small muted">Last market update: ${(() => { const d = ov.rounds.filter((r) => r.completed_at).pop(); return d ? `Round ${d.id} at ${MV.time(d.completed_at)}` : 'none'; })()}</p>
          </section>
        </div>
        <section class="card"><h2>Rounds</h2><div class="table-wrap"><table>
          <tr><th>#</th><th>Title</th><th>Status</th><th>Paper</th><th>Opened</th><th>Deadline</th><th>Closed</th><th>News</th><th>Update</th><th class="r">Exec</th><th class="r">Rej</th><th class="r">Events</th></tr>
          ${ov.rounds.map((r) => `<tr class="${r.id === s.current_round ? 'sel' : ''}"><td>${r.id}</td><td>${esc(r.title)}</td><td>${esc(r.status)}</td>
            <td>${r.newspaper_published_at ? '✓' : r.pdf_present ? 'ready' : r.newspaper_pdf ? '<span class="down">missing</span>' : '—'}</td>
            <td>${MV.time(r.opened_at)}</td><td>${MV.time(r.trading_deadline)}</td><td>${MV.time(r.closed_at)}</td>
            <td>${r.bulletin_published_at ? '✓' : '—'}</td><td>${r.market_update_status === 'done' ? '✓ ' + MV.time(r.completed_at) : '—'}</td>
            <td class="r">${r.executed}</td><td class="r">${r.rejected}</td><td class="r">${r.events}</td></tr>`).join('')}
        </table></div></section>
        <section class="card"><h2>Recent admin actions</h2><table>
          ${ov.recent_audit.map((a) => `<tr><td class="small num">${MV.time(a.created_at)}</td><td>${esc(a.action)}</td><td class="small muted">${esc(a.username || 'system')}</td><td class="small">${esc(a.reason || '')}</td></tr>`).join('')}
        </table></section>
      </div>`;
    if (focus === 'msg-input') { const m = $('#msg-input'); m.focus(); m.setSelectionRange(m.value.length, m.value.length); }
    tick();

    const R = s.current_round;
    const handlers = {
      start: (b) => act(b, 'Start event', () => api('/api/admin/event/start', { body: {} }), 'Start the event? Company configuration will be frozen.'),
      paper: (b) => act(b, 'Publish newspaper', () => api(`/api/admin/rounds/${next.id}/publish-newspaper`, { body: {} }), `Release Round ${next.id}'s newspaper to all teams now?`),
      open: (b) => act(b, 'Open round', () => api(`/api/admin/rounds/${next.id}/open`, { body: {} }), `Open trading for Round ${next.id} (${next.duration_seconds}s)?`),
      close: (b) => act(b, 'Close trading', () => api(`/api/admin/rounds/${R}/close`, { body: {} }), `Close Round ${R} trading NOW, before the deadline?`),
      extend: (b) => {
        const reason = prompt(`Extend Round ${R} by ${b.dataset.s}s. Reason (shown in audit log):`, 'Organiser extension');
        if (reason) act(b, 'Extend', () => api(`/api/admin/rounds/${R}/extend`, { body: { seconds: Number(b.dataset.s), reason } }));
      },
      bulletin: (b) => act(b, 'Publish news', () => api(`/api/admin/rounds/${R}/publish-news`, { body: {} }), `Show Round ${R}'s news segment on all screens?`),
      'goto-update': () => { A.tab = 'update'; A.updateRound = R; document.querySelector('[data-tab=update]').click(); },
      apply: (b) => act(b, 'Market update', () => api(`/api/admin/rounds/${R}/apply-market-update`, { body: {} }),
        `Apply Round ${R}'s market update?\n\nThis sets new prices for all companies. It can be undone only until the next round opens. Did you preview it?`),
      reopen: (b) => {
        const secs = prompt(`Reopen Round ${R} trading for how many seconds?`, '120');
        if (!secs) return;
        const reason = prompt('Reason (audit log):', 'Trading closed by mistake');
        if (reason) act(b, 'Reopen', () => api(`/api/admin/rounds/${R}/reopen`, { body: { seconds: Number(secs), reason } }));
      },
      'undo-update': (b) => {
        const reason = prompt(`UNDO Round ${R}'s market update?\n\nPrices go back to before the update and the round returns to "closed". Teams see the old prices until you apply again.\n\nReason (audit log):`);
        if (reason) act(b, 'Undo update', () => api(`/api/admin/rounds/${R}/undo-market-update`, { body: { reason } }));
      },
      end: (b) => act(b, 'End event', () => api('/api/admin/event/end', { body: {} }), 'End the event and freeze the final rankings? This cannot be undone.'),
      pause: (b) => { const reason = prompt('Pause all trading. Reason:', 'Technical issue'); if (reason !== null) act(b, 'Pause', () => api('/api/admin/pause', { body: { reason } })); },
      'resume-extend': (b) => act(b, 'Resume', () => api('/api/admin/resume', { body: { extend: true } }), 'Resume and add the paused time to the deadline (same for all teams)?'),
      'resume-noextend': (b) => act(b, 'Resume', () => api('/api/admin/resume', { body: { extend: false } }), 'Resume WITHOUT extending the deadline? If it has passed, trading closes immediately.'),
      msg: (b) => act(b, 'Message', () => api('/api/admin/message', { body: { message: $('#msg-input').value } })),
      'msg-clear': (b) => { $('#msg-input').value = ''; act(b, 'Message', () => api('/api/admin/message', { body: { message: '' } })); },
    };
    main.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => handlers[b.dataset.a](b)));
  }

  // ---------------------------------------------------------------- market update
  async function renderUpdate() {
    const s = A.ov.state;
    const r = A.updateRound || Math.max(1, s.current_round);
    A.updateRound = r;
    main.innerHTML = '<p class="muted">Computing preview…</p>';
    let p;
    try { p = await api(`/api/admin/rounds/${r}/preview`); } catch (e) { main.innerHTML = `<div class="banner down">${esc(e.message)}</div>`; return; }
    if (A.tab !== 'update') return;
    const done = p.round.market_update_status === 'done';
    let applied = null;
    if (done) {
      const h = await api('/api/market/history');
      applied = h;
    }
    main.innerHTML = `
      <div class="stack">
        <div class="row"><label for="u-round" style="margin:0">Round</label>
          <select id="u-round" style="width:auto">${A.ov.rounds.map((x) => `<option ${x.id === r ? 'selected' : ''}>${x.id}</option>`).join('')}</select>
          <span class="chip">${esc(p.round.status)}</span>${done ? '<span class="chip up">Applied ✓</span>' : ''}
          <button id="u-refresh" class="small">Refresh preview</button></div>
        ${done ? '<div class="banner info">This round is already applied. Applying again is impossible; the table below is what it would compute now (no events remain) — the official result is in the price history.</div>' : ''}
        <section class="card"><h2>Events effective this round</h2>
          ${p.events.length ? p.events.map((e) => `<div><b>${esc(e.id)}</b> — ${esc(e.event_name)}<pre>${esc(JSON.stringify(e.configuration))}</pre></div>`).join('') : '<p class="muted">None. Prices move only by trading pressure and noise.</p>'}
        </section>
        <section class="card"><h2>${done ? 'Official result' : 'Preview'}</h2><div class="table-wrap"><table>
          <tr><th>Ticker</th><th>Industry</th><th class="r">Net demand</th><th class="r">Fund.</th><th class="r">Trading</th><th class="r">Noise</th><th class="r">Total</th><th class="r">Previous</th><th class="r">New</th></tr>
          ${(done ? officialRows(applied, r, p.rows) : p.rows).map((x) => `<tr><td class="mono"><b>${esc(x.ticker)}</b></td><td class="small">${esc(x.industry || '')}</td>
            <td class="r num">${x.net_demand == null ? '' : int(x.net_demand)}</td><td class="r num">${x.fundamental_bps == null ? '' : pct(x.fundamental_bps)}</td><td class="r num">${x.trading_bps == null ? '' : pct(x.trading_bps)}</td>
            <td class="r num">${x.noise_bps == null ? '' : pct(x.noise_bps)}</td><td class="r num ${tone(x.total_bps)} ${Math.abs(x.total_bps) >= 1500 ? 'flag' : ''}">${pct(x.total_bps)}</td>
            <td class="r num">${inr(x.prev_price)}</td><td class="r num"><b>${inr(x.price)}</b></td></tr>`).join('')}
        </table></div><p class="small muted">Highlighted: moves of 15% or more — double-check these against the event plan.</p></section>
        ${!done && p.round.status === 'closed' ? `<button class="primary" id="u-apply">Apply Round ${r} market update</button>` : ''}
        ${!done && p.round.status !== 'closed' ? `<div class="banner warn">Round ${r} is ${esc(p.round.status)}. It can be applied only after trading closes. Demand figures will change until then.</div>` : ''}
      </div>`;
    $('#u-round').onchange = (e) => { A.updateRound = Number(e.target.value); renderUpdate(); };
    $('#u-refresh').onclick = renderUpdate;
    const apply = $('#u-apply');
    if (apply) apply.onclick = async () => {
      const res = await act(apply, 'Market update', () => api(`/api/admin/rounds/${r}/apply-market-update`, { body: {} }),
        `Apply Round ${r}'s market update with these prices? It can be undone only until the next round opens.`);
      if (res) renderUpdate();
    };
  }

  function officialRows(history, round, previewRows) {
    return previewRows.map((x) => {
      const h = history[x.ticker] || [];
      const now = h.find((pt) => pt.round === round);
      const prev = h.find((pt) => pt.round === round - 1);
      if (!now || !prev) return x;
      return { ticker: x.ticker, industry: x.industry, prev_price: prev.price, price: now.price,
        total_bps: Math.round(((now.price - prev.price) * 10000) / prev.price) };
    });
  }

  // ---------------------------------------------------------------- teams
  async function renderTeams() {
    const teams = await api('/api/admin/teams');
    if (A.tab !== 'teams') return;
    const s = A.ov.state.settings;
    main.innerHTML = `
      <div class="cols" style="grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr)">
        <section class="card"><h2>Live valuations (not the published leaderboard)</h2><div class="table-wrap"><table>
          <tr><th>#</th><th>Team</th><th>ID</th><th class="r">Cash</th><th class="r">Shares</th><th class="r">Debt</th><th class="r">Net worth</th><th class="r">P/L</th><th class="r">Sess.</th></tr>
          ${teams.map((t) => `<tr class="click ${A.selectedTeam === t.team_id ? 'sel' : ''}" data-team="${t.team_id}"><td>${t.rank}${t.tied ? '=' : ''}</td><td>${esc(t.name)}</td><td class="mono small">${esc(t.access_identifier)}</td>
            <td class="r num">${inrShort(t.cash)}</td><td class="r num">${inrShort(t.holdings_value)}</td><td class="r num">${t.debt ? inrShort(t.debt) : '—'}</td>
            <td class="r num"><b>${inrShort(t.net_worth)}</b></td><td class="r num ${tone(t.net_worth - s.starting_cash)}">${MV.signedInr(t.net_worth - s.starting_cash)}</td><td class="r">${t.sessions}</td></tr>`).join('')}
        </table></div></section>
        <section class="card" id="team-detail"><p class="muted">Select a team to inspect its portfolio, orders, ledger and loans.</p></section>
      </div>`;
    main.querySelectorAll('[data-team]').forEach((tr) => (tr.onclick = () => { A.selectedTeam = Number(tr.dataset.team); renderTeams(); }));
    if (A.selectedTeam) renderTeamDetail(A.selectedTeam);
  }

  async function renderTeamDetail(id) {
    const d = await api(`/api/admin/teams/${id}`);
    const p = d.portfolio;
    const el = $('#team-detail');
    if (!el) return;
    el.innerHTML = `
      <div class="stack">
        <div class="spread"><h2>${esc(p.team.name)} <span class="muted mono small">${esc(p.team.access_identifier)}</span></h2><button class="small" id="t-reset">Reset password</button></div>
        <div class="stats">
          <div class="stat"><div class="k">Cash</div><div class="v num">${inrShort(p.cash)}</div></div>
          <div class="stat"><div class="k">Net worth</div><div class="v num">${inrShort(p.net_worth)}</div></div>
          <div class="stat"><div class="k">Debt</div><div class="v num">${inrShort(p.debt)}</div></div>
        </div>
        <table><tr><th>Ticker</th><th class="r">Qty</th><th class="r">Pledged</th><th class="r">Value</th></tr>
          ${p.holdings.map((h) => `<tr><td class="mono">${esc(h.ticker)}</td><td class="r num">${int(h.quantity)}</td><td class="r num">${int(h.pledged_quantity)}</td><td class="r num">${inrShort(h.value)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No holdings</td></tr>'}
        </table>
        <details><summary>Orders (${d.orders.length})</summary><div class="table-wrap"><table>
          ${d.orders.map((o) => `<tr><td class="small num">${MV.time(o.submitted_at)}</td><td>R${o.round_id || '—'}</td><td>${esc(o.side)} ${int(o.quantity)} ${esc(o.ticker || '')}</td>
            <td>${o.status === 'executed' ? '✓ ' + inr(o.execution_price) : `<span class="down small">${esc(o.rejection_reason)}</span>`}</td><td class="small muted">${esc(o.placed_by || '')}</td>
            <td>${o.order_id ? reverseBtn({ id: o.order_id, round_id: o.round_id, status: o.status, reversed_at: o.reversed_reason != null, reversal_reason: o.reversed_reason, team_name: p.team.name, side: o.side, quantity: o.quantity, ticker: o.ticker }) : ''}</td></tr>`).join('')}
        </table></div></details>
        <details><summary>Cash ledger (${d.ledger.length})</summary><div class="table-wrap"><table>
          ${d.ledger.map((l) => `<tr><td class="small num">${MV.time(l.created_at)}</td><td class="small">${esc(l.transaction_type)}</td><td class="r num ${tone(l.amount)}">${inr(l.amount)}</td><td class="r num">${inr(l.balance_after)}</td><td class="small muted">${esc(l.memo || '')}</td></tr>`).join('')}
        </table></div></details>
        ${d.loans.length ? `<details open><summary>Loans</summary><table>${d.loans.map((l) => `<tr><td>#${l.id}</td><td>${esc(l.status)}</td><td class="r num">${inr(l.principal)}</td><td class="r num">${inr(l.interest_due)}</td><td>due R${l.due_round}</td></tr>`).join('')}</table></details>` : ''}
        <p class="small muted">Corrections for this team are on the “Rewards &amp; corrections” tab.</p>
      </div>`;
    bindReverse(el, () => renderTeamDetail(id));
    $('#t-reset').onclick = async () => {
      const reason = prompt(`Reset ${p.team.name}'s password? All its devices will be logged out. Reason:`);
      if (!reason) return;
      try {
        const r = await api(`/api/admin/teams/${id}/reset-password`, { body: { reason } });
        prompt('New password (copy it now — it is not shown again):', r.password);
      } catch (e) { alert(e.message); }
    };
  }

  // ---------------------------------------------------------------- companies
  async function renderCompanies() {
    const cs = await api('/api/admin/companies');
    if (A.tab !== 'companies') return;
    const setup = A.ov.state.status === 'setup';
    main.innerHTML = `
      <section class="card"><h2>Companies</h2>
        <p class="small muted">${setup ? 'Configuration is editable until the event starts.' : 'Configuration is frozen. Max order size can still be changed as a logged emergency correction; trading can be suspended with a reason.'}</p>
        <div class="table-wrap"><table>
          <tr><th>Ticker</th><th>Name</th><th>Industry</th><th class="r">Price</th><th class="r">Last Δ</th><th class="r">Float</th><th class="r">Inventory</th><th class="r">Held</th><th class="r">Max order</th><th class="r">Pressure ref</th><th>Loan</th><th>Trading</th></tr>
          ${cs.map((c) => `<tr><td class="mono"><b>${esc(c.ticker)}</b></td><td>${esc(c.name)}</td><td class="small">${esc(c.industry)}</td>
            <td class="r num">${inr(c.price)}</td><td class="r num ${tone(c.change_bps)}">${pct(c.change_bps)}</td>
            <td class="r num">${int(c.float_shares)}</td><td class="r num">${int(c.exchange_inventory)}</td><td class="r num">${int(c.held_by_teams)}</td>
            <td class="r num"><a href="#" data-edit="${c.id}" data-field="max_order_quantity" data-v="${c.max_order_quantity}">${int(c.max_order_quantity)}</a></td>
            <td class="r num">${setup ? `<a href="#" data-edit="${c.id}" data-field="pressure_ref_qty" data-v="${c.pressure_ref_qty}">${int(c.pressure_ref_qty)}</a>` : int(c.pressure_ref_qty)}</td>
            <td>${c.loan_eligible ? '✓' : '—'}</td>
            <td>${c.is_tradable ? `<button class="small danger" data-susp="${c.id}">Suspend</button>` : `<span class="chip warn" title="${esc(c.suspension_reason)}">Suspended</span> <button class="small" data-resume="${c.id}">Resume</button>`}</td></tr>`).join('')}
        </table></div></section>`;
    main.querySelectorAll('[data-edit]').forEach((a) => (a.onclick = async (ev) => {
      ev.preventDefault();
      const v = prompt(`New ${a.dataset.field.replace(/_/g, ' ')}:`, a.dataset.v);
      if (!v) return;
      const reason = setup ? 'pre-event configuration' : prompt('Reason for this emergency correction:');
      if (!reason) return;
      await act(null, 'Update company', () => api(`/api/admin/companies/${a.dataset.edit}`, { method: 'PATCH', body: { [a.dataset.field]: Number(v), reason } }));
      renderCompanies();
    }));
    main.querySelectorAll('[data-susp]').forEach((b) => (b.onclick = async () => {
      const reason = prompt('Suspend trading in this company. Reason (shown to teams):');
      if (!reason) return;
      await act(b, 'Suspend', () => api(`/api/admin/companies/${b.dataset.susp}/trading`, { body: { tradable: false, reason } }));
      renderCompanies();
    }));
    main.querySelectorAll('[data-resume]').forEach((b) => (b.onclick = async () => {
      const reason = prompt('Resume trading. Reason:', 'Suspension lifted');
      if (!reason) return;
      await act(b, 'Resume', () => api(`/api/admin/companies/${b.dataset.resume}/trading`, { body: { tradable: true, reason } }));
      renderCompanies();
    }));
  }

  // ---------------------------------------------------------------- orders
  const reverseBtn = (o) => (o.status !== 'executed' ? '' : o.reversed_at
    ? `<span class="chip warn" title="${esc(o.reversal_reason || '')}">reversed</span>`
    : `<button class="small danger" data-rev="${o.id}" data-round="${o.round_id || ''}" data-desc="${esc(`${o.team_name || ''} ${o.side} ${o.quantity} ${o.ticker || ''}`)}">Reverse</button>`);

  function bindReverse(root, after) {
    root.querySelectorAll('[data-rev]').forEach((b) => (b.onclick = async () => {
      const rd = A.ov.rounds.find((r) => String(r.id) === b.dataset.round);
      const late = rd && rd.status === 'settled'
        ? `\n\n⚠ Round ${rd.id} is already settled: prices have moved since this trade, so reversing it now gives the team hindsight. Its effect on Round ${rd.id}'s prices stays.` : '';
      const reason = prompt(`Reverse order #${b.dataset.rev} (${b.dataset.desc})?\n\nShares and the full cash amount (including the fee) go back as if it never happened. The team sees it as a correction in its history.${late}\n\nReason (shown to the team):`);
      if (!reason) return;
      if (await act(b, 'Reverse order', () => api(`/api/admin/orders/${b.dataset.rev}/reverse`, { body: { reason } }))) after();
    }));
  }

  async function renderOrders() {
    const status = A.orderStatus || '';
    const round = A.orderRound || '';
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (round) q.set('round', round);
    const [orders, dups] = await Promise.all([api('/api/admin/orders?' + q), api('/api/admin/orders/suspected-duplicates')]);
    if (A.tab !== 'orders') return;
    main.innerHTML = `
      <div class="stack">
        <section class="card"><h2>Possible human double-submissions</h2>
          <p class="small muted">Same team, company, side and size within 15 s under different submission keys. Network retries never appear here — they are deduplicated automatically. Review with the team before correcting anything.</p>
          ${dups.length ? `<table><tr><th>Team</th><th>Order</th><th>Orders</th><th>Gap</th><th></th></tr>${dups.map((d) => `<tr><td>${esc(d.team_name)}</td><td>R${d.round_id} ${esc(d.side)} ${int(d.quantity)} ${esc(d.ticker)}</td><td>#${d.first_order}, #${d.second_order}</td><td>${d.seconds_apart}s</td>
            <td>${reverseBtn({ id: d.second_order, round_id: d.round_id, status: 'executed', team_name: d.team_name, side: d.side, quantity: d.quantity, ticker: d.ticker })}</td></tr>`).join('')}</table>` : '<p class="muted">None.</p>'}
        </section>
        <section class="card"><div class="row"><h2 style="margin:0">Orders</h2>
          <select id="o-status" style="width:auto"><option value="">All</option><option ${status === 'executed' ? 'selected' : ''}>executed</option><option ${status === 'rejected' ? 'selected' : ''}>rejected</option></select>
          <select id="o-round" style="width:auto"><option value="">All rounds</option>${A.ov.rounds.map((r) => `<option ${String(r.id) === String(round) ? 'selected' : ''}>${r.id}</option>`).join('')}</select>
          <span class="muted small">latest 500</span></div>
          <div class="table-wrap"><table>
            <tr><th>#</th><th>Time</th><th>Team</th><th>By</th><th>Rnd</th><th>Order</th><th>Status</th><th class="r">Price</th><th></th></tr>
            ${orders.map((o) => `<tr><td class="num">${o.id}</td><td class="small num">${MV.time(o.submitted_at)}</td><td>${esc(o.team_name)}</td><td class="small muted">${esc(o.placed_by || '')}</td><td>${o.round_id || '—'}</td>
              <td>${esc(o.side)} ${o.quantity == null ? '?' : int(o.quantity)} ${esc(o.ticker || '')}</td>
              <td>${o.status === 'executed' ? '<span class="up">executed</span>' : `<span class="down">rejected</span> <span class="small">${esc(o.rejection_reason)}</span>`}</td>
              <td class="r num">${o.execution_price ? inr(o.execution_price) : ''}</td><td>${reverseBtn(o)}</td></tr>`).join('')}
          </table></div></section>
      </div>`;
    bindReverse(main, renderOrders);
    $('#o-status').onchange = (e) => { A.orderStatus = e.target.value; renderOrders(); };
    $('#o-round').onchange = (e) => { A.orderRound = e.target.value; renderOrders(); };
  }

  // ---------------------------------------------------------------- events
  async function renderEvents() {
    const [d, cs] = await Promise.all([api('/api/admin/events'), api('/api/admin/companies')]);
    if (A.tab !== 'events') return;
    const script = d.events.filter((e) => /^SCRIPT-R\d+$/.test(e.id)).sort((a, b) => a.effective_round - b.effective_round);
    const others = d.events.filter((e) => !script.includes(e));
    const setup = A.ov.state.status === 'setup';
    const tickers = cs.map((c) => c.ticker).sort();
    main.innerHTML = `
      <div class="stack">
        <div class="banner warn">Confidential. Never show this tab on the presentation screen.</div>
        ${script.length ? `<section class="card"><h2>Price script (fixed % move per round)</h2>
          <p class="small muted">Applied at each round's market update; trading pressure is added on top. Click a value in a round that is not applied yet to correct it${setup ? '' : ' (logged emergency correction, reason required)'}.</p>
          <div class="table-wrap"><table>
            <tr><th>Ticker</th>${script.map((e) => `<th class="r">R${e.effective_round}${e.is_applied ? ' ✓' : ''}</th>`).join('')}</tr>
            ${tickers.map((t) => `<tr><td class="mono"><b>${esc(t)}</b></td>${script.map((e) => {
              const v = (e.configuration.companies || {})[t] || 0;
              return `<td class="r num ${tone(v)}">${e.is_applied ? pct(v) : `<a href="#" data-script="${esc(e.id)}" data-t="${esc(t)}" data-v="${v}">${pct(v)}</a>`}</td>`;
            }).join('')}</tr>`).join('')}
          </table></div></section>` : ''}
        <section class="card"><h2>Scheduled events</h2><div class="table-wrap"><table>
          <tr><th>ID</th><th>Name</th><th>Clue</th><th>Effective</th><th>Impacts</th><th>Notes</th><th>Applied</th></tr>
          ${others.map((e) => `<tr><td class="mono small">${esc(e.id)}</td><td>${esc(e.event_name)}</td><td>${e.clue_round ? 'R' + e.clue_round : '—'}</td><td>R${e.effective_round}</td>
            <td class="small">${[...Object.entries(e.configuration.industries || {}).map(([k, v]) => `${esc(k)} ${pct(v)}`), ...Object.entries(e.configuration.companies || {}).map(([k, v]) => `<b>${esc(k)}</b> ${pct(v)}`)].join('<br>')}</td>
            <td class="small muted">${esc(e.notes)}</td><td>${e.is_applied ? '✓ ' + MV.time(e.applied_at) : `<button class="small" data-ev="${esc(e.id)}">Edit</button>`}</td></tr>`).join('')}
        </table></div><p class="small muted">Plan changes belong in config/game.json before seeding. Editing here is for correcting a mistake found during the event; every edit is in the audit log.</p></section>
        <section class="card"><h2>News-segment headlines</h2><div class="table-wrap"><table>
          <tr><th>Round</th><th>Headline</th><th>Affected</th><th>Media</th><th>Published</th></tr>
          ${d.news.map((n) => `<tr><td>${n.round_id}</td><td><b>${esc(n.title)}</b><div class="small muted">${esc(n.content)}</div></td><td class="small">${esc(n.affected)}</td><td class="small">${esc(n.media_url || '')}</td><td>${n.is_published ? '✓' : '—'}</td></tr>`).join('')}
        </table></div></section>
        <section class="card"><h2>Newspapers</h2><table>
          ${A.ov.rounds.map((r) => `<tr><td>R${r.id}</td><td>${esc(r.title)}</td><td class="mono small">${esc(r.newspaper_pdf || '')}</td>
            <td>${r.pdf_present ? `<a href="/api/admin/rounds/${r.id}/paper" target="_blank" rel="noopener">Preview</a>` : '<span class="down small">file missing</span>'}</td><td>${r.newspaper_published_at ? 'published' : 'hidden'}</td></tr>`).join('')}
        </table></section>
      </div>`;
    const save = async (id, configuration, label) => {
      const reason = setup ? 'pre-event configuration' : prompt(`${label}\n\nThis changes a pre-decided outcome during the event. Reason (audit log):`);
      if (!reason) return;
      if (await act(null, 'Update event', () => api(`/api/admin/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: { configuration, reason } }))) renderEvents();
    };
    main.querySelectorAll('[data-script]').forEach((a) => (a.onclick = (ev) => {
      ev.preventDefault();
      const e = script.find((x) => x.id === a.dataset.script);
      const input = prompt(`${a.dataset.t}, Round ${e.effective_round}: new move in % (e.g. -11.88)`, (Number(a.dataset.v) / 100).toFixed(2));
      if (input == null || input.trim() === '') return;
      const bps = Math.round(Number(input.replace('%', '')) * 100);
      if (!Number.isFinite(bps)) { alert('Enter a number such as -11.88'); return; }
      const companies = { ...(e.configuration.companies || {}) };
      if (bps) companies[a.dataset.t] = bps; else delete companies[a.dataset.t];
      save(e.id, { industries: e.configuration.industries || {}, companies }, `${a.dataset.t} R${e.effective_round}: ${pct(Number(a.dataset.v))} → ${pct(bps)}`);
    }));
    main.querySelectorAll('[data-ev]').forEach((b) => (b.onclick = () => {
      const e = others.find((x) => x.id === b.dataset.ev);
      const input = prompt(`Edit ${e.id} impacts (basis points, 100 = 1%):`, JSON.stringify({ industries: e.configuration.industries || {}, companies: e.configuration.companies || {} }));
      if (!input) return;
      let cfg;
      try { cfg = JSON.parse(input); } catch { alert('That is not valid JSON'); return; }
      save(e.id, cfg, `Change ${e.id}`);
    }));
  }

  // ---------------------------------------------------------------- rewards & corrections
  async function renderMoney() {
    const [teams, cs] = await Promise.all([api('/api/admin/teams'), api('/api/admin/companies')]);
    if (A.tab !== 'money') return;
    teams.sort((a, b) => a.team_id - b.team_id);
    const teamOpts = teams.map((t) => `<option value="${t.team_id}">${esc(t.name)} (${esc(t.access_identifier)})</option>`).join('');
    const max = A.ov.state.settings.max_reward;
    main.innerHTML = `
      <div class="cols">
        <section class="card stack"><h2>Quest / quiz reward</h2>
          <p class="small muted">Each team can receive a given quest's reward once. Cap per reward: ${inr(max)}.</p>
          <div><label>Teams (Ctrl/Cmd-click for several)</label><select id="r-teams" multiple size="8">${teamOpts}</select></div>
          <div class="form-grid"><div><label>Quest name</label><input id="r-quest" placeholder="round-3-quiz"></div><div><label>Amount (₹)</label><input id="r-amt" inputmode="numeric"></div></div>
          <div><label>Reason</label><input id="r-reason" placeholder="Correct answer to the Round 3 quiz"></div>
          <button class="primary" id="r-go">Grant reward</button></section>
        <section class="card stack"><h2>Cash correction</h2>
          <p class="small muted">Recorded as an adjustment ledger entry plus an audit entry. Use a negative amount to debit.</p>
          <div><label>Team</label><select id="c-team">${teamOpts}</select></div>
          <div class="form-grid"><div><label>Amount (₹, ±)</label><input id="c-amt"></div></div>
          <div><label>Reason (required)</label><input id="c-reason"></div>
          <button id="c-go">Apply cash correction</button></section>
        <section class="card stack"><h2>Holdings correction</h2>
          <p class="small muted">Moves shares between the exchange inventory and the team (e.g. reconciling a manually collected trade during an outage). Cash is not changed — pair with a cash correction if needed.</p>
          <div><label>Team</label><select id="h-team">${teamOpts}</select></div>
          <div class="form-grid"><div><label>Company</label><select id="h-co">${cs.map((c) => `<option value="${c.id}">${esc(c.ticker)}</option>`).join('')}</select></div>
            <div><label>Share delta (±)</label><input id="h-delta"></div></div>
          <div><label>Reason (required)</label><input id="h-reason"></div>
          <button id="h-go">Apply holdings correction</button></section>
      </div>`;
    $('#r-go').onclick = (e) => {
      const ids = Array.from($('#r-teams').selectedOptions).map((o) => Number(o.value));
      const amount = Math.round(Number($('#r-amt').value) * 100);
      act(e.target, 'Reward', async () => {
        const r = await api('/api/admin/rewards', { body: { team_ids: ids, quest: $('#r-quest').value, amount, reason: $('#r-reason').value } });
        const skipped = r.filter((x) => x.skipped).length;
        if (skipped) alert(`${skipped} team(s) already had this quest's reward and were skipped.`);
        return r;
      }, `Grant ${inr(amount)} to ${ids.length} team(s)?`);
    };
    $('#c-go').onclick = (e) => {
      const amount = Math.round(Number($('#c-amt').value) * 100);
      act(e.target, 'Cash correction', () => api(`/api/admin/teams/${$('#c-team').value}/adjust-cash`, { body: { amount, reason: $('#c-reason').value } }),
        `Adjust ${$('#c-team').selectedOptions[0].text} cash by ${inr(amount)}?`);
    };
    $('#h-go').onclick = (e) => {
      const delta = Number($('#h-delta').value);
      act(e.target, 'Holdings correction', () => api(`/api/admin/teams/${$('#h-team').value}/adjust-holdings`, { body: { company_id: Number($('#h-co').value), delta, reason: $('#h-reason').value } }),
        `Adjust ${$('#h-team').selectedOptions[0].text} ${$('#h-co').selectedOptions[0].text} holdings by ${delta}?`);
    };
  }

  // ---------------------------------------------------------------- health
  async function renderHealth() {
    const [integrity, auditLog, sys] = await Promise.all([api('/api/admin/integrity'), api('/api/admin/audit-log'), api('/api/admin/system-log')]);
    if (A.tab !== 'health') return;
    main.innerHTML = `
      <div class="stack">
        <section class="card"><div class="spread"><h2>Integrity check</h2><button id="i-run" class="small">Run again</button></div>
          ${integrity.problems.length ? `<div class="banner down">${integrity.problems.length} problem(s). Pause trading and investigate before continuing.</div><pre>${esc(JSON.stringify(integrity.problems, null, 2))}</pre>`
            : `<div class="banner up">All checks passed at ${MV.time(integrity.checked_at)}: share supply conserved, cash matches ledger, collateral matches pledges, every order has a trade and ledger entry, every settled round is fully priced.</div>`}
        </section>
        <section class="card"><h2>Audit log</h2><div class="table-wrap"><table>
          <tr><th>Time</th><th>Admin</th><th>Action</th><th>Reason</th><th>Before → After</th></tr>
          ${auditLog.map((a) => `<tr><td class="small num">${new Date(a.created_at).toLocaleString('en-IN')}</td><td class="small">${esc(a.username || 'system')}</td><td>${esc(a.action)}</td><td class="small">${esc(a.reason || '')}</td>
            <td><details><summary class="small">details</summary><pre>${esc(JSON.stringify({ before: a.before_state, after: a.after_state }, null, 1))}</pre></details></td></tr>`).join('')}
        </table></div></section>
        <section class="card"><h2>System log</h2><table>
          ${sys.map((l) => `<tr><td class="small num">${new Date(l.created_at).toLocaleString('en-IN')}</td><td class="${l.level === 'error' ? 'down' : ''}">${esc(l.level)}</td><td class="small">${esc(l.message)}</td></tr>`).join('')}
        </table></section>
      </div>`;
    $('#i-run').onclick = renderHealth;
  }

  boot();
})();
