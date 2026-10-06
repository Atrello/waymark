<script>
  import { api } from '../lib/api.js';
  import { app } from '../lib/app.svelte.js';
  import { confirmBox, busy } from '../lib/ui.svelte.js';
  import Msg from '../components/Msg.svelte';

  let msg = $state(null);
  const ok = (text) => { msg = { text, kind: 'ok' }; };
  const bad = (e) => { msg = { text: e.message || e, kind: 'bad' }; };
  let working = $state({}); // which button is busy

  /* ---- Company settings ---- */
  let rate = $state(app.settings.ratePence);
  async function saveSettings(e) {
    e.preventDefault();
    try {
      const r = await busy((b) => (working.settings = b), () => api('PUT', '/api/settings', { ratePence: Number(rate) }));
      app.settings = r.settings;
      rate = r.settings.ratePence;
      ok(r.message);
    } catch (err) { bad(err); }
  }

  /* ---- Google server key (write-only: the server only ever says whether one is set) ---- */
  let gKey = $state('');
  const g = $derived(app.google);
  async function saveGoogle(e) {
    e.preventDefault();
    if (!gKey.trim()) { msg = { text: 'Paste a key first.', kind: 'warn' }; return; }
    try {
      const r = await busy((b) => (working.gsave = b), () => api('PUT', '/api/settings/google-key', { key: gKey.trim() }));
      gKey = '';
      app.google = r.google;
      ok(`${r.message} Click "Test key" to check it works.`);
    } catch (err) { bad(err); }
  }
  async function testGoogle() {
    msg = null;
    try { ok((await busy((b) => (working.gtest = b), () => api('POST', '/api/settings/google-key/test'))).message); } catch (err) { bad(err); }
  }
  async function removeGoogle() {
    if (!(await confirmBox('Remove Google API key?', 'New distances will not be looked up until a key is added again.\nCached distances keep working.', 'Remove'))) return;
    try {
      const r = await api('DELETE', '/api/settings/google-key');
      app.google = r.google;
      ok(r.message);
    } catch (err) { bad(err); }
  }

  /* ---- Browser key for the maps (not secret: Google restricts it to this site's address) ---- */
  let mKey = $state('');
  const m = $derived(app.mapsPicker);
  async function saveMaps(e) {
    e.preventDefault();
    if (!mKey.trim()) { msg = { text: 'Paste a key first.', kind: 'warn' }; return; }
    try {
      const r = await busy((b) => (working.msave = b), () => api('PUT', '/api/settings/maps-browser-key', { key: mKey.trim() }));
      mKey = '';
      app.mapsPicker = r.mapsPicker;
      ok(`${r.message} Open a place and click "Pick on map" to check it works.`);
    } catch (err) { bad(err); }
  }
  async function removeMaps() {
    if (!(await confirmBox('Remove map picker key?', 'The "Pick on map" button will be hidden. Coordinates can still be pasted or typed in.', 'Remove'))) return;
    try {
      const r = await api('DELETE', '/api/settings/maps-browser-key');
      app.mapsPicker = r.mapsPicker;
      ok(r.message);
    } catch (err) { bad(err); }
  }

  /* ---- Backups ---- */
  let backup = $state(null);
  let freq = $state('off');
  let start = $state('');
  let keep = $state(0);
  function applySchedule(b) { backup = b; freq = b.frequency; start = b.start; keep = b.keep; }
  api('GET', '/api/settings/backup-schedule').then((r) => applySchedule(r.backup)).catch(bad);

  function onFreq() { if (freq === 'hourly' && Number(keep) === 0) keep = 48; } // two days of hourly copies
  const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: '2-digit',
    month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(/,/g, '') : ''); // UK time, like "Next backup"

  async function saveSchedule(e) {
    e.preventDefault();
    try {
      const r = await busy((b) => (working.schedule = b), () => api('PUT', '/api/settings/backup-schedule', { frequency: freq, start, keep }));
      applySchedule(r.backup);
      ok(r.message);
    } catch (err) { bad(err); }
  }
  async function backupNow() {
    try { ok((await busy((b) => (working.backup = b), () => api('POST', '/api/backup'))).message); } catch (err) { bad(err); }
  }
</script>

