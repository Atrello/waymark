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
const { UserError, str } = require('./util');

const ROLES = ['admin', 'user', 'accounts'];
const ROLE_LABELS = { admin: 'Administrator', user: 'User', accounts: 'Accounts' };
const MIN_PASSWORD = 10;

/* ---------------- Reads ---------------- */

const BASE = `SELECT u.id, u.username, u.name, u.email, u.role, COALESCE(u.banned, 0) AS banned,
    COALESCE(u.twoFactorEnabled, 0) AS twoFactorEnabled, u.createdAt AS created,
    COALESCE(p.must_change_password, 0) AS mustChangePassword, COALESCE(p.prompt_two_factor, 0) AS promptTwoFactor`;
const FROM = `
  FROM "user" u
  LEFT JOIN user_profile p ON p.user_id = u.id`;
// Last sign-in comes from the permanent activity log: session rows are deleted on sign-out and expiry.
const SELECT = `${BASE},
    (SELECT MAX(a.at) FROM audit_log a WHERE a.user_id = u.id AND a.action = 'auth.sign_in') AS lastLogin,
    (SELECT COUNT(*) FROM passkey k WHERE k.userId = u.id) AS passkeys,
    (SELECT COUNT(*) FROM log l WHERE l.user_id = u.id) AS legs${FROM}`;
// Just the account itself, for the per-request sign-in check (no counts).
const LEAN = `${BASE}${FROM}`;

