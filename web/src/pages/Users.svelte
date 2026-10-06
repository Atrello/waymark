<script>
  import { untrack } from 'svelte';
  import { api } from '../lib/api.js';
  import { app, setUsers } from '../lib/app.svelte.js';
  import { toast, confirmBox, busy } from '../lib/ui.svelte.js';
  import { uk, londonDate, randomPassword } from '../lib/format.js';
  import Modal from '../components/Modal.svelte';
  import Msg from '../components/Msg.svelte';

  let users = $state(null);
  let loadError = $state('');

  async function load() {
    try { users = (await api('GET', '/api/users')).users; } catch (e) { loadError = e.message; }
  }
  load();

  /* ---- Add / edit dialog ---- */
  let editing = $state(null);
  let f = $state({});
  let msg = $state(null);
  let saving = $state(false);

  function openEditor(u) {
    editing = u || {};
    untrack(() => {
      f = {
        name: u ? u.name : '', username: u ? u.username : '', email: u ? u.email || '' : '', role: u ? u.role : 'user',
        password: u ? '' : randomPassword(), active: u ? u.active : true, resetTwoFactor: false,
      };
      msg = null;
    });
  }
  const close = () => { editing = null; };

  function updated(r) {
    users = r.users;
    setUsers(r.users);
    // Editing your own record changes the name shown in the sidebar too.
    const mine = r.users.find((u) => u.id === app.me.id);
    if (mine) app.me = { ...app.me, ...mine };
    close();
    toast(r.message);
  }

  async function save() {
    const id = editing.id;
    const username = id ? editing.username : f.username.trim(); // read now: the dialog closes once saved
    const body = {
      name: f.name.trim(), role: f.role, password: f.password,
      active: f.active, email: f.email.trim(), resetTwoFactor: f.resetTwoFactor,
    };
    if (!id) body.username = f.username.trim();
    try {
      const r = await busy((b) => (saving = b), () => api(id ? 'PUT' : 'POST', id ? `/api/users/${id}` : '/api/users', body));
      updated(r);
      if (body.password) {
        app.notice = { text: `Password for ${username}: ${body.password}\nCopy it now; it will not be shown again.`, kind: 'info' };
      }
    } catch (e) { msg = { text: e.message, kind: 'bad' }; }
  }

  async function remove() {
    if (!(await confirmBox(`Delete ${editing.name}?`,
      'This removes their account for good. People with logged journeys can\'t be deleted; untick "Active" to deactivate them instead.'))) return;
    try { updated(await api('DELETE', `/api/users/${editing.id}`)); } catch (e) { msg = { text: e.message, kind: 'bad' }; }
  }
</script>

<section class="page">
  <header class="page-head">
    <div>
      <h1>Users</h1>
      <p>Who can sign in, and what they can do.</p>
    </div>
    <button type="button" class="btn primary" onclick={() => openEditor(null)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      Add user
    </button>
  </header>
  <div class="panel">
    <div class="table-wrap">
      <table class="grid users">
        <thead>
          <tr><th>Name</th><th>Username</th><th>Role</th><th class="num">Journey legs</th><th>Security</th><th>Last sign-in</th><th>Status</th></tr>
        </thead>
        <tbody>
          {#if loadError}
            <tr><td class="empty" colspan="7">{loadError}</td></tr>
          {:else if !users}
            <tr><td class="empty" colspan="7"><span class="spinner"></span></td></tr>
          {:else}
            {#each users as u (u.id)}
              <tr class="clickable" onclick={() => openEditor(u)}>
                <td class="c-uname"><b>{u.name}</b>{#if u.id === app.me.id} <span class="muted">(you)</span>{/if}</td>
                <td class="c-ulogin">{u.username}</td>
                <td class="c-urole"><span class="badge role-{u.role}">{u.roleLabel}</span></td>
                <td class="c-ulegs num">{u.legs}</td>
                <td class="c-usec">
                  {#if u.twoFactorEnabled}<span class="badge live">2FA</span> {/if}
                  {#if u.passkeys}<span class="badge role-accounts">{u.passkeys} passkey{u.passkeys === 1 ? '' : 's'}</span>{/if}
                  {#if !u.twoFactorEnabled && !u.passkeys}<span class="muted">Password only</span>{/if}
                </td>
                <td class="c-ulast nowrap">{u.lastLogin ? uk(londonDate(u.lastLogin)) : 'never'}</td>
                <td class="c-ustatus">
                  {#if !u.active}<span class="badge inactive">Inactive</span>
                  {:else if u.mustChangePassword}<span class="badge test">Temp password</span>
                  {:else}<span class="badge live">Active</span>{/if}
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
    <div class="table-foot"><span><b>Administrator</b>: everything. <b>User</b>: logs and sees their own journeys. <b>Accounts</b>: read-only view and export of everyone's journeys.</span></div>
  </div>
</section>

<Modal id="userModal" open={!!editing} title={editing && editing.id ? `Edit ${editing.name}` : 'Add user'} onclose={close}>
  <Msg {msg} />
  {#if editing}
    <form autocomplete="off" novalidate onsubmit={(e) => { e.preventDefault(); save(); }}>
      <div class="grid-2">
        <div class="field">
          <label class="f" for="uName">Full name</label>
          <input id="uName" type="text" maxlength="80" bind:value={f.name}>
        </div>
        <div class="field">
          <label class="f" for="uUsername">Username <span class="hint">(used to sign in)</span></label>
          <input id="uUsername" type="text" maxlength="40" autocapitalize="none" spellcheck="false" bind:value={f.username} disabled={!!editing.id}>
        </div>
      </div>
      <div class="field">
        <label class="f" for="uEmail">Email <span class="hint">(optional; shown in their authenticator app)</span></label>
        <input id="uEmail" type="email" maxlength="200" autocapitalize="none" spellcheck="false" bind:value={f.email}>
      </div>
      <div class="field">
        <label class="f" for="uRole">Role</label>
        <select id="uRole" bind:value={f.role}>
          <option value="user">User: logs and sees their own journeys</option>
          <option value="accounts">Accounts: read-only, sees and exports everyone's journeys</option>
          <option value="admin">Administrator: full access, including users</option>
        </select>
      </div>
      <div class="field">
        <label class="f" for="uPassword">{editing.id ? 'Reset password (optional)' : 'Temporary password'}</label>
        <div class="input-row">
          <input id="uPassword" type="text" autocomplete="off" spellcheck="false" bind:value={f.password}>
          <button type="button" class="btn" onclick={() => { f.password = randomPassword(); }}>Generate</button>
        </div>
        <p class="hint">{editing.id ? 'Leave blank to keep their current password. A reset signs them out and asks them to change it.'
          : "At least 10 characters. Give it to them; they'll be asked to change it after signing in."}</p>
      </div>
      {#if editing.id}
        <label class="check mb10"><input type="checkbox" bind:checked={f.active}> Active (can sign in)</label>
        {#if editing.twoFactorEnabled}
          <label class="check"><input type="checkbox" bind:checked={f.resetTwoFactor}> Turn off their two-factor sign-in (if they've lost their phone and backup codes)</label>
        {/if}
      {/if}
    </form>
  {/if}
  {#snippet foot()}
    {#if editing && editing.id && editing.id !== app.me.id}<button type="button" class="btn danger-outline" onclick={remove}>Delete</button>{/if}
    <span class="spacer"></span>
    <button type="button" class="btn" onclick={close}>Cancel</button>
    <button type="button" class="btn primary" disabled={saving} onclick={save}>{#if saving}<span class="spinner"></span>{:else}Save user{/if}</button>
  {/snippet}
</Modal>
