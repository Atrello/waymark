'use strict';
/**
 * Waymark — self-hosted web server.
 *   npm start   (reads .env)
 *
 * Auth: Better Auth (lib/auth.js) — username + password, optional 2FA (authenticator app) and passkeys.
 * Roles: admin (everything), user (own journeys), accounts (read-only, all users' journeys + exports).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { toNodeHandler, fromNodeHeaders } = require('better-auth/node');

const db = require('./lib/db');
const authLib = require('./lib/auth');
const mileage = require('./lib/mileage');
const exporter = require('./lib/exporter');
const googleKey = require('./lib/googleKey');
const customers = require('./lib/customers');
const users = require('./lib/users');
const audit = require('./lib/audit');
const { UserError, todayIso, ukDate, str } = require('./lib/util');

/* ---------------- Config ---------------- */

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET not set: using a random one, so everyone is signed out whenever the server restarts' +
               ' and a Google key saved in Settings cannot be decrypted after a restart.');
}

db.open();
const ready = authLib.init();
if (require.main === module) {
  ready.catch((e) => { console.error(e.message); process.exit(1); });
}

/* ---------------- Login throttling (per IP; Better Auth sees no client IP behind Node) ---------------- */

const failures = new Map();
function loginLocked(ip) {
  const f = failures.get(ip);
  return f && f.count >= 5 && Date.now() - f.first < 15 * 60000;
}
function noteFailure(ip) {
  if (failures.size > 1000) { // forget expired entries so the map can't grow without limit
    for (const [k, v] of failures) if (Date.now() - v.first > 15 * 60000) failures.delete(k);
  }
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > 15 * 60000) failures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

/** Copy Set-Cookie headers from a Better Auth Response onto the Express response. */
function forwardCookies(response, res) {
  for (const c of response.headers.getSetCookie()) res.append('Set-Cookie', c);
}

/* ---------------- App ---------------- */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.ready = ready;

/*
 * The map pages (place picker, route map) are the only ones that load Google's script, so they alone get the
 * looser policy Google documents for the Maps JavaScript API (and may be framed, by our own pages only). Everything else keeps
 * the strict policy below.
 */
const MAP_PAGES = new Set(['/map-picker.html', '/route-map.html']);
const MAP_PICKER_CSP = "default-src 'self'; " +
  "script-src 'self' https://*.googleapis.com https://*.gstatic.com *.google.com https://*.ggpht.com *.googleusercontent.com blob:; " +
  "img-src 'self' https://*.googleapis.com https://*.gstatic.com *.google.com *.googleusercontent.com data:; " +
  "connect-src 'self' https://*.googleapis.com *.google.com https://*.gstatic.com data: blob:; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
  "frame-src *.google.com; worker-src blob:; frame-ancestors 'self'; form-action 'self'";

app.use((req, res, next) => {
  const picker = MAP_PAGES.has(req.path);
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': picker ? 'SAMEORIGIN' : 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'",
  });
  if (picker) {
    res.set('Content-Security-Policy', MAP_PICKER_CSP);
    // Google checks a browser key's allowed websites against the Referer, so send our origin (never the path).
    res.set('Referrer-Policy', 'strict-origin');
  }
  next();
});

/*
 * Better Auth endpoints. Only the ones the app uses are reachable; admin/sign-up endpoints are not
 * exposed (admin actions go through /api/users, which enforces the app's rules). Must be mounted
 * before express.json(), which would consume the request body.
 */
