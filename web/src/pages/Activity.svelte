<script>
  import { api } from '../lib/api.js';
  import { app } from '../lib/app.svelte.js';
  import { ukDateTime } from '../lib/format.js';

  const ACTION_LABELS = {
    'journey.create': 'Journey saved', 'journey.delete': 'Entry deleted', 'export.csv': 'CSV exported',
    'place.create': 'Place added', 'place.update': 'Place changed', 'place.delete': 'Place deleted',
    'customer.create': 'Customer added', 'customer.update': 'Customer changed', 'customer.merge': 'Customers merged',
    'customer.delete': 'Customer deleted', 'user.create': 'User added', 'user.update': 'User changed', 'user.delete': 'User deleted',
    'settings.update': 'Settings changed', 'settings.google_key': 'Google key changed',
    'backup.server': 'Backup saved', 'backup.download': 'Backup downloaded', 'backup.yearly': 'Yearly backup',
    'backup.scheduled': 'Scheduled backup',
    'auth.sign_in': 'Signed in', 'auth.sign_in_failed': 'Failed sign-in', 'auth.locked_out': 'Sign-in blocked',
    'auth.sign_out': 'Signed out', 'account.profile': 'Profile changed', 'account.password': 'Password changed',
    'security.2fa_on': 'Two-factor on', 'security.2fa_off': 'Two-factor off', 'security.backup_codes': 'Backup codes',
    'security.passkey_add': 'Passkey added', 'security.passkey_remove': 'Passkey removed', 'security.sessions': 'Sessions signed out',
  };
  const WARN = ['journey.delete', 'place.delete', 'customer.delete', 'user.delete', 'auth.sign_in_failed', 'auth.locked_out', 'security.2fa_off'];
  const AREAS = [['', 'Everything'], ['journey', 'Journeys'], ['export', 'Exports'], ['place', 'Places'], ['customer', 'Customers'],
    ['user', 'Users'], ['settings', 'Settings'], ['backup', 'Backups'], ['auth', 'Sign-ins'], ['security', 'Account security'],
    ['account', 'Own account']];

  let user = $state('');
  let area = $state('');
  let search = $state('');
  let debounced = $state('');
  let rows = $state(null);
  let more = $state(false);
  let error = $state('');
  let ticket = 0; // ignore replies to requests superseded by newer filters

  // Typing in Search waits a moment before asking the server.
  $effect(() => {
    const s = search;
    const t = setTimeout(() => { debounced = s.trim(); }, 300);
    return () => clearTimeout(t);
  });

  async function load(older) {
    const params = new URLSearchParams({ userId: user, area, search: debounced });
    if (older && rows && rows.length) params.set('before', rows[rows.length - 1].id);
    const mine = ++ticket;
    if (!older) rows = null;
    try {
      const r = await api('GET', `/api/activity?${params}`);
      if (mine !== ticket) return;
      rows = older && rows ? rows.concat(r.rows) : r.rows;
      more = r.more;
      error = '';
    } catch (e) { if (mine === ticket) error = e.message; }
  }

  $effect(() => { void user; void area; void debounced; load(false); });

  const who = (r) => r.username || (/^backup\.(yearly|scheduled)$/.test(r.action) ? 'System' : '—');
</script>

<section class="page">
  <header class="page-head">
    <div>
      <h1>Activity</h1>
      <p>Who did what, and when. Entries are permanent and can't be edited or deleted.</p>
    </div>
  </header>
  <div class="panel">
    <div class="toolbar">
      <label class="tf"><span>User</span>
        <select bind:value={user}>
          <option value="">All users</option>
          {#each app.users as u (u.id)}<option value={String(u.id)}>{u.name}</option>{/each}
        </select>
      </label>
      <label class="tf"><span>Area</span>
        <select bind:value={area}>{#each AREAS as [v, label] (v)}<option value={v}>{label}</option>{/each}</select>
      </label>
      <label class="tf grow"><span>Search</span><input type="search" placeholder="Entry ID, place, file name, IP address…" bind:value={search}></label>
      <button type="button" class="btn small ghost" onclick={() => { user = ''; area = ''; search = ''; debounced = ''; }}>Clear</button>
    </div>
    <div class="table-wrap">
      <table class="grid activity">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th><th>From</th></tr></thead>
        <tbody>
          {#if error}
            <tr><td class="empty" colspan="5">{error}</td></tr>
          {:else if !rows}
            <tr><td class="empty" colspan="5"><span class="spinner"></span></td></tr>
          {:else}
            {#each rows as r (r.id)}
              <tr>
                <td class="c-awhen nowrap">{ukDateTime(r.at)}</td>
                <td class="c-awho">{who(r)}</td>
                <td class="c-aaction"><span class="badge {WARN.includes(r.action) ? 'test' : 'role-accounts'}">{ACTION_LABELS[r.action] || r.action}</span></td>
                <td class="c-adetail">{r.summary}</td>
                <td class="c-aip nowrap">{r.ip || '—'}</td>
              </tr>
            {:else}
              <tr><td class="empty" colspan="5">No activity matches.</td></tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
    <div class="table-foot">
      <span>{rows ? `Showing ${rows.length}${more ? '+' : ''} entries, newest first` : ''}</span>
      {#if more && rows}<button type="button" class="btn small" onclick={() => load(true)}>Show older</button>{/if}
    </div>
  </div>
</section>
