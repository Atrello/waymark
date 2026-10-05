<script>
  /* The app-wide "Are you sure?" and "Enter your password" dialogs (see confirmBox / askPassword), and the toast. */
  import Modal from './Modal.svelte';
  import Msg from './Msg.svelte';
  import { ui } from '../lib/ui.svelte.js';

  function answer(value) {
    const c = ui.confirm;
    ui.confirm = null;
    if (c) c.resolve(value);
  }

  let pw = $state('');
  let pwMsg = $state(null);
  let pwInput = $state();
  $effect(() => {
    if (ui.password) { pw = ''; pwMsg = null; setTimeout(() => pwInput && pwInput.focus(), 50); }
  });
  function finish(value) {
    const p = ui.password;
    ui.password = null;
    if (p) p.resolve(value);
  }
  function submitPw(e) {
    e.preventDefault();
    if (!pw) { pwMsg = { text: 'Enter your password.', kind: 'warn' }; return; }
    finish(pw);
  }
</script>

<Modal id="confirmModal" role="alertdialog" size="narrow" closable={false} open={!!ui.confirm}
  title={ui.confirm ? ui.confirm.title : ''} onclose={() => answer(false)}>
  <p class="pre-line">{ui.confirm ? ui.confirm.text : ''}</p>
  {#snippet foot()}
    <!-- svelte-ignore a11y_autofocus -->
    <button type="button" class="btn" autofocus onclick={() => answer(false)}>Cancel</button>
    <button type="button" class="btn danger" onclick={() => answer(true)}>{ui.confirm ? ui.confirm.ok : 'Delete'}</button>
  {/snippet}
</Modal>

<Modal id="pwModal" size="narrow" closable={false} open={!!ui.password}
  title={ui.password ? ui.password.title : ''} onclose={() => finish(null)}>
  <Msg msg={pwMsg} />
  <form novalidate onsubmit={submitPw}>
    <p class="hint mb10">{ui.password ? ui.password.text : ''}</p>
    <label class="f" for="pwModalInput">Password</label>
    <input id="pwModalInput" type="password" autocomplete="current-password" bind:value={pw} bind:this={pwInput}>
  </form>
  {#snippet foot()}
    <button type="button" class="btn" onclick={() => finish(null)}>Cancel</button>
    <button type="button" class="btn primary" onclick={submitPw}>{ui.password ? ui.password.ok : 'Continue'}</button>
  {/snippet}
</Modal>

{#if ui.toast}<div class="toast" role="status">{ui.toast}</div>{/if}
