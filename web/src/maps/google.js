/* Load Google's Maps JavaScript API with the browser key from the server. Only the map pages load it
 * (their content security policy allows Google's scripts; the rest of the app's does not). */

/** Resolves once `google.maps` is ready. onAuthFailure(message) is called if Google rejects the key. */
export async function loadGoogleMaps(libraries = [], onAuthFailure) {
  const res = await fetch('/api/maps-browser-key', { credentials: 'same-origin' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'Could not load the map.');

  // Google calls this when it rejects the key (wrong website restriction, API not enabled, billing off…).
  window.gm_authFailure = () => onAuthFailure?.(`Google rejected the map key. In Google Cloud, check the browser key allows ${location.origin}/* and has the Maps JavaScript API enabled.`);

  await new Promise((resolve, reject) => {
    window.waymarkMapsReady = resolve;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(j.key)}&callback=waymarkMapsReady` +
      `${libraries.length ? `&libraries=${libraries.join(',')}` : ''}&loading=async&v=weekly&region=GB&language=en-GB`;
    s.async = true;
    s.onerror = () => reject(new Error('Could not reach Google Maps. Check the internet connection.'));
    document.head.appendChild(s);
  });
}
