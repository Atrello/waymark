'use strict';
/**
 * Backup schedule maths (pure: no database, no clock). Times are UK wall-clock times (Europe/London), so a
 * daily 02:00 backup stays at 02:00 when the clocks change. Hourly / 6-hourly schedules count real hours.
 *
 * A schedule is { frequency, start: 'YYYY-MM-DDTHH:MM' (London time), keep }.
 */
const { UserError } = require('./util');

const FREQUENCIES = {
  off: 'Off', hourly: 'Every hour', '6h': 'Every 6 hours', daily: 'Every day', weekly: 'Every week',
  monthly: 'Every month', yearly: 'Every year',
};
const START_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const TZ = 'Europe/London';
const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** London wall-clock parts of an instant. */
function londonParts(date) {
  const p = {};
  partsFmt.formatToParts(date).forEach((x) => { p[x.type] = Number(x.value); });
  return { y: p.year, m: p.month, d: p.day, hh: p.hour, mm: p.minute };
}

/** The instant (ms) at which London's clock shows y-m-d hh:mm. (In the spring-forward gap, the hour after.) */
function londonToUtc(y, m, d, hh, mm) {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let t = wall;
  for (let i = 0; i < 2; i++) { // London is UTC+0 or UTC+1, so two corrections always settle
    const p = londonParts(new Date(t));
    t -= Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - wall;
  }
  return t;
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Validate and normalise a schedule from the settings form. */
function parseSchedule(input) {
  input = input || {};
  const frequency = String(input.frequency || 'off');
  if (!FREQUENCIES[frequency]) throw new UserError('Pick how often to back up.');
  const start = String(input.start || '').trim();
  const m = START_RE.exec(start);
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > daysInMonth(+m[1], +m[2]) || +m[4] > 23 || +m[5] > 59) {
    throw new UserError('Pick a start date and time.');
  }
  const keep = input.keep === '' || input.keep == null ? 30 : Number(input.keep);
  if (!Number.isInteger(keep) || keep < 0 || keep > 10000) throw new UserError('"Keep" must be a whole number (0 keeps every backup).');
  return { frequency, start, keep };
}

/**
 * The k-th occurrence (k >= 0) of a schedule, as an instant in ms. Calendar schedules step in London
 * wall-clock days/months; a monthly schedule starting on the 31st falls on the last day of shorter months.
 */
function occurrence(s, k) {
  const [, Y, M, D, H, Mi] = START_RE.exec(s.start).map(Number);
  switch (s.frequency) {
    case 'hourly': return londonToUtc(Y, M, D, H, Mi) + k * 3600000;
    case '6h': return londonToUtc(Y, M, D, H, Mi) + k * 6 * 3600000;
    case 'daily':
    case 'weekly': {
      const day = new Date(Date.UTC(Y, M - 1, D + k * (s.frequency === 'weekly' ? 7 : 1)));
      return londonToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), H, Mi);
    }
    case 'monthly':
    case 'yearly': {
      const months = (M - 1) + k * (s.frequency === 'yearly' ? 12 : 1);
      const y = Y + Math.floor(months / 12), mo = (months % 12) + 1;
      return londonToUtc(y, mo, Math.min(D, daysInMonth(y, mo)), H, Mi);
    }
    default: return NaN;
  }
}

/** Rough interval in ms, only to make a first guess at k (then corrected exactly). */
const APPROX = { hourly: 3600e3, '6h': 21600e3, daily: 864e5, weekly: 6048e5, monthly: 2629746e3, yearly: 31556952e3 };

/** { last, next } occurrence instants (ms) around `now`; last is null before the start, both null when off. */
function window(s, now) {
  if (!s || s.frequency === 'off') return { last: null, next: null };
  const first = occurrence(s, 0);
  if (now < first) return { last: null, next: first };
  let k = Math.max(0, Math.floor((now - first) / APPROX[s.frequency]));
  while (k > 0 && occurrence(s, k) > now) k--;
  while (occurrence(s, k + 1) <= now) k++;
  return { last: occurrence(s, k), next: occurrence(s, k + 1) };
}

/** "Tue 06/10/2026 02:00" in UK time, for messages. */
function describe(ms) {
  if (ms == null) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(ms)).replace(/,/g, '');
}

module.exports = { FREQUENCIES, parseSchedule, occurrence, window, describe, londonToUtc };
