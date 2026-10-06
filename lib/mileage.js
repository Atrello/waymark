'use strict';
/**
 * Trips (route -> legs -> log rows), places, and Google distance lookups.
 */
const crypto = require('node:crypto');
const db = require('./db');
const googleKey = require('./googleKey');
const {
  UserError, normKey, str, todayIso, parseIsoDate, claimFor, round1, round2, parseCoords, optCoord, pairKey,
  legCustomer, ukDate,
} = require('./util');
const customers = require('./customers');

const GOOGLE_SOURCE = 'Google Routes API';
const MAX_STOPS = 15;

/* ------------------------------------------------------------------ */
/* Google                                                              */
/* ------------------------------------------------------------------ */

const inflight = new Map(); // pairKey -> Promise<miles>, so parallel requests share one Google call

/** One Routes API call from a to b ({place, lat, lng}); returns the first route with the fields in fieldMask. */
async function computeRoute(a, b, fieldMask, keyOverride) {
  const key = keyOverride || googleKey.getKey();
  if (!key) throw new UserError('No Google Maps API key is set (Settings → Google Maps API key), so new distances cannot be looked up.');
  let res, body;
  try {
    res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: a.lat, longitude: a.lng } } },
        destination: { location: { latLng: { latitude: b.lat, longitude: b.lng } } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
        regionCode: 'GB',
      }),
      signal: AbortSignal.timeout(15000),
    });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    throw new UserError(`Could not reach Google for ${a.place} → ${b.place}: ${e.message}`);
  }
  if (!res.ok) {
    throw new UserError(`Google Routes API error for ${a.place} → ${b.place}: ${(body.error && body.error.message) || res.status}`);
  }
  const route = body.routes && body.routes[0];
  if (!route || !(route.distanceMeters > 0)) {
    throw new UserError(`Google found no driving route from "${a.place}" to "${b.place}". Check both places' coordinates.`);
  }
  return route;
}

async function fetchGoogleMiles(a, b, keyOverride) {
  const route = await computeRoute(a, b, 'routes.distanceMeters', keyOverride);
  return round1(route.distanceMeters / 1609.344);
}

/** Check the saved key with one lookup (Carlisle → Wigton). Nothing is cached. */
async function testGoogleKey() {
  if (!googleKey.getKey()) throw new UserError('No Google Maps API key is set.');
  const miles = await fetchGoogleMiles({ place: 'Carlisle', lat: 54.8925, lng: -2.9329 },
                                       { place: 'Wigton', lat: 54.8236, lng: -3.1606 });
  return { message: `Key works: Google returned ${miles.toFixed(1)} mi for a test route (Carlisle → Wigton).` };
}

/* ------------------------------------------------------------------ */
/* Trips                                                               */
/* ------------------------------------------------------------------ */

function placeMap() {
  const m = new Map();
  for (const p of db.listPlaces()) m.set(normKey(p.place), p);
  return m;
}

/** Validate the entry form. Returns a clean trip; throws UserError. */
function validateTrip(p) {
  p = p || {};
  const date = parseIsoDate(p.date, 'Date');
  if (date > todayIso()) throw new UserError('Date cannot be in the future.');
  if (date < '2000-01-01') throw new UserError('Date looks wrong.');

  if (!Array.isArray(p.stops)) throw new UserError('Route is missing.');
  if (p.stops.length < 2) throw new UserError('A route needs at least 2 stops.');
  if (p.stops.length > MAX_STOPS) throw new UserError(`Maximum ${MAX_STOPS} stops per entry.`);
  const map = placeMap();
  const unknown = [];
  const stops = p.stops.map((s, i) => {
    const name = String(s == null ? '' : s).trim();
    if (!name) throw new UserError(`Stop ${i + 1} is empty.`);
    const d = map.get(normKey(name));
    if (!d) unknown.push(name);
    return d;
  });
  if (unknown.length) throw new UserError(`Unknown place(s): ${unknown.join(', ')}. Add them on the Places tab first.`);

  // The rate is set only in Settings (company rate); anything the browser sends is ignored.
  const ratePence = db.getSettings().ratePence;
  const dataType = String(p.dataType || 'Live');
  if (dataType !== 'Live' && dataType !== 'Test') throw new UserError('Data Type must be Live or Test.');

  return {
    date,
    stops,
    reason: str(p.reason, 200, 'Visit reason', true) || 'Site visit',
    ticket: str(p.ticket, 50, 'Ticket ID', true),
    customerOverride: customers.resolve(p.customerId),
    ratePence,
    dataType,
  };
}