function shape(u) {
  if (!u) return u;
  const { banned, ...rest } = u;
  return {
    ...rest,
    email: /@users\.invalid$/.test(u.email || '') ? '' : u.email, // placeholder addresses aren't shown
    active: !banned,
    twoFactorEnabled: !!u.twoFactorEnabled,
    mustChangePassword: !!u.mustChangePassword,
    promptTwoFactor: !!u.promptTwoFactor && !u.twoFactorEnabled,
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

/** The account (without counts) for a user id, or null if it doesn't exist. */
function find(id) {
  return shape(db.open().prepare(`${LEAN} WHERE u.id = ?`).get(Number(id))) || null;
}

/** The app user for a Better Auth session, or null if missing/deactivated. Runs on every request, so it stays lean. */
function fromSession(session) {
  if (!session || !session.user) return null;
  const u = find(session.user.id);
  return u && u.active ? u : null;
}

/** True while a Better Auth session row exists (sign-in steps that need a second factor delete theirs). */
function sessionExists(token) {
  return !!token && !!db.open().prepare('SELECT 1 FROM session WHERE token = ?').get(String(token));
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
  if (!s) return authLib.placeholderEmail(username); // Better Auth needs an email; this placeholder is never shown
  // The same rule Better Auth applies, so an address saved here never blocks a later admin edit.
  if (s.length > 200 || !authLib.EMAIL_RE.test(s)) throw new UserError('Email address is not valid.');
  return s;
}

function validRole(v) {
  if (!ROLES.includes(v)) throw new UserError('Role must be Administrator, User or Accounts.');
  return v;
}

function activeAdmins(exceptId) {
  return db.open().prepare(`SELECT COUNT(*) n FROM "user" WHERE role = 'admin' AND COALESCE(banned, 0) = 0 AND id <> ?`)
    .get(exceptId || 0).n;
}

function emailTaken(email, exceptId) {
  return !!db.open().prepare('SELECT 1 FROM "user" WHERE email = ? COLLATE NOCASE AND id <> ?').get(email, exceptId || 0);
}

/**
 * "Must change password" flag (set for temporary passwords). Upserts only this column, so other profile flags
 * (e.g. prompt_two_factor) are left alone. (Per-user home places and rates are no longer used.)
 */
function setMustChange(userId, on) {
  db.open().prepare(`INSERT INTO user_profile(user_id, must_change_password) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET must_change_password = excluded.must_change_password`).run(userId, on ? 1 : 0);
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

/* ---------------- First run: the first person to open the app creates the administrator ---------------- */

/** True until the first account exists. */
function needsSetup() {
  return db.open().prepare('SELECT COUNT(*) n FROM "user"').get().n === 0;
}

let setupBusy = false;

/**
 * Create the first administrator from the setup form. Refused once any account exists; requests that
 * arrive while one is being created are refused too, so two people can't both become the admin.
 */
async function createFirstAdmin(input) {
  input = input || {};
  const username = validUsername(input.username);
  const email = String(input.email == null ? '' : input.email).trim();
  if (!email) throw new UserError('Enter your email address.');
  const validatedEmail = validEmail(email, username);
  const password = checkPassword(input.password);
  if (setupBusy || !needsSetup()) throw new UserError('This app has already been set up. Sign in instead.');
  setupBusy = true;
  try {
    const res = await call(() => authLib.get().api.createUser({
      body: { email: validatedEmail, password, name: username.charAt(0).toUpperCase() + username.slice(1), role: 'admin',
        data: { username, displayUsername: username } },
    }));
    const id = Number(res.user.id);
    setMustChange(id, false);
    setTwoFactorPrompt(id, true);
    authLib.assignOrphanJourneys(db.open());
    return get(id);
  } finally {
    setupBusy = false;
  }
}

/** Whether to suggest two-factor sign-in when this user opens the app (set at setup; cleared on skip or turn-on). */
function setTwoFactorPrompt(userId, on) {
  db.open().prepare(`INSERT INTO user_profile(user_id, prompt_two_factor) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET prompt_two_factor = excluded.prompt_two_factor`).run(userId, on ? 1 : 0);
}

/* ---------------- Admin: create / update ---------------- */

/*
 * User changes run one at a time: the "at least one active administrator" check and the Better Auth calls that
 * follow it must not interleave with another change (two admins demoting each other at once).
 */
let queue = Promise.resolve();
function oneAtATime(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

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
  setMustChange(id, true);
  return { message: `Created ${ROLE_LABELS[role]} "${username}". Give them the temporary password; they'll be asked to change it.`, users: list() };
}

function update(id, input, actor, headers) {
  return oneAtATime(() => doUpdate(id, input, actor, headers));
}

async function doUpdate(id, input, actor, headers) {
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
  const newPassword = input.password ? checkPassword(input.password, 'New password') : null;

  const auth = authLib.get();
  const userId = String(u.id);
  const data = { name };
  if (email) data.email = email;
  await call(() => auth.api.adminUpdateUser({ headers, body: { userId, data } }));
  if (role !== u.role) await call(() => auth.api.setRole({ headers, body: { userId, role } }));
  if (!active && u.active) await call(() => auth.api.banUser({ headers, body: { userId, banReason: 'Deactivated by an administrator' } }));
  if (active && !u.active) await call(() => auth.api.unbanUser({ headers, body: { userId } }));

  let message = `Saved ${u.username}.`;
  if (newPassword) {
    await call(() => auth.api.setUserPassword({ headers, body: { userId, newPassword } }));
    await call(() => auth.api.revokeUserSessions({ headers, body: { userId } }));
    setMustChange(u.id, true);
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
function remove(id, actor, headers) {
  return oneAtATime(() => doRemove(id, actor, headers));
}

async function doRemove(id, actor, headers) {
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
  // Email is optional and only labels the account (authenticator apps, passkeys); sign-in uses the username.
  const email = input.email === undefined ? null : validEmail(input.email, user.username);
  if (email && emailTaken(email, user.id)) throw new UserError('Another user already has that email address.');
  const now = new Date().toISOString();
  if (email) db.open().prepare('UPDATE "user" SET name = ?, email = ?, updatedAt = ? WHERE id = ?').run(name, email, now, user.id);
  else db.open().prepare('UPDATE "user" SET name = ?, updatedAt = ? WHERE id = ?').run(name, now, user.id);
  return { message: 'Profile saved.', me: get(user.id) };
}

function passwordChanged(userId) {
  db.open().prepare('UPDATE user_profile SET must_change_password = 0 WHERE user_id = ?').run(userId);
}

module.exports = {
  ROLES, ROLE_LABELS, MIN_PASSWORD, list, get, find, fromSession, sessionExists, create, update, remove, updateProfile,
  passwordChanged, needsSetup, createFirstAdmin, setTwoFactorPrompt, resetTwoFactor, checkPassword,
};
