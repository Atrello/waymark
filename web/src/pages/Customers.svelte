<script>
  import { untrack } from 'svelte';
  import { api } from '../lib/api.js';
  import { app, isHome, setPlacesAndCustomers, loadLog } from '../lib/app.svelte.js';
  import { toast, confirmBox, busy } from '../lib/ui.svelte.js';
  import { norm, mi, money, uk, sortRows, nextSort } from '../lib/format.js';
  import Modal from '../components/Modal.svelte';
  import Msg from '../components/Msg.svelte';

  const COLUMNS = [
    { key: 'name', label: 'Customer' }, { key: null, label: 'Sites' }, { key: 'legs', label: 'Legs', cls: 'num' },
    { key: 'miles', label: 'Miles', cls: 'num' }, { key: 'claim', label: 'Claim', cls: 'num' }, { key: 'lastVisit', label: 'Last visit' },
  ];

  let search = $state('');
  let sort = $state({ key: 'name', dir: 1 });
  const sitesOf = (id) => app.places.filter((p) => p.customerId === id);

  const rows = $derived(sortRows(app.customers.filter((c) => {
    const q = norm(search);
    return !q || norm(`${c.name} ${sitesOf(c.id).map((p) => p.place).join(' ')}`).includes(q);
  }), sort));
  const unassigned = $derived(app.places.filter((p) => !p.customerId && !isHome(p.place)).length);

  /* ---- Add / edit dialog ---- */
  let editing = $state(null);   // the customer being edited, {} for a new one, null when closed
  let name = $state('');
  let notes = $state('');
  let siteSearch = $state('');
  let checked = $state({});     // placeId -> ticked
  let mergeInto = $state('');
  let msg = $state(null);
  let saving = $state(false);
  let merging = $state(false);

  function openEditor(c) {
    editing = c || {};
    untrack(() => {
      name = c ? c.name : '';
      notes = c ? c.notes : '';
      siteSearch = '';
      mergeInto = '';
      msg = null;
      checked = Object.fromEntries((c ? sitesOf(c.id) : []).map((p) => [p.id, true]));
    });
  }
  const close = () => { editing = null; };
  const siteList = $derived(app.places.filter((p) => !siteSearch || norm(`${p.place} ${p.address} ${p.business}`).includes(norm(siteSearch))));

  function afterChange(r) {
    setPlacesAndCustomers(r);
    close();
    toast(r.message);
    loadLog();
  }

  async function save() {
    const body = { name: name.trim(), notes: notes.trim(), placeIds: Object.keys(checked).filter((k) => checked[k]).map(Number) };
    if (!body.name) { msg = { text: 'Customer name is required.', kind: 'bad' }; return; }
    const id = editing.id;
    const moving = body.placeIds.map((pid) => app.places.find((p) => p.id === pid)).filter((p) => p && p.customerId && p.customerId !== id);
    if (moving.length && !(await confirmBox('Move sites?', `${moving.map((p) => `${p.place} (now ${p.business})`).join('\n')}\n\nwill move to ${body.name}. Past journeys keep their customer.`, 'Move'))) return;
    try {
      afterChange(await busy((b) => (saving = b), () => api(id ? 'PUT' : 'POST', id ? `/api/customers/${id}` : '/api/customers', body)));
    } catch (e) { msg = { text: e.message, kind: 'bad' }; }
  }

  async function merge() {
    if (!mergeInto) { msg = { text: 'Choose the customer to merge into.', kind: 'warn' }; return; }
    const into = app.customers.find((c) => String(c.id) === mergeInto);
    if (!(await confirmBox('Merge customers?', `All sites and past journey legs of "${editing.name}" will move to "${into.name}", and "${editing.name}" will be removed.`, 'Merge'))) return;
    try {
      afterChange(await busy((b) => (merging = b), () => api('POST', `/api/customers/${editing.id}/merge`, { intoId: Number(mergeInto) })));
    } catch (e) { msg = { text: e.message, kind: 'bad' }; }
  }

  async function remove() {
    if (!(await confirmBox(`Delete ${editing.name}?`, "Its sites will become unassigned. Customers with past journeys can't be deleted; use Merge instead."))) return;
    try { afterChange(await api('DELETE', `/api/customers/${editing.id}`)); } catch (e) { msg = { text: e.message, kind: 'bad' }; }
  }
</script>

