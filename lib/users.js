'use strict';
/**
 * Users, on top of Better Auth (lib/auth.js).
 *   admin    — everything, including managing users. Logs their own journeys.
 *   user     — logs and sees only their own journeys; can add/edit places.
 *   accounts — read-only: sees every user's journeys and exports them.
 *
 * Better Auth owns the account itself (name, username, email, password, role, banned = deactivated,
 * 2FA, passkeys, sessions). App-specific fields live in user_profile.
 */
const db = require('./db');
const authLib = require('./auth');
const { UserError, str, normKey } = require('./util');

const ROLES = ['admin', 'user', 'accounts'];
const ROLE_LABELS = { admin: 'Administrator', user: 'User', accounts: 'Accounts' };
const MIN_PASSWORD = 10;

/* ---------------- Reads ---------------- */

const SELECT = `SELECT u.id, u.username, u.name, u.email, u.role, COALESCE(u.banned, 0) AS banned,
    COALESCE(u.twoFactorEnabled, 0) AS twoFactorEnabled, u.createdAt AS created,
    p.home_place_id AS homePlaceId, COALESCE(pl.place, '') AS homePlace, p.rate_pence AS ratePence,
    COALESCE(p.must_change_password, 0) AS mustChangePassword,
    (SELECT MAX(s.createdAt) FROM session s WHERE s.userId = u.id) AS lastLogin,
    (SELECT COUNT(*) FROM passkey k WHERE k.userId = u.id) AS passkeys,
    (SELECT COUNT(*) FROM log l WHERE l.user_id = u.id) AS legs
  FROM "user" u
  LEFT JOIN user_profile p ON p.user_id = u.id
  LEFT JOIN places pl ON pl.id = p.home_place_id`;

function shape(u) {
  if (!u) return u;
  const { banned, ...rest } = u;
  return {
    ...rest,
    email: /@users\.invalid$/.test(u.email || '') ? '' : u.email, // placeholder addresses aren't shown
    active: !banned,
    twoFactorEnabled: !!u.twoFactorEnabled,
    mustChangePassword: !!u.mustChangePassword,
    roleLabel: ROLE_LABELS[u.role] || u.role,
  };
}

function list() {
  return db.open().prepare(`${SELECT} ORDER BY COALESCE(u.banned, 0), u.name COLLATE NOCASE`).all().map(shape);
}

function get(id) {
  const u = shape(db.open().prepare(`${SELECT} WHERE u.id = ?`).get(Number(id)));
  if (!u) throw new UserError('That user no longer exists.');
  return u;
}

/** The app user for a Better Auth session, or null if missing/deactivated. */
function fromSession(session) {
  if (!session || !session.user) return null;
  const u = db.open().prepare(`${SELECT} WHERE u.id = ?`).get(Number(session.user.id));
  if (!u || u.banned) return null;
  return shape(u);
}

/** Rate (pence) to default new journeys to for this user. */
function rateFor(user) {
  return user.ratePence > 0 ? user.ratePence : db.getSettings().ratePence;
}

/** Place names treated as "home" for this user: shared base places (Settings) + their own home. */
function homePlacesFor(user) {
  const set = new Set(db.getSettings().homePlaces.map(normKey));
  if (user && user.homePlace) set.add(normKey(user.homePlace));
  return set;
}

/* ---------------- Validation ---------------- */

function checkPassword(pw, label = 'Password') {
  const s = String(pw == null ? '' : pw);
  if (s.length < MIN_PASSWORD) throw new UserError(`${label} must be at least ${MIN_PASSWORD} characters.`);
  if (s.length > 200) throw new UserError(`${label} is too long.`);
  return s;
}

function validUsername(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!authLib.USERNAME_RE.test(s)) throw new UserError('Username must be 2–40 characters: letters, numbers, dot, dash or underscore.');
  return s;
}

