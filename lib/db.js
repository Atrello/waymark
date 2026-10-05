'use strict';
/**
 * SQLite storage (Node's built-in node:sqlite). One file: DB_FILE (default ./data/waymark.db).
 * All access is synchronous, so each request's writes are atomic without extra locking.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS places (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  place            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  address          TEXT NOT NULL DEFAULT '',
  lat              REAL,
  lng              REAL,
  default_business TEXT NOT NULL DEFAULT '',
  notes            TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS distance_cache (
  pair_key  TEXT PRIMARY KEY,
  from_place TEXT NOT NULL,
  to_place   TEXT NOT NULL,
  miles      REAL NOT NULL,
  source     TEXT NOT NULL DEFAULT '',
  fetched    TEXT
);
-- Driving routes drawn on the Mileage page's route map, keyed by coordinates (direction matters), so a
-- place whose coordinates change simply gets a fresh route. Separate from distance_cache, which sets claims.
CREATE TABLE IF NOT EXISTS route_cache (
  route_key  TEXT PRIMARY KEY,          -- "lat,lng>lat,lng"
  distance_m INTEGER NOT NULL,
  duration_s INTEGER NOT NULL,
  polyline   TEXT NOT NULL,             -- Google encoded polyline
  fetched    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,             -- YYYY-MM-DD
  start        TEXT NOT NULL,
  destination  TEXT NOT NULL,
  visit_reason TEXT NOT NULL DEFAULT '',
  business     TEXT NOT NULL DEFAULT '',
  miles        REAL NOT NULL,
  rate         REAL NOT NULL,             -- £ per mile, e.g. 0.55
  claim        REAL NOT NULL,             -- £, 2dp
  month        TEXT NOT NULL,             -- YYYY-MM
  data_type    TEXT NOT NULL DEFAULT 'Live' CHECK (data_type IN ('Live','Test')),
  ticket_id    TEXT NOT NULL DEFAULT '',
  entry_id     TEXT NOT NULL UNIQUE,
  created      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS log_date ON log(date);
CREATE TABLE IF NOT EXISTS customers (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  notes   TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Per-user app settings. Accounts themselves ("user", account, session, twoFactor, passkey …) belong to Better Auth.
CREATE TABLE IF NOT EXISTS user_profile (
  user_id              INTEGER PRIMARY KEY,
  home_place_id        INTEGER REFERENCES places(id) ON DELETE SET NULL,
  rate_pence           REAL,
  must_change_password INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
-- Activity log (lib/audit.js). Append-only: rows can't be changed or deleted. username is a snapshot,
-- so entries stay readable after a user is renamed or deleted (hence no foreign key on user_id).
CREATE TABLE IF NOT EXISTS audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,             -- ISO timestamp (UTC)
  user_id  INTEGER,                   -- null = the system or an unknown visitor
  username TEXT NOT NULL DEFAULT '',
  action   TEXT NOT NULL,             -- e.g. journey.delete, export.csv
  summary  TEXT NOT NULL,
  ip       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'The activity log cannot be changed.'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'The activity log cannot be changed.'); END;
`;

const DEFAULT_SETTINGS = {
  RatePence: '55',
  HomePlaces: 'Home',
};

let db = null;

function open(file = process.env.DB_FILE || './data/waymark.db') {
  if (db) return db;
  const full = path.resolve(file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  db = new DatabaseSync(full);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  db.filePath = full;
  return db;
}

function hasColumn(d, table, col) {
  return d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

/**
 * Customers: places.customer_id and log.customer_id link to customers(id). The text columns
 * places.default_business / log.business are kept as a mirror of the customer's name (so exports
 * and backups read naturally) and are rewritten whenever a customer is renamed or merged.
 * Any row with a name but no link (older data, CSV imports) is linked here, creating customers as needed.
 */
function migrate(d) {
  if (!hasColumn(d, 'places', 'customer_id')) d.exec('ALTER TABLE places ADD COLUMN customer_id INTEGER REFERENCES customers(id)');
  if (!hasColumn(d, 'log', 'customer_id')) d.exec('ALTER TABLE log ADD COLUMN customer_id INTEGER REFERENCES customers(id)');
  if (!hasColumn(d, 'log', 'user_id')) d.exec('ALTER TABLE log ADD COLUMN user_id INTEGER REFERENCES "user"(id)');
  d.exec('CREATE INDEX IF NOT EXISTS log_user ON log(user_id, date)');
  d.exec(`
    CREATE INDEX IF NOT EXISTS log_customer ON log(customer_id);
    CREATE INDEX IF NOT EXISTS places_customer ON places(customer_id);
  `);
  linkCustomers(d);
  // Email was removed from the app; drop its old settings.
  d.exec("DELETE FROM settings WHERE key IN ('EmailTo', 'MonthlyEmail', 'LastMonthlyEmail')");
}

