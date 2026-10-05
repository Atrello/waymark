/* App-wide state shared by every page (Svelte 5 runes). Pages read it directly; changes re-render everywhere. */
import { api } from './api.js';
import { norm } from './format.js';

export const ROLE_LABELS = { admin: 'Administrator', user: 'User', accounts: 'Accounts' };

export const app = $state({
  ready: false,
  loadError: '',
  me: null,
  users: [],          // directory for user pickers (admin + accounts only)
  places: [],
  customers: [],
  settings: { ratePence: 55 },
  today: '',
  google: { configured: true },
  mapsPicker: { configured: false },
  log: [],
  logLoaded: false,
  logError: '',
  page: 'mileage',
  logFilter: { year: null, month: '' }, // set by "Add journey" so a new entry is visible
  notice: null,           // { text, kind } shown at the top of every page (e.g. a new user's temporary password)
  mustChangePassword: false,
  startTwoFactor: false,  // set by "Set up now" in the two-factor suggestion; the Account page starts the flow
});

/* ---- Roles ---- */
export const role = () => (app.me ? app.me.role : '');
export const isAdmin = () => role() === 'admin';
export const viewsAll = () => role() === 'admin' || role() === 'accounts';
export const logsJourneys = () => role() === 'admin' || role() === 'user';
export const canDelete = (r) => role() === 'admin' || (role() === 'user' && r.userId === app.me.id);

/* ---- Places ---- */
export const placeByName = (name) => app.places.find((p) => norm(p.place) === norm(name)) || null;

/** After a place/customer change the server returns both lists. */
export function setPlacesAndCustomers(r) {
  if (r.places) app.places = r.places;
  if (r.customers) app.customers = r.customers;
}

export function setUsers(list) {
  app.users = list.map((u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: u.active }));
}

/* ---- Journeys ---- */
export async function loadLog() {
  try {
    const r = await api('GET', '/api/log');
    app.log = r.rows;
    app.logLoaded = true;
    app.logError = '';
  } catch (e) {
    app.logError = e.message;
  }
}

/* ---- Pages (#hash) ---- */
export const PAGES = ['mileage', 'customers', 'places', 'export', 'users', 'activity', 'settings', 'account'];

export function pageAllowed(name) {
  switch (name) {
    case 'mileage': case 'export': case 'account': return true;
    case 'customers': case 'users': case 'settings': return isAdmin();
    case 'places': return logsJourneys();
    case 'activity': return viewsAll();
    default: return false;
  }
}

export function showPage(name) {
  if (!pageAllowed(name)) name = 'mileage';
  app.page = name;
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
}