/** Legs with distances: cache first (either direction), Google only for uncached pairs. */
async function computeLegs(trip) {
  const legs = [], skipped = [];
  for (let i = 0; i < trip.stops.length - 1; i++) {
    const a = trip.stops[i], b = trip.stops[i + 1];
    if (normKey(a.place) === normKey(b.place)) { skipped.push(`${a.place} → ${b.place}`); continue; }
    legs.push({ from: a, to: b, key: pairKey(a.place, b.place) });
  }
  if (!legs.length) throw new UserError('Nothing to log: every leg starts and ends at the same place.');

  const missing = new Set();
  for (const leg of legs) {
    if (db.cacheGet(leg.key)) continue;
    for (const d of [leg.from, leg.to]) if (d.lat === null) missing.add(d.place);
  }
  if (missing.size) {
    throw new UserError(`Missing coordinates for: ${[...missing].join(', ')}. Add them on the Places tab (paste from Google Maps) and try again.`);
  }

  for (const leg of legs) {
    const hit = db.cacheGet(leg.key);
    if (hit) {
      leg.miles = hit.miles;
      leg.source = leg.fetchedNow ? 'google' : 'cache';
      continue;
    }
    if (!inflight.has(leg.key)) {
      inflight.set(leg.key, fetchGoogleMiles(leg.from, leg.to).then((miles) => {
        db.cachePut(leg.key, leg.from.place, leg.to.place, miles, GOOGLE_SOURCE, new Date().toISOString());
        return miles;
      }).finally(() => inflight.delete(leg.key)));
    }
    leg.miles = await inflight.get(leg.key);
    leg.source = 'google';
    legs.filter((l) => l.key === leg.key).forEach((l) => { l.fetchedNow = true; });
  }

  let totalMiles = 0, totalClaim = 0;
  const out = legs.map((leg, i) => {
    const claim = claimFor(leg.miles, trip.ratePence);
    const cust = legCustomer(leg.from, leg.to, trip.customerOverride);
    totalMiles += leg.miles;
    totalClaim += claim;
    return {
      n: i + 1,
      from: leg.from.place,
      to: leg.to.place,
      miles: leg.miles,
      source: leg.source,
      business: cust ? cust.name : '',
      customerId: cust ? cust.id : null,
      claim,
    };
  });
  return { legs: out, skipped, totalMiles: round1(totalMiles), totalClaim: round2(totalClaim) };
}

function dupKey(date, start, dest, ticket) {
  return [date, normKey(start), normKey(dest), normKey(ticket)].join('|');
}

/**
 * Legs this user has already logged with the same Date + Start + Destination + Ticket ID. Only a heads-up in
 * the preview: identical entries are allowed (each leg has its own entry ID), e.g. the same trip twice in a day.
 */
function findDuplicates(date, legs, ticket, userId) {
  const existing = new Set(db.open().prepare('SELECT start, destination, ticket_id FROM log WHERE date = ? AND user_id IS ?').all(date, userId)
    .map((r) => dupKey(date, r.start, r.destination, r.ticket_id)));
  return legs.filter((l) => existing.has(dupKey(date, l.from, l.to, ticket))).map((l) => `${l.from} → ${l.to}`);
}

