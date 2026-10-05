<script>
  /* Sign-in: password, then a two-factor code if the user has turned it on; or a passkey.
   * On a brand-new install (no accounts yet) it offers to create the administrator account instead. */
  import { onMount, tick } from 'svelte';
  import { authCall, passkeysSupported, signInWithPasskey } from '../lib/api.js';
  import { busy } from '../lib/ui.svelte.js';

  let mode = $state('password'); // 'setup' | 'password' | 'totp' | 'backup'
  let error = $state('');
  let working = $state(false);

  let username = $state('');
  let password = $state('');
  let code = $state('');
  let trustDevice = $state(false);
  let setup = $state({ username: '', email: '', password: '', confirm: '' });
  let codeEl = $state();
  let passwordEl = $state();
  let setupUserEl = $state();
  const passkeys = passkeysSupported();

  const done = () => location.replace('/');

  async function setMode(m) {
    mode = m;
    if (m === 'totp' || m === 'backup') { code = ''; await tick(); codeEl?.focus(); }
  }

  async function submit(e) {
    e.preventDefault();
    error = '';
    try {
      if (mode === 'setup') await createAccount();
      else if (mode === 'password') await signIn();
      else await verifyCode();
    } catch (err) {
      error = err.message;
    }
  }

  async function createAccount() {
    const s = { ...setup, username: setup.username.trim(), email: setup.email.trim() };
    if (!s.username || !s.email || !s.password) throw new Error('Enter a username, email and password.');
    if (s.password.length < 10) throw new Error('Password must be at least 10 characters.');
    if (s.password !== s.confirm) throw new Error("The passwords don't match.");
    const res = await busy((b) => (working = b), () => fetch('/api/setup', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'waymark' },
      body: JSON.stringify({ username: s.username, email: s.email, password: s.password }),
    }));
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (/already been set up/.test(j.error || '')) setMode('password'); // someone else got there first
      throw new Error(j.error || 'Could not create the account.');
    }
    done();
  }

  async function signIn() {
    if (!username.trim() || !password) throw new Error('Enter your username and password.');
    const r = await busy((b) => (working = b), () => authCall('POST', '/sign-in/username', { username: username.trim(), password, rememberMe: true }));
    if (r && r.twoFactorRedirect) { setMode('totp'); return; }
    done();
  }

  async function verifyCode() {
    const c = code.replace(/\s+/g, '');
    if (!c) throw new Error('Enter the code.');
    try {
      await busy((b) => (working = b), () => authCall('POST', mode === 'totp' ? '/two-factor/verify-totp' : '/two-factor/verify-backup-code', { code: c, trustDevice }));
      done();
    } catch (err) {
      if (err.status === 401 && /two.?factor|session/i.test(err.message) && !/code/i.test(err.message)) {
        setMode('password');
        throw new Error('That took too long. Sign in again.');
      }
      throw err;
    }
  }

  async function back() {
    error = '';
    password = '';
    await setMode('password');
    await tick();
    passwordEl?.focus();
  }

  async function passkey() {
    error = '';
    try { await busy((b) => (working = b), signInWithPasskey); done(); } catch (err) { error = err.message; }
  }

  onMount(async () => {
    // Brand-new install? Offer to create the first account instead of signing in.
    try {
      const j = await (await fetch('/api/setup', { credentials: 'same-origin' })).json();
      if (j && j.needed) { mode = 'setup'; await tick(); setupUserEl?.focus(); }
    } catch { /* stay on the sign-in form */ }
  });
</script>

{#snippet label(text)}{#if working}<span class="spinner"></span>{:else}{text}{/if}{/snippet}

<div class="login-wrap">
  <form class="login-card" novalidate onsubmit={submit}>
    <div class="brand">
      <img class="logo" src="/favicon.svg" alt="" width="40" height="40">
      <div><b>Waymark</b></div>
    </div>
    {#if error}<div class="msg bad">{error}</div>{/if}

    {#if mode === 'setup'}
      <h2 class="login-title">Welcome to Waymark</h2>
      <p class="hint mb16">Create your account to get started. You'll be the administrator, and can add other people later.</p>
      <div class="field">
        <label class="f" for="setupUsername">Username</label>
        <input id="setupUsername" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="40"
          bind:value={setup.username} bind:this={setupUserEl}>
        <p class="hint">2–40 characters: letters, numbers, dot, dash or underscore.</p>
      </div>
      <div class="field">
        <label class="f" for="setupEmail">Email</label>
        <input id="setupEmail" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="200" bind:value={setup.email}>
      </div>
      <div class="field">
        <label class="f" for="setupPassword">Password</label>
        <input id="setupPassword" type="password" autocomplete="new-password" maxlength="200" bind:value={setup.password}>
        <p class="hint">At least 10 characters.</p>
      </div>
      <div class="field">
        <label class="f" for="setupConfirm">Confirm password</label>
        <input id="setupConfirm" type="password" autocomplete="new-password" maxlength="200" bind:value={setup.confirm}>
      </div>
      <button type="submit" class="btn primary" disabled={working}>{@render label('Create account')}</button>

    {:else if mode === 'password'}
      <div class="field">
        <label class="f" for="username">Username</label>
        <!-- svelte-ignore a11y_autofocus -->
        <input id="username" type="text" autocomplete="username webauthn" autocapitalize="none" spellcheck="false" required autofocus bind:value={username}>
      </div>
      <div class="field">
        <label class="f" for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" required bind:value={password} bind:this={passwordEl}>
      </div>
      <button type="submit" class="btn primary" disabled={working}>{@render label('Sign in')}</button>
      {#if passkeys}
        <div class="login-or">
          <span>or</span>
          <button type="button" class="btn" disabled={working} onclick={passkey}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="9" r="4"/><path d="M2 21c.6-3.5 3-5.5 6-5.5 1.3 0 2.5.4 3.4 1"/><path d="M17 11a3 3 0 1 0 0 .01M17 14v7l1.5-1.5L17 18"/></svg>
            Sign in with a passkey
          </button>
        </div>
      {/if}

    {:else}
      <p class="hint mb10">{mode === 'totp' ? 'Enter the 6-digit code from your authenticator app.'
        : 'Enter one of the backup codes you saved when you turned on two-factor sign-in. Each code works once.'}</p>
      <div class="field">
        <label class="f" for="code">{mode === 'totp' ? 'Authentication code' : 'Backup code'}</label>
        <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" spellcheck="false" maxlength="20" bind:value={code} bind:this={codeEl}>
      </div>
      <label class="check mb16"><input type="checkbox" bind:checked={trustDevice}> Don't ask again on this device for 30 days</label>
      <button type="submit" class="btn primary" disabled={working}>{@render label('Verify')}</button>
      <div class="login-links">
        <button type="button" class="link-plain" onclick={() => { error = ''; setMode(mode === 'totp' ? 'backup' : 'totp'); }}>
          {mode === 'totp' ? 'Use a backup code instead' : 'Use my authenticator app instead'}
        </button>
        <button type="button" class="link-plain" onclick={back}>Back</button>
      </div>
    {/if}
  </form>
</div>
