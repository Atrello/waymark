<script>
  import { tick, untrack } from 'svelte';
  import { api } from '../lib/api.js';
  import { app, placeByName, isHome, homePlace } from '../lib/app.svelte.js';
  import { toast, busy } from '../lib/ui.svelte.js';
  import { norm, mi, money, ukLong, randomId } from '../lib/format.js';
  import Modal from '../components/Modal.svelte';
  import Msg from '../components/Msg.svelte';

  let { open = $bindable(false), onsaved } = $props();

  const MAX_STOPS = 15;
  let date = $state('');
  let dataType = $state('Live');
  let stops = $state(['', '']);
  let reason = $state('Site visit');
  let ticket = $state('');
  let customerId = $state('');
  let rate = $state('');
  let msg = $state(null);
  let preview = $state(null);       // the server's preview of the trip
  let previewKey = $state(null);    // JSON of the payload that was previewed
  let submissionId = $state(null);  // one save per preview (double-click guard)
  let previewing = $state(false);
  let saving = $state(false);
  let inputs = $state([]);
  let suggestFor = $state(-1);      // index of the stop whose suggestion list is open
  let active = $state(0);           // highlighted suggestion
  let previewEl = $state();

  // Reset the form each time it opens (untracked: only `open` should re-run this, not app data changing meanwhile).
  $effect(() => { if (open) untrack(reset); });
  function reset() {
    date = app.today;
    dataType = 'Live';
    reason = 'Site visit';
    ticket = '';
    customerId = '';
    rate = app.me.ratePence;
    stops = [homePlace(), ''];
    msg = null;
    preview = null;
    previewKey = null;
    suggestFor = -1;
    tick().then(() => { if (inputs[1] && window.matchMedia('(min-width: 701px)').matches) inputs[1].focus(); });
  }

  const payload = $derived({
    date, stops: stops.map((s) => s.trim()), reason: reason.trim(), ticket: ticket.trim(), customerId,
    ratePence: rate === '' || rate === null ? '' : Number(rate), dataType,
  });
  const fresh = $derived(previewKey !== null && JSON.stringify(payload) === previewKey);

  /* ---- Place search for each stop ---- */
  function matches(q) {
    q = norm(q);
    const list = app.places.slice().sort((a, b) => (isHome(a.place) ? 0 : 1) - (isHome(b.place) ? 0 : 1) || a.place.localeCompare(b.place));
    if (!q) return list.slice(0, 60);
    const starts = [], contains = [];
    for (const p of list) {
      const n = norm(p.place);
      if (n.startsWith(q)) starts.push(p);
      else if (n.includes(q) || norm(p.address).includes(q) || norm(p.business).includes(q)) contains.push(p);
    }
    return starts.concat(contains).slice(0, 60);
  }
  const suggestions = $derived(suggestFor >= 0 ? matches(stops[suggestFor] || '') : []);
  const invalid = (v) => !!v.trim() && !placeByName(v);

  function openSuggest(i) { suggestFor = i; active = 0; }
  function choose(i, place) {
    stops[i] = place;
    suggestFor = -1;
    const next = inputs[i + 1];
    if (next && !stops[i + 1]) next.focus(); else inputs[i] && inputs[i].blur();
  }
  function onBlur(i) {
    setTimeout(() => {
      const p = placeByName(stops[i]);
      if (p && stops[i] !== p.place) stops[i] = p.place; // tidy to the saved spelling
      if (suggestFor === i) suggestFor = -1;
    }, 150);
  }
  function onKey(e, i) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (suggestFor !== i) openSuggest(i);
      if (!suggestions.length) return;
      active = e.key === 'ArrowDown' ? Math.min(suggestions.length - 1, active + 1) : Math.max(0, active - 1);
      tick().then(() => document.querySelector('.suggest button.active')?.scrollIntoView({ block: 'nearest' }));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestFor === i && suggestions[active]) choose(i, suggestions[active].place);
    } else if (e.key === 'Escape' && suggestFor === i) {
      e.stopPropagation(); // close the list, not the dialog
      suggestFor = -1;
    }
  }

  /* ---- Route editing ---- */
  function move(i, d) { const j = i + d; [stops[i], stops[j]] = [stops[j], stops[i]]; }
  function removeStop(i) { if (stops.length > 2) stops.splice(i, 1); }
  async function addStop() {
    if (stops.length >= MAX_STOPS) { toast(`Maximum ${MAX_STOPS} stops.`); return; }
    stops.push('');
    await tick();
    inputs[stops.length - 1]?.focus();
  }
  function returnToStart() {
    const first = stops[0].trim();
    if (!first) { toast('Pick the first stop first.'); return; }
    const last = stops.length - 1;
    if (norm(stops[last]) === norm(first)) { toast(`Route already returns to ${first}.`); return; }
    if (!stops[last].trim()) stops[last] = first; else stops.push(first);
  }
  async function roundTripHome() {
    const home = homePlace();
    if (!home) { toast('Set your home place first (click your name at the bottom left → Account).'); return; }
    const mid = stops.map((s) => s.trim()).filter(Boolean);
    if (mid.length && norm(mid[0]) === norm(home)) mid.shift();
    if (mid.length && norm(mid[mid.length - 1]) === norm(home)) mid.pop();
    stops = [home, ...(mid.length ? mid : ['']), home];
    await tick();
    const empty = stops.indexOf('');
    if (empty >= 0) inputs[empty]?.focus();
  }

  /* ---- Preview + save ---- */
  function clientCheck(p) {
    if (!p.date) return 'Pick a date.';
    if (p.date > app.today) return 'Date cannot be in the future.';
    for (let i = 0; i < p.stops.length; i++) {
      if (!p.stops[i]) return `Stop ${i + 1} is empty.`;
      if (!placeByName(p.stops[i])) return `"${p.stops[i]}" is not a saved place. Pick from the list or add it on the Places page.`;
    }
    if (!(p.ratePence > 0 && p.ratePence <= 200)) return 'Rate must be between 1 and 200 pence.';
    return '';
  }

  async function doPreview() {
    msg = null;
    const p = $state.snapshot(payload);
    const err = clientCheck(p);
    if (err) { msg = { text: err, kind: 'bad' }; return; }
    previewKey = null;
    try {
      const r = await busy((b) => (previewing = b), () => api('POST', '/api/trips/preview', p));
      preview = r;
      previewKey = JSON.stringify(p);
      submissionId = randomId();
      await tick();
      previewEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      preview = null;
      msg = { text: e.message, kind: 'bad' };
    }
  }

  async function save() {
    const p = $state.snapshot(payload);
    if (JSON.stringify(p) !== previewKey) { msg = { text: 'Preview again before saving.', kind: 'warn' }; return; }
    msg = null;
    try {
      const r = await busy((b) => (saving = b), () => api('POST', '/api/trips', { ...p, submissionId }));
      open = false;
      toast(r.message);
      onsaved?.(p.date);
    } catch (e) {
      msg = { text: e.message, kind: 'bad' };
    }
  }