const AUTH_ALLOWED = new Set([
  'POST /sign-in/username', 'POST /sign-out', 'GET /get-session',
  'POST /two-factor/enable', 'POST /two-factor/disable', 'POST /two-factor/verify-totp',
  'POST /two-factor/verify-backup-code', 'POST /two-factor/generate-backup-codes',
  'GET /passkey/generate-register-options', 'POST /passkey/verify-registration',
  'GET /passkey/generate-authenticate-options', 'POST /passkey/verify-authentication',
  'GET /passkey/list-user-passkeys', 'POST /passkey/delete-passkey', 'POST /passkey/update-passkey',
  'GET /list-sessions', 'POST /revoke-session', 'POST /revoke-other-sessions',
]);
/** Sign-in steps, with how the person proved who they are (for the activity log). */
const LOGIN_STEPS = new Map([
  ['/sign-in/username', 'password'], ['/two-factor/verify-totp', 'password + authenticator code'],
  ['/two-factor/verify-backup-code', 'password + backup code'], ['/passkey/verify-authentication', 'passkey'],
]);
/** Account-security actions taken while signed in: [action, summary]. */
const SECURITY_EVENTS = {
  '/sign-out': ['auth.sign_out', 'Signed out'],
  '/two-factor/disable': ['security.2fa_off', 'Turned off two-factor sign-in'],
  '/two-factor/generate-backup-codes': ['security.backup_codes', 'Generated new two-factor backup codes'],
  '/passkey/verify-registration': ['security.passkey_add', 'Added a passkey'],
  '/passkey/delete-passkey': ['security.passkey_remove', 'Removed a passkey'],
  '/revoke-session': ['security.sessions', 'Signed out one of their sessions'],
  '/revoke-other-sessions': ['security.sessions', 'Signed out all their other sessions'],
};
let authHandler = null;

app.all('/api/auth/{*rest}', async (req, res, next) => {
  try { await ready; } catch (e) { return next(e); }
  const sub = req.path.slice('/api/auth'.length) || '/';
  if (!AUTH_ALLOWED.has(`${req.method} ${sub}`)) return res.status(404).json({ message: 'Not found.' });
  // CSRF: state-changing calls must come from our own pages (a custom header can't be sent cross-site).
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'waymark') return res.status(403).json({ message: 'Bad request origin.' });
  if (LOGIN_STEPS.has(sub) && loginLocked(req.ip)) {
    audit.record(null, 'auth.locked_out', 'Sign-in refused: too many failed attempts from this address', req.ip);
    return res.status(429).json({ message: 'Too many attempts. Try again in 15 minutes.' });
  }
  // Who is already signed in (verifying a code while signed in means turning two-factor on, not signing in).
  const before = SECURITY_EVENTS[sub] || sub === '/two-factor/verify-totp' ? users.fromSession(await sessionOf(req)) : null;
  const note = {}; // filled in by the hooks in lib/auth.js
  res.on('finish', () => {
    const ok = res.statusCode < 300;
    if (LOGIN_STEPS.has(sub) && !before) {
      if (res.statusCode === 401 || res.statusCode === 403) {
        noteFailure(req.ip);
        audit.record(null, 'auth.sign_in_failed',
          `Failed sign-in (${LOGIN_STEPS.get(sub)})${note.username ? ` as "${note.username}"` : ''}`, req.ip);
      } else if (ok) {
        failures.delete(req.ip);
        const u = note.sessionUserId ? users.list().find((x) => x.id === note.sessionUserId) : null;
        if (u) audit.record(u, 'auth.sign_in', `Signed in (${LOGIN_STEPS.get(sub)})`, req.ip);
      }
    } else if (ok && before && sub === '/two-factor/verify-totp') {
      audit.record(before, 'security.2fa_on', 'Turned on two-factor sign-in', req.ip);
      users.setTwoFactorPrompt(before.id, false);
    } else if (ok && before && SECURITY_EVENTS[sub]) {
      audit.record(before, ...SECURITY_EVENTS[sub], req.ip);
    }
  });
  authHandler = authHandler || toNodeHandler(authLib.get());
  return authLib.requestContext.run(note, () => authHandler(req, res));
});

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

