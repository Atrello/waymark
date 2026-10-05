<script>
  import { api } from '../lib/api.js';
  import { app, viewsAll } from '../lib/app.svelte.js';
  import { mi, money, prevMonth } from '../lib/format.js';
  import Msg from '../components/Msg.svelte';

  let mode = $state('month');
  let month = $state(prevMonth(app.today));
  let from = $state(`${app.today.slice(0, 8)}01`);
  let to = $state(app.today);
  let user = $state('');
  let summary = $state(null);
  let msg = $state(null);

  const query = $derived.by(() => {
    const q = mode === 'range' ? { mode, from, to } : { mode, month: month.trim() };
    if (viewsAll()) q.userId = user;
    const ok = mode === 'range' ? !!(from && to) : /^\d{4}-\d{2}$/.test(q.month);
    return { ok, qs: new URLSearchParams(q).toString() };
  });

  // Reload the summary whenever the period or user changes; ignore replies to superseded requests.
  let ticket = 0;
  $effect(() => {
    const { ok, qs } = query;
    const mine = ++ticket;
    if (!ok) { summary = null; return; }
    msg = null;
    api('GET', `/api/export/summary?${qs}`)
      .then((r) => { if (mine === ticket) summary = r; })
      .catch((e) => { if (mine === ticket) { summary = null; msg = { text: e.message, kind: 'bad' }; } });
  });

  function download(e) {
    if (!query.ok) { e.preventDefault(); msg = { text: 'Pick a month or both dates first.', kind: 'warn' }; }
  }
</script>

<section class="page">
  <header class="page-head">
    <div>
      <h1>Export</h1>
      <p>Claim CSV for a month or date range. Live entries only, with totals and a summary.</p>
    </div>
  </header>
  <Msg {msg} />
  <div class="export-grid">
    <div class="panel"><div class="panel-body">
      <div class="seg mb16">
        <label><input type="radio" name="xMode" value="month" bind:group={mode}><span>Month</span></label>
        <label><input type="radio" name="xMode" value="range" bind:group={mode}><span>Date range</span></label>
      </div>
      {#if viewsAll()}
        <div class="field">
          <label class="f" for="xUser">User</label>
          <select id="xUser" bind:value={user}>
            <option value="">All users</option>
            {#each app.users as u (u.id)}<option value={String(u.id)}>{u.name}</option>{/each}
          </select>
        </div>
      {/if}
      {#if mode === 'month'}
        <div class="field">
          <label class="f" for="xMonth">Month</label>
          <input id="xMonth" type="month" bind:value={month}>
        </div>
      {:else}
        <div class="grid-2">
          <div class="field"><label class="f" for="xFrom">From</label><input id="xFrom" type="date" bind:value={from}></div>
          <div class="field"><label class="f" for="xTo">To</label><input id="xTo" type="date" bind:value={to}></div>
        </div>
      {/if}
      <div class="btn-col">
        <a class="btn primary" href={query.ok ? `/api/export/csv?${query.qs}` : '#'} onclick={download}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>
          Download CSV
        </a>
      </div>
    </div></div>

    <div>
      {#if summary}
        {@const s = summary.summary}
        <div class="kpis summary-kpis">
          <div class="kpi"><span>Legs</span><b>{s.legs}</b></div>
          <div class="kpi"><span>Miles</span><b>{mi(s.miles)}</b></div>
          <div class="kpi"><span>Claim</span><b>{money(s.claim)}</b></div>
        </div>
        {#if s.byUser.length > 1 || (viewsAll() && !user)}
          <div class="panel mb16"><div class="panel-body">
            <h2 class="section-title">{summary.label} · by user</h2>
            {#if s.byUser.length}
              <table class="breakdown">
                <tbody>
                  <tr><th>User</th><th class="num">Legs</th><th class="num">Miles</th><th class="num">Claim</th></tr>
                  {#each s.byUser as u (u.user)}
                    <tr><td>{u.user}</td><td class="num">{u.legs}</td><td class="num">{mi(u.miles)}</td><td class="num">{money(u.claim)}</td></tr>
                  {/each}
                </tbody>
              </table>
            {:else}<p class="muted">No Live entries in this period.</p>{/if}
          </div></div>
        {/if}
        <div class="panel"><div class="panel-body">
          <h2 class="section-title">{summary.label} · {summary.scope} · by customer</h2>
          {#if s.byBusiness.length}
            <table class="breakdown">
              <tbody>
                <tr><th>Customer</th><th class="num">Legs</th><th class="num">Miles</th><th class="num">Claim</th></tr>
                {#each s.byBusiness as b (b.business)}
                  <tr><td>{b.business}</td><td class="num">{b.legs}</td><td class="num">{mi(b.miles)}</td><td class="num">{money(b.claim)}</td></tr>
                {/each}
              </tbody>
            </table>
          {:else}<p class="muted">No Live entries in this period.</p>{/if}
          <p class="hint">File: {summary.filename}</p>
        </div></div>
      {/if}
    </div>
  </div>
</section>
