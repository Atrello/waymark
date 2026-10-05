<script>
  /* Route map for one Mileage entry, shown in an iframe. The server works out the route (cached after the first
   * lookup); this page only draws it, with the browser key. */
  import { onMount } from 'svelte';
  import { loadGoogleMaps } from './google.js';

  const entryId = new URLSearchParams(location.search).get('entry') || '';
  let route = $state(null);
  let error = $state('');
  let mapEl = $state();

  const diff = $derived(route ? Math.round((route.loggedMiles - route.routeMiles) * 10) / 10 : 0);
  const differs = $derived(route ? Math.abs(diff) >= 0.5 && Math.abs(diff) / Math.max(route.routeMiles, 0.1) >= 0.1 : false);
  const directions = $derived(route ? 'https://www.google.com/maps/dir/?api=1&travelmode=driving' +
    `&origin=${encodeURIComponent(`${route.from.lat},${route.from.lng}`)}&destination=${encodeURIComponent(`${route.to.lat},${route.to.lng}`)}` : '');

  async function getJson(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Could not load the route.');
    return j;
  }

  function draw() {
    const { from, to } = route;
    const map = new google.maps.Map(mapEl, {
      center: { lat: from.lat, lng: from.lng }, zoom: 11,
      streetViewControl: false, fullscreenControl: false, clickableIcons: false, gestureHandling: 'greedy',
      mapTypeControlOptions: { mapTypeIds: ['roadmap', 'hybrid'] },
    });
    const path = route.polyline ? google.maps.geometry.encoding.decodePath(route.polyline)
      : [new google.maps.LatLng(from.lat, from.lng), new google.maps.LatLng(to.lat, to.lng)];
    new google.maps.Polyline({ map, path, strokeColor: '#1d4ed8', strokeOpacity: 0.85, strokeWeight: 5 });
    new google.maps.Marker({ map, position: { lat: from.lat, lng: from.lng }, label: 'A', title: `Start: ${from.place}` });
    new google.maps.Marker({ map, position: { lat: to.lat, lng: to.lng }, label: 'B', title: `Destination: ${to.place}` });
    const bounds = new google.maps.LatLngBounds();
    path.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, 40);
  }

  onMount(async () => {
    if (!entryId) { error = 'No entry was chosen.'; return; }
    try {
      route = await getJson(`/api/log/${encodeURIComponent(entryId)}/route`);
      await loadGoogleMaps(['geometry'], (msg) => { error = msg; });
      draw();
    } catch (e) { error = e.message; }
  });
</script>

<div class="route-info" class:bad={!!error} aria-live="polite">
  {#if error}
    {error}
  {:else if !route}
    Loading route…
  {:else}
    <div class="route-title"><b>{route.from.place} → {route.to.place}</b><span>{route.dateUk}{route.business ? ` · ${route.business}` : ''}</span></div>
    <div class="route-figures">
      <span>Logged <b>{route.loggedMiles.toFixed(1)} mi</b> · £{route.claim.toFixed(2)} at {route.ratePence}p</span>
      <span>Route today <b>{route.routeMiles.toFixed(1)} mi</b> · about {route.minutes} min</span>
      <a href={directions} target="_blank" rel="noopener">Open in Google Maps ↗</a>
    </div>
    {#if differs}
      <div class="route-warn">The logged distance is {Math.abs(diff).toFixed(1)} mi {diff > 0 ? 'longer' : 'shorter'} than today's route. Roads, the route taken or a place's coordinates may have changed since it was logged.</div>
    {/if}
  {/if}
</div>
<div class="picker-map" bind:this={mapEl} aria-label="Map of the driving route"></div>
