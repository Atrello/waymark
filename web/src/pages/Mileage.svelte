<script>
  import { api } from '../lib/api.js';
  import { app, viewsAll, logsJourneys, canDelete, role, loadLog } from '../lib/app.svelte.js';
  import { toast, confirmBox } from '../lib/ui.svelte.js';
  import { norm, mi, money, uk, sortRows, nextSort } from '../lib/format.js';
  import Modal from '../components/Modal.svelte';
  import TripModal from './TripModal.svelte';

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const COLUMNS = [
    { key: 'userName', label: 'User', cls: 'c-user' }, { key: 'date', label: 'Date' }, { key: 'start', label: 'Start' },
    { key: 'dest', label: 'Destination' }, { key: 'reason', label: 'Visit reason' }, { key: 'business', label: 'Customer' },
    { key: 'miles', label: 'Miles', cls: 'num' }, { key: 'rate', label: 'Rate', cls: 'num' }, { key: 'claim', label: 'Claim', cls: 'num' },
    { key: 'type', label: 'Type' }, { key: 'ticket', label: 'Ticket' },
  ];
  const DESC_FIRST = ['date', 'miles', 'claim'];

  let year = $state(app.today.slice(0, 4));
  let month = $state('');
  let user = $state('');
  let business = $state('');
  let type = $state('');
  let search = $state('');
  let sort = $state({ key: 'date', dir: -1 });
  let limit = $state(200);
  let tripOpen = $state(false);
  let route = $state(null); // { entryId, title }

  const years = $derived([...new Set([...app.log.map((r) => r.date.slice(0, 4)), app.today.slice(0, 4)])].sort().reverse());
  const businesses = $derived([...new Set(app.log.map((r) => r.business).filter(Boolean))].sort((a, b) => a.localeCompare(b)));

  const rows = $derived.by(() => {
    const q = norm(search);
    const u = viewsAll() ? user : '';
    const list = app.log.filter((r) => {
      if (u && String(r.userId) !== u) return false;
      if (year && r.date.slice(0, 4) !== year) return false;
      if (month && r.date.slice(5, 7) !== month) return false;
      if (business && r.business !== business) return false;
      if (type && r.type !== type) return false;
      if (q && !norm([r.start, r.dest, r.reason, r.business, r.ticket, r.userName, uk(r.date)].join(' ')).includes(q)) return false;
      return true;
    });
    return sortRows(list, sort, 'id');
  });
  const shown = $derived(rows.slice(0, limit));
  const totals = $derived(rows.reduce((t, r) => ({ miles: t.miles + r.miles, claim: t.claim + r.claim, days: t.days.add(r.date) }),
    { miles: 0, claim: 0, days: new Set() }));
  const hasTest = $derived(rows.some((r) => r.type === 'Test'));
  const routes = $derived(app.mapsPicker.configured); // rows open the route map once a browser key is set

  function sortBy(key) { sort = nextSort(sort, key, DESC_FIRST.includes(key) ? -1 : 1); }
  const resetLimit = () => { limit = 200; };
  function clearFilters() { user = ''; year = ''; month = ''; business = ''; type = ''; search = ''; resetLimit(); }

  async function remove(r) {
    const ok = await confirmBox('Delete this entry?',
      `${uk(r.date)}\n${r.start} → ${r.dest}\n${mi(r.miles)} mi · ${money(r.claim)}\n\nThis cannot be undone.`);
    if (!ok) return;
    try {
      const res = await api('DELETE', `/api/log/${encodeURIComponent(r.entryId)}`);
      toast(res.message);
      await loadLog();
    } catch (e) { toast(e.message); }
  }

  /** After saving a journey, make sure its rows are visible with the current filters. */
  function onSaved(date) {
    if (year && year !== date.slice(0, 4)) year = date.slice(0, 4);
    if (month && month !== date.slice(5, 7)) month = '';
    loadLog();
  }

  function openRoute(r) { if (routes) route = { entryId: r.entryId, title: `Route · ${uk(r.date)}` }; }
</script>