const PUBLIC = path.join(__dirname, 'public');
const OPEN_FILES = new Set(['/login.html', '/login.js', '/theme.js', '/styles.css', '/favicon.svg', '/webauthn.js']);
const VENDOR = {
  '/vendor/simplewebauthn.js': path.join(__dirname, 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js'),
  '/vendor/qrcode.js': path.join(__dirname, 'node_modules/qrcode-generator/dist/qrcode.js'),
};
for (const [route, file] of Object.entries(VENDOR)) {
  app.get(route, (req, res) => res.type('application/javascript').sendFile(file));
}

async function sessionOf(req) {
  await ready;
  try {
    return await authLib.get().api.getSession({ headers: fromNodeHeaders(req.headers) });
  } catch {
    return null;
  }
}

app.get('/login', async (req, res) => {
  if (users.fromSession(await sessionOf(req))) return res.redirect(303, '/');
  res.sendFile(path.join(PUBLIC, 'login.html'));
});

app.post('/logout', async (req, res) => {
  try {
    await ready;
    const u = users.fromSession(await sessionOf(req));
    if (u) audit.record(u, 'auth.sign_out', 'Signed out', req.ip);
    const r = await authLib.get().api.signOut({ headers: fromNodeHeaders(req.headers), asResponse: true });
    forwardCookies(r, res);
  } catch { /* already signed out */ }
  res.redirect(303, '/login');
});

/*
 * First-run setup: until an account exists, the sign-in page offers to create the administrator.
 * Whoever does it first becomes the admin; after that these refuse (see users.createFirstAdmin).
 */
app.get('/api/setup', async (req, res) => {
  await ready;
  res.set('Cache-Control', 'no-store').json({ needed: users.needsSetup() });
});
app.post('/api/setup', async (req, res) => {
  await ready;
  if (req.get('X-Requested-With') !== 'waymark') return res.status(403).json({ error: 'Bad request origin.' });
  const b = req.body || {};
  const u = await users.createFirstAdmin(b);
  audit.record(u, 'user.create', `Created the first administrator account ${u.username} (first-run setup)`, req.ip);
  const r = await authLib.get().api.signInUsername({
    body: { username: u.username, password: String(b.password), rememberMe: true }, headers: fromNodeHeaders(req.headers), asResponse: true,
  });
  forwardCookies(r, res);
  audit.record(u, 'auth.sign_in', 'Signed in (password, first-run setup)', req.ip);
  res.json({ ok: true });
});

// Everything below needs a signed-in, active user (req.user).
app.use(async (req, res, next) => {
  if (OPEN_FILES.has(req.path)) return next();
  try {
    req.user = users.fromSession(await sessionOf(req));
  } catch (e) {
    return next(e);
  }
  if (req.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in.' });
  res.redirect(303, '/login');
});

// CSRF for the app's own API (same rule as above).
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'waymark') return res.status(403).json({ error: 'Bad request origin.' });
  next();
});

/* ---------------- API ---------------- */

const api = express.Router();

/** Route guard: allow only these roles. */
const allow = (...roles) => (req, res, next) =>
  (roles.includes(req.user.role) ? next() : res.status(403).json({ error: "You don't have access to that." }));
const ADMIN = allow('admin');
const LOGGERS = allow('admin', 'user'); // people who log journeys
const viewsAll = (u) => u.role === 'admin' || u.role === 'accounts';
const userDirectory = () => users.list().map((u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: u.active }));
const headersOf = (req) => fromNodeHeaders(req.headers);

/* ---- Activity log helpers ---- */

/** Record what the signed-in user just did. */
const note = (req, action, summary) => audit.record(req.user, action, summary, req.ip);

/** [label, before, after] triples -> "Label: before → after; …" for the ones that changed ('' if none did). */
function changes(list) {
  const show = (v) => (v === null || v === undefined || v === '' ? '(blank)' : String(v));
  return list.filter(([, a, b]) => show(a) !== show(b)).map(([label, a, b]) => `${label}: ${show(a)} → ${show(b)}`).join('; ');
}
const coords = (p) => (p && p.lat !== null ? `${p.lat}, ${p.lng}` : '');
const ratePence = (v) => (v ? `${v}p` : '');
const placeById = (id) => db.listPlaces().find((p) => p.id === Number(id));
const sitesOf = (customerId) => db.listPlaces().filter((p) => p.customerId === Number(customerId)).map((p) => p.place);
const money = (n) => `£${Number(n).toFixed(2)}`;
const miles = (n) => `${Number(n).toFixed(1)} mi`;

