/* Waymark — map picker. Runs inside an iframe in the place form (see openMapPicker in app.js).
 * Search or click to drop a pin, drag to adjust; every change is posted to the parent page as
 * {type: 'waymark-map-pin', lat, lng, address}. Uses the browser key from /api/maps-browser-key. */
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var map, marker, geocoder, reverseTimer, status = document.getElementById('pickStatus');

  function say(text, bad) {
    status.textContent = text;
    status.classList.toggle('bad', !!bad);
  }
  function tell(lat, lng, address) {
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'waymark-map-pin', lat: lat, lng: lng, address: address || '' }, location.origin);
    }
  }
  function round6(n) { return Math.round(n * 1e6) / 1e6; }

  /** Put the pin at lat/lng. address: known already (from a search), or looked up from the pin. */
  function setPin(lat, lng, address) {
    lat = round6(lat); lng = round6(lng);
    var pos = { lat: lat, lng: lng };
    if (!marker) {
      marker = new google.maps.Marker({ map: map, position: pos, draggable: true });
      marker.addListener('dragend', function (e) { setPin(e.latLng.lat(), e.latLng.lng()); });
    } else {
      marker.setPosition(pos);
    }
    say(lat + ', ' + lng + (address ? ' · ' + address : ''));
    tell(lat, lng, address);
    if (address) return;
    // Suggest an address for the pin (only used if the place has none yet).
    clearTimeout(reverseTimer);
    reverseTimer = setTimeout(function () {
      geocoder.geocode({ location: pos }).then(function (r) {
        var a = r.results && r.results[0] ? r.results[0].formatted_address : '';
        if (marker && marker.getPosition().lat() === lat && marker.getPosition().lng() === lng && a) {
          say(lat + ', ' + lng + ' · ' + a);
          tell(lat, lng, a);
        }
      }).catch(function () { /* the address is only a suggestion */ });
    }, 400);
  }

  function search(q) {
    if (!q) return;
    say('Searching…');
    geocoder.geocode({ address: q, region: 'gb' }).then(function (r) {
      var hit = r.results[0];
      if (hit.geometry.viewport) map.fitBounds(hit.geometry.viewport); else map.setCenter(hit.geometry.location);
      if (map.getZoom() > 17) map.setZoom(17);
      setPin(hit.geometry.location.lat(), hit.geometry.location.lng(), hit.formatted_address);
    }).catch(function (e) {
      var code = e && e.code;
      say(code === 'ZERO_RESULTS' ? 'No match for "' + q + '". Try a postcode, or click the map.'
        : code === 'REQUEST_DENIED' ? 'Search is not allowed for this key: enable the Geocoding API for it in Google Cloud.'
          : 'Search failed. Click the map to drop a pin instead.', true);
    });
  }

  window.waymarkMapReady = function () {
    geocoder = new google.maps.Geocoder();
    var lat = parseFloat(params.get('lat')), lng = parseFloat(params.get('lng'));
    var has = isFinite(lat) && isFinite(lng);
    map = new google.maps.Map(document.getElementById('pickMap'), {
      center: has ? { lat: lat, lng: lng } : { lat: 54.6, lng: -3.0 }, // Great Britain until there is a pin
      zoom: has ? 16 : 6,
      streetViewControl: false, fullscreenControl: false, clickableIcons: false, gestureHandling: 'greedy',
      mapTypeControlOptions: { mapTypeIds: ['roadmap', 'hybrid'] },
    });
    map.addListener('click', function (e) { setPin(e.latLng.lat(), e.latLng.lng()); });
    if (has) {
      marker = new google.maps.Marker({ map: map, position: { lat: lat, lng: lng }, draggable: true });
      marker.addListener('dragend', function (e) { setPin(e.latLng.lat(), e.latLng.lng()); });
      say('Current location: ' + lat + ', ' + lng + '. Click the map or drag the pin to move it.');
    } else if (params.get('q')) {
      document.getElementById('pickQuery').value = params.get('q');
      search(params.get('q'));
    } else {
      say('Search above, or click the map to drop a pin.');
    }
  };

  // Google calls this when it rejects the key (wrong website restriction, API not enabled, billing off…).
  window.gm_authFailure = function () {
    say('Google rejected the map key. In Google Cloud, check the browser key allows ' + location.origin +
      '/* and has the Maps JavaScript API enabled.', true);
  };

  document.getElementById('pickSearch').addEventListener('submit', function (e) {
    e.preventDefault();
    if (geocoder) search(document.getElementById('pickQuery').value.trim());
  });

  fetch('/api/maps-browser-key', { credentials: 'same-origin' }).then(function (r) {
    return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not load the map.'); return j.key; });
  }).then(function (key) {
    var s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) +
      '&callback=waymarkMapReady&loading=async&v=weekly&region=GB&language=en-GB';
    s.async = true;
    s.onerror = function () { say('Could not reach Google Maps. Check the internet connection.', true); };
    document.head.appendChild(s);
  }).catch(function (e) { say(e.message, true); });
})();