<section class="page">
  <header class="page-head">
    <div>
      <h1>Mileage</h1>
      <p>Every journey leg in the log. Filter, sort, and add new journeys.</p>
    </div>
    {#if logsJourneys()}
      <button type="button" class="btn primary" onclick={() => { tripOpen = true; }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        Add journey
      </button>
    {/if}
  </header>

  <div class="kpis summary-kpis">
    <div class="kpi"><span>Journey legs</span><b>{rows.length}</b><small>{totals.days.size} day{totals.days.size === 1 ? '' : 's'}</small></div>
    <div class="kpi"><span>Miles</span><b>{mi(totals.miles)}</b>{#if rows.length}<small>avg {mi(totals.miles / rows.length)} per leg</small>{/if}</div>
    <div class="kpi"><span>Claim</span><b>{money(totals.claim)}</b>{#if hasTest}<small>includes Test rows</small>{/if}</div>
  </div>

  <div class="panel">
    <div class="toolbar">
      <label class="tf"><span>Year</span>
        <select bind:value={year} onchange={resetLimit}>
          <option value="">All years</option>
          {#each years as y (y)}<option value={y}>{y}</option>{/each}
        </select>
      </label>
      <label class="tf"><span>Month</span>
        <select bind:value={month} onchange={resetLimit}>
          <option value="">All months</option>
          {#each MONTHS as m, i (m)}<option value={String(i + 1).padStart(2, '0')}>{m}</option>{/each}
        </select>
      </label>
      {#if viewsAll()}
        <label class="tf"><span>User</span>
          <select bind:value={user} onchange={resetLimit}>
            <option value="">All users</option>
            {#each app.users as u (u.id)}<option value={String(u.id)}>{u.name}</option>{/each}
          </select>
        </label>
      {/if}
      <label class="tf"><span>Customer</span>
        <select bind:value={business} onchange={resetLimit}>
          <option value="">All customers</option>
          {#each businesses as b (b)}<option value={b}>{b}</option>{/each}
        </select>
      </label>
      <label class="tf"><span>Type</span>
        <select bind:value={type} onchange={resetLimit}><option value="">All</option><option value="Live">Live</option><option value="Test">Test</option></select>
      </label>
      <label class="tf grow"><span>Search</span><input type="search" placeholder="Place, address, reason, ticket…" bind:value={search} oninput={resetLimit}></label>
      <button type="button" class="btn small ghost" onclick={clearFilters}>Clear</button>
    </div>
    <div class="table-wrap">
      <table class="grid log" class:hide-user={!viewsAll()}>
        <thead>
          <tr>
            {#each COLUMNS as c (c.key)}
              <th class={c.cls} class:sorted={sort.key === c.key} onclick={() => sortBy(c.key)}>
                {c.label}{sort.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
              </th>
            {/each}
            <th aria-label="Actions"></th>
          </tr>
        </thead>
        <tbody>
          {#if app.logError}
            <tr><td class="empty" colspan="12">{app.logError}</td></tr>
          {:else}
            {#each shown as r (r.entryId)}
              <tr class:clickable={routes} title={routes ? 'Show the route on a map' : undefined} onclick={() => openRoute(r)}>
                <td class="c-user nowrap">{r.userName || '—'}</td>
                <td class="c-date nowrap">{uk(r.date)}</td>
                <td class="c-start trunc" title={r.start}>{r.start}</td>
                <td class="c-dest trunc" title={r.dest}>{r.dest}</td>
                <td class="c-reason trunc" title={r.reason}>{r.reason}</td>
                <td class="c-biz" title={r.business}>{r.business || '—'}</td>
                <td class="c-miles num">{mi(r.miles)}</td>
                <td class="c-rate num">{Math.round(r.rate * 10000) / 100}p</td>
                <td class="c-claim num">{money(r.claim)}</td>
                <td class="c-type"><span class="badge {r.type === 'Test' ? 'test' : 'live'}">{r.type}</span></td>
                <td class="c-ticket">{r.ticket}</td>
                <td class="c-act">
                  {#if canDelete(r)}
                    <button type="button" class="icon-btn del" aria-label="Delete entry" onclick={(e) => { e.stopPropagation(); remove(r); }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
                    </button>
                  {/if}
                </td>
              </tr>
            {:else}
              <tr><td class="empty" colspan="12">
                {app.log.length ? 'No entries match these filters.'
                  : role() === 'accounts' ? 'No journeys have been logged yet.' : 'No journeys yet. Click “Add journey” to log your first trip.'}
              </td></tr>
            {/each}
          {/if}
        </tbody>
        {#if rows.length}
          <tfoot>
            <tr><td class="c-user"></td><td colspan="5">Total · {rows.length} legs</td><td class="num">{mi(totals.miles)}</td>
              <td class="c-rate"></td><td class="num">{money(totals.claim)}</td><td colspan="3"></td></tr>
          </tfoot>
        {/if}
      </table>
    </div>
    <div class="table-foot">
      <span>Showing {shown.length} of {rows.length} matching entries ({app.log.length} in total)</span>
      {#if rows.length > limit}<button type="button" class="btn small" onclick={() => { limit += 200; }}>Show more</button>{/if}
    </div>
  </div>
</section>

<TripModal bind:open={tripOpen} onsaved={onSaved} />

<Modal id="routeModal" size="wide" open={!!route} title={route ? route.title : 'Route'} onclose={() => { route = null; }}>
  {#if route}<iframe class="map-frame" title="Route map" src="/route-map.html?entry={encodeURIComponent(route.entryId)}"></iframe>{/if}
</Modal>
