<script>
  /* A message box (ok / bad / warn / info). Scrolls itself into view if it appears off-screen. */
  let { msg } = $props(); // { text, kind } or null
  let el = $state();

  $effect(() => {
    if (!msg || !msg.text || !el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
</script>

{#if msg && msg.text}
  <div bind:this={el} class="msg {msg.kind || 'info'}">{msg.text}</div>
{/if}
