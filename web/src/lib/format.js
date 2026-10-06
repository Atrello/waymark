/* Small pure helpers shared by the pages. */

export function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }

export function mi(n) { return Number(n).toFixed(1); }
export function money(n) { return '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

/** '2026-10-05' -> '05/10/2026' */
export function uk(iso) { return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : ''; }

/** '2026-10-05' -> 'Monday 05/10/2026' */
export function ukLong(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '';
  return `${new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-GB', { weekday: 'long' })} ${uk(iso)}`;
}

/* UK time (Europe/London), whatever time zone the browser is in: the server works in UK time too. */
const LONDON = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function londonParts(d) {
  return Object.fromEntries(LONDON.formatToParts(d).map((x) => [x.type, x.value]));
}

/** ISO timestamp (or Date) -> its UK date, '2026-10-05'. */
export function londonDate(iso = new Date()) {
  const p = londonParts(new Date(iso));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Today's date in the UK, '2026-10-05'. */
export const londonToday = () => londonDate(new Date());

/** ISO timestamp -> '05/10/2026 19:30' in UK time. */
export function ukDateTime(iso) {
  const p = londonParts(new Date(iso));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** '2026-01-15' -> '2025-12' */
export function prevMonth(iso) {
  let y = +iso.slice(0, 4), m = +iso.slice(5, 7) - 1;
  if (m === 0) { y--; m = 12; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** Random hex ID. (crypto.randomUUID needs HTTPS; getRandomValues also works over plain http on a LAN.) */
export function randomId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const a = new Uint32Array(14);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => chars[n % chars.length]).join('');
}

/** Sort a copy of rows by sort.key (numbers numerically, text case-insensitively); sort.dir is 1 or -1. */
export function sortRows(rows, sort, tieKey) {
  const { key, dir } = sort;
  return rows.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    let c = typeof x === 'number' && typeof y === 'number' ? x - y
      : String(x ?? '').localeCompare(String(y ?? ''), 'en-GB', { sensitivity: 'base' });
    if (c === 0 && tieKey) c = (a[tieKey] || 0) - (b[tieKey] || 0);
    return c * dir;
  });
}

/** Click on a sortable header: same key flips direction, a new key starts with its default direction. */
export function nextSort(sort, key, firstDir = 1) {
  return sort.key === key ? { key, dir: -sort.dir } : { key, dir: firstDir };
}

export const COORD_RE = /^\s*\(?\s*(-?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?\s*$/;
