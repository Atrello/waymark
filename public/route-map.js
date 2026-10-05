/* Waymark — route map for one Mileage entry. Runs inside an iframe (see openRouteMap in app.js).
 * The server works out the route (GET /api/log/:entryId/route, cached after the first lookup);
 * this page only draws it, using the browser key from /api/maps-browser-key. */
(function () {
  'use strict';
  var info = document.getElementById('routeInfo');
  var entryId = new URLSearchParams(location.search).get('entry') || '';
  var route = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fail(text) {
    info.className = 'route-info bad';
    info.textContent = text;
  }
  function getJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Could not load the route.');
        return j;
      });
    });
  }

  function describe(r) {
    var diff = Math.round((r.loggedMiles - r.routeMiles) * 10) / 10;
    var differs = Math.abs(diff) >= 0.5 && Math.abs(diff) / Math.max(r.routeMiles, 0.1) >= 0.1;
    var dirs = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=' + encodeURIComponent(r.from.lat + ',' + r.from.lng) +
      '&destination=' + encodeURIComponent(r.to.lat + ',' + r.to.lng);
    info.className = 'route-info';
    info.innerHTML =
      '<div class="route-title"><b>' + esc(r.from.place) + ' → ' + esc(r.to.place) + '</b><span>' + esc(r.dateUk) +
        (r.business ? ' · ' + esc(r.business) : '') + '</span></div>' +
      '<div class="route-figures">' +
        '<span>Logged <b>' + r.loggedMiles.toFixed(1) + ' mi</b> · £' + r.claim.toFixed(2) + ' at ' + r.ratePence + 'p</span>' +
        '<span>Route today <b>' + r.routeMiles.toFixed(1) + ' mi</b> · about ' + r.minutes + ' min</span>' +
        '<a href="' + esc(dirs) + '" target="_blank" rel="noopener">Open in Google Maps ↗</a>' +
      '</div>' +
      (differs ? '<div class="route-warn">The logged distance is ' + Math.abs(diff).toFixed(1) + ' mi ' + (diff > 0 ? 'longer' : 'shorter') +
        ' than today\'s route. Roads, the route taken or a place\'s coordinates may have changed since it was logged.</div>' : '');
  }

  window.waymarkRouteReady = function () {
    var map = new google.maps.Map(document.getElementById('routeMap'), {
      center: { lat: route.from.lat, lng: route.from.lng }, zoom: 11,
      streetViewControl: false, fullscreenControl: false, clickableIcons: false, gestureHandling: 'greedy',
      mapTypeControlOptions: { mapTypeIds: ['roadmap', 'hybrid'] },
    });
    var path = route.polyline ? google.maps.geometry.encoding.decodePath(route.polyline)
      : [new google.maps.LatLng(route.from.lat, route.from.lng), new google.maps.LatLng(route.to.lat, route.to.lng)];
    new google.maps.Polyline({ map: map, path: path, strokeColor: '#1d4ed8', strokeOpacity: 0.85, strokeWeight: 5 });
    new google.maps.Marker({ map: map, position: { lat: route.from.lat, lng: route.from.lng }, label: 'A', title: 'Start: ' + route.from.place });
    new google.maps.Marker({ map: map, position: { lat: route.to.lat, lng: route.to.lng }, label: 'B', title: 'Destination: ' + route.to.place });
    var bounds = new google.maps.LatLngBounds();
    path.forEach(function (p) { bounds.extend(p); });
    map.fitBounds(bounds, 40);
  };

  window.gm_authFailure = function () {
    fail('Google rejected the map key. In Google Cloud, check the browser key allows ' + location.origin +
      '/* and has the Maps JavaScript API enabled.');
  };

  if (!entryId) { fail('No entry was chosen.'); return; }
  Promise.all([getJson('/api/log/' + encodeURIComponent(entryId) + '/route'), getJson('/api/maps-browser-key')]).then(function (res) {
    route = res[0];
    describe(route);
    var s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(res[1].key) +
      '&callback=waymarkRouteReady&libraries=geometry&loading=async&v=weekly&region=GB&language=en-GB';
    s.async = true;
    s.onerror = function () { fail('Could not reach Google Maps. Check the internet connection.'); };
    document.head.appendChild(s);
  }).catch(function (e) { fail(e.message); });
})();
