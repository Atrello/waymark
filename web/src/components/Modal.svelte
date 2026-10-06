<script>
  /* A dialog. Closes on the ✕ button, a click on the backdrop, or Escape (only the topmost one). */
  import { untrack } from 'svelte';
  import { modalOpened, modalClosed, isTopModal } from '../lib/ui.svelte.js';

  let {
    open = $bindable(false), id, title, size = '', role = 'dialog', closable = true,
    onclose, children, foot,
  } = $props();

  function close() { if (onclose) onclose(); else open = false; }

  // Register in the open-modal stack. Untracked: the stack is read and written here, and tracking it would make
  // this effect re-run (and loop) every time any modal opens or closes.
  $effect(() => {
    if (!open) return;
    untrack(() => modalOpened(id));
    return () => untrack(() => modalClosed(id));
  });

  function onkeydown(e) {
    // defaultPrevented: the dialog above already closed on this keypress, so this one stays open.
    if (open && e.key === 'Escape' && !e.defaultPrevented && isTopModal(id)) { e.preventDefault(); close(); }
  }

  // Close on a backdrop click only when the press started on the backdrop too: selecting text in the dialog
  // and letting go outside it must not close it.
  let downOnBackdrop = false;
</script>

<svelte:window {onkeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="modal" {id} {role} aria-modal="true" aria-labelledby="{id}-title" onmousedown={(e) => { downOnBackdrop = e.target === e.currentTarget; }}
    onclick={(e) => { if (e.target === e.currentTarget && downOnBackdrop) close(); downOnBackdrop = false; }}>
    <div class="modal-card {size}">
      <div class="modal-head">
        <h2 id="{id}-title">{title}</h2>
        {#if closable}
          <button type="button" class="icon-btn" aria-label="Close" onclick={close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        {/if}
      </div>
      <div class="modal-body">{@render children?.()}</div>
      {#if foot}<div class="modal-foot">{@render foot()}</div>{/if}
    </div>
  </div>
{/if}
