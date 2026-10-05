'use strict';
/**
 * CSV export, backups, and the background scheduler.
 */
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const users = require('./users');
const audit = require('./audit');
const {
  UserError, parseIsoDate, ukDate, todayIso, monthLabel, lastDayOfMonth, round1, round2, toCsv, londonParts,
} = require('./util');

const CSV_HEADERS = ['Date', 'Start', 'Destination', 'Visit Reason', 'Business', 'Miles', 'Rate', 'Claim', 'Ticket ID'];

/** q: {mode:'month', month:'2026-09'} or {mode:'range', from, to} -> {from, to, label, filename} */
function resolvePeriod(q) {
  q = q || {};
  if (q.mode === 'range') {
    const from = parseIsoDate(q.from, 'From date');
    const to = parseIsoDate(q.to, 'To date');
    if (to < from) throw new UserError('"To" date is before "From" date.');
    return { from, to, label: `${ukDate(from)} to ${ukDate(to)}`, filename: `Mileage_${from}_to_${to}.csv` };
  }
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(q.month || '').trim());
  if (!m) throw new UserError('Pick a month (YYYY-MM).');
  const ym = `${m[1]}-${m[2]}`;
  return { from: `${ym}-01`, to: lastDayOfMonth(ym), label: monthLabel(ym), filename: `Mileage_${ym}.csv` };
}

function summarise(rows) {
  const by = new Map(), byU = new Map();
  let miles = 0, claim = 0;
  for (const r of rows) {
    miles += r.miles;
    claim += r.claim;
    const uk = r.userName || '(unknown)';
    if (!byU.has(uk)) byU.set(uk, { user: uk, legs: 0, miles: 0, claim: 0 });
    const u = byU.get(uk);
    u.legs++; u.miles += r.miles; u.claim += r.claim;
    const k = r.business || '(none)';
    if (!by.has(k)) by.set(k, { business: k, legs: 0, miles: 0, claim: 0 });
    const b = by.get(k);
    b.legs++; b.miles += r.miles; b.claim += r.claim;
  }
  const byBusiness = [...by.values()]
    .map((b) => ({ business: b.business, legs: b.legs, miles: round1(b.miles), claim: round2(b.claim) }))
    .sort((a, b) => b.claim - a.claim);
  const byUser = [...byU.values()]
    .map((u) => ({ user: u.user, legs: u.legs, miles: round1(u.miles), claim: round2(u.claim) }))
    .sort((a, b) => a.user.localeCompare(b.user));
  return { legs: rows.length, miles: round1(miles), claim: round2(claim), byBusiness, byUser };
}

/**
 * withUser: prepend a User column (used when an export covers more than one person).
 * period: when given, a summary (totals, by customer, by user) follows the journey rows, as on the Export page.
 */
function buildCsv(rows, summary, withUser, period) {
  const pre = (r) => (withUser ? [r] : []);
  const lines = [[...pre('User'), ...CSV_HEADERS]];
  for (const r of rows) {
    lines.push([...pre(r.userName), ukDate(r.date), r.start, r.dest, r.reason, r.business, r.miles.toFixed(1),
      String(Math.round(r.rate * 10000) / 10000), r.claim.toFixed(2), r.ticket]);
  }
  lines.push([...pre(''), 'TOTAL', '', '', '', '', summary.miles.toFixed(1), '', summary.claim.toFixed(2), '']);
  if (period) {
    const breakdown = (title, list, key) => [[], [title, 'Legs', 'Miles', 'Claim'],
      ...list.map((x) => [x[key], x.legs, x.miles.toFixed(1), x.claim.toFixed(2)])];
    lines.push([], ['SUMMARY'],
      ['Period', period.label],
      ['Covers', period.scope],
      ['Exported', ukDate(todayIso())],
      ['Journey legs', summary.legs],
      ['Total miles', summary.miles.toFixed(1)],
      ['Total claim', summary.claim.toFixed(2)],
      ...breakdown('BY CUSTOMER', summary.byBusiness, 'business'),
      ...(withUser ? breakdown('BY USER', summary.byUser, 'user') : []));
  }
  return toCsv(lines);
}

/** Live rows in the period with summary and CSV text. */
/**
 * Who an export covers. Users only ever get their own entries; admin/accounts can choose one user
 * (q.userId) or everyone (blank). actor null = everyone.
 */
function exportScope(q, actor) {
  if (actor && actor.role === 'user') return actor;
  const id = q && q.userId !== undefined && q.userId !== '' && q.userId !== null ? Number(q.userId) : null;
  return id ? users.get(id) : null;
}

function buildExport(q, actor) {
  const period = resolvePeriod(q);
  const who = exportScope(q, actor);
  const rows = db.logBetween(period.from, period.to, true, who ? who.id : null);
  const summary = summarise(rows);
  const suffix = who ? `_${who.username}` : '_all-users';
  period.filename = period.filename.replace(/\.csv$/, `${suffix}.csv`);
  period.scope = who ? who.name : 'All users';
  return { period, rows, summary, who, csv: buildCsv(rows, summary, !who, period) };
}

/* ------------------------------------------------------------------ */
/* Backups (HMRC: keep 6 years)                                        */
/* ------------------------------------------------------------------ */

function backupDir() {
  const dir = path.resolve(process.env.BACKUP_DIR || './backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Consistent snapshot of the database to a temp/target file. */
function snapshotDb(target) {
  if (fs.existsSync(target)) fs.unlinkSync(target);
  db.open().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

/** Writes backups/mileage-YYYY-MM-DD.db and a full-log CSV. Returns the file paths. */
function backupNow() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const dir = backupDir();
  const dbFile = snapshotDb(path.join(dir, `mileage-${stamp}.db`));
  const rows = db.allLog().reverse();
  const csv = toCsv([['User', 'Date', 'Start', 'Destination', 'Visit Reason', 'Business', 'Miles', 'Rate', 'Claim', 'Month',
    'Data Type', 'Ticket ID', 'Entry ID', 'Created'],
  ...rows.map((r) => [r.userName, ukDate(r.date), r.start, r.dest, r.reason, r.business, r.miles, r.rate, r.claim, r.month, r.type,
    r.ticket, r.entryId, r.created])]);
  const csvFile = path.join(dir, `mileage-log-${stamp}.csv`);
  fs.writeFileSync(csvFile, csv);
  return { dbFile, csvFile };
}

/* ------------------------------------------------------------------ */
/* Scheduler: yearly backup on 6 April                                 */
/* ------------------------------------------------------------------ */

async function schedulerTick(now = new Date()) {
  const t = londonParts(now);
  const settings = db.getSettings();

  // Yearly backup: once per tax year, on/after 6 April.
  if (t.m > 4 || (t.m === 4 && t.d >= 6)) {
    if (settings.raw.LastYearlyBackup !== String(t.y)) {
      try {
        const r = backupNow();
        db.setSetting('LastYearlyBackup', String(t.y));
        console.log(`[scheduler] yearly backup written: ${r.dbFile}`);
        audit.record(null, 'backup.yearly', `Automatic yearly backup: ${path.basename(r.dbFile)} and ${path.basename(r.csvFile)}`);
      } catch (e) {
        console.error(`[scheduler] yearly backup failed: ${e.message}`);
      }
    }
  }
}

function startScheduler() {
  const run = () => schedulerTick().catch((e) => console.error('[scheduler]', e));
  setTimeout(run, 5000);
  return setInterval(run, 60 * 1000);
}

module.exports = {
  resolvePeriod, summarise, buildCsv, buildExport, backupNow, snapshotDb,
  startScheduler, schedulerTick, CSV_HEADERS,
};