function validEmail(v, username) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return `${username}@users.invalid`; // Better Auth needs an email; this placeholder is never shown
  if (s.length > 200 || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s)) throw new UserError('Email address is not valid.');
  return s;
}

function validRole(v) {
  if (!ROLES.includes(v)) throw new UserError('Role must be Administrator, User or Accounts.');
  return v;
}

function validHomePlace(v) {
  if (v === '' || v == null) return null;
  const p = db.open().prepare('SELECT id FROM places WHERE id = ?').get(Number(v));
  if (!p) throw new UserError('That home place no longer exists.');
  return p.id;
}

function validRate(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!(n > 0 && n <= 200)) throw new UserError('Rate must be between 1 and 200 pence (or blank for the default).');
  return n;
}

function activeAdmins(exceptId) {
  return db.open().prepare(`SELECT COUNT(*) n FROM "user" WHERE role = 'admin' AND COALESCE(banned, 0) = 0 AND id <> ?`)
    .get(exceptId || 0).n;
}

function emailTaken(email, exceptId) {
  return !!db.open().prepare('SELECT 1 FROM "user" WHERE email = ? COLLATE NOCASE AND id <> ?').get(email, exceptId || 0);
}

/** mustChange undefined = keep the current flag. */
function setProfile(userId, homePlaceId, ratePence, mustChange) {
  const cur = db.open().prepare('SELECT must_change_password AS m FROM user_profile WHERE user_id = ?').get(userId);
  const m = mustChange === undefined ? (cur ? cur.m : 0) : (mustChange ? 1 : 0);
  db.open().prepare('INSERT OR REPLACE INTO user_profile(user_id, home_place_id, rate_pence, must_change_password) VALUES (?, ?, ?, ?)')
    .run(userId, homePlaceId, ratePence, m);
}

/** Better Auth API errors -> readable UserError. */
async function call(fn) {
  try {
    return await fn();
  } catch (e) {
    const msg = (e && e.body && e.body.message) || (e && e.message) || 'Request failed';
    throw new UserError(msg);
  }
}

/* ---------------- Admin: create / update ---------------- */

/** headers: the admin's request headers (Better Auth checks they're an admin). */
async function create(input, actor, headers) {
  input = input || {};
  const username = validUsername(input.username);
  const name = str(input.name, 80, 'Name');
  const role = validRole(input.role);
  const email = validEmail(input.email, username);
  const password = checkPassword(input.password, 'Temporary password');
  if (db.open().prepare('SELECT 1 FROM "user" WHERE username = ? COLLATE NOCASE').get(username)) {
    throw new UserError(`The username "${username}" is already taken.`);
  }
  if (emailTaken(email)) throw new UserError('Another user already has that email address.');
  const auth = authLib.get();
  const res = await call(() => auth.api.createUser({
    headers, body: { email, password, name, role, data: { username, displayUsername: username } },
  }));
  const id = Number(res.user.id);
  setProfile(id, role === 'accounts' ? null : validHomePlace(input.homePlaceId), role === 'accounts' ? null : validRate(input.ratePence), true);
  return { message: `Created ${ROLE_LABELS[role]} "${username}". Give them the temporary password; they'll be asked to change it.`, users: list() };
}