</script>

<Modal id="tripModal" size="wide" bind:open title="Add journey">
  <Msg {msg} />
  <form autocomplete="off" novalidate onsubmit={(e) => e.preventDefault()}>
    <div class="grid-2">
      <div class="field">
        <label class="f" for="tDate">Date</label>
        <input id="tDate" type="date" max={app.today} required bind:value={date}>
        <div class="date-label">{ukLong(date)}</div>
      </div>
      <div class="field">
        <span class="f">Data type</span>
        <div class="seg">
          <label><input type="radio" name="tType" value="Live" bind:group={dataType}><span>Live</span></label>
          <label><input type="radio" name="tType" value="Test" bind:group={dataType}><span>Test</span></label>
        </div>
      </div>
    </div>

    <h3 class="section-title">Route</h3>
    <ol class="stops">
      {#each stops as stop, i (i)}
        <li class="stop">
          <span class="n">{i + 1}</span>
          <div class="combo">
            <input class="place-input" class:invalid={suggestFor !== i && invalid(stop)} type="text" autocomplete="off" autocorrect="off"
              spellcheck="false" placeholder="{i === 0 ? 'Start' : `Stop ${i + 1}`}…" aria-label="Stop {i + 1}"
              bind:value={stops[i]} bind:this={inputs[i]}
              onfocus={(e) => { e.currentTarget.select(); openSuggest(i); }} oninput={() => openSuggest(i)}
              onblur={() => onBlur(i)} onkeydown={(e) => onKey(e, i)}>
            {#if suggestFor === i}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="suggest" onmousedown={(e) => e.preventDefault()}>
                {#each suggestions as p, k (p.id)}
                  <button type="button" class:active={k === active} onclick={() => choose(i, p.place)}>
                    <b>{p.place}</b>{#if p.lat === null} <span class="badge missing">no coords</span>{/if}
                    <small>{p.address || p.business || ''}</small>
                  </button>
                {:else}
                  <div class="none">No match. Add it on the Places page.</div>
                {/each}
              </div>
            {/if}
          </div>
          <button type="button" class="sbtn" aria-label="Move up" disabled={i === 0} onclick={() => move(i, -1)}>▲</button>
          <button type="button" class="sbtn" aria-label="Move down" disabled={i === stops.length - 1} onclick={() => move(i, 1)}>▼</button>
          <button type="button" class="sbtn" aria-label="Remove stop" disabled={stops.length <= 2} onclick={() => removeStop(i)}>✕</button>
        </li>
      {/each}
    </ol>
    <div class="quick">
      <button type="button" class="btn small" onclick={addStop}>＋ Add stop</button>
      <button type="button" class="btn small" onclick={returnToStart}>↩ Return to start</button>
      <button type="button" class="btn small" onclick={roundTripHome}>⌂ Round trip Home</button>
    </div>

    <h3 class="section-title">Details</h3>
    <div class="field">
      <label class="f" for="tReason">Visit reason</label>
      <input id="tReason" type="text" maxlength="200" bind:value={reason}>
    </div>
    <div class="grid-2">
      <div class="field">
        <label class="f" for="tTicket">Ticket ID <span class="hint">(optional)</span></label>
        <input id="tTicket" type="text" maxlength="50" bind:value={ticket}>
      </div>
      <div class="field">
        <label class="f" for="tRate">Rate (pence/mile)</label>
        <input id="tRate" type="number" inputmode="decimal" min="1" max="200" step="0.01" bind:value={rate}>
      </div>
    </div>
    <div class="field">
      <label class="f" for="tCustomer">Customer override <span class="hint">(optional, applies to every leg)</span></label>
      <select id="tCustomer" bind:value={customerId}>
        <option value="">Use each site's customer</option>
        {#each app.customers as c (c.id)}<option value={String(c.id)}>{c.name}</option>{/each}
      </select>
    </div>
  </form>

  {#if preview}
    <div class="preview" class:stale={!fresh} bind:this={previewEl}>
      <h3>Preview · {ukLong(preview.date)}</h3>
      {#if preview.duplicates.length}
        <div class="msg warn">You've already logged {preview.duplicates.length === 1 ? 'this leg' : 'these legs'} on {preview.dateUk} with the same ticket ID:
{preview.duplicates.join('\n')}
If you made the trip again, save as normal and it will be added as a separate entry.</div>
      {/if}
      {#each preview.warnings as w (w)}<div class="msg warn">{w}</div>{/each}
      {#if preview.skipped.length}<div class="msg info">Skipped (same place): {preview.skipped.join(', ')}</div>{/if}
      <table>
        <thead><tr><th>#</th><th>Leg</th><th class="num">Miles</th><th class="num">Claim</th></tr></thead>
        <tbody>
          {#each preview.legs as l (l.n)}
            <tr>
              <td>{l.n}</td>
              <td>{l.from} → {l.to}<span class="sub">{l.business || 'no business'} · <span class="badge {l.source}">{l.source === 'google' ? 'Google' : 'Cache'}</span></span></td>
              <td class="num">{mi(l.miles)}</td><td class="num">{money(l.claim)}</td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr><td></td><td>Total · {preview.legs.length} leg{preview.legs.length === 1 ? '' : 's'} @ {preview.ratePence}p</td>
            <td class="num">{mi(preview.totalMiles)}</td><td class="num">{money(preview.totalClaim)}</td></tr>
        </tfoot>
      </table>
    </div>
  {/if}

  {#snippet foot()}
    <button type="button" class="btn" onclick={() => { open = false; }}>Cancel</button>
    <button type="button" class="btn primary" disabled={previewing} onclick={doPreview}>
      {#if previewing}<span class="spinner"></span>{:else}Preview{/if}
    </button>
    <button type="button" class="btn ok" disabled={!fresh || saving} onclick={save}>
      {#if saving}<span class="spinner"></span>{:else}Save{/if}
    </button>
  {/snippet}
</Modal>
