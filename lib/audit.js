'use strict';
/**
 * Activity log: who did what, when, and from where. One row per action (journey saved/deleted, export
 * downloaded, place/customer/user/settings changes, sign-ins). Append-only (see the triggers in db.js).
 */
const db = require('./db');

const MAX_PAGE = 500;

/** Record an action. user: the app user ({id, username}) or null for the system / unknown visitors. */
function record(user, action, summary, ip) {
  try {
    db.open().prepare('INSERT INTO audit_log(at, user_id, username, action, summary, ip) VALUES (?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), user ? user.id : null, user ? user.username : '', action, String(summary), cleanIp(ip));
  } catch (e) {
    // Never let logging break the action itself; leave a trace on the console instead.
    console.error(`[audit] could not record ${action}: ${e.message}`);
  }
}

/** "::ffff:10.0.0.5" -> "10.0.0.5"; "::1" -> "localhost". */
function cleanIp(ip) {
  const s = String(ip || '');
  if (s === '::1' || s === '127.0.0.1' || s === '::ffff:127.0.0.1') return 'localhost';
  return s.replace(/^::ffff:/, '');
}

/**
 * Newest first. q: {before (id, for paging), userId, area (the part of `action` before the dot), search}.
 * Returns {rows, more}.
 */
function list(q) {
  q = q || {};
  const where = [], args = [];
  if (Number(q.before) > 0) { where.push('id < ?'); args.push(Number(q.before)); }
  if (q.userId) { where.push('user_id = ?'); args.push(Number(q.userId)); }
  if (q.area) { where.push("action LIKE ? ESCAPE '\\'"); args.push(`${String(q.area).replace(/[\\%_]/g, '\\$&')}.%`); }
  if (q.search) {
    where.push("(summary LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\')");
    const like = `%${String(q.search).slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`;
    args.push(like, like, like);
  }
  const rows = db.open().prepare(`SELECT id, at, user_id AS userId, username, action, summary, ip FROM audit_log
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, MAX_PAGE + 1)
    .map((r) => ({ ...r }));
  return { rows: rows.slice(0, MAX_PAGE), more: rows.length > MAX_PAGE };
}

module.exports = { record, list, cleanIp };
