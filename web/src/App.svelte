<script>
  import { onMount } from 'svelte';
  import { api } from './lib/api.js';
  import { app, pageAllowed, showPage, loadLog, setUsers } from './lib/app.svelte.js';
  import { londonToday } from './lib/format.js';
  import { toast } from './lib/ui.svelte.js';
  import Modal from './components/Modal.svelte';
  import Dialogs from './components/Dialogs.svelte';
  import Msg from './components/Msg.svelte';
  import Mileage from './pages/Mileage.svelte';
  import Customers from './pages/Customers.svelte';
  import Places from './pages/Places.svelte';
  import Export from './pages/Export.svelte';
  import Users from './pages/Users.svelte';
  import Activity from './pages/Activity.svelte';
  import Settings from './pages/Settings.svelte';
  import Account from './pages/Account.svelte';

  const NAV = [
    { page: 'mileage', label: 'Mileage', icon: '<path d="M5 17h14M6 17l1.5-6h9L18 17"/><circle cx="8" cy="18" r="1.5"/><circle cx="16" cy="18" r="1.5"/><path d="M8 11l1-4h6l1 4"/>' },
    { page: 'customers', label: 'Customers', icon: '<path d="M3 21V7l9-4 9 4v14"/><path d="M9 21v-6h6v6"/><path d="M8 10h.01M12 10h.01M16 10h.01"/>' },
    { page: 'places', label: 'Places', icon: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>' },
    { page: 'export', label: 'Export', icon: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>' },
    { page: 'users', label: 'Users', icon: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14.6c2.4.3 4.2 2 4.9 5.4"/>' },
    { page: 'activity', label: 'Activity', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
    { page: 'settings', label: 'Settings', icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>' },
  ];
  const nav = $derived(app.me ? NAV.filter((n) => pageAllowed(n.page)) : []);

  const initials = $derived(app.me ? String(app.me.name || app.me.username || '?').trim().split(/\s+/).slice(0, 2)
    .map((w) => w.charAt(0)).join('').toUpperCase() : '');

  /* ---- Theme: System -> Light -> Dark (theme.js applies it before the page paints) ---- */
  const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
  let theme = $state(window.waymarkTheme ? window.waymarkTheme.get() : 'system');
  function cycleTheme() {
    const order = ['system', 'light', 'dark'];
    theme = order[(order.indexOf(theme) + 1) % order.length];
    window.waymarkTheme.set(theme);
  }

  /* ---- Two-factor suggestion after first-run setup ---- */
  let tfPrompt = $state(false);
  async function skipTwoFactor() {
    tfPrompt = false;
    try {
      await api('PUT', '/api/me/two-factor-prompt');
      toast('Skipped. You can turn on two-factor sign-in any time from your Account (click your name).');
    } catch { /* it'll just be suggested again next time */ }
  }
  function setUpTwoFactor() {
    tfPrompt = false;
    showPage('account');
    app.startTwoFactor = true;
  }

  // Keep "today" current in a tab left open past midnight (UK time), so today's journeys can still be logged.
  onMount(() => {
    const t = setInterval(() => { const d = londonToday(); if (d > app.today) app.today = d; }, 60 * 1000);
    return () => clearInterval(t);
  });

  onMount(async () => {
    try {
      const d = await api('GET', '/api/init');
      app.today = d.today;
      app.settings = d.settings;
      setUsers(d.users || []);
      app.me = d.me;
      app.places = d.places;
      app.customers = d.customers;
      app.google = d.google;
      app.mapsPicker = d.mapsPicker;
      app.mustChangePassword = d.me.mustChangePassword;
      app.ready = true;
      tfPrompt = !!d.me.promptTwoFactor;
      showPage(location.hash.slice(1));
      loadLog();
    } catch (e) {
      app.loadError = `Could not load: ${e.message}`;
    }
  });
</script>

<svelte:window onhashchange={() => { if (app.me) showPage(location.hash.slice(1)); }} />

<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <img class="logo" src="/favicon.svg" alt="" width="40" height="40">
      <div><b>Waymark</b></div>
    </div>
    <nav class="nav" aria-label="Sections">
      {#each nav as n (n.page)}
        <button type="button" aria-current={app.page === n.page ? 'page' : undefined} onclick={() => showPage(n.page)}>
          {@html `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${n.icon}</svg>`}
          {n.label}
        </button>
      {/each}
    </nav>
    {#if app.me}
      <button type="button" class="whoami" class:active={app.page === 'account'} aria-current={app.page === 'account' ? 'page' : undefined}
        title="Your account: profile, password and sign-in security" aria-label="Your account ({app.me.name})" onclick={() => showPage('account')}>
        <span class="avatar" aria-hidden="true">{initials}</span>
        <span class="who-text"><b>{app.me.name}</b><small>{app.me.roleLabel} · Account</small></span>
      </button>
    {/if}
    <form class="side-foot" method="post" action="/logout">
      <button type="button" class="theme-btn" aria-label="Change theme" title="Theme: {THEME_LABELS[theme]} (click to change)" onclick={cycleTheme}>
        {#if theme === 'light'}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        {:else if theme === 'dark'}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
        {:else}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>
        {/if}
        <span>{THEME_LABELS[theme]}</span>
      </button>
      <button type="submit" class="link-btn">Log out</button>
    </form>
  </aside>

  <main class="content">
    {#if app.loadError}
      <div class="msg bad">{app.loadError}</div>
    {:else if !app.ready}
      <div class="msg info"><span class="spinner"></span> Loading…</div>
    {:else}
      {#if !app.google.configured}
        <div class="msg warn">No Google Maps API key set: new distances cannot be looked up. {app.me.role === 'admin' ? 'Add one under Settings.' : 'Ask an administrator to add one.'}</div>
      {/if}
      <Msg msg={app.notice} />
      {#if app.mustChangePassword}
        <div class="msg warn">You are using a temporary password. <button type="button" class="link-inline" onclick={() => showPage('account')}>Change it now</button></div>
      {/if}

      {#if app.page === 'mileage'}<Mileage />
      {:else if app.page === 'customers'}<Customers />
      {:else if app.page === 'places'}<Places />
      {:else if app.page === 'export'}<Export />
      {:else if app.page === 'users'}<Users />
      {:else if app.page === 'activity'}<Activity />
      {:else if app.page === 'settings'}<Settings />
      {:else if app.page === 'account'}<Account />
      {/if}
    {/if}
  </main>
</div>

<Modal id="tfPromptModal" size="narrow" closable={false} bind:open={tfPrompt} title="Protect your account">
  <p>Turn on <b>two-factor sign-in</b> so that a password on its own isn't enough to get into Waymark. After your password, you'll enter a 6-digit code from an authenticator app on your phone (Microsoft Authenticator, Google Authenticator, 1Password and so on).</p>
  <p class="hint">It takes about a minute. You can also do it later from your Account (click your name at the bottom left).</p>
  {#snippet foot()}
    <span class="spacer"></span>
    <button type="button" class="btn" onclick={skipTwoFactor}>Skip for now</button>
    <button type="button" class="btn primary" onclick={setUpTwoFactor}>Set up now</button>
  {/snippet}
</Modal>

<Dialogs />
