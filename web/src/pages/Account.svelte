<script>
  import { tick, untrack } from 'svelte';
  import qrcode from 'qrcode-generator';
  import { api, authCall, passkeysSupported, registerPasskey } from '../lib/api.js';
  import { app, ROLE_LABELS } from '../lib/app.svelte.js';
  import { toast, confirmBox, askPassword, busy } from '../lib/ui.svelte.js';
  import { uk } from '../lib/format.js';
  import Msg from '../components/Msg.svelte';

  let msg = $state(null);
  const ok = (text) => { msg = { text, kind: 'ok' }; };
  const bad = (e) => { msg = { text: e.message || e, kind: 'bad' }; };
  let working = $state('');

  /* ---- Profile ---- */
  let name = $state(app.me.name);
  let email = $state(app.me.email || '');
  async function saveProfile(e) {
    e.preventDefault();
    try {
      const r = await busy((b) => (working = b ? 'profile' : ''), () => api('PUT', '/api/me', { name: name.trim(), email: email.trim() }));
      app.me = { ...app.me, ...r.me };
      email = r.me.email || '';
      ok(r.message);
    } catch (err) { bad(err); }
  }

  /* ---- Password ---- */
  let pwCurrent = $state('');
  let pwNew = $state('');
  let pwNew2 = $state('');
  let pwCurrentEl = $state();
  $effect(() => { if (app.mustChangePassword && pwCurrentEl) pwCurrentEl.focus(); });
  async function changePassword(e) {
    e.preventDefault();
    if (pwNew !== pwNew2) { msg = { text: 'The new passwords do not match.', kind: 'bad' }; return; }
    try {
      const r = await busy((b) => (working = b ? 'password' : ''), () => api('PUT', '/api/me/password', { current: pwCurrent, next: pwNew }));
      pwCurrent = pwNew = pwNew2 = '';
      app.mustChangePassword = false;
      ok(r.message);
    } catch (err) { bad(err); }
  }

  /* ---- Two-factor ---- */
  let tf = $state(null);        // setup in progress: { step: 'scan' | 'codes', qr, secret, code }
  let pendingCodes = [];
  let codeEl = $state();
  let setupEl = $state();

  async function turnOn() {
    const pw = await askPassword('Turn on two-factor sign-in', 'Enter your password to start.', 'Continue');
    if (!pw) return;
    try {
      const r = await busy((b) => (working = b ? 'tfon' : ''), () => authCall('POST', '/two-factor/enable', { password: pw }));
      const qr = qrcode(0, 'M');
      qr.addData(r.totpURI);
      qr.make();
      pendingCodes = r.backupCodes || [];
      tf = { step: 'scan', qr: qr.createDataURL(5, 2), secret: (new URL(r.totpURI).searchParams.get('secret') || '').replace(/(.{4})/g, '$1 ').trim(), code: '' };
      await tick();
      codeEl?.focus();
    } catch (err) { bad(err); }
  }
  async function verify() {
    const code = tf.code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) { msg = { text: 'Enter the 6-digit code from your authenticator app.', kind: 'warn' }; return; }
    try {
      await busy((b) => (working = b ? 'verify' : ''), () => authCall('POST', '/two-factor/verify-totp', { code }));
      app.me.twoFactorEnabled = true;
      ok('Two-factor sign-in is on. You will be asked for a code after your password.');
      showCodes(pendingCodes);
    } catch (err) { bad(err); }
  }
  async function showCodes(codes) {
    tf = { step: 'codes', codes: codes || [] };
    await tick();
    setupEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function copyCodes() {
    (navigator.clipboard ? navigator.clipboard.writeText(tf.codes.join('\n')) : Promise.reject())
      .then(() => toast('Backup codes copied.'))
      .catch(() => toast('Copy failed: select the codes and copy them manually.'));
  }
  async function turnOff() {
    const pw = await askPassword('Turn off two-factor sign-in', 'You will only need your password (or a passkey) to sign in.', 'Turn off');
    if (!pw) return;
    try {
      await busy((b) => (working = b ? 'tfoff' : ''), () => authCall('POST', '/two-factor/disable', { password: pw }));
      app.me.twoFactorEnabled = false;
      tf = null;
      ok('Two-factor sign-in is off.');
    } catch (err) { bad(err); }
  }
  async function newCodes() {
    const pw = await askPassword('New backup codes', 'Your old backup codes will stop working.', 'Create new codes');
    if (!pw) return;
    try {
      const r = await busy((b) => (working = b ? 'codes' : ''), () => authCall('POST', '/two-factor/generate-backup-codes', { password: pw }));
      showCodes(r.backupCodes);
    } catch (err) { bad(err); }
  }

  // "Set up now" in the suggestion after first-run setup.
  $effect(() => {
    if (app.startTwoFactor) {
      app.startTwoFactor = false;
      if (!app.me.twoFactorEnabled) untrack(turnOn);
    }
  });

  /* ---- Passkeys ---- */
  const supported = passkeysSupported();
  let passkeys = $state([]);
  async function loadPasskeys() {
    try { passkeys = (await authCall('GET', '/passkey/list-user-passkeys')) || []; } catch { passkeys = []; }
  }
  loadPasskeys();

  function deviceName() {
    const ua = navigator.userAgent;
    const dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone'
      : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'This device';
    return `${dev} (${uk(app.today)})`;
  }
  async function addPasskey() {
    try {
      await busy((b) => (working = b ? 'pk' : ''), () => registerPasskey(deviceName()));
      toast('Passkey added. You can now sign in with it.');
      loadPasskeys();
    } catch (err) { bad(err); }
  }
  async function removePasskey(k) {
    if (!(await confirmBox('Remove passkey?', `${k.name || 'Passkey'} will no longer be able to sign in.`, 'Remove'))) return;
    try {
      await authCall('POST', '/passkey/delete-passkey', { id: k.id });
      toast('Passkey removed.');
      loadPasskeys();
    } catch (err) { bad(err); }
  }
</script>

{#snippet spin(id, label)}{#if working === id}<span class="spinner"></span>{:else}{label}{/if}{/snippet}

<section class="page">
  <header class="page-head">
    <div>
      <h1>Account</h1>
      <p>Your profile, password, two-factor sign-in and passkeys.</p>
    </div>
  </header>
  <Msg {msg} />
  <div class="account-grid mb16">
    <form class="panel" novalidate onsubmit={saveProfile}><div class="panel-body">
      <h2 class="section-title">My account</h2>
      <p class="hint mb10">Signed in as {app.me.username} · {ROLE_LABELS[app.me.role]}</p>
      <div class="field">
        <label class="f" for="meName">Name</label>
        <input id="meName" type="text" maxlength="80" bind:value={name}>
      </div>
      <div class="field">
        <label class="f" for="meEmail">Email <span class="hint">(optional)</span></label>
        <input id="meEmail" type="email" maxlength="200" autocomplete="email" autocapitalize="none" spellcheck="false" bind:value={email}>
        <p class="hint">Shown in your authenticator app and on passkeys. You sign in with your username, not your email.</p>
      </div>
      <button type="submit" class="btn primary" disabled={working === 'profile'}>{@render spin('profile', 'Save profile')}</button>
    </div></form>

    <form class="panel" autocomplete="off" novalidate onsubmit={changePassword}><div class="panel-body">
      <h2 class="section-title">Change password</h2>
      <div class="field">
        <label class="f" for="pwCurrent">Current password</label>
        <input id="pwCurrent" type="password" autocomplete="current-password" bind:value={pwCurrent} bind:this={pwCurrentEl}>
      </div>
      <div class="field">
        <label class="f" for="pwNew">New password <span class="hint">(at least 10 characters)</span></label>
        <input id="pwNew" type="password" autocomplete="new-password" bind:value={pwNew}>
      </div>
      <div class="field">
        <label class="f" for="pwNew2">Confirm new password</label>
        <input id="pwNew2" type="password" autocomplete="new-password" bind:value={pwNew2}>
      </div>
      <button type="submit" class="btn primary" disabled={working === 'password'}>{@render spin('password', 'Change password')}</button>
    </div></form>
  </div>

  <div class="panel mb16"><div class="panel-body">
    <h2 class="section-title">Sign-in security</h2>
    <p class="hint mb16">Both are optional. Two-factor adds a code from your phone after your password; a passkey lets you sign in with your fingerprint, face or device PIN instead of a password.</p>

    <div class="sec-row">
      <div class="sec-text">
        <b>Two-factor sign-in</b> <span class="badge {app.me.twoFactorEnabled ? 'live' : 'inactive'}">{app.me.twoFactorEnabled ? 'On' : 'Off'}</span>
        <p class="hint">Uses an authenticator app such as Microsoft Authenticator, Google Authenticator or 1Password.</p>
      </div>
      <div class="sec-actions">
        {#if app.me.twoFactorEnabled}
          <button type="button" class="btn" disabled={working === 'codes'} onclick={newCodes}>{@render spin('codes', 'New backup codes')}</button>
          <button type="button" class="btn danger-outline" disabled={working === 'tfoff'} onclick={turnOff}>{@render spin('tfoff', 'Turn off')}</button>
        {:else}
          <button type="button" class="btn" disabled={working === 'tfon'} onclick={turnOn}>{@render spin('tfon', 'Turn on')}</button>
        {/if}
      </div>
    </div>

    {#if tf}
      <div class="tf-setup" bind:this={setupEl}>
        {#if tf.step === 'scan'}
          <p><b>1.</b> Scan this QR code with your authenticator app.</p>
          <div class="qr-wrap"><img src={tf.qr} alt="QR code for your authenticator app"></div>
          <p class="hint">Can't scan it? Enter this key manually: <code class="secret">{tf.secret}</code></p>
          <p><b>2.</b> Enter the 6-digit code the app shows.</p>
          <div class="input-row">
            <input type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" bind:value={tf.code} bind:this={codeEl}
              onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); verify(); } }}>
            <button type="button" class="btn primary" disabled={working === 'verify'} onclick={verify}>{@render spin('verify', 'Verify')}</button>
          </div>
          <button type="button" class="link-plain" onclick={() => { tf = null; msg = null; }}>Cancel</button>
        {:else}
          <p><b>Save your backup codes.</b> Each one signs you in once if you lose your phone. Keep them somewhere safe (e.g. your password manager). They won't be shown again.</p>
          <ol class="backup-codes">{#each tf.codes as c (c)}<li><code>{c}</code></li>{/each}</ol>
          <div class="btns-row">
            <button type="button" class="btn" onclick={copyCodes}>Copy codes</button>
            <button type="button" class="btn primary" onclick={() => { tf = null; pendingCodes = []; }}>I've saved them</button>
          </div>
        {/if}
      </div>
    {/if}

    <div class="sec-row">
      <div class="sec-text">
        <b>Passkeys</b> <span class="badge {passkeys.length ? 'live' : 'inactive'}">{passkeys.length ? `${passkeys.length} added` : 'None'}</span>
        <p class="hint">{supported ? 'Add one on each device you use (phone, laptop).'
          : 'Not available at this address: passkeys need the site opened over HTTPS (or on this PC via localhost).'}</p>
      </div>
      <div class="sec-actions">
        <button type="button" class="btn" disabled={!supported || working === 'pk'} onclick={addPasskey}>{@render spin('pk', 'Add a passkey')}</button>
      </div>
    </div>
    <ul class="key-list">
      {#each passkeys as k (k.id)}
        <li>
          <span><b>{k.name || 'Passkey'}</b><small>Added {uk(String(k.createdAt).slice(0, 10))}{k.backedUp ? ' · synced' : ''}</small></span>
          <button type="button" class="btn small danger-outline" onclick={() => removePasskey(k)}>Remove</button>
        </li>
      {/each}
    </ul>
  </div></div>
</section>