<section class="page">
  <header class="page-head">
    <div>
      <h1>Customers</h1>
      <p>Each site belongs to a customer. Rename a customer here and it updates everywhere.</p>
    </div>
    <button type="button" class="btn primary" onclick={() => openEditor(null)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      Add customer
    </button>
  </header>
  <div class="panel">
    <div class="toolbar">
      <label class="tf grow"><span>Search</span><input type="search" placeholder="Customer or site name…" bind:value={search}></label>
      <span class="muted">{app.customers.length} customers{unassigned ? ` · ${unassigned} site(s) without a customer` : ''}</span>
    </div>
    <div class="table-wrap">
      <table class="grid customers">
        <thead>
          <tr>
            {#each COLUMNS as c (c.label)}
              {#if c.key}
                <th class={c.cls} class:sorted={sort.key === c.key} onclick={() => { sort = nextSort(sort, c.key, c.key === 'name' ? 1 : -1); }}>
                  {c.label}{sort.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
                </th>
              {:else}<th>{c.label}</th>{/if}
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each rows as c (c.id)}
            <tr class="clickable" onclick={() => openEditor(c)}>
              <td class="c-name">{c.name}{#if c.notes}<span class="sub muted"> · {c.notes}</span>{/if}</td>
              <td class="c-sites"><div class="chips">
                {#each sitesOf(c.id) as p (p.id)}<span class="chip">{p.place}</span>{:else}<span class="muted">No sites</span>{/each}
              </div></td>
              <td class="c-legs num">{c.legs}</td>
              <td class="c-miles num">{mi(c.miles)}</td>
              <td class="c-claim num">{money(c.claim)}</td>
              <td class="c-last nowrap">{c.lastVisit ? uk(c.lastVisit) : '—'}</td>
            </tr>
          {:else}
            <tr><td class="empty" colspan="6">{app.customers.length ? 'No customers match.' : 'No customers yet. Click “Add customer”.'}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="table-foot"><span>Totals are Live journeys, all time.</span></div>
  </div>
</section>

<Modal id="customerModal" open={!!editing} title={editing && editing.id ? `Edit ${editing.name}` : 'Add customer'} onclose={close}>
  <Msg {msg} />
  <form autocomplete="off" novalidate onsubmit={(e) => { e.preventDefault(); save(); }}>
    <div class="field">
      <label class="f" for="cName">Customer name</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input id="cName" type="text" maxlength="100" required bind:value={name} autofocus={window.matchMedia('(min-width: 701px)').matches}>
    </div>
    <div class="field">
      <label class="f" for="cNotes">Notes</label>
      <input id="cNotes" type="text" maxlength="500" bind:value={notes}>
    </div>
    <h3 class="section-title">Sites</h3>
    <p class="hint mb10">Tick the sites that belong to this customer. Moving a site from another customer only changes future journeys.</p>
    <input type="search" placeholder="Filter sites…" class="mb10" bind:value={siteSearch}>
    <div class="site-list">
      {#each siteList as p (p.id)}
        {@const other = p.customerId && p.customerId !== editing?.id ? p.business : ''}
        <label>
          <input type="checkbox" bind:checked={checked[p.id]}>
          <span class="site-name">{p.place}</span>
          {#if other}<small>now: {other}</small>{:else if !p.customerId}<small>unassigned</small>{/if}
        </label>
      {:else}
        <div class="none">No sites match.</div>
      {/each}
    </div>
  </form>
  {#if editing && editing.id}
    <div class="merge-box">
      <h3 class="section-title">Merge into another customer</h3>
      <p class="hint mb10">Moves every site and past journey leg to the chosen customer, then removes this one. Use it to tidy up duplicates.</p>
      <div class="input-row">
        <select bind:value={mergeInto}>
          <option value="">Choose customer…</option>
          {#each app.customers.filter((x) => x.id !== editing.id) as x (x.id)}<option value={String(x.id)}>{x.name}</option>{/each}
        </select>
        <button type="button" class="btn" disabled={merging} onclick={merge}>{#if merging}<span class="spinner"></span>{:else}Merge{/if}</button>
      </div>
    </div>
  {/if}
  {#snippet foot()}
    {#if editing && editing.id}<button type="button" class="btn danger-outline" onclick={remove}>Delete</button>{/if}
    <span class="spacer"></span>
    <button type="button" class="btn" onclick={close}>Cancel</button>
    <button type="button" class="btn primary" disabled={saving} onclick={save}>{#if saving}<span class="spinner"></span>{:else}Save customer{/if}</button>
  {/snippet}
</Modal>