function tripResponse(trip, result, duplicates) {
  return {
    date: trip.date,
    dateUk: ukDate(trip.date),
    legs: result.legs,
    skipped: result.skipped,
    totalMiles: result.totalMiles,
    totalClaim: result.totalClaim,
    ratePence: trip.ratePence,
    duplicates,
    warnings: result.legs.filter((l) => !l.business)
      .map((l) => `Leg ${l.n} (${l.from} → ${l.to}) has no customer. Pick a Customer override, or assign the site to a customer.`),
  };
}

async function previewTrip(payload, user) {
  const trip = validateTrip(payload);
  const result = await computeLegs(trip);
  return tripResponse(trip, result, findDuplicates(trip.date, result.legs, trip.ticket, user.id));
}

/*
 * Double-tap guard. Each preview gets a one-time submission ID from the browser; a second save with the same
 * ID (two clicks on Save, or a retry after the first one actually went through) is refused. Identical journeys
 * saved on purpose come from separate previews, so they get separate IDs and are allowed.
 */
const SUBMISSION_TTL_MS = 60 * 60 * 1000;
const savedSubmissions = new Map(); // `${userId}|${submissionId}` -> time saved

function submissionKey(payload, user) {
  const id = payload && payload.submissionId;
  if (id === undefined || id === null || id === '') return null;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(id))) throw new UserError('Invalid submission. Preview the journey again.');
  return `${user.id}|${id}`;
}