/** What the browser gets about the signed-in user: ratePence = effective rate, ratePenceOwn = their override. */
function meView(u) {
  return { ...u, ratePenceOwn: u.ratePence, ratePence: users.rateFor(u) };
}

function globalSettings() {
  const s = db.getSettings();
  return { ratePence: s.ratePence, homePlaces: s.homePlaces };
}

api.get('/init', (req, res) => {
  const me = req.user;
  res.json({
    me: meView(me),
    users: viewsAll(me) ? userDirectory() : [],
    places: db.listPlaces(),
    customers: customers.list(),
    settings: globalSettings(),
    today: todayIso(),
    google: me.role === 'admin' ? googleKey.status() : { configured: googleKey.status().configured },
    mapsPicker: me.role === 'admin' ? googleKey.browserStatus() : { configured: googleKey.browserStatus().configured },
  });
});

/* ---- My account ---- */
api.get('/me', (req, res) => res.json({ me: meView(users.get(req.user.id)) }));
api.put('/me', (req, res) => {
  const before = users.get(req.user.id);
  const r = users.updateProfile(req.user, req.body);
  const diff = changes([['Name', before.name, r.me.name], ['Home place', before.homePlace, r.me.homePlace],
    ['Own rate', ratePence(before.ratePence), ratePence(r.me.ratePence)]]);
  if (diff) note(req, 'account.profile', `Updated own profile: ${diff}`);
  r.me = meView(r.me);
  res.json(r);
});
// The two-factor suggestion shown after first-run setup: 'Skip for now' turns it off.
api.put('/me/two-factor-prompt', (req, res) => {
  users.setTwoFactorPrompt(req.user.id, false);
  res.json({ ok: true });
});
api.put('/me/password', async (req, res) => {
  const b = req.body || {};
  const current = String(b.current || ''), next = String(b.next || '');
  users.checkPassword(next, 'New password');
  if (next === current) throw new UserError('New password must be different.');
  const r = await authLib.get().api.changePassword({
    headers: headersOf(req), body: { currentPassword: current, newPassword: next, revokeOtherSessions: true }, asResponse: true,
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new UserError(/invalid password/i.test(e.message || '') ? 'Current password is wrong.' : (e.message || 'Could not change password.'));
  }
  forwardCookies(r, res); // new session for this browser; other devices are signed out
  users.passwordChanged(req.user.id);
  note(req, 'account.password', 'Changed own password (other devices signed out)');
  res.json({ message: 'Password changed. Any other devices have been signed out.' });
});

/* ---- Users (admin) ---- */
api.get('/users', ADMIN, (req, res) => res.json({ users: users.list() }));
api.post('/users', ADMIN, async (req, res) => {
  const r = await users.create(req.body, req.user, headersOf(req));
  const u = r.users.find((x) => x.username === String(req.body.username).trim().toLowerCase());
  if (u) note(req, 'user.create', `Created user ${u.username} (${u.name}, ${u.roleLabel})`);
  res.json(r);
});
api.put('/users/:id', ADMIN, async (req, res) => {
  const before = users.get(req.params.id);
  const r = await users.update(req.params.id, req.body, req.user, headersOf(req));
  const after = users.get(before.id);
  const extra = [req.body.password && 'password reset', req.body.resetTwoFactor && before.twoFactorEnabled && 'two-factor turned off']
    .filter(Boolean);
  const diff = [changes([['Name', before.name, after.name], ['Email', before.email, after.email],
    ['Role', before.roleLabel, after.roleLabel], ['Status', before.active ? 'Active' : 'Inactive', after.active ? 'Active' : 'Inactive'],
    ['Home place', before.homePlace, after.homePlace], ['Rate', ratePence(before.ratePence), ratePence(after.ratePence)]]),
  ...extra].filter(Boolean).join('; ');
  if (diff) note(req, 'user.update', `Updated user ${before.username}: ${diff}`);
  res.json(r);
});
api.delete('/users/:id', ADMIN, async (req, res) => {
  const before = users.get(req.params.id);
  const r = await users.remove(req.params.id, req.user, headersOf(req));
  note(req, 'user.delete', `Deleted user ${before.username} (${before.name}, ${before.roleLabel})`);
  res.json(r);
});

/* ---- Google API key (admin; write-only — never returned) ---- */
api.put('/settings/google-key', ADMIN, (req, res) => {
  const status = googleKey.setKey(req.body && req.body.key);
  note(req, 'settings.google_key', 'Saved a new Google Maps API key');
  res.json({ message: 'Google Maps API key saved.', google: status });
});
api.delete('/settings/google-key', ADMIN, (req, res) => {
  const status = googleKey.removeKey();
  note(req, 'settings.google_key', 'Removed the saved Google Maps API key');
  res.json({ message: status.configured ? 'Saved key removed; falling back to the key in .env.' : 'Google Maps API key removed.', google: status });
});
api.post('/settings/google-key/test', ADMIN, async (req, res) => res.json(await mileage.testGoogleKey()));

/* ---- Maps browser key (admin sets it; any signed-in user gets it, since the maps run in their browser) ---- */
api.put('/settings/maps-browser-key', ADMIN, (req, res) => {
  const status = googleKey.setBrowserKey(req.body && req.body.key);
  note(req, 'settings.google_key', 'Saved a new Google Maps browser key (map picker)');
  res.json({ message: 'Map picker key saved.', mapsPicker: status });
});
api.delete('/settings/maps-browser-key', ADMIN, (req, res) => {
  const status = googleKey.removeBrowserKey();
  note(req, 'settings.google_key', 'Removed the saved Google Maps browser key (map picker)');
  res.json({ message: status.configured ? 'Saved key removed; falling back to the key in .env.' : 'Map picker key removed.', mapsPicker: status });
});
api.get('/maps-browser-key', (req, res) => {
  const key = googleKey.getBrowserKey();
  if (!key) throw new UserError('The map picker is not set up. An administrator can add a browser key under Settings.');
  res.set('Cache-Control', 'no-store');
  res.json({ key });
});

/* ---- Journeys ---- */
// Admin + accounts see everyone's entries; users see only their own.
api.get('/log', (req, res) => res.json({ rows: db.allLog(viewsAll(req.user) ? null : req.user.id) }));
api.get('/log/:entryId/route', async (req, res) => res.json(await mileage.routeForEntry(req.params.entryId, req.user)));
api.delete('/log/:entryId', LOGGERS, (req, res) => {
  const r = mileage.deleteLogEntry(req.params.entryId, req.user);
  const d = r.deleted;
  note(req, 'journey.delete', `Deleted entry ${d.entryId}${d.owner ? ` (${d.owner})` : ''}: ${ukDate(d.date)} ${d.start} → ${d.destination}, ` +
    `${miles(d.miles)}, ${money(d.claim)}, ${d.data_type}${d.business ? `, ${d.business}` : ''}${d.ticket_id ? `, ticket ${d.ticket_id}` : ''}`);
  delete r.deleted;
  res.json(r);
});

api.post('/trips/preview', LOGGERS, async (req, res) => res.json(await mileage.previewTrip(req.body, req.user)));
api.post('/trips', LOGGERS, async (req, res) => {
  const r = await mileage.saveTrip(req.body, req.user);
  const route = [r.legs[0].from, ...r.legs.map((l) => l.to)].join(' → ');
  note(req, 'journey.create', `Saved ${r.legs.length} leg${r.legs.length === 1 ? '' : 's'} for ${r.dateUk}: ${route}, ` +
    `${miles(r.totalMiles)}, ${money(r.totalClaim)} at ${r.ratePence}p, ${r.dataType}${r.ticket ? `, ticket ${r.ticket}` : ''} ` +
    `(${r.entryIds.join(', ')})`);
  res.json(r);
});

/* ---- Customers (everyone can read; admin manages) ---- */
api.get('/customers', (req, res) => res.json({ customers: customers.list() }));
api.post('/customers', ADMIN, (req, res) => {
  const r = customers.create(req.body);
  const c = r.customers.find((x) => x.name.toLowerCase() === String(req.body.name).trim().replace(/\s+/g, ' ').toLowerCase());
  const sites = c ? sitesOf(c.id) : [];
  note(req, 'customer.create', `Added customer "${c ? c.name : req.body.name}"${sites.length ? ` with sites: ${sites.join(', ')}` : ''}`);
  res.json(r);
});
api.put('/customers/:id', ADMIN, (req, res) => {
  const before = customers.get(req.params.id);
  const notesBefore = (customers.list().find((c) => c.id === before.id) || {}).notes;
  const sitesBefore = sitesOf(before.id);
  const r = customers.update(req.params.id, req.body);
  const after = r.customers.find((c) => c.id === before.id);
  const sitesAfter = sitesOf(before.id);
  const added = sitesAfter.filter((s) => !sitesBefore.includes(s)), removed = sitesBefore.filter((s) => !sitesAfter.includes(s));
  const diff = [changes([['Name', before.name, after.name], ['Notes', notesBefore, after.notes]]),
    added.length && `sites added: ${added.join(', ')}`, removed.length && `sites removed: ${removed.join(', ')}`].filter(Boolean).join('; ');
  if (diff) note(req, 'customer.update', `Updated customer "${before.name}": ${diff}`);
  res.json(r);
});
api.post('/customers/:id/merge', ADMIN, (req, res) => {
  const r = customers.merge(req.params.id, req.body && req.body.intoId);
  note(req, 'customer.merge', r.message);
  res.json(r);
});
api.delete('/customers/:id', ADMIN, (req, res) => {
  const before = customers.get(req.params.id);
  const r = customers.remove(req.params.id);
  note(req, 'customer.delete', `Deleted customer "${before.name}"`);
  res.json(r);
});

/* ---- Places (loggers add/edit; admin deletes) ---- */
api.post('/places', LOGGERS, (req, res) => {
  const r = mileage.createPlace(req.body);
  const p = r.places.find((x) => x.place.toLowerCase() === String(req.body.place).trim().replace(/\s+/g, ' ').toLowerCase());
  if (p) {
    note(req, 'place.create', `Added place "${p.place}": ${coords(p) || 'no coordinates'}${p.business ? `, customer ${p.business}` : ''}` +
      `${p.address ? `, ${p.address}` : ''}`);
  }
  res.json(r);
});
api.put('/places/:id', LOGGERS, (req, res) => {
  const before = placeById(req.params.id);
  const r = mileage.updatePlace(req.params.id, req.body);
  const after = r.places.find((p) => p.id === before.id);
  const diff = changes([['Name', before.place, after.place], ['Address', before.address, after.address],
    ['Coordinates', coords(before), coords(after)], ['Customer', before.business, after.business], ['Notes', before.notes, after.notes]]);
  if (diff) note(req, 'place.update', `Updated place "${before.place}": ${diff}`);
  res.json(r);
});
api.delete('/places/:id', ADMIN, (req, res) => {
  const before = placeById(req.params.id);
  const r = mileage.deletePlace(req.params.id);
  if (before) note(req, 'place.delete', `Deleted place "${before.place}"${coords(before) ? ` (${coords(before)})` : ''}`);
  res.json(r);
});

/* ---- Export (scoped: users get their own; admin/accounts pick a user or all) ---- */
api.get('/export/summary', (req, res) => {
  const x = exporter.buildExport(req.query, req.user);
  res.json({ label: x.period.label, scope: x.period.scope, filename: x.period.filename, summary: x.summary });
});
api.get('/export/csv', (req, res) => {
  const x = exporter.buildExport(req.query, req.user);
  note(req, 'export.csv', `Downloaded ${x.period.filename}: ${x.period.label}, ${x.period.scope} ` +
    `(${x.summary.legs} legs, ${miles(x.summary.miles)}, ${money(x.summary.claim)})`);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(x.period.filename);
  res.send(x.csv);
});

/* ---- Global settings + backups (admin) ---- */
api.put('/settings', ADMIN, (req, res) => {
  const b = req.body || {};
  const rate = Number(b.ratePence);
  if (!(rate > 0 && rate <= 200)) throw new UserError('Default rate must be between 1 and 200 pence.');
  const home = str(b.homePlaces, 500, 'Base places', true).split(',').map((x) => x.trim()).filter(Boolean).join(',');
  const before = globalSettings();
  db.tx(() => {
    db.setSetting('RatePence', String(rate));
    db.setSetting('HomePlaces', home);
  });
  const after = globalSettings();
  const diff = changes([['Default rate', ratePence(before.ratePence), ratePence(after.ratePence)],
    ['Base places', before.homePlaces.join(', '), after.homePlaces.join(', ')]]);
  if (diff) note(req, 'settings.update', `Changed settings: ${diff}`);
  res.json({ message: 'Settings saved.', settings: after });
});

api.post('/backup', ADMIN, (req, res) => {
  const r = exporter.backupNow();
  const files = `${path.basename(r.dbFile)} and ${path.basename(r.csvFile)}`;
  note(req, 'backup.server', `Saved a backup on the server: ${files}`);
  res.json({ message: `Backup saved on the server: ${files}.` });
});

api.get('/backup/download', ADMIN, (req, res) => {
  const tmp = path.join(os.tmpdir(), `waymark-${process.pid}-${Date.now()}.db`);
  exporter.snapshotDb(tmp);
  note(req, 'backup.download', 'Downloaded a copy of the database');
  res.download(tmp, `waymark-${todayIso()}.db`, () => fs.unlink(tmp, () => {}));
});

/* ---- Activity log (admin + accounts; read-only) ---- */
api.get('/activity', allow('admin', 'accounts'), (req, res) => res.json(audit.list(req.query)));

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use(express.static(PUBLIC, { index: 'index.html', extensions: ['html'] }));

// Errors: UserError -> 400 with its message; anything else -> 500 (details go to the server console only).
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof UserError) {
    console.log(`[refused] ${req.method} ${req.path}: ${err.message}`); // shown to the user too; logged to help support
    return res.status(400).json({ error: err.message });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

/* ---------------- Start ---------------- */

if (require.main === module) {
  ready.then(() => {
    app.listen(PORT, HOST, (err) => {
      if (err) {
        // Express 5 passes bind errors here (e.g. the port is already taken by another program).
        console.error(`Could not start on ${HOST}:${PORT}: ${err.code || err.message}. Is something else using port ${PORT}?`);
        process.exit(1);
      }
      console.log(`Waymark running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
      console.log(`App URL (passkeys): ${authLib.appUrl().origin}`);
      console.log(`Database: ${db.open().filePath}`);
      if (users.needsSetup()) {
        console.log(`No accounts yet. Open ${authLib.appUrl().origin} to create the administrator account.`);
        console.log('Until then, the first person to open the app can create it.');
      } else {
        console.log(`Users: ${users.list().filter((u) => u.active).map((u) => `${u.username} (${u.role})`).join(', ')}`);
      }
      const g = googleKey.status();
      console.log(`Google key: ${g.configured ? `set (${g.source === 'app' ? 'saved in Settings' : '.env'})` : 'not set (add it in Settings)'}`);
    });
    exporter.startScheduler();
  });
}

module.exports = app;
