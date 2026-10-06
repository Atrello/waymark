<script>
  import { untrack } from 'svelte';
  import { api } from '../lib/api.js';
  import { app, isAdmin, logsJourneys, setPlacesAndCustomers } from '../lib/app.svelte.js';
  import { toast, confirmBox, busy } from '../lib/ui.svelte.js';
  import { norm, sortRows, nextSort, COORD_RE } from '../lib/format.js';
  import Modal from '../components/Modal.svelte';
  import Msg from '../components/Msg.svelte';

  const COLUMNS = [
    { key: 'place', label: 'Place' }, { key: 'address', label: 'Address' }, { key: null, label: 'Coordinates' },
    { key: 'business', label: 'Customer' }, { key: null, label: 'Notes' }, { key: 'status', label: 'Status' },
  ];

  let search = $state('');
  let missingOnly = $state(false);
  let sort = $state({ key: 'place', dir: 1 });

  const rows = $derived(sortRows(app.places
    .filter((p) => !(missingOnly && p.lat !== null) && (!search || norm(`${p.place} ${p.address} ${p.business} ${p.notes}`).includes(norm(search))))
    .map((p) => ({ ...p, status: p.lat === null ? 0 : 1 })), sort));
  const missing = $derived(app.places.filter((p) => p.lat === null).length);

  /* ---- Add / edit dialog ---- */
  let editing = $state(null);
  let f = $state({ place: '', address: '', coords: '', lat: '', lng: '', customerId: '', notes: '' });
  let msg = $state(null);
  let gps = $state(null);       // { text, kind }
  let locating = $state(false);
  let saving = $state(false);
  let gpsTicket = 0; // a GPS fix that arrives after the dialog was closed or reopened is ignored

  function openEditor(p) {
    editing = p || {};
    gpsTicket++;
    locating = false;
    untrack(() => {
      f = {
        place: p ? p.place : '', address: p ? p.address : '', coords: '',
        lat: p && p.lat !== null ? String(p.lat) : '', lng: p && p.lng !== null ? String(p.lng) : '',
        customerId: p && p.customerId ? String(p.customerId) : '', notes: p ? p.notes : '',
      };
      msg = null;
      gps = null;
    });
  }
  const close = () => { editing = null; gpsTicket++; locating = false; };

  const coordsBad = $derived(!!f.coords.trim() && !COORD_RE.test(f.coords));
  function onCoords() {
    const m = COORD_RE.exec(f.coords);
    if (m) { f.lat = m[1]; f.lng = m[2]; }
  }
  const mapLink = $derived(f.lat.trim() && f.lng.trim() && isFinite(f.lat) && isFinite(f.lng)
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${f.lat.trim()},${f.lng.trim()}`)}` : '');

  /* "Use my location": fill Lat/Lng from the device GPS. */
  function useGps() {
    if (!window.isSecureContext) {
      gps = { text: 'Location only works over HTTPS (or on the PC via localhost). Open the site through your HTTPS address to use GPS.', kind: 'bad' };
      return;
    }
    if (!navigator.geolocation) { gps = { text: 'This browser does not support location.', kind: 'bad' }; return; }
    locating = true;
    gps = { text: 'Getting a GPS fix… stand outside or near a window for best accuracy.', kind: '' };
    const mine = ++gpsTicket;
    navigator.geolocation.getCurrentPosition((pos) => {
      if (mine !== gpsTicket) return;
      locating = false;
      const acc = Math.round(pos.coords.accuracy);
      f.lat = pos.coords.latitude.toFixed(6);
      f.lng = pos.coords.longitude.toFixed(6);
      f.coords = '';
      gps = acc > 100
        ? { text: `Location filled in, but accuracy is poor (±${acc} m). Try again outdoors, or check it on the map.`, kind: 'warn' }
        : { text: `Location filled in (±${acc} m). Check it on the map, then save.`, kind: 'ok' };
    }, (err) => {
      if (mine !== gpsTicket) return;
      locating = false;
      gps = { kind: 'bad', text: {
        1: 'Location permission was denied. Allow location for this site in your browser settings, then try again.',
        2: 'Your location could not be determined. Check GPS / Location is switched on.',
        3: 'Timed out getting a GPS fix. Try again, ideally outdoors.',
      }[err.code] || `Could not get location: ${err.message}` };
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }

  /* "Pick on map": map-picker.html in an iframe posts {type: 'waymark-map-pin', lat, lng, address} on every pin change. */
  let picker = $state(null);    // iframe src while open
  let pin = $state(null);
  let frame = $state();
  function openPicker() {
    const q = f.address.trim() || f.place.trim();
    const params = f.lat.trim() && f.lng.trim() && isFinite(f.lat) && isFinite(f.lng)
      ? `lat=${encodeURIComponent(f.lat.trim())}&lng=${encodeURIComponent(f.lng.trim())}` : (q ? `q=${encodeURIComponent(q)}` : '');
    pin = null;
    picker = `/map-picker.html${params ? `?${params}` : ''}`;
  }
  function onMessage(e) {
    if (!picker || !frame || e.origin !== location.origin || e.source !== frame.contentWindow) return;
    const m = e.data || {};
    if (m.type !== 'waymark-map-pin' || !isFinite(m.lat) || !isFinite(m.lng)) return;
    pin = { lat: Number(m.lat), lng: Number(m.lng), address: String(m.address || '') };
  }
  function usePin() {
    f.lat = String(pin.lat);
    f.lng = String(pin.lng);
    f.coords = '';
    if (!f.address.trim() && pin.address) f.address = pin.address.slice(0, 300);
    picker = null;
  }

  function afterChange(r) {
    setPlacesAndCustomers(r);
    close();
    toast(r.message);
  }

  async function save() {
    const body = { place: f.place.trim(), address: f.address.trim(), lat: f.lat.trim(), lng: f.lng.trim(), customerId: f.customerId, notes: f.notes.trim() };
    if (!body.place) { msg = { text: 'Place name is required.', kind: 'bad' }; return; }
    const id = editing.id;
    try {
      afterChange(await busy((b) => (saving = b), () => api(id ? 'PUT' : 'POST', id ? `/api/places/${id}` : '/api/places', body)));
    } catch (e) { msg = { text: e.message, kind: 'bad' }; }
  }

  async function remove() {
    if (!(await confirmBox(`Delete ${editing.place}?`, 'The place and its cached distances will be removed.\nExisting log rows keep the name and are not affected.'))) return;
    try { afterChange(await api('DELETE', `/api/places/${editing.id}`)); } catch (e) { msg = { text: e.message, kind: 'bad' }; }
  }
</script>

<svelte:window onmessage={onMessage} />

<section class="page">
  <header class="page-head">
    <div>
      <h1>Places</h1>
      <p>Saved destinations used in the route builder. Click a row to edit.</p>
    </div>
    {#if logsJourneys()}
      <button type="button" class="btn primary" onclick={() => openEditor(null)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        Add place
      </button>
    {/if}
  </header>

  <div class="panel">
    <div class="toolbar">
      <label class="tf grow"><span>Search</span><input type="search" placeholder="Name, address, customer…" bind:value={search}></label>
      <label class="check"><input type="checkbox" bind:checked={missingOnly}> Missing coordinates only</label>
      <span class="muted">{app.places.length} places{missing ? ` · ${missing} missing coordinates` : ''}</span>
    </div>
    <div class="table-wrap">
      <table class="grid places">
        <thead>
          <tr>
            {#each COLUMNS as c (c.label)}
              {#if c.key}
                <th class:sorted={sort.key === c.key} onclick={() => { sort = nextSort(sort, c.key); }}>{c.label}{sort.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>
              {:else}<th>{c.label}</th>{/if}
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each rows as p (p.id)}
            <tr class="clickable" onclick={() => openEditor(p)}>
              <td class="c-place">{p.place}</td>
              <td class="c-addr trunc" title={p.address}>{p.address || '—'}</td>
              <td class="c-coords nowrap">{p.lat === null ? '—' : `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`}</td>
              <td class="c-biz" title={p.business}>{p.business || '—'}</td>
              <td class="c-notes trunc">{p.notes}</td>
              <td class="c-status">{#if p.lat === null}<span class="badge missing">No coordinates</span>{:else}<span class="badge okc">Ready</span>{/if}</td>
            </tr>
          {:else}
            <tr><td class="empty" colspan="6">{app.places.length ? 'No places match.' : 'No places yet. Click “Add place”.'}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</section>

<Modal id="placeModal" open={!!editing} title={editing && editing.id ? `Edit ${editing.place}` : 'Add place'} onclose={close}>
  <Msg {msg} />
  <form autocomplete="off" novalidate onsubmit={(e) => { e.preventDefault(); save(); }}>
    <div class="field">
      <label class="f" for="pPlace">Place <span class="hint">(short unique name, e.g. "Acme Depot")</span></label>
      <!-- svelte-ignore a11y_autofocus -->
      <input id="pPlace" type="text" maxlength="60" required bind:value={f.place} autofocus={window.matchMedia('(min-width: 701px)').matches}>
    </div>
    <div class="field">
      <label class="f" for="pAddress">Address</label>
      <input id="pAddress" type="text" maxlength="300" bind:value={f.address}>
    </div>
    <div class="field">
      <label class="f" for="pCoords">Paste coordinates <span class="hint">(Google Maps → right-click / long-press the pin → copy "54.83, -3.16")</span></label>
      <div class="input-row">
        <input id="pCoords" type="text" inputmode="decimal" placeholder="54.83, -3.16" class:invalid={coordsBad} bind:value={f.coords} oninput={onCoords}>
        <button type="button" class="btn" title="Fill in Lat/Lng from this device's GPS" disabled={locating} onclick={useGps}>
          {#if locating}<span class="spinner"></span> Locating…{:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/></svg>
            Use my location
          {/if}
        </button>
      </div>
      {#if gps}<p class="hint {gps.kind}">{gps.text}</p>{/if}
    </div>
    <div class="grid-2">
      <div class="field"><label class="f" for="pLat">Lat</label><input id="pLat" type="text" inputmode="decimal" bind:value={f.lat}></div>
      <div class="field"><label class="f" for="pLng">Lng</label><input id="pLng" type="text" inputmode="decimal" bind:value={f.lng}></div>
    </div>
    <div class="map-actions">
      {#if app.mapsPicker.configured}
        <button type="button" class="btn" onclick={openPicker}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>
          Pick on map
        </button>
      {/if}
      <div class="date-label map-link">{#if mapLink}<a href={mapLink} target="_blank" rel="noopener">Check on Google Maps ↗</a>{/if}</div>
    </div>
    <div class="field">
      <label class="f" for="pCustomer">Customer</label>
      <select id="pCustomer" bind:value={f.customerId}>
        <option value="">— No customer —</option>
        {#each app.customers as c (c.id)}<option value={String(c.id)}>{c.name}</option>{/each}
      </select>
    </div>
    <div class="field">
      <label class="f" for="pNotes">Notes</label>
      <input id="pNotes" type="text" maxlength="500" bind:value={f.notes}>
    </div>
  </form>
  {#snippet foot()}
    {#if editing && editing.id && isAdmin()}<button type="button" class="btn danger-outline" onclick={remove}>Delete</button>{/if}
    <span class="spacer"></span>
    <button type="button" class="btn" onclick={close}>Cancel</button>
    <button type="button" class="btn primary" disabled={saving} onclick={save}>{#if saving}<span class="spinner"></span>{:else}Save place{/if}</button>
  {/snippet}
</Modal>

<Modal id="mapModal" size="wide" open={!!picker} title="Pick a location" onclose={() => { picker = null; }}>
  {#if picker}<iframe class="map-frame" title="Map" src={picker} bind:this={frame}></iframe>{/if}
  {#snippet foot()}
    <span class="spacer"></span>
    <button type="button" class="btn" onclick={() => { picker = null; }}>Cancel</button>
    <button type="button" class="btn primary" disabled={!pin} onclick={usePin}>Use this location</button>
  {/snippet}
</Modal>