/** Link rows that have a customer name but no customer_id, creating customers as needed. */
function linkCustomers(d = open()) {
  d.exec(`
    INSERT OR IGNORE INTO customers(name)
      SELECT TRIM(default_business) FROM places WHERE customer_id IS NULL AND TRIM(default_business) <> ''
      UNION SELECT TRIM(business) FROM log WHERE customer_id IS NULL AND TRIM(business) <> '';
    UPDATE places SET customer_id = (SELECT id FROM customers c WHERE c.name = TRIM(places.default_business))
      WHERE customer_id IS NULL AND TRIM(default_business) <> '';
    UPDATE log SET customer_id = (SELECT id FROM customers c WHERE c.name = TRIM(log.business))
      WHERE customer_id IS NULL AND TRIM(business) <> '';
  `);
}

/** Run fn inside a transaction; rolls back if it throws. Nested calls join the outer transaction. */
let txDepth = 0;
function tx(fn) {
  const d = open();
  if (txDepth > 0) return fn(d);
  d.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const r = fn(d);
    txDepth--;
    d.exec('COMMIT');
    return r;
  } catch (e) {
    txDepth--;
    d.exec('ROLLBACK');
    throw e;
  }
}

/* ---------------- Settings ---------------- */

function getSettingsRaw() {
  const out = {};
  for (const r of open().prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

function getSettings() {
  const s = getSettingsRaw();
  const rate = Number(s.RatePence);
  return {
    ratePence: rate > 0 ? rate : 55,
    homePlaces: String(s.HomePlaces || 'Home').split(',').map((x) => x.trim()).filter(Boolean),
    raw: s,
  };
}

function setSetting(key, value) {
  open().prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/* ---------------- Places ---------------- */

function listPlaces() {
  return open().prepare(`SELECT p.id, p.place, p.address, p.lat, p.lng, p.customer_id AS customerId,
                           COALESCE(c.name, '') AS business, p.notes
                         FROM places p LEFT JOIN customers c ON c.id = p.customer_id
                         ORDER BY p.place COLLATE NOCASE`).all()
    .map((r) => {
      const has = r.lat != null && r.lng != null;
      return { ...r, lat: has ? r.lat : null, lng: has ? r.lng : null };
    });
}

/* ---------------- Distance cache ---------------- */

function cacheGet(key) {
  return open().prepare('SELECT miles, source FROM distance_cache WHERE pair_key = ?').get(key) || null;
}

function cachePut(key, from, to, miles, source, fetched) {
  open().prepare(`INSERT INTO distance_cache(pair_key, from_place, to_place, miles, source, fetched)
                  VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(pair_key) DO UPDATE SET from_place = excluded.from_place, to_place = excluded.to_place,
                    miles = excluded.miles, source = excluded.source, fetched = excluded.fetched`)
    .run(key, from, to, miles, source, fetched);
}

/* ---------------- Log ---------------- */

const LOG_COLS = `l.id, l.date, l.start, l.destination AS dest, l.visit_reason AS reason, l.business,
                  l.customer_id AS customerId, l.miles, l.rate, l.claim, l.month, l.data_type AS type,
                  l.ticket_id AS ticket, l.entry_id AS entryId, l.created, l.user_id AS userId,
                  COALESCE(u.name, '') AS userName, COALESCE(u.username, '') AS username`;
const LOG_FROM = 'FROM log l LEFT JOIN "user" u ON u.id = l.user_id';

/** All journey legs, newest first. userId limits to one user (null/undefined = everyone). */
function allLog(userId) {
  const one = userId != null;
  return open().prepare(`SELECT ${LOG_COLS} ${LOG_FROM} ${one ? 'WHERE l.user_id = ?' : ''} ORDER BY l.date DESC, l.id DESC`)
    .all(...(one ? [userId] : [])).map((r) => ({ ...r }));
}

function logBetween(fromIso, toIso, liveOnly, userId) {
  const one = userId != null;
  return open().prepare(`SELECT ${LOG_COLS} ${LOG_FROM} WHERE l.date BETWEEN ? AND ?
                         ${liveOnly ? "AND l.data_type = 'Live'" : ''} ${one ? 'AND l.user_id = ?' : ''}
                         ORDER BY l.date ASC, u.name COLLATE NOCASE ASC, l.id ASC`)
    .all(fromIso, toIso, ...(one ? [userId] : [])).map((r) => ({ ...r }));
}

module.exports = { open, tx, linkCustomers, getSettings, getSettingsRaw, setSetting, listPlaces, cacheGet, cachePut, allLog, logBetween };
