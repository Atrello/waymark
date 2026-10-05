'use strict';
/* npm test — pure logic + a real (temporary) SQLite database. No Google calls are made. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waymark-test-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.BACKUP_DIR = path.join(tmp, 'backups');
delete process.env.GOOGLE_MAPS_API_KEY;
process.env.SESSION_SECRET = require('node:crypto').randomBytes(32).toString('hex');
process.env.APP_URL = 'http://localhost:3000';

const util = require('../lib/util');
const db = require('../lib/db');
const mileage = require('../lib/mileage');
const exporter = require('../lib/exporter');
const customers = require('../lib/customers');
const users = require('../lib/users');
const authLib = require('../lib/auth');
const PW = 'pw-for-tests-only';

/* ---- HTTP helpers (Better Auth sign-in) ---- */
function mergeCookies(jar, setCookies) {
  const m = new Map((jar || '').split('; ').filter(Boolean).map((c) => [c.slice(0, c.indexOf('=')), c]));
  for (const sc of setCookies || []) {
    const pair = sc.split(';')[0];
    const name = pair.slice(0, pair.indexOf('='));
    if (/max-age=0/i.test(sc) || pair.endsWith('=')) m.delete(name); else m.set(name, pair);
  }
  return [...m.values()].join('; ');
}
async function authPost(base, p, body, jar) {
  const r = await fetch(`${base}/api/auth${p}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'waymark', Origin: 'http://localhost:3000', ...(jar ? { cookie: jar } : {}) },
    body: JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json, jar: mergeCookies(jar, r.headers.getSetCookie()) };
}
/** Username + password sign-in. Returns the cookie jar, or null if refused. */
async function signIn(base, username, password) {
  const r = await authPost(base, '/sign-in/username', { username, password });
  return r.status === 200 && !r.json.twoFactorRedirect ? r.jar : null;
}
/* RFC 6238 TOTP for the tests (what an authenticator app does). */
function totp(secretB32, t = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretB32.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = require('node:crypto').createHmac('sha1', key).update(ctr).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
let ADMIN; // created in the database test once places exist

test('claim rounding, coords, pair keys, dates', () => {
  assert.equal(util.claimFor(23.5, 55), 12.93);
  assert.equal(util.claimFor(11.9, 55), 6.55);
  assert.deepEqual(util.parseCoords('54.83, -3.16'), { lat: 54.83, lng: -3.16 });
  assert.throws(() => util.parseCoords('nope'));
  assert.equal(util.pairKey('Home', 'Acme Depot'), util.pairKey(' acme depot', 'HOME'));
  assert.equal(util.parseIsoDate('2026-01-06'), '2026-01-06');
  assert.throws(() => util.parseIsoDate('2026-02-31'), /not a valid date/);
  assert.equal(util.lastDayOfMonth('2026-02'), '2026-02-28');
});

test('customer rule', () => {
  const home = { place: 'Home', customerId: null, business: '' };
  const office = { place: 'Office', customerId: 1, business: 'Example Ltd' };
  const depot = { place: 'Acme Depot', customerId: 2, business: 'Acme Ltd' };
  const acme = { id: 2, name: 'Acme Ltd' }, override = { id: 9, name: 'Override' };
  const fuel = { place: 'Fuel stop', customerId: null, business: '' };
  assert.deepEqual(util.legCustomer(home, depot, null), acme, "a leg takes the destination's customer");
  assert.deepEqual(util.legCustomer(depot, home, null), acme, 'the trip back from a site counts towards that customer');
  assert.deepEqual(util.legCustomer(depot, fuel, null), acme, 'any destination without a customer takes the origin');
  assert.deepEqual(util.legCustomer(depot, office, null), { id: 1, name: 'Example Ltd' }, 'a destination with a customer keeps it');
  assert.deepEqual(util.legCustomer(home, depot, override), override, 'the override wins');
  assert.equal(util.legCustomer(home, fuel, null), null, 'neither end has a customer');
});

test('database: places, cached trip, repeat trips, CSV, rename', async () => {
  const custId = (name) => {
    if (!name) return '';
    const found = customers.list().find((c) => c.name === name);
    return found ? found.id : customers.create({ name }).customers.find((c) => c.name === name).id;
  };
  const add = (place, lat, lng, business) => mileage.createPlace({ place, lat, lng, customerId: custId(business) });
  add('Home', 54.8296, -3.1505, '');
  add('Acme Depot', 54.8743, -3.3734, 'Acme Ltd');
  add('Office', 54.9296, -2.9573, 'Example Ltd');
  add('Beta Site', '', '', 'Beta Corp');
  assert.throws(() => add('home', 1, 1, ''), /already exists/);

  // First-run setup: no accounts yet, so the first visitor creates the administrator (and is signed in).
  const app = require('../server');
  await app.ready;
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const setup = (body, headers = { 'X-Requested-With': 'waymark' }) => fetch(`${base}/api/setup`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.deepEqual(await (await fetch(`${base}/api/setup`)).json(), { needed: true });
    assert.equal((await setup({ username: 'admin', email: 'admin@example.com', password: PW }, {})).status, 403, 'needs our header');
    assert.match((await (await setup({ username: 'admin', email: '', password: PW })).json()).error, /email/);
    assert.match((await (await setup({ username: 'admin', email: 'admin@example.com', password: 'short' })).json()).error, /at least 10/);
    // Two people submitting at once: once one setup has started, the other is refused (no second admin).
    const realCreate = users.createFirstAdmin;
    let started;
    const adminStarted = new Promise((resolve) => { started = resolve; });
    users.createFirstAdmin = (input) => { const p = realCreate(input); started(); return p; };
    let a, b;
    try {
      const pa = setup({ username: 'admin', email: 'admin@example.com', password: PW });
      await adminStarted;
      b = await setup({ username: 'intruder', email: 'x@example.com', password: 'intruder-password-1' });
      a = await pa;
    } finally {
      users.createFirstAdmin = realCreate;
    }
    assert.equal(a.status, 200, await a.clone().text());
    assert.equal(b.status, 400);
    assert.match((await b.json()).error, /already been set up/);
    const cookie = a.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const init = await (await fetch(`${base}/api/init`, { headers: { cookie } })).json();
    assert.equal(init.me.username, 'admin', 'signed in straight away');
    assert.equal(init.me.role, 'admin');
    assert.equal(init.me.promptTwoFactor, true, 'two-factor is suggested');
    assert.deepEqual(await (await fetch(`${base}/api/setup`)).json(), { needed: false });
    assert.match((await (await setup({ username: 'late', email: 'l@example.com', password: 'late-password-1' })).json()).error,
      /already been set up/);
    assert.equal(users.list().length, 1);
    // "Skip for now" stops the suggestion.
    const skip = await fetch(`${base}/api/me/two-factor-prompt`, { method: 'PUT', headers: { cookie, 'X-Requested-With': 'waymark' } });
    assert.equal(skip.status, 200);
    assert.equal((await (await fetch(`${base}/api/init`, { headers: { cookie } })).json()).me.promptTwoFactor, false);
  } finally {
    srv.close();
  }
  ADMIN = users.get(users.list().find((u) => u.username === 'admin').id);
  assert.equal(ADMIN.homePlace, undefined, 'users have no personal home place');
  assert.equal(ADMIN.email, 'admin@example.com');
  db.cachePut(util.pairKey('Home', 'Acme Depot'), 'Home', 'Acme Depot', 12, 'seed', null);
  db.cachePut(util.pairKey('Office', 'Acme Depot'), 'Office', 'Acme Depot', 24, 'seed', null);

  const today = util.todayIso();
  const trip = { date: today, stops: ['Home', 'Acme Depot', 'Acme Depot', 'Home'], ratePence: 55, dataType: 'Live' };

  const pv = await mileage.previewTrip(trip, ADMIN);
  assert.equal(pv.legs.length, 2);
  assert.deepEqual(pv.skipped, ['Acme Depot → Acme Depot']);
  assert.equal(pv.totalMiles, 24);
  assert.equal(pv.totalClaim, 13.2);
  assert.ok(pv.legs.every((l) => l.source === 'cache' && l.business === 'Acme Ltd'));

  const saved = await mileage.saveTrip({ ...trip, submissionId: 'preview-one-0001' }, ADMIN);
  assert.match(saved.message, /Saved 2 legs/);
  assert.equal(db.allLog().length, 2);

  // The same trip again on the same day is allowed (a real second trip): the preview mentions it, saving adds it.
  const again = await mileage.previewTrip(trip, ADMIN);
  assert.deepEqual(again.duplicates, ['Home → Acme Depot', 'Acme Depot → Home']);
  const second = await mileage.saveTrip({ ...trip, submissionId: 'preview-two-0002' }, ADMIN);
  assert.equal(db.allLog().length, 4);
  const ids = db.allLog().map((r) => r.entryId);
  assert.equal(new Set(ids).size, 4, 'every leg has its own hidden entry ID');
  assert.ok(second.entryIds.every((id) => /^E\d{8}T\d{6}-[0-9a-f]{8}-\d+$/.test(id)));

  // But pressing Save twice for one preview (same submission ID) only saves once, even if both arrive together.
  const twice = await Promise.allSettled([
    mileage.saveTrip({ ...trip, date: today, reason: 'Double tap', submissionId: 'preview-three-03' }, ADMIN),
    mileage.saveTrip({ ...trip, date: today, reason: 'Double tap', submissionId: 'preview-three-03' }, ADMIN),
  ]);
  assert.deepEqual(twice.map((t) => t.status).sort(), ['fulfilled', 'rejected']);
  assert.match(twice.find((t) => t.status === 'rejected').reason.message, /already been saved/);
  assert.equal(db.allLog().filter((r) => r.reason === 'Double tap').length, 2, 'one trip (2 legs), not two');
  await assert.rejects(mileage.saveTrip({ ...trip, submissionId: 'bad id!' }, ADMIN), /Invalid submission/);
  for (const r of db.allLog().filter((x) => x.reason === 'Double tap')) mileage.deleteLogEntry(r.entryId, ADMIN);
  assert.equal(db.allLog().length, 4);

  // Uncached leg to a place without coordinates is refused, naming the place.
  await assert.rejects(mileage.previewTrip({ ...trip, stops: ['Home', 'Beta Site'] }, ADMIN), /Missing coordinates for: Beta Site/);
  // Uncached leg with coordinates but no API key -> clear error, nothing cached.
  await assert.rejects(mileage.previewTrip({ ...trip, stops: ['Home', 'Office'] }, ADMIN), /No Google Maps API key/);
  // Future dates refused.
  await assert.rejects(mileage.previewTrip({ ...trip, date: '2999-01-01' }, ADMIN), /future/);

  // Test rows are excluded from exports.
  await mileage.saveTrip({ ...trip, ticket: 'T2', dataType: 'Test' }, ADMIN);
  const x = exporter.buildExport({ mode: 'month', month: today.slice(0, 7), userId: ADMIN.id }, ADMIN);
  assert.equal(x.summary.legs, 4);
  assert.equal(x.summary.claim, 26.4);
  const lines = x.csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Date,Start,Destination,Visit Reason,Business,Miles,Rate,Claim,Ticket ID');
  assert.equal(lines[5], 'TOTAL,,,,,48.0,,26.40,', 'journey rows then the TOTAL row');
  // Summary block after the rows, matching the Export page.
  assert.equal(lines[6], '');
  assert.equal(lines[7], 'SUMMARY');
  assert.ok(lines.includes('Covers,Admin'));
  assert.ok(lines.includes('Journey legs,4'));
  assert.ok(lines.includes('Total miles,48.0'));
  assert.ok(lines.includes('Total claim,26.40'));
  assert.ok(lines.includes('BY CUSTOMER,Legs,Miles,Claim'));
  assert.ok(lines.includes('Acme Ltd,4,48.0,26.40'));
  assert.ok(!lines.includes('BY USER,Legs,Miles,Claim'), 'single-user export has no per-user breakdown');
  const all = exporter.buildExport({ mode: 'month', month: today.slice(0, 7) }, ADMIN).csv;
  assert.ok(all.includes('BY USER,Legs,Miles,Claim\r\nAdmin,4,48.0,26.40'), 'all-users export breaks down by user');
  assert.equal(x.period.filename, `Mileage_${today.slice(0, 7)}_admin.csv`);

  // Rename keeps cache (re-keyed); moving coordinates clears it.
  const depot = db.listPlaces().find((p) => p.place === 'Acme Depot');
  mileage.updatePlace(depot.id, { place: 'Acme Yard', lat: depot.lat, lng: depot.lng, customerId: depot.customerId });
  assert.equal(db.cacheGet(util.pairKey('Home', 'Acme Yard')).miles, 12);
  mileage.updatePlace(depot.id, { place: 'Acme Yard', lat: 54.9, lng: -3.3, customerId: depot.customerId });
  assert.equal(db.cacheGet(util.pairKey('Home', 'Acme Yard')), null);

  // Delete one entry.
  const first = db.allLog()[0];
  mileage.deleteLogEntry(first.entryId, ADMIN);
  assert.ok(!db.allLog().some((r) => r.entryId === first.entryId));

  // Backup writes a db snapshot + CSV.
  const b = exporter.backupNow();
  assert.ok(fs.existsSync(b.dbFile) && fs.existsSync(b.csvFile));
});

test('Google key is write-only and encrypted at rest', async () => {
  const googleKey = require('../lib/googleKey');
  const KEY = 'AIzaSyTESTKEY_1234567890abcdefghij';

  assert.equal(googleKey.status().configured, false);
  assert.throws(() => googleKey.setKey('not a key!'), /does not look like/);
  googleKey.setKey(KEY);
  assert.deepEqual(googleKey.status(), { configured: true, source: 'app' });
  assert.equal(googleKey.getKey(), KEY);
  const stored = db.getSettingsRaw().GoogleMapsApiKeyEnc;
  assert.ok(stored && !stored.includes(KEY), 'stored value must be encrypted');

  // Nothing the browser can fetch contains the key.
  const app = require('../server');
  await app.ready;
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const cookie = await signIn(base, 'admin', PW);
    assert.ok(cookie, 'admin can sign in');
    const h = { cookie, 'X-Requested-With': 'waymark', 'Content-Type': 'application/json' };
    const bodies = [];
    for (const p of ['/api/init', '/api/log', '/api/export/summary?mode=month&month=2026-01']) {
      bodies.push(await (await fetch(base + p, { headers: h })).text());
    }
    bodies.push(await (await fetch(`${base}/api/settings/google-key`, { method: 'PUT', headers: h, body: JSON.stringify({ key: KEY }) })).text());
    for (const b of bodies) assert.ok(!b.includes(KEY), 'API response leaked the key');
    assert.match(bodies[0], /"google":\{"configured":true,"source":"app"\}/);

    // Map picker browser key: must differ from the server key; signed-in loggers can fetch it (the map runs in their browser).
    const put = (key) => fetch(`${base}/api/settings/maps-browser-key`, { method: 'PUT', headers: h, body: JSON.stringify({ key }) });
    assert.match((await (await put(KEY)).json()).error, /separate key/);
    const BROWSER = 'AIzaSyBROWSERKEY_0987654321zyxwvuts';
    assert.deepEqual((await (await put(BROWSER)).json()).mapsPicker, { configured: true, source: 'app' });
    assert.equal((await (await fetch(`${base}/api/maps-browser-key`, { headers: h })).json()).key, BROWSER);
    assert.match(await (await fetch(`${base}/api/init`, { headers: h })).text(), /"mapsPicker":\{"configured":true,"source":"app"\}/);
    assert.equal((await fetch(`${base}/api/maps-browser-key`)).status, 401, 'not without signing in');

    // Only the picker page gets Google's looser content policy, may be framed (by us), and sends our origin to Google.
    const picker = await fetch(`${base}/map-picker.html`, { headers: { cookie } });
    assert.equal(picker.status, 200);
    assert.match(picker.headers.get('content-security-policy'), /script-src 'self' https:\/\/\*\.googleapis\.com/);
    assert.match(picker.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.equal(picker.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(picker.headers.get('referrer-policy'), 'strict-origin');
    const main = await fetch(`${base}/`, { headers: { cookie } });
    assert.match(main.headers.get('content-security-policy'), /script-src 'self';/);
    assert.match(main.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(main.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(`${base}/map-picker.html`, { redirect: 'manual' })).status, 303, 'picker needs a sign-in too');

    const delB = await (await fetch(`${base}/api/settings/maps-browser-key`, { method: 'DELETE', headers: h })).json();
    assert.equal(delB.mapsPicker.configured, false);
    assert.equal((await fetch(`${base}/api/maps-browser-key`, { headers: h })).status, 400);
    assert.ok(require('../lib/audit').list({ search: 'map picker' }).rows.length >= 2, 'browser key changes are logged');

    const del = await (await fetch(`${base}/api/settings/google-key`, { method: 'DELETE', headers: h })).json();
    assert.equal(del.google.configured, false);
  } finally {
    srv.close();
  }
});

test('customers: rename everywhere, assign sites, merge, delete rules', async () => {
  const byName = (n) => customers.list().find((c) => c.name === n);
  const acme = byName('Acme Ltd');
  assert.ok(acme && acme.legs > 0, 'trips from the earlier test are linked to the customer');
  const legsBefore = db.allLog().filter((r) => r.customerId === acme.id).length;

  // Rename updates sites and past journey legs.
  customers.update(acme.id, { name: 'Acme Group Ltd' });
  assert.ok(db.allLog().filter((r) => r.customerId === acme.id).every((r) => r.business === 'Acme Group Ltd'));
  assert.equal(db.listPlaces().find((p) => p.place === 'Acme Yard').business, 'Acme Group Ltd');
  assert.equal(exporter.buildExport({ mode: 'month', month: util.todayIso().slice(0, 7) }).summary.byBusiness[0].business, 'Acme Group Ltd');
  assert.throws(() => customers.create({ name: 'acme group ltd' }), /already exists/);

  // A duplicate customer with a site; merge moves sites + legs and removes it.
  const dupe = customers.create({ name: 'Acme (old)' }).customers.find((c) => c.name === 'Acme (old)');
  const betaSite = db.listPlaces().find((p) => p.place === 'Beta Site');
  customers.update(dupe.id, { name: 'Acme (old)', placeIds: [betaSite.id] });
  assert.equal(db.listPlaces().find((p) => p.place === 'Beta Site').customerId, dupe.id);
  customers.merge(dupe.id, acme.id);
  assert.equal(byName('Acme (old)'), undefined);
  assert.equal(db.listPlaces().find((p) => p.place === 'Beta Site').customerId, acme.id);

  // Can't delete a customer with journeys; can delete one without (sites become unassigned).
  assert.throws(() => customers.remove(acme.id), /Use Merge/);
  const spare = customers.create({ name: 'Spare' }).customers.find((c) => c.name === 'Spare');
  customers.update(spare.id, { name: 'Spare', placeIds: [betaSite.id] });
  customers.remove(spare.id);
  assert.equal(db.listPlaces().find((p) => p.place === 'Beta Site').customerId, null);
  assert.equal(db.allLog().filter((r) => r.customerId === acme.id).length, legsBefore);

  // Customer override on a trip, and the home-place rule uses the origin's customer.
  const office = byName('Example Ltd');
  const pv = await mileage.previewTrip({ date: util.todayIso(), stops: ['Home', 'Acme Yard'], ratePence: 55,
    dataType: 'Test', customerId: office.id }, ADMIN).catch((e) => e);
  assert.ok(pv instanceof Error ? /coordinates|Google/i.test(pv.message) : pv.legs.every((l) => l.business === office.name));
  assert.throws(() => mileage.validateTrip({ date: util.todayIso(), stops: ['Home', 'Office'], ratePence: 55, customerId: 99999 }), /no longer exists/);
});

test('users + roles over HTTP: admin, user, accounts', async () => {
  const app = require('../server');
  await app.ready;
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const login = (username, password) => signIn(base, username, password);
  const call = async (cookie, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { cookie, 'X-Requested-With': 'waymark', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, json, text };
  };
  try {
    assert.equal(await login('admin', 'wrong-password!!'), null, 'bad password rejected');
    const admin = await login('admin', PW);
    assert.ok(admin);

    // Admin creates an engineer and Helen (accounts).
    const home = db.listPlaces().find((p) => p.place === 'Office');
    let r = await call(admin, 'POST', '/api/users', { username: 'bob', name: 'Bob Engineer', role: 'user', password: 'bob-temp-password', homePlaceId: home.id });
    assert.equal(r.status, 200, r.text);
    r = await call(admin, 'POST', '/api/users', { username: 'helen', name: 'Helen', role: 'accounts', password: 'helen-temp-password' });
    assert.equal(r.status, 200, r.text);
    r = await call(admin, 'POST', '/api/users', { username: 'Helen', name: 'Dup', role: 'user', password: 'xxxxxxxxxxxx' });
    assert.match(r.json.error, /already taken/);
    r = await call(admin, 'POST', '/api/users', { username: 'x1', name: 'Short', role: 'user', password: 'short' });
    assert.match(r.json.error, /at least 10/);

    const bob = await login('bob', 'bob-temp-password');
    const helen = await login('helen', 'helen-temp-password');
    assert.ok(bob && helen);

    // Bob logs a trip (cached leg). Same trip as the admin is fine: duplicates are per user.
    const trip = { date: util.todayIso(), stops: ['Home', 'Acme Yard'], ratePence: 45, dataType: 'Live' };
    db.cachePut(util.pairKey('Home', 'Acme Yard'), 'Home', 'Acme Yard', 12, 'seed', null);
    r = await call(bob, 'POST', '/api/trips', trip);
    assert.equal(r.status, 200, r.text);
    r = await call(admin, 'POST', '/api/trips', { ...trip, ticket: 'ROLE-TEST' });
    assert.equal(r.status, 200, r.text);

    // Rates come only from Settings: a rate sent with the trip (Bob sent 45p) or with a profile is ignored.
    assert.ok(db.allLog().filter((x) => x.username === 'bob').every((x) => x.rate === 0.55), 'claimed at the company rate');
    r = await call(bob, 'PUT', '/api/me', { name: 'Bob Engineer', homePlaceId: home.id, ratePence: 150 });
    assert.equal(r.json.me.ratePence, 55, 'no personal rate');
    assert.equal(r.json.me.ratePenceOwn, undefined);
    assert.equal(r.json.me.homePlace, undefined, 'no personal home place either');

    // Users change their own email.
    r = await call(bob, 'PUT', '/api/me', { name: 'Bob Engineer', email: 'Bob@Example.com' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.me.email, 'bob@example.com');
    assert.match((await call(bob, 'PUT', '/api/me', { name: 'Bob Engineer', email: 'not-an-email' })).json.error, /not valid/);
    assert.match((await call(bob, 'PUT', '/api/me', { name: 'Bob Engineer', email: 'admin@example.com' })).json.error, /already has that email/);
    assert.equal(users.get(r.json.me.id).email, 'bob@example.com', 'refused changes leave it alone');
    assert.ok(require('../lib/audit').list({ search: 'bob@example.com' }).rows.some((a) => a.action === 'account.profile'), 'logged');
    r = await call(bob, 'PUT', '/api/me', { name: 'Bob Engineer', email: '' });
    assert.equal(r.json.me.email, '', 'email can be cleared');
    assert.equal(r.json.me.homePlaceId, undefined);
    r = await call(bob, 'POST', '/api/trips/preview', { ...trip, ticket: 'RATE', ratePence: 199 });
    assert.equal(r.json.ratePence, 55);
    r = await call(admin, 'PUT', '/api/settings', { ratePence: 45 });
    assert.equal(r.status, 200, r.text);
    r = await call(bob, 'POST', '/api/trips/preview', { ...trip, ticket: 'RATE' });
    assert.equal(r.json.ratePence, 45, 'changing the company rate changes new journeys');
    assert.equal(r.json.totalClaim, 5.4);
    await call(admin, 'PUT', '/api/settings', { ratePence: 55 });

    // Visibility.
    const bobLog = (await call(bob, 'GET', '/api/log')).json.rows;
    assert.ok(bobLog.length >= 1 && bobLog.every((x) => x.username === 'bob'), 'user sees only own rows');
    const helenLog = (await call(helen, 'GET', '/api/log')).json.rows;
    assert.ok(helenLog.some((x) => x.username === 'bob') && helenLog.some((x) => x.username === 'admin'), 'accounts sees everyone');

    // Accounts is read-only.
    assert.equal((await call(helen, 'POST', '/api/trips', trip)).status, 403);
    assert.equal((await call(helen, 'DELETE', `/api/log/${bobLog[0].entryId}`)).status, 403);
    assert.equal((await call(helen, 'POST', '/api/places', { place: 'Nope' })).status, 403);
    assert.equal((await call(helen, 'GET', '/api/users')).status, 403);
    assert.equal((await call(helen, 'PUT', '/api/settings', {})).status, 403);
    assert.equal((await call(bob, 'GET', '/api/users')).status, 403);
    assert.equal((await call(bob, 'POST', '/api/customers', { name: 'Nope' })).status, 403);

    // A user can't delete someone else's entry; admin can delete anyone's.
    const adminRow = helenLog.find((x) => x.username === 'admin');
    r = await call(bob, 'DELETE', `/api/log/${adminRow.entryId}`);
    assert.match(r.json.error, /only delete your own/);

    // Exports: accounts gets everyone (with a User column) or one user; a user always gets only themselves.
    const month = util.todayIso().slice(0, 7);
    r = await call(helen, 'GET', `/api/export/csv?mode=month&month=${month}`);
    assert.match(r.text.split('\r\n')[0], /^﻿?User,Date,Start/);
    assert.ok(r.text.includes('Bob Engineer') && r.text.includes('Admin'));
    const bobId = (await call(admin, 'GET', '/api/users')).json.users.find((u) => u.username === 'bob').id;
    r = await call(helen, 'GET', `/api/export/summary?mode=month&month=${month}&userId=${bobId}`);
    assert.equal(r.json.scope, 'Bob Engineer');
    assert.match(r.json.filename, /_bob\.csv$/);
    r = await call(bob, 'GET', `/api/export/summary?mode=month&month=${month}&userId=`); // tries "all users"
    assert.equal(r.json.scope, 'Bob Engineer', 'user cannot widen export scope');
    assert.ok(r.json.summary.byUser.every((u) => u.user === 'Bob Engineer'));

    // Password change signs out other sessions; the old temp password stops working.
    r = await call(helen, 'PUT', '/api/me/password', { current: 'helen-temp-password', next: 'helen-new-password-1' });
    assert.equal(r.status, 200, r.text);
    assert.equal((await call(helen, 'GET', '/api/log')).status, 401, 'old cookie revoked');
    assert.equal(await login('helen', 'helen-temp-password'), null);
    assert.ok(await login('helen', 'helen-new-password-1'));

    // Deactivating a user signs them out; admin can't lock themselves out.
    r = await call(admin, 'PUT', `/api/users/${bobId}`, { name: 'Bob Engineer', role: 'user', active: false });
    assert.equal(r.status, 200, r.text);
    assert.equal((await call(bob, 'GET', '/api/log')).status, 401);
    const me = (await call(admin, 'GET', '/api/init')).json.me;
    r = await call(admin, 'PUT', `/api/users/${me.id}`, { name: 'Admin', role: 'accounts', active: true });
    assert.match(r.json.error, /own administrator access/);

    // Deleting: only admins, never yourself, never someone with journeys; a user with none is removed completely.
    assert.equal((await call(helen, 'DELETE', `/api/users/${bobId}`)).status, 401, 'helen was signed out above');
    const helen2 = await login('helen', 'helen-new-password-1');
    assert.equal((await call(helen2, 'DELETE', `/api/users/${bobId}`)).status, 403);
    r = await call(admin, 'DELETE', `/api/users/${me.id}`);
    assert.match(r.json.error, /delete yourself/);
    r = await call(admin, 'DELETE', `/api/users/${bobId}`);
    assert.match(r.json.error, /journey leg\(s\)/);
    r = await call(admin, 'POST', '/api/users', { username: 'temp', name: 'Temp', role: 'user', password: 'temp-password-1' });
    const tempId = r.json.users.find((u) => u.username === 'temp').id;
    const temp = await login('temp', 'temp-password-1');
    r = await call(admin, 'DELETE', `/api/users/${tempId}`);
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.json.users.some((u) => u.username === 'temp'));
    assert.equal((await call(temp, 'GET', '/api/log')).status, 401, 'deleted user is signed out');
    assert.equal(await login('temp', 'temp-password-1'), null);
    assert.equal(db.open().prepare('SELECT COUNT(*) n FROM user_profile WHERE user_id = ?').get(tempId).n, 0);

    // Activity log: the actions above were recorded, with who, what and where from.
    r = await call(admin, 'DELETE', `/api/log/${adminRow.entryId}`);
    assert.equal(r.status, 200, r.text);
    const act = (await call(admin, 'GET', '/api/activity')).json.rows;
    const has = (action, re, who) => act.some((a) => a.action === action && re.test(a.summary) && (!who || a.username === who));
    assert.ok(has('auth.sign_in_failed', /as "admin"/), 'failed sign-in records the username tried');
    assert.ok(has('auth.sign_in', /password/, 'bob'));
    assert.ok(has('journey.create', /Home → Acme Yard, 12\.0 mi/, 'bob'));
    assert.ok(has('export.csv', /^Downloaded Mileage_.*_all-users\.csv/, 'helen'));
    assert.ok(has('user.create', /bob \(Bob Engineer, User\)/, 'admin'));
    assert.ok(has('user.update', /Status: Active → Inactive/, 'admin'));
    assert.ok(has('user.delete', /temp/, 'admin'));
    assert.ok(has('account.password', /Changed own password/, 'helen'));
    assert.ok(has('journey.delete', new RegExp(`${adminRow.entryId} \\(Admin\\): .* Home → Acme Yard, 12\\.0 mi`), 'admin'),
      "a deleted entry's details survive in the log");
    assert.equal(act[0].ip, 'localhost');
    assert.ok((await call(admin, 'GET', '/api/activity?area=journey')).json.rows.every((a) => a.action.startsWith('journey.')));
    assert.ok((await call(admin, 'GET', `/api/activity?search=${adminRow.entryId}`)).json.rows.length >= 1);

    // Accounts can read it; users can't; nobody can change it, not even directly in the database.
    assert.equal((await call(helen2, 'GET', '/api/activity')).status, 200);
    await call(admin, 'POST', '/api/users', { username: 'eve', name: 'Eve', role: 'user', password: 'eve-password-123' });
    assert.equal((await call(await login('eve', 'eve-password-123'), 'GET', '/api/activity')).status, 403);
    assert.throws(() => db.open().prepare('DELETE FROM audit_log').run(), /cannot be changed/);
    assert.throws(() => db.open().prepare("UPDATE audit_log SET summary = 'x'").run(), /cannot be changed/);
  } finally {
    srv.close();
  }
});

test('Better Auth: optional 2FA, backup codes, passkeys, admin reset, hardening', async () => {
  const app = require('../server');
  await app.ready;
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (jar, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { cookie: jar, 'X-Requested-With': 'waymark', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, json };
  };
  try {
    const admin = await signIn(base, 'admin', PW);
    assert.ok(admin);

    // Hardening: no public sign-up, admin endpoints not exposed, custom header required.
    assert.equal((await authPost(base, '/sign-up/email', { email: 'x@example.com', password: 'whatever-123456', name: 'x' })).status, 404);
    assert.equal((await authPost(base, '/admin/set-role', { userId: '1', role: 'user' }, admin)).status, 404);
    const noHeader = await fetch(`${base}/api/auth/sign-in/username`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PW }) });
    assert.equal(noHeader.status, 403);

    // New user, 2FA off by default -> password alone signs in.
    let r = await call(admin, 'POST', '/api/users', { username: 'carol', name: 'Carol', role: 'user', password: 'carol-password-1', email: 'carol@example.com' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const carolId = r.json.users.find((u) => u.username === 'carol').id;
    let carol = await signIn(base, 'carol', 'carol-password-1');
    assert.ok(carol, '2FA is not forced');

    // Turn on 2FA (password, then a code from the app).
    let e = await authPost(base, '/two-factor/enable', { password: 'carol-password-1' }, carol);
    assert.equal(e.status, 200, JSON.stringify(e.json));
    assert.match(e.json.totpURI, /^otpauth:\/\/totp\/Waymark:carol%40example\.com/);
    const secret = new URL(e.json.totpURI).searchParams.get('secret');
    const backup = e.json.backupCodes;
    carol = e.jar;
    e = await authPost(base, '/two-factor/verify-totp', { code: totp(secret) }, carol);
    assert.equal(e.status, 200, JSON.stringify(e.json));
    assert.equal(users.get(carolId).twoFactorEnabled, true);

    // Now sign-in needs a code: wrong code refused, right code works, backup code works once.
    let s1 = await authPost(base, '/sign-in/username', { username: 'carol', password: 'carol-password-1' });
    assert.equal(s1.json.twoFactorRedirect, true);
    assert.equal((await call(s1.jar, 'GET', '/api/log')).status, 401, 'no session until the code is entered');
    assert.equal((await authPost(base, '/two-factor/verify-totp', { code: '000000' }, s1.jar)).status, 401);
    const ok = await authPost(base, '/two-factor/verify-totp', { code: totp(secret) }, s1.jar);
    assert.equal(ok.status, 200);
    assert.equal((await call(ok.jar, 'GET', '/api/log')).status, 200);
    s1 = await authPost(base, '/sign-in/username', { username: 'carol', password: 'carol-password-1' });
    assert.equal((await authPost(base, '/two-factor/verify-backup-code', { code: backup[0] }, s1.jar)).status, 200);
    s1 = await authPost(base, '/sign-in/username', { username: 'carol', password: 'carol-password-1' });
    assert.notEqual((await authPost(base, '/two-factor/verify-backup-code', { code: backup[0] }, s1.jar)).status, 200, 'backup codes are single use');

    // Passkeys: options are issued for this site (actual signing needs a real authenticator).
    const reg = await fetch(`${base}/api/auth/passkey/generate-register-options`, { headers: { cookie: ok.jar } });
    assert.equal(reg.status, 200);
    const regJson = await reg.json();
    assert.equal(regJson.rp.id, 'localhost');
    assert.equal(regJson.user.name, 'carol@example.com');
    const authOpts = await fetch(`${base}/api/auth/passkey/generate-authenticate-options`);
    assert.equal(authOpts.status, 200);
    assert.equal((await authOpts.json()).rpId, 'localhost');
    const list = await fetch(`${base}/api/auth/passkey/list-user-passkeys`, { headers: { cookie: ok.jar } });
    assert.deepEqual(await list.json(), []);

    // Admin turns off Carol's 2FA (lost phone): she is signed out and password alone works again.
    r = await call(admin, 'PUT', `/api/users/${carolId}`, { name: 'Carol', role: 'user', active: true, resetTwoFactor: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await call(ok.jar, 'GET', '/api/log')).status, 401);
    assert.ok(await signIn(base, 'carol', 'carol-password-1'));
    assert.equal(users.get(carolId).email, 'carol@example.com');

    // Brute force: 5 failures from one IP -> locked out (even with the right password).
    for (let i = 0; i < 5; i++) await authPost(base, '/sign-in/username', { username: 'carol', password: 'wrong-password-' + i });
    const locked = await authPost(base, '/sign-in/username', { username: 'carol', password: 'carol-password-1' });
    assert.equal(locked.status, 429);

    // Activity log: turning 2FA on is not mistaken for a sign-in; each sign-in records how it was proved.
    const carolActs = require('../lib/audit').list({ search: 'carol' }).rows.concat(require('../lib/audit').list({ userId: carolId }).rows);
    const did = (action, re) => carolActs.some((a) => a.action === action && re.test(a.summary));
    assert.ok(did('security.2fa_on', /Turned on two-factor/));
    assert.ok(did('auth.sign_in', /password \+ authenticator code/));
    assert.ok(did('auth.sign_in', /password \+ backup code/));
    assert.ok(did('auth.sign_in_failed', /as "carol"/));
    assert.ok(did('user.update', /two-factor turned off/));
    assert.ok(require('../lib/audit').list({ area: 'auth' }).rows.some((a) => a.action === 'auth.locked_out'));
  } finally {
    srv.close();
  }
});

test('route map: route for an entry, cached by coordinates, same visibility as the log', async () => {
  const googleKey = require('../lib/googleKey');
  googleKey.setKey('AIzaSyTESTKEY_route_1234567890abcdef');
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://routes.googleapis.com')) return realFetch(url, opts);
    calls++;
    assert.match(opts.headers['X-Goog-FieldMask'], /routes\.polyline\.encodedPolyline/);
    return new Response(JSON.stringify({ routes: [{ distanceMeters: 19312, duration: '1080s', polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' } }] }));
  };
  try {
    const rows = db.allLog();
    const yard = rows.find((r) => r.start === 'Home' && r.dest === 'Acme Yard' && r.username === 'bob');
    const byName = (n) => users.get(users.list().find((u) => u.username === n).id);

    const r1 = await mileage.routeForEntry(yard.entryId, ADMIN);
    assert.equal(r1.source, 'google');
    assert.deepEqual([r1.from.place, r1.to.place, r1.routeMiles, r1.minutes, r1.loggedMiles], ['Home', 'Acme Yard', 12, 18, 12]);
    assert.equal(r1.polyline, '_p~iF~ps|U_ulLnnqC');
    assert.equal((await mileage.routeForEntry(yard.entryId, byName('helen'))).source, 'cache', 'accounts can view; second time is cached');
    assert.equal((await mileage.routeForEntry(yard.entryId, byName('bob'))).source, 'cache', 'owner can view');
    await assert.rejects(mileage.routeForEntry(yard.entryId, byName('eve')), /only view your own/);
    assert.equal(calls, 1);

    // Moving a place gives a fresh route; an entry whose place was renamed since explains why there's no map.
    const home = db.listPlaces().find((p) => p.place === 'Home');
    mileage.updatePlace(home.id, { place: 'Home', lat: 54.83, lng: -3.15 });
    assert.equal((await mileage.routeForEntry(yard.entryId, ADMIN)).source, 'google');
    assert.equal(calls, 2);
    const renamed = rows.find((r) => r.dest === 'Acme Depot' || r.start === 'Acme Depot');
    await assert.rejects(mileage.routeForEntry(renamed.entryId, ADMIN), /no longer a saved place/);
  } finally {
    global.fetch = realFetch;
    googleKey.removeKey();
  }
});

test('scheduled backups: UK-time schedule maths, runs once per slot, keeps the last N, never prunes manual backups', async () => {
  const schedule = require('../lib/schedule');
  const at = (iso) => Date.parse(iso);

  // Schedule maths (times are UK wall-clock).
  const weekly = schedule.window({ frequency: 'weekly', start: '2026-10-06T02:00' }, at('2026-10-20T12:00:00Z'));
  assert.equal(new Date(weekly.last).toISOString(), '2026-10-20T01:00:00.000Z', 'Tue 02:00 BST');
  assert.equal(schedule.occurrence({ frequency: 'monthly', start: '2026-01-31T02:00' }, 1), at('2026-02-28T02:00:00Z'), 'last day of Feb');
  const daily = schedule.window({ frequency: 'daily', start: '2026-10-20T02:00' }, at('2026-10-26T12:00:00Z'));
  assert.equal(new Date(daily.last).toISOString(), '2026-10-26T02:00:00.000Z', 'still 02:00 UK after the clocks go back');
  assert.deepEqual(schedule.window({ frequency: 'off', start: '2026-01-01T00:00' }, Date.now()), { last: null, next: null });
  assert.equal(schedule.window({ frequency: 'daily', start: '2030-01-01T02:00' }, at('2026-10-05T12:00:00Z')).last, null, 'not started yet');
  assert.throws(() => schedule.parseSchedule({ frequency: 'fortnightly', start: '2026-10-06T02:00' }), /how often/);
  assert.throws(() => schedule.parseSchedule({ frequency: 'daily', start: '2026-02-30T02:00' }), /start date/);
  assert.throws(() => schedule.parseSchedule({ frequency: 'daily', start: '2026-10-06T02:00', keep: -1 }), /whole number/);

  // Saving a schedule never sets off a backup at once; each scheduled slot then backs up exactly once.
  const dir = process.env.BACKUP_DIR;
  const autos = () => fs.readdirSync(dir).filter((f) => /^waymark-auto-\d/.test(f) && f.endsWith('.db')).sort();
  const manual = exporter.backupNow('manual', new Date('2026-01-01T00:00:00Z'));
  const now = new Date('2026-10-05T12:00:00Z');
  const st = exporter.setSchedule({ frequency: 'daily', start: '2026-10-01T02:00', keep: 2 }, now);
  assert.equal(st.nextText, 'Tue 06/10/2026 02:00');
  assert.equal(await exporter.schedulerTick(now), null, 'nothing due yet');
  const day = (n) => new Date(Date.parse('2026-10-06T03:00:00Z') + n * 86400000);
  assert.ok(await exporter.schedulerTick(day(0)), 'Tuesday 02:00 slot backs up');
  assert.equal(await exporter.schedulerTick(new Date(day(0).getTime() + 60000)), null, 'only once per slot');
  // Off for three days: one catch-up backup, not three.
  assert.ok(await exporter.schedulerTick(day(3)));
  assert.equal(await exporter.schedulerTick(day(3)), null);
  assert.ok(await exporter.schedulerTick(day(4)));
  assert.deepEqual(autos(), ['waymark-auto-2026-10-09-03-00-00.db', 'waymark-auto-2026-10-10-03-00-00.db'], 'kept the newest 2');
  assert.ok(fs.existsSync(manual.dbFile) && fs.existsSync(manual.csvFile), 'manual backups are never pruned');
  assert.ok(require('../lib/audit').list({ area: 'backup' }).rows.some((a) => a.action === 'backup.scheduled' && /every day/.test(a.summary)));
  assert.equal(exporter.scheduleStatus(day(4)).lastFile, 'waymark-auto-2026-10-10-03-00-00.db');

  // Off means off.
  exporter.setSchedule({ frequency: 'off', start: '2026-10-01T02:00', keep: 2 }, day(4));
  assert.equal(await exporter.schedulerTick(day(30)), null);
});

test('built Svelte app: sign-in page and its bundles are open, everything else needs a sign-in', async () => {
  const http = require('node:http');
  const app = require('../server');
  await app.ready;
  const srv = app.listen(0);
  const port = srv.address().port;
  // Raw request, so paths like /assets/../index.html reach the server exactly as written (fetch would tidy them up).
  const raw = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; }).on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    }).on('error', reject);
  });
  try {
    const login = await raw('/login');
    assert.equal(login.status, 200);
    const assets = [...login.body.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(assets.length >= 2, 'the sign-in page loads its built script and styles');
    for (const a of assets) assert.equal((await raw(a)).status, 200, `${a} loads without signing in`);
    assert.equal((await raw('/theme.js')).status, 200);

    for (const p of ['/', '/index.html', '/map-picker.html', '/route-map.html', '/assets/../index.html', '/assets/%2e%2e/index.html', '/assets/x/../../index.html']) {
      const r = await raw(p);
      assert.equal(r.status, 303, `${p} needs a sign-in`);
      assert.match(r.location, /\/login$/);
    }
    assert.equal((await raw('/api/init')).status, 401);
  } finally {
    srv.close();
  }
});
