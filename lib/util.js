'use strict';
/**
 * Pure helpers: no database, no network. Covered by test/logic.test.js.
 */

const TZ = 'Europe/London';

class UserError extends Error {}

function normKey(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Trim/collapse a text input and enforce required + max length. */
function str(v, max, label, optional) {
  const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
  if (!s && !optional) throw new UserError(`${label} is required.`);
  if (s.length > max) throw new UserError(`${label} is too long (max ${max} characters).`);
  return s;
}

/* ---------------- Dates (all as 'YYYY-MM-DD' strings in Europe/London) ---------------- */

const isoFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function todayIso(now = new Date()) { return isoFmt.format(now); }

/** {y, m, d, hh, mm} of a moment in Europe/London. */
function londonParts(now = new Date()) {
  const p = {};
  partsFmt.formatToParts(now).forEach((x) => { p[x.type] = x.value; });
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute };
}

function validIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function parseIsoDate(s, label = 'Date') {
  const iso = validIso(s);
  if (!iso) throw new UserError(`${label} is not a valid date.`);
  return iso;
}

function ukDate(iso) { return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : ''; }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

function monthLabel(ym) { return `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`; }

function lastDayOfMonth(ym) {
  const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0));
  return d.toISOString().slice(0, 10);
}

/* ---------------- Numbers ---------------- */

function round1(n) { return Math.round(n * 10 + 1e-9) / 10; }
function round2(n) { return Math.round(n * 100 + 1e-9) / 100; }

/** Claim in £ from miles and a rate in pence, rounded half-up to 2dp. */
function claimFor(miles, ratePence) { return Math.round(miles * ratePence + 1e-9) / 100; }

/* ---------------- Places + distances ---------------- */

const COORD_RE = /^\s*\(?\s*(-?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?\s*$/;

/** "54.83, -3.16" -> {lat, lng}. Throws if invalid. */
function parseCoords(text) {
  const m = COORD_RE.exec(String(text || ''));
  if (!m) throw new UserError('Coordinates should look like "54.83, -3.16" (copy them from Google Maps).');
  const lat = Number(m[1]), lng = Number(m[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new UserError('Coordinates are out of range.');
  return { lat, lng };
}

function optCoord(v, label, min, max) {
  const s = String(v == null ? '' : v).trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < min || n > max) throw new UserError(`${label} must be a number between ${min} and ${max}.`);
  return n;
}

/** Direction-independent key for a pair of places. */
function pairKey(a, b) {
  const x = normKey(a), y = normKey(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/**
 * Customer for one leg: the override, else the destination's customer, else (the destination has none, e.g.
 * Home, the office or a fuel stop) the customer of where the leg started. So a trip back from a customer's site
 * counts towards that customer. `override` is {id, name} or null; returns {id, name} or null.
 */
function legCustomer(from, to, override) {
  if (override) return override;
  const src = to.customerId ? to : from;
  return src.customerId ? { id: src.customerId, name: src.business } : null;
}

/* ---------------- CSV ---------------- */

function csvCell(v) {
  let s = String(v == null ? '' : v);
  // Formula-injection guard: spreadsheets treat cells starting with = + - @ (or a tab / carriage return) as formulas.
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && Number.isNaN(Number(s)))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(lines) {
  return `﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

module.exports = {
  TZ, UserError, normKey, str, todayIso, londonParts, validIso, parseIsoDate, ukDate, monthLabel,
  lastDayOfMonth, round1, round2, claimFor, parseCoords, optCoord, pairKey, legCustomer,
  csvCell, toCsv, COORD_RE,
};
