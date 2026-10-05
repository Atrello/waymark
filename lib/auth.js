'use strict';
/**
 * Authentication via Better Auth (https://www.better-auth.com).
 *
 *   - Username + password sign-in (username plugin). Public sign-up is disabled; admins create users.
 *   - Optional two-factor (TOTP authenticator app + backup codes) and optional passkeys. Neither is forced.
 *   - Roles (admin / user / accounts) and deactivation (ban) via the admin plugin.
 *   - Sessions live in the database, so they can be listed and revoked.
 *
 * Better Auth gets its own SQLite connection to the same file: it holds interactive transactions across
 * awaits, which must never mix with the app's synchronous transactions on the main connection.
 */
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DatabaseSync } = require('node:sqlite');
const { betterAuth } = require('better-auth');
const { username } = require('better-auth/plugins/username');
const { twoFactor } = require('better-auth/plugins/two-factor');
const { admin } = require('better-auth/plugins/admin');
const { createAccessControl } = require('better-auth/plugins/access');
const { defaultStatements, adminAc, userAc } = require('better-auth/plugins/admin/access');
const { passkey } = require('@better-auth/passkey');
const { getMigrations } = require('better-auth/db/migration');
const baCrypto = require('better-auth/crypto');
const { createAuthMiddleware } = require('better-auth/api');
const db = require('./db');

const SESSION_DAYS = 30;
const USERNAME_RE = /^[a-z0-9._-]{2,40}$/i;

/**
 * Per-request notes for the activity log. server.js runs each /api/auth request inside requestContext;
 * the hooks below fill in the username a sign-in tried and the user a new session belongs to.
 */
const requestContext = new AsyncLocalStorage();

/** Public address of the app (used for passkeys and allowed origins). */
function appUrl() {
  return new URL(process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`);
}

function trustedOrigins() {
  const u = appUrl();
  const port = u.port ? `:${u.port}` : '';
  const list = new Set([u.origin, `http://localhost${port}`, `http://127.0.0.1${port}`]);
  String(process.env.TRUSTED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((o) => list.add(o));
  return [...list];
}

/* ---- Passwords: Better Auth's scrypt format, plus the app's earlier format so old passwords keep working ---- */

function legacyVerify(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6) return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

function options(database) {
  const ac = createAccessControl(defaultStatements);
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET must be set before auth is initialised.');
  return {
    appName: 'Waymark',
    database,
    secret,
    baseURL: appUrl().origin,
    basePath: '/api/auth',
    trustedOrigins: trustedOrigins(),
    telemetry: { enabled: false },
    advanced: {
      database: { generateId: 'serial' },
      useSecureCookies: appUrl().protocol === 'https:',
    },
    session: { expiresIn: SESSION_DAYS * 86400, updateAge: 86400 },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const note = requestContext.getStore();
        if (note && ctx.path === '/sign-in/username') note.username = String((ctx.body && ctx.body.username) || '').slice(0, 60);
      }),
    },
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            const note = requestContext.getStore();
            if (note) note.sessionUserId = Number(session.userId);
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 10,
      maxPasswordLength: 200,
      password: {
        hash: baCrypto.hashPassword,
        verify: async ({ hash, password }) =>
          (String(hash).startsWith('scrypt$') ? legacyVerify(password, hash) : baCrypto.verifyPassword({ hash, password })),
      },
    },
    plugins: [
      username({ minUsernameLength: 2, maxUsernameLength: 40, usernameValidator: (u) => USERNAME_RE.test(u) }),
      admin({
        ac,
        roles: { admin: adminAc, user: userAc, accounts: ac.newRole({}) },
        defaultRole: 'user',
        adminRoles: ['admin'],
      }),
      twoFactor({ issuer: 'Waymark' }),
      passkey({ rpID: appUrl().hostname, rpName: 'Waymark', origin: appUrl().origin }),
    ],
  };
}

let auth = null;
let ready = null;

/** Create Better Auth tables, migrate old accounts, and make sure an admin exists. Safe to call repeatedly. */
function init() {
  if (ready) return ready;
  ready = (async () => {
    const main = db.open();
    const database = new DatabaseSync(main.filePath);
    database.exec('PRAGMA busy_timeout = 5000;');
    const opts = options(database);
    await (await getMigrations(opts)).runMigrations();
    auth = betterAuth(opts);
    migrateLegacyUsers(main);
    await bootstrapAdmin(main);
    return auth;
  })();
  return ready;
}

function get() {
  if (!auth) throw new Error('Auth not initialised yet.');
  return auth;
}

/* ------------------------------------------------------------------ */
/* One-off migration from the app's own users table                    */
/* ------------------------------------------------------------------ */