async function update(id, input, actor, headers) {
  input = input || {};
  const u = get(id);
  const name = str(input.name, 80, 'Name');
  const role = validRole(input.role);
  const active = input.active === undefined ? u.active : !!input.active;
  const email = input.email === undefined ? null : validEmail(input.email, u.username);
  if (actor && actor.id === u.id && (role !== 'admin' || !active)) {
    throw new UserError("You can't remove your own administrator access or deactivate yourself.");
  }
  if (u.role === 'admin' && u.active && (role !== 'admin' || !active) && activeAdmins(u.id) === 0) {
    throw new UserError('There must always be at least one active administrator.');
  }
  if (email && emailTaken(email, u.id)) throw new UserError('Another user already has that email address.');
  const homePlaceId = role === 'accounts' ? null : validHomePlace(input.homePlaceId);
  const ratePence = role === 'accounts' ? null : validRate(input.ratePence);
  const newPassword = input.password ? checkPassword(input.password, 'New password') : null;

  const auth = authLib.get();
  const userId = String(u.id);
  const data = { name };
  if (email) data.email = email;
  await call(() => auth.api.adminUpdateUser({ headers, body: { userId, data } }));
  if (role !== u.role) await call(() => auth.api.setRole({ headers, body: { userId, role } }));
  if (!active && u.active) await call(() => auth.api.banUser({ headers, body: { userId, banReason: 'Deactivated by an administrator' } }));
  if (active && !u.active) await call(() => auth.api.unbanUser({ headers, body: { userId } }));
  setProfile(u.id, homePlaceId, ratePence);

  let message = `Saved ${u.username}.`;
  if (newPassword) {
    await call(() => auth.api.setUserPassword({ headers, body: { userId, newPassword } }));
    await call(() => auth.api.revokeUserSessions({ headers, body: { userId } }));
    setProfile(u.id, homePlaceId, ratePence, true);
    message += ' Password reset; they have been signed out and will be asked to change it.';
  }
  if (input.resetTwoFactor && u.twoFactorEnabled) {
    resetTwoFactor(u.id);
    await call(() => auth.api.revokeUserSessions({ headers, body: { userId } }));
    message += ' Two-factor sign-in turned off for them.';
  }
  return { message, users: list() };
}

/**
 * Delete a user for good. Only allowed when they have no journeys (HMRC records must keep their owner);
 * anyone with journeys should be deactivated instead.
 */
async function remove(id, actor, headers) {
  const u = get(id);
  if (actor && actor.id === u.id) throw new UserError("You can't delete yourself.");
  if (u.role === 'admin' && u.active && activeAdmins(u.id) === 0) {
    throw new UserError('There must always be at least one active administrator.');
  }
  if (u.legs) {
    throw new UserError(`${u.name} has ${u.legs} journey leg(s), so they can't be deleted (mileage records must be kept). ` +
                        'Untick "Active" to deactivate them instead.');
  }
  // Better Auth removes the user, their sessions and their password; the rest is cleaned up here.
  await call(() => authLib.get().api.removeUser({ headers, body: { userId: String(u.id) } }));
  db.tx((d) => {
    d.prepare('DELETE FROM passkey WHERE userId = ?').run(u.id);
    d.prepare('DELETE FROM twoFactor WHERE userId = ?').run(u.id);
    d.prepare('DELETE FROM user_profile WHERE user_id = ?').run(u.id);
  });
  return { message: `Deleted ${u.username}.`, users: list() };
}

/** For a user who has lost their authenticator and backup codes. */
function resetTwoFactor(userId) {
  db.open().prepare('DELETE FROM twoFactor WHERE userId = ?').run(userId);
  db.open().prepare('UPDATE "user" SET twoFactorEnabled = 0 WHERE id = ?').run(userId);
}

/* ---------------- Self-service ---------------- */

/** Profile fields a user can change for themselves. */
function updateProfile(user, input) {
  input = input || {};
  const name = str(input.name, 80, 'Name');
  db.open().prepare('UPDATE "user" SET name = ?, updatedAt = ? WHERE id = ?').run(name, new Date().toISOString(), user.id);
  if (user.role === 'accounts') setProfile(user.id, null, null);
  else setProfile(user.id, validHomePlace(input.homePlaceId), validRate(input.ratePence));
  return { message: 'Profile saved.', me: get(user.id) };
}

function passwordChanged(userId) {
  db.open().prepare('UPDATE user_profile SET must_change_password = 0 WHERE user_id = ?').run(userId);
}

module.exports = {
  ROLES, ROLE_LABELS, MIN_PASSWORD, list, get, fromSession, create, update, remove, updateProfile, passwordChanged,
  resetTwoFactor, rateFor, homePlacesFor, checkPassword,
};
