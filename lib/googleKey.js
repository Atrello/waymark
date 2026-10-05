'use strict';
/**
 * Google Maps API key storage. Write-only from the web UI: it can be set, tested or removed,
 * but never read back. Stored AES-256-GCM encrypted in the settings table, keyed from
 * SESSION_SECRET, so database backups don't contain it in plain text.
 * Falls back to GOOGLE_MAPS_API_KEY in .env when no key has been saved in the app.
 */
const crypto = require('node:crypto');
const db = require('./db');
const { UserError } = require('./util');

const SETTING = 'GoogleMapsApiKeyEnc';

// The 'jjm-google-key' label predates the rename; changing it would make keys already saved unreadable.
function cipherKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set.');
  return crypto.createHash('sha256').update(`jjm-google-key|${secret}`).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cipherKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

function decrypt(stored) {
  const [iv, tag, data] = stored.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', cipherKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/** The key to use for Google calls (app-saved first, then .env). Server-side only. */
function getKey() {
  const stored = db.getSettingsRaw()[SETTING];
  if (stored) {
    try { return decrypt(stored); } catch {
      console.warn('Saved Google API key could not be decrypted (SESSION_SECRET changed?). Re-enter it in Settings.');
    }
  }
  return process.env.GOOGLE_MAPS_API_KEY || '';
}

/** What the UI may know: whether a key exists and where it comes from. Never the key itself. */
function status() {
  const stored = db.getSettingsRaw()[SETTING];
  let saved = false;
  if (stored) { try { saved = !!decrypt(stored); } catch { saved = false; } }
  if (saved) return { configured: true, source: 'app' };
  if (process.env.GOOGLE_MAPS_API_KEY) return { configured: true, source: 'env' };
  return { configured: false, source: stored ? 'unreadable' : 'none' };
}

function setKey(value) {
  const key = String(value == null ? '' : value).trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(key)) {
    throw new UserError('That does not look like a Google API key (letters, numbers, - and _ only, usually starting "AIza").');
  }
  db.setSetting(SETTING, encrypt(key));
  return status();
}

function removeKey() {
  db.open().prepare('DELETE FROM settings WHERE key = ?').run(SETTING);
  return status();
}

/*
 * Browser key, for the map picker (Maps JavaScript API + Geocoding API). Unlike the server key above it
 * is sent to signed-in browsers, so it isn't secret: it is protected in Google Cloud by restricting it
 * to the app's web address (HTTP referrers) and to those two APIs. Stored as plain text.
 */
const BROWSER_SETTING = 'GoogleMapsBrowserKey';

function getBrowserKey() {
  return db.getSettingsRaw()[BROWSER_SETTING] || process.env.GOOGLE_MAPS_BROWSER_KEY || '';
}

function browserStatus() {
  if (db.getSettingsRaw()[BROWSER_SETTING]) return { configured: true, source: 'app' };
  if (process.env.GOOGLE_MAPS_BROWSER_KEY) return { configured: true, source: 'env' };
  return { configured: false, source: 'none' };
}

function setBrowserKey(value) {
  const key = String(value == null ? '' : value).trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(key)) {
    throw new UserError('That does not look like a Google API key (letters, numbers, - and _ only, usually starting "AIza").');
  }
  if (key === getKey()) {
    throw new UserError('Use a separate key for the map picker, not the server key: the browser key is visible to signed-in users.');
  }
  db.setSetting(BROWSER_SETTING, key);
  return browserStatus();
}

function removeBrowserKey() {
  db.open().prepare('DELETE FROM settings WHERE key = ?').run(BROWSER_SETTING);
  return browserStatus();
}

module.exports = { getKey, status, setKey, removeKey, getBrowserKey, browserStatus, setBrowserKey, removeBrowserKey };
