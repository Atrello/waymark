<script>
  /* Map picker, shown in an iframe in the place form. Search or click to drop a pin, drag to adjust; every change is
   * posted to the parent page as {type: 'waymark-map-pin', lat, lng, address}. Uses the browser key. */
  import { onMount } from 'svelte';
  import { loadGoogleMaps } from './google.js';

  const params = new URLSearchParams(location.search);
  let status = $state({ text: 'Loading map…', bad: false });
  let query = $state(params.get('q') || '');
  let mapEl = $state();
  let map, marker, geocoder, reverseTimer;

  const say = (text, bad = false) => { status = { text, bad }; };
  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  function tell(lat, lng, address) {
    if (window.parent !== window) window.parent.postMessage({ type: 'waymark-map-pin', lat, lng, address: address || '' }, location.origin);
  }

  function placeMarker(pos) {
    if (!marker) {
      marker = new google.maps.Marker({ map, position: pos, draggable: true });
      marker.addListener('dragend', (e) => setPin(e.latLng.lat(), e.latLng.lng()));
    } else {
      marker.setPosition(pos);
    }
  }

  /** Put the pin at lat/lng. address: known already (from a search), or looked up from the pin. */
  function setPin(lat, lng, address) {
    lat = round6(lat); lng = round6(lng);
    const pos = { lat, lng };
    placeMarker(pos);
    say(`${lat}, ${lng}${address ? ` · ${address}` : ''}`);
    tell(lat, lng, address);
    if (address) return;
    clearTimeout(reverseTimer); // suggest an address for the pin (only used if the place has none yet)
    reverseTimer = setTimeout(() => {
      geocoder.geocode({ location: pos }).then((r) => {
        const a = r.results && r.results[0] ? r.results[0].formatted_address : '';
        const p = marker.getPosition();
        if (a && p.lat() === lat && p.lng() === lng) { say(`${lat}, ${lng} · ${a}`); tell(lat, lng, a); }
      }).catch(() => {});
    }, 400);
  }

  function search(e) {
    e?.preventDefault();
    const q = query.trim();
    if (!q || !geocoder) return;
    say('Searching…');
    geocoder.geocode({ address: q, region: 'gb' }).then((r) => {
      const hit = r.results[0];
      if (hit.geometry.viewport) map.fitBounds(hit.geometry.viewport); else map.setCenter(hit.geometry.location);
      if (map.getZoom() > 17) map.setZoom(17);
      setPin(hit.geometry.location.lat(), hit.geometry.location.lng(), hit.formatted_address);
    }).catch((err) => {
      const code = err && err.code;
      say(code === 'ZERO_RESULTS' ? `No match for "${q}". Try a postcode, or click the map.`
        : code === 'REQUEST_DENIED' ? 'Search is not allowed for this key: enable the Geocoding API for it in Google Cloud.'
          : 'Search failed. Click the map to drop a pin instead.', true);
    });
  }

  onMount(async () => {
    try {
      await loadGoogleMaps([], (msg) => say(msg, true));
    } catch (err) { say(err.message, true); return; }
    geocoder = new google.maps.Geocoder();
    const lat = parseFloat(params.get('lat')), lng = parseFloat(params.get('lng'));
    const has = isFinite(lat) && isFinite(lng);
    map = new google.maps.Map(mapEl, {
      center: has ? { lat, lng } : { lat: 54.6, lng: -3.0 }, // Great Britain until there is a pin
      zoom: has ? 16 : 6,
      streetViewControl: false, fullscreenControl: false, clickableIcons: false, gestureHandling: 'greedy',
      mapTypeControlOptions: { mapTypeIds: ['roadmap', 'hybrid'] },
    });
    map.addListener('click', (e) => setPin(e.latLng.lat(), e.latLng.lng()));
    if (has) {
      placeMarker({ lat, lng });
      say(`Current location: ${lat}, ${lng}. Click the map or drag the pin to move it.`);
    } else if (query) {
      search();
    } else {
      say('Search above, or click the map to drop a pin.');
    }
  });
</script>

<form class="picker-search" role="search" onsubmit={search}>
  <input type="search" placeholder="Search an address, postcode or place…" aria-label="Search" autocomplete="off" bind:value={query}>
  <button type="submit" class="btn">Search</button>
</form>
<div class="picker-map" bind:this={mapEl} aria-label="Map. Click to drop a pin."></div>
<div class="picker-status" class:bad={status.bad} aria-live="polite">{status.text}</div>