{#snippet spin(name, label)}{#if working[name]}<span class="spinner"></span>{:else}{label}{/if}{/snippet}

<section class="page">
  <header class="page-head">
    <div>
      <h1>Settings</h1>
      <p>Platform settings for everyone: the mileage rate, Google keys and backups.</p>
    </div>
  </header>
  <Msg {msg} />
  <div class="export-grid">
    <form class="panel" novalidate onsubmit={saveSettings}><div class="panel-body">
      <h2 class="section-title">Company settings</h2>
      <div class="field">
        <label class="f" for="sRate">Mileage rate (pence per mile)</label>
        <input id="sRate" type="number" inputmode="decimal" min="1" max="200" step="0.01" bind:value={rate}>
        <p class="hint">1 to 200 pence, up to 2 decimal places. Every journey is claimed at this rate. Journeys already saved keep the rate they were claimed at.</p>
      </div>
      <button type="submit" class="btn primary" disabled={working.settings}>{@render spin('settings', 'Save settings')}</button>
    </div></form>

    <div class="stack">
      <form class="panel" autocomplete="off" novalidate onsubmit={saveGoogle}><div class="panel-body">
        <h2 class="section-title">Google Maps API key</h2>
        <p class="key-status {g.configured ? 'on' : 'off'}">
          {g.configured ? (g.source === 'env' ? 'Key set (from the server .env file)' : 'Key saved')
            : g.source === 'unreadable' ? 'Saved key can no longer be read (server secret changed). Please enter it again.'
            : 'No key set. Only distances already in the cache can be used.'}
        </p>
        <div class="field">
          <label class="f" for="gKey">{g.configured ? 'Replace key' : 'API key'}</label>
          <input id="gKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="Paste key (AIza…)" bind:value={gKey}>
          <p class="hint">Used only on the server to look up driving distances (Routes API). For security, a saved key can be replaced or removed but never shown.</p>
        </div>
        <div class="btns-row">
          <button type="submit" class="btn primary" disabled={working.gsave}>{@render spin('gsave', 'Save key')}</button>
          <button type="button" class="btn" disabled={!g.configured || working.gtest} onclick={testGoogle}>{@render spin('gtest', 'Test key')}</button>
          {#if g.source === 'app'}<button type="button" class="btn danger-outline" onclick={removeGoogle}>Remove</button>{/if}
        </div>
      </div></form>

      <form class="panel" autocomplete="off" novalidate onsubmit={saveMaps}><div class="panel-body">
        <h2 class="section-title">Map picker key</h2>
        <p class="key-status {m.configured ? 'on' : 'off'}">
          {m.configured ? (m.source === 'env' ? 'Key set (from the server .env file)' : 'Key saved') : 'No key set. The "Pick on map" button is hidden until one is added.'}
        </p>
        <div class="field">
          <label class="f" for="mKey">Browser key</label>
          <input id="mKey" type="text" spellcheck="false" placeholder="Paste key (AIza…)" bind:value={mKey}>
          <p class="hint">Shows Google maps in the app: picking a place's location, and the route of a Mileage entry (click a row). Use a <b>separate</b> key from the one above: this one is sent to signed-in browsers. In Google Cloud, enable the <b>Maps JavaScript API</b> and <b>Geocoding API</b> for it, and restrict it to these websites: {location.origin}/*</p>
        </div>
        <div class="btns-row">
          <button type="submit" class="btn primary" disabled={working.msave}>{@render spin('msave', 'Save key')}</button>
          {#if m.source === 'app'}<button type="button" class="btn danger-outline" onclick={removeMaps}>Remove</button>{/if}
        </div>
      </div></form>

      <div class="panel"><div class="panel-body">
        <h2 class="section-title">Backups</h2>
        <form novalidate onsubmit={saveSchedule}>
          <div class="grid-2">
            <div class="field">
              <label class="f" for="bFreq">Back up automatically</label>
              <select id="bFreq" bind:value={freq} onchange={onFreq}>
                <option value="off">Off</option>
                <option value="hourly">Every hour</option>
                <option value="6h">Every 6 hours</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
                <option value="yearly">Every year</option>
              </select>
            </div>
            {#if freq !== 'off'}
              <div class="field">
                <label class="f" for="bStart">Starting <span class="hint">(UK time)</span></label>
                <input id="bStart" type="datetime-local" bind:value={start}>
              </div>
            {/if}
          </div>
          {#if freq !== 'off'}
            <div class="field" id="bKeepField">
              <label class="f" for="bKeep">Keep the last</label>
              <div class="input-row">
                <input id="bKeep" type="number" inputmode="numeric" min="0" max="10000" step="1" bind:value={keep}>
                <span class="hint">scheduled backups (0 keeps them all). Backups you make by hand are never deleted.</span>
              </div>
            </div>
          {/if}
          {#if backup}
            <p class="hint">
              {backup.frequency === 'off' ? 'Scheduled backups are off.' : `Next backup: ${backup.nextText || '—'}.`}
              {#if backup.lastRun}Last scheduled backup: {when(backup.lastRun)}{backup.lastFile ? ` (${backup.lastFile})` : ''}.{/if}
            </p>
          {/if}
          <button type="submit" class="btn primary mb16" disabled={working.schedule}>{@render spin('schedule', 'Save schedule')}</button>
        </form>
        <p class="hint">Back up by hand at any time. Keep copies somewhere off this machine: HMRC requires 6 years of records.</p>
        <div class="btn-col">
          <a class="btn primary" href="/api/backup/download">Download database backup (.db)</a>
          <button type="button" class="btn" disabled={working.backup} onclick={backupNow}>{@render spin('backup', 'Save backup on server now')}</button>
        </div>
      </div></div>
    </div>
  </div>
</section>