function tableExists(d, name) {
  return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * Earlier versions kept users in `users` (scrypt hashes, integer ids). Copy them into Better Auth's
 * `user` + `account` tables with the same ids (so journeys stay linked), move profile fields to
 * `user_profile`, point log.user_id at the new table, then drop `users`. Existing passwords keep working.
 */
function migrateLegacyUsers(d) {
  if (!tableExists(d, 'users')) return;
  d.exec('PRAGMA foreign_keys = OFF');
  d.exec('BEGIN IMMEDIATE');
  try {
    const iso = (s) => (s ? `${String(s).replace(' ', 'T')}${String(s).endsWith('Z') ? '' : 'Z'}` : new Date().toISOString());
    const now = new Date().toISOString();
    const legacy = d.prepare('SELECT * FROM users').all();
    const insUser = d.prepare(`INSERT OR IGNORE INTO "user"(id, name, email, emailVerified, createdAt, updatedAt, username,
      displayUsername, role, banned, twoFactorEnabled) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 0)`);
    const insAcct = d.prepare(`INSERT INTO account(accountId, providerId, userId, password, createdAt, updatedAt)
      SELECT ?, 'credential', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM account WHERE userId = ? AND providerId = 'credential')`);
    const insProfile = d.prepare(`INSERT OR REPLACE INTO user_profile(user_id, home_place_id, rate_pence, must_change_password)
      VALUES (?, ?, ?, ?)`);
    for (const u of legacy) {
      const created = iso(u.created);
      insUser.run(u.id, u.name, `${u.username}@users.invalid`, created, created, u.username, u.username, u.role, u.active ? 0 : 1);
      insAcct.run(String(u.id), u.id, u.password_hash, now, now, u.id);
      insProfile.run(u.id, u.home_place_id, u.rate_pence, u.must_change_password ? 1 : 0);
    }
    rebuildLogUserFk(d);
    d.exec('DROP TABLE users');
    d.exec('COMMIT');
    console.log(`Moved ${legacy.length} user account(s) to Better Auth. Existing passwords still work.`);
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  } finally {
    d.exec('PRAGMA foreign_keys = ON');
  }
}

/** Recreate `log` so user_id references Better Auth's "user" table (SQLite can't alter a foreign key). */
function rebuildLogUserFk(d) {
  const cols = `id, date, start, destination, visit_reason, business, miles, rate, claim, month, data_type,
                ticket_id, entry_id, created, customer_id, user_id`;
  d.exec(`
    CREATE TABLE log_new (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      date         TEXT NOT NULL,
      start        TEXT NOT NULL,
      destination  TEXT NOT NULL,
      visit_reason TEXT NOT NULL DEFAULT '',
      business     TEXT NOT NULL DEFAULT '',
      miles        REAL NOT NULL,
      rate         REAL NOT NULL,
      claim        REAL NOT NULL,
      month        TEXT NOT NULL,
      data_type    TEXT NOT NULL DEFAULT 'Live' CHECK (data_type IN ('Live','Test')),
      ticket_id    TEXT NOT NULL DEFAULT '',
      entry_id     TEXT NOT NULL UNIQUE,
      created      TEXT NOT NULL,
      customer_id  INTEGER REFERENCES customers(id),
      user_id      INTEGER REFERENCES "user"(id)
    );
    INSERT INTO log_new (${cols}) SELECT ${cols} FROM log;
    DROP TABLE log;
    ALTER TABLE log_new RENAME TO log;
    CREATE INDEX IF NOT EXISTS log_date ON log(date);
    CREATE INDEX IF NOT EXISTS log_customer ON log(customer_id);
    CREATE INDEX IF NOT EXISTS log_user ON log(user_id, date);
  `);
}

/**
 * First run (no users at all): create the administrator "admin" (or ADMIN_USERNAME) with APP_PASSWORD.
 * Every run: journeys without an owner (e.g. from a CSV import) are given to the first active admin.
 */
async function bootstrapAdmin(d) {
  const count = d.prepare('SELECT COUNT(*) n FROM "user"').get().n;
  if (!count) {
    const pw = process.env.APP_PASSWORD;
    const name = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
    if (!pw || pw === 'change-me-to-something-long') {
      throw new Error('No users yet: set APP_PASSWORD in .env to create the first administrator.');
    }
    const res = await auth.api.createUser({
      body: { email: `${name}@users.invalid`, password: pw, name: name.charAt(0).toUpperCase() + name.slice(1), role: 'admin',
              data: { username: name, displayUsername: name } },
    });
    const home = d.prepare("SELECT id FROM places WHERE place = 'Home' COLLATE NOCASE").get();
    d.prepare('INSERT OR REPLACE INTO user_profile(user_id, home_place_id, must_change_password) VALUES (?, ?, 0)')
      .run(Number(res.user.id), home ? home.id : null);
    console.log(`Created administrator "${name}" (password = APP_PASSWORD from .env).`);
  }
  const first = d.prepare(`SELECT id FROM "user" WHERE role = 'admin' AND COALESCE(banned, 0) = 0 ORDER BY id LIMIT 1`).get();
  if (first) d.prepare('UPDATE log SET user_id = ? WHERE user_id IS NULL').run(first.id);
}

module.exports = { init, get, appUrl, trustedOrigins, requestContext, USERNAME_RE, SESSION_DAYS };