async function saveTrip(payload, user) {
  const trip = validateTrip(payload);
  // The preview showed claims at the rate it returned; if Settings changed since, don't save different figures.
  const expected = payload && payload.expectedRatePence;
  if (expected !== undefined && expected !== null && Number(expected) !== trip.ratePence) {
    throw new UserError(`The company rate changed to ${trip.ratePence}p since your preview. Preview again before saving.`);
  }
  const key = submissionKey(payload, user);
  const result = await computeLegs(trip);
  // The double-tap check and the insert happen in one synchronous transaction, so two clicks can't both save.
  const entryIds = db.tx((d) => {
    const now = new Date();
    for (const [k, t] of savedSubmissions) if (now - t > SUBMISSION_TTL_MS) savedSubmissions.delete(k);
    if (key && savedSubmissions.has(key)) {
      throw new UserError('This journey has already been saved (Save was pressed twice). Check the Mileage list.');
    }
    const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
    const idBase = `E${stamp}-${crypto.randomBytes(4).toString('hex')}`; // hidden, unique per leg: E<time>-<8 hex>-<leg>
    const ins = d.prepare(`INSERT INTO log(date, start, destination, visit_reason, business, customer_id, miles, rate, claim,
                           month, data_type, ticket_id, entry_id, created, user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const l of result.legs) {
      ins.run(trip.date, l.from, l.to, trip.reason, l.business, l.customerId, l.miles, trip.ratePence / 100, l.claim,
              trip.date.slice(0, 7), trip.dataType, trip.ticket, `${idBase}-${l.n}`, now.toISOString(), user.id);
    }
    if (key) savedSubmissions.set(key, now.getTime()); // only once the rows are in
    return result.legs.map((l) => `${idBase}-${l.n}`);
  });
  const resp = tripResponse(trip, result, []);
  resp.entryIds = entryIds;
  resp.dataType = trip.dataType;
  resp.ticket = trip.ticket;
  const n = result.legs.length;
  resp.message = `Saved ${n} leg${n === 1 ? '' : 's'} for ${ukDate(trip.date)}: ${result.totalMiles.toFixed(1)} mi, ` +
                 `£${result.totalClaim.toFixed(2)}${trip.dataType === 'Test' ? ' (Test)' : ''}.`;
  return resp;
}

/** Admins can delete any entry; users only their own. Returns the deleted row as `deleted` (for the activity log). */
function deleteLogEntry(entryId, user) {
  const id = str(entryId, 80, 'Entry ID');
  const row = db.open().prepare(`SELECT l.user_id, l.date, l.start, l.destination, l.business, l.miles, l.claim, l.data_type,
      l.ticket_id, COALESCE(u.name, '') AS owner FROM log l LEFT JOIN "user" u ON u.id = l.user_id WHERE l.entry_id = ?`).get(id);
  if (!row) throw new UserError(`Entry ${id} not found (already deleted?). Refresh the list.`);
  if (user.role !== 'admin' && row.user_id !== user.id) throw new UserError("You can only delete your own entries.");
  const r = db.open().prepare('DELETE FROM log WHERE entry_id = ?').run(id);
  if (!r.changes) throw new UserError(`Entry ${id} not found (already deleted?). Refresh the list.`);
  return { message: `Deleted entry ${id}.`, deleted: { entryId: id, ...row } };
}

/**
 * The driving route for one log entry, for the route map: today's route between the start and destination
 * places' current coordinates, next to what was logged. Routes are cached by coordinates, so each pair is
 * fetched from Google once (and again only if a place moves). Visible to whoever can see the entry.
 */
async function routeForEntry(entryId, user) {
  const id = str(entryId, 80, 'Entry ID');
  const row = db.open().prepare('SELECT user_id, date, start, destination, business, miles, claim, rate FROM log WHERE entry_id = ?').get(id);
  if (!row) throw new UserError(`Entry ${id} not found (deleted?). Refresh the list.`);
  if (user.role === 'user' && row.user_id !== user.id) throw new UserError('You can only view your own entries.');

  const map = placeMap();
  const ends = [row.start, row.destination].map((name) => {
    const p = map.get(normKey(name));
    if (!p) throw new UserError(`"${name}" is no longer a saved place (renamed or deleted?), so this route can't be shown.`);
    if (p.lat === null) throw new UserError(`"${p.place}" has no coordinates. Add them on the Places page to see this route.`);
    return p;
  });
  const [from, to] = ends;
  const key = `${from.lat},${from.lng}>${to.lat},${to.lng}`;
  let cached = db.open().prepare('SELECT distance_m, duration_s, polyline FROM route_cache WHERE route_key = ?').get(key);
  const source = cached ? 'cache' : 'google';
  if (!cached) {
    const r = await computeRoute(from, to, 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline');
    cached = { distance_m: r.distanceMeters, duration_s: parseInt(r.duration, 10) || 0, polyline: (r.polyline && r.polyline.encodedPolyline) || '' };
    db.open().prepare(`INSERT OR REPLACE INTO route_cache(route_key, distance_m, duration_s, polyline, fetched) VALUES (?, ?, ?, ?, ?)`)
      .run(key, cached.distance_m, cached.duration_s, cached.polyline, new Date().toISOString());
  }
  const end = (p) => ({ place: p.place, address: p.address, lat: p.lat, lng: p.lng });
  return {
    entryId: id, date: row.date, dateUk: ukDate(row.date), business: row.business,
    from: end(from), to: end(to),
    loggedMiles: row.miles, claim: row.claim, ratePence: Math.round(row.rate * 10000) / 100,
    routeMiles: round1(cached.distance_m / 1609.344), minutes: Math.round(cached.duration_s / 60),
    polyline: cached.polyline, source,
  };
}

/* ------------------------------------------------------------------ */
/* Places                                                              */
/* ------------------------------------------------------------------ */


function validatePlace(input) {
  input = input || {};
  const place = str(input.place, 60, 'Place');
  if (/[,|]/.test(place)) throw new UserError('Place names cannot contain commas or "|".');
  let lat, lng;
  if (String(input.coords || '').trim()) ({ lat, lng } = parseCoords(input.coords));
  else {
    lat = optCoord(input.lat, 'Lat', -90, 90);
    lng = optCoord(input.lng, 'Lng', -180, 180);
  }
  if ((lat === null) !== (lng === null)) throw new UserError('Enter both Lat and Lng, or neither.');
  return {
    place,
    address: str(input.address, 300, 'Address', true),
    lat, lng,
    customer: customers.resolve(input.customerId),
    notes: str(input.notes, 500, 'Notes', true),
  };
}

function placeResult(message) {
  return { message, places: db.listPlaces(), customers: customers.list() };
}

function createPlace(input) {
  const p = validatePlace(input);
  return db.tx((d) => {
    const clash = d.prepare('SELECT place FROM places WHERE place = ? COLLATE NOCASE').get(p.place);
    if (clash) throw new UserError(`A place called "${clash.place}" already exists.`);
    d.prepare('INSERT INTO places(place, address, lat, lng, customer_id, default_business, notes) VALUES (?,?,?,?,?,?,?)')
      .run(p.place, p.address, p.lat, p.lng, p.customer ? p.customer.id : null, p.customer ? p.customer.name : '', p.notes);
    return placeResult(`Added "${p.place}".${p.lat === null ? ' No coordinates yet, so new distances to/from it cannot be looked up.' : ''}`);
  });
}

function updatePlace(id, input) {
  const p = validatePlace(input);
  return db.tx((d) => {
    const old = d.prepare('SELECT * FROM places WHERE id = ?').get(Number(id));
    if (!old) throw new UserError('That place no longer exists. Reload the page.');
    const clash = d.prepare('SELECT place FROM places WHERE place = ? COLLATE NOCASE AND id <> ?').get(p.place, old.id);
    if (clash) throw new UserError(`A place called "${clash.place}" already exists.`);
    d.prepare('UPDATE places SET place=?, address=?, lat=?, lng=?, customer_id=?, default_business=?, notes=? WHERE id=?')
      .run(p.place, p.address, p.lat, p.lng, p.customer ? p.customer.id : null, p.customer ? p.customer.name : '', p.notes, old.id);

    let message = `Saved "${p.place}".`;
    const renamed = old.place !== p.place;
    const moved = old.lat !== null && (old.lat !== p.lat || old.lng !== p.lng);
    if (renamed || moved) {
      const rows = d.prepare('SELECT * FROM distance_cache WHERE from_place = ? COLLATE NOCASE OR to_place = ? COLLATE NOCASE')
        .all(old.place, old.place);
      d.prepare('DELETE FROM distance_cache WHERE from_place = ? COLLATE NOCASE OR to_place = ? COLLATE NOCASE')
        .run(old.place, old.place);
      if (moved) {
        if (rows.length) message += ` Coordinates changed, so ${rows.length} cached distance(s) were cleared and will be re-fetched.`;
      } else {
        for (const r of rows) {
          const from = normKey(r.from_place) === normKey(old.place) ? p.place : r.from_place;
          const to = normKey(r.to_place) === normKey(old.place) ? p.place : r.to_place;
          db.cachePut(pairKey(from, to), from, to, r.miles, r.source, r.fetched);
        }
        if (rows.length) message += ` Renamed it in ${rows.length} cached distance(s).`;
      }
      if (renamed) message += ' Existing log rows keep the old name.';
    }
    return placeResult(message);
  });
}

function deletePlace(id) {
  return db.tx((d) => {
    const old = d.prepare('SELECT place FROM places WHERE id = ?').get(Number(id));
    if (!old) throw new UserError('That place no longer exists. Reload the page.');
    d.prepare('DELETE FROM places WHERE id = ?').run(Number(id));
    d.prepare('DELETE FROM distance_cache WHERE from_place = ? COLLATE NOCASE OR to_place = ? COLLATE NOCASE')
      .run(old.place, old.place);
    return placeResult(`Deleted "${old.place}". Existing log rows are not affected.`);
  });
}

module.exports = {
  previewTrip, saveTrip, deleteLogEntry, routeForEntry, createPlace, updatePlace, deletePlace,
  validateTrip, computeLegs, testGoogleKey, GOOGLE_SOURCE,
};
