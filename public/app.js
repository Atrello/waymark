/* Waymark — browser app. Plain JS, no build step. */
(function () {
  'use strict';

  /* ================================================================ */
  /* State + helpers                                                   */
  /* ================================================================ */

  var S = {
    places: [], placeMap: {}, customers: [], customerSort: { key: 'name', dir: 1 },
    settings: { ratePence: 55, homePlaces: ['Home'] },
    today: '', mapsPicker: { configured: false },
    log: [], logLoaded: false,
    logSort: { key: 'date', dir: -1 }, logLimit: 200,
    placeSort: { key: 'place', dir: 1 },
    stops: ['', ''], previewKey: null, previewOk: false,
  };

  function $(id) { return document.getElementById(id); }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function mi(n) { return Number(n).toFixed(1); }
  function money(n) { return '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function uk(iso) { return iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : ''; }
  function ukLong(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-GB', { weekday: 'long' }) + ' ' + uk(iso);
  }
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /** JSON API call. Throws Error(message) on failure; bounces to /login when the session expires. */
  function api(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { 'X-Requested-With': 'waymark' } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (res) {
      if (res.status === 401) { location.href = '/login'; throw new Error('Session expired. Please sign in again.'); }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    });
  }

  function busy(btn, promise) {
    var html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    return promise.finally(function () { btn.disabled = false; btn.innerHTML = html; });
  }

  function showMsg(id, text, kind) {
    var el = $(id);
    if (!text) { el.hidden = true; return; }
    el.className = 'msg ' + (kind || 'info');
    el.textContent = text;
    el.hidden = false;
    // Messages sit at the top of their page or form; bring one into view if the button pressed was further down.
    var r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  var toastTimer;
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }

  function isHome(name) {
    if (S.me && S.me.homePlace && norm(S.me.homePlace) === norm(name)) return true;
    return S.settings.homePlaces.some(function (h) { return norm(h) === norm(name); });
  }
  /** The signed-in user's own home place (set in Settings → My account). */
  function homePlace() {
    var p = S.me && S.me.homePlace ? S.placeMap[norm(S.me.homePlace)] : null;
    return p ? p.place : '';
  }
  function setPlaces(list) {
    S.places = list.slice();
    S.placeMap = {};
    S.places.forEach(function (p) { S.placeMap[norm(p.place)] = p; });
    document.querySelectorAll('select.place-select').forEach(function (sel) {
      var cur = sel.value;
      sel.innerHTML = '<option value="">' + esc(sel.dataset.empty || '—') + '</option>' + S.places.map(function (p) {
        return '<option value="' + p.id + '">' + esc(p.place) + '</option>';
      }).join('');
      sel.value = cur;
      if (sel.value !== cur) sel.value = '';
    });
  }

  /* ---- Roles ---- */
  function role() { return S.me ? S.me.role : ''; }
  function viewsAll() { return role() === 'admin' || role() === 'accounts'; }
  function canDelete(r) { return role() === 'admin' || (role() === 'user' && r.userId === S.me.id); }
  /** Show/hide every element marked data-roles="admin user …" for the signed-in role. */
  function applyRoles() {
    document.querySelectorAll('[data-roles]').forEach(function (el) {
      el.hidden = el.dataset.roles.split(/\s+/).indexOf(role()) < 0;
    });
    document.querySelector('.grid.log').classList.toggle('hide-user', !viewsAll());
  }
  /** Store customers and refill every customer <select> (keeping each one's current choice). */
  function setCustomers(list) {
    S.customers = list;
    document.querySelectorAll('select.customer-select').forEach(function (sel) {
      var cur = sel.value;
      sel.innerHTML = '<option value="">' + esc(sel.dataset.empty || '—') + '</option>' + list.map(function (c) {
        return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
      }).join('');
      sel.value = cur;
      if (sel.value !== cur) sel.value = '';
    });
    if (!$('page-customers').hidden) renderCustomers();
  }

  /* ================================================================ */
  /* Customers                                                         */
  /* ================================================================ */

  function sitesOf(customerId) {
    return S.places.filter(function (p) { return p.customerId === customerId; });
  }

  function renderCustomers() {
    var q = norm($('cSearch').value);
    var rows = S.customers.filter(function (c) {
      if (!q) return true;
      return norm(c.name + ' ' + sitesOf(c.id).map(function (p) { return p.place; }).join(' ')).indexOf(q) >= 0;
    });
    rows = sortRows(rows, S.customerSort);
    var unassigned = S.places.filter(function (p) { return !p.customerId && !isHome(p.place); }).length;
    $('cCount').textContent = S.customers.length + ' customers' + (unassigned ? ' · ' + unassigned + ' site(s) without a customer' : '');
    $('customerBody').innerHTML = rows.length ? rows.map(function (c) {
      var sites = sitesOf(c.id);
      return '<tr class="clickable" data-id="' + c.id + '">' +
        '<td class="c-name">' + esc(c.name) + (c.notes ? '<span class="sub muted"> · ' + esc(c.notes) + '</span>' : '') + '</td>' +
        '<td class="c-sites"><div class="chips">' + (sites.length ? sites.map(function (p) { return '<span class="chip">' + esc(p.place) + '</span>'; }).join('')
          : '<span class="muted">No sites</span>') + '</div></td>' +
        '<td class="c-legs num">' + c.legs + '</td>' +
        '<td class="c-miles num">' + mi(c.miles) + '</td>' +
        '<td class="c-claim num">' + money(c.claim) + '</td>' +
        '<td class="c-last nowrap">' + (c.lastVisit ? uk(c.lastVisit) : '—') + '</td></tr>';
    }).join('') : '<tr><td class="empty" colspan="6">' + (S.customers.length ? 'No customers match.' : 'No customers yet. Click “Add customer”.') + '</td></tr>';
    markSorted('.grid.customers th[data-csort]', 'data-csort', S.customerSort);
  }

  $('cSearch').addEventListener('input', renderCustomers);
  document.querySelector('.grid.customers thead').addEventListener('click', function (e) {
    var th = e.target.closest('th[data-csort]');
    if (!th) return;
    var k = th.dataset.csort;
    S.customerSort = S.customerSort.key === k ? { key: k, dir: -S.customerSort.dir } : { key: k, dir: k === 'name' ? 1 : -1 };
    renderCustomers();
  });
  $('customerBody').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-id]');
    if (tr) openCustomerModal(S.customers.filter(function (c) { return String(c.id) === tr.dataset.id; })[0]);
  });
  $('btnAddCustomer').addEventListener('click', function () { openCustomerModal(null); });

  var siteChecks = {}; // placeId -> checked, kept while filtering the list

  function renderSiteChecks() {
    var q = norm($('cSiteSearch').value);
    var id = Number($('cId').value) || null;
    var list = S.places.filter(function (p) { return !q || norm(p.place + ' ' + p.address + ' ' + p.business).indexOf(q) >= 0; });
    $('cSites').innerHTML = list.length ? list.map(function (p) {
      var other = p.customerId && p.customerId !== id ? p.business : '';
      return '<label><input type="checkbox" data-pid="' + p.id + '"' + (siteChecks[p.id] ? ' checked' : '') + '>' +
        '<span class="site-name">' + esc(p.place) + '</span>' +
        (other ? '<small>now: ' + esc(other) + '</small>' : (!p.customerId ? '<small>unassigned</small>' : '')) + '</label>';
    }).join('') : '<div class="none">No sites match.</div>';
  }
  $('cSites').addEventListener('change', function (e) {
    if (e.target.dataset.pid) siteChecks[e.target.dataset.pid] = e.target.checked;
  });
  $('cSiteSearch').addEventListener('input', renderSiteChecks);

  function openCustomerModal(c) {
    $('cId').value = c ? c.id : '';
    $('cName').value = c ? c.name : '';
    $('cNotes').value = c ? c.notes : '';
    $('cSiteSearch').value = '';
    $('customerTitle').textContent = c ? 'Edit ' + c.name : 'Add customer';
    siteChecks = {};
    if (c) sitesOf(c.id).forEach(function (p) { siteChecks[p.id] = true; });
    renderSiteChecks();
    $('btnDeleteCustomer').hidden = !c;
    $('cMergeBox').hidden = !c;
    if (c) {
      $('cMergeInto').innerHTML = '<option value="">Choose customer…</option>' + S.customers.filter(function (x) { return x.id !== c.id; })
        .map(function (x) { return '<option value="' + x.id + '">' + esc(x.name) + '</option>'; }).join('');
    }
    showMsg('customerMsg', '');
    openModal('customerModal');
    if (window.matchMedia('(min-width: 701px)').matches) $('cName').focus();
  }

  function afterCustomerChange(r) {
    setPlaces(r.places);
    setCustomers(r.customers);
    renderCustomers();
    renderPlaces();
    closeModal('customerModal');
    toast(r.message);
    loadLog();
  }

  $('customerForm').addEventListener('submit', function (e) { e.preventDefault(); $('btnSaveCustomer').click(); });
  $('btnSaveCustomer').addEventListener('click', function () {
    var id = $('cId').value;
    var body = {
      name: $('cName').value.trim(),
      notes: $('cNotes').value.trim(),
      placeIds: Object.keys(siteChecks).filter(function (k) { return siteChecks[k]; }).map(Number),
    };
    if (!body.name) { showMsg('customerMsg', 'Customer name is required.', 'bad'); return; }
    var moving = body.placeIds.map(function (pid) { return S.places.filter(function (p) { return p.id === pid; })[0]; })
      .filter(function (p) { return p && p.customerId && String(p.customerId) !== id; });
    var go = moving.length
      ? confirmBox('Move sites?', moving.map(function (p) { return p.place + ' (now ' + p.business + ')'; }).join('\n') +
          '\n\nwill move to ' + body.name + '. Past journeys keep their customer.', 'Move')
      : Promise.resolve(true);
    var btn = this;
    go.then(function (ok) {
      if (!ok) return;
      busy(btn, api(id ? 'PUT' : 'POST', id ? '/api/customers/' + id : '/api/customers', body))
        .then(afterCustomerChange)
        .catch(function (e) { showMsg('customerMsg', e.message, 'bad'); });
    });
  });

  $('btnMerge').addEventListener('click', function () {
    var id = $('cId').value, into = $('cMergeInto').value;
    if (!into) { showMsg('customerMsg', 'Choose the customer to merge into.', 'warn'); return; }
    var from = $('cName').value, intoName = $('cMergeInto').selectedOptions[0].textContent;
    var btn = this;
    confirmBox('Merge customers?', 'All sites and past journey legs of "' + from + '" will move to "' + intoName + '", and "' +
      from + '" will be removed.', 'Merge').then(function (ok) {
      if (!ok) return;
      busy(btn, api('POST', '/api/customers/' + id + '/merge', { intoId: Number(into) }))
        .then(afterCustomerChange)
        .catch(function (e) { showMsg('customerMsg', e.message, 'bad'); });
    });
  });

  $('btnDeleteCustomer').addEventListener('click', function () {
    var id = $('cId').value, name = $('cName').value;
    confirmBox('Delete ' + name + '?', 'Its sites will become unassigned. Customers with past journeys can\'t be deleted; use Merge instead.')
      .then(function (ok) {
        if (!ok) return;
        api('DELETE', '/api/customers/' + id).then(afterCustomerChange)
          .catch(function (e) { showMsg('customerMsg', e.message, 'bad'); });
      });
  });

  /* ================================================================ */
  /* Activity (admin + accounts; read-only)                            */
  /* ================================================================ */

  var ACTION_LABELS = {
    'journey.create': 'Journey saved', 'journey.delete': 'Entry deleted', 'export.csv': 'CSV exported',
    'place.create': 'Place added', 'place.update': 'Place changed', 'place.delete': 'Place deleted',
    'customer.create': 'Customer added', 'customer.update': 'Customer changed', 'customer.merge': 'Customers merged',
    'customer.delete': 'Customer deleted', 'user.create': 'User added', 'user.update': 'User changed', 'user.delete': 'User deleted',
    'settings.update': 'Settings changed', 'settings.google_key': 'Google key changed',
    'backup.server': 'Backup saved', 'backup.download': 'Backup downloaded', 'backup.yearly': 'Yearly backup',
    'auth.sign_in': 'Signed in', 'auth.sign_in_failed': 'Failed sign-in', 'auth.locked_out': 'Sign-in blocked',
    'auth.sign_out': 'Signed out', 'account.profile': 'Profile changed', 'account.password': 'Password changed',
    'security.2fa_on': 'Two-factor on', 'security.2fa_off': 'Two-factor off', 'security.backup_codes': 'Backup codes',
    'security.passkey_add': 'Passkey added', 'security.passkey_remove': 'Passkey removed', 'security.sessions': 'Sessions signed out',
  };
  var WARN_ACTIONS = ['journey.delete', 'place.delete', 'customer.delete', 'user.delete', 'auth.sign_in_failed', 'auth.locked_out',
    'security.2fa_off'];
  var activity = { rows: [], more: false, loading: 0 };

  function activityWhen(iso) {
    var d = new Date(iso);
    return uk(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')) +
      ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /** older: append the next page instead of starting again. */
  function loadActivity(older) {
    var params = ['userId=' + encodeURIComponent($('aUser').value), 'area=' + encodeURIComponent($('aArea').value),
      'search=' + encodeURIComponent($('aSearch').value.trim())];
    if (older && activity.rows.length) params.push('before=' + activity.rows[activity.rows.length - 1].id);
    var ticket = ++activity.loading; // ignore replies to older requests if the filters changed meanwhile
    if (!older) $('activityBody').innerHTML = '<tr><td class="empty" colspan="5"><span class="spinner"></span></td></tr>';
    api('GET', '/api/activity?' + params.join('&')).then(function (r) {
      if (ticket !== activity.loading) return;
      activity.rows = older ? activity.rows.concat(r.rows) : r.rows;
      activity.more = r.more;
      renderActivity();
    }).catch(function (e) {
      $('activityBody').innerHTML = '<tr><td class="empty" colspan="5">' + esc(e.message) + '</td></tr>';
    });
  }

  function renderActivity() {
    $('activityBody').innerHTML = activity.rows.length ? activity.rows.map(function (r) {
      var who = r.username || (r.action === 'backup.yearly' ? 'System' : '—');
      return '<tr>' +
        '<td class="c-awhen nowrap">' + esc(activityWhen(r.at)) + '</td>' +
        '<td class="c-awho">' + esc(who) + '</td>' +
        '<td class="c-aaction"><span class="badge ' + (WARN_ACTIONS.indexOf(r.action) >= 0 ? 'test' : 'role-accounts') + '">' +
          esc(ACTION_LABELS[r.action] || r.action) + '</span></td>' +
        '<td class="c-adetail">' + esc(r.summary) + '</td>' +
        '<td class="c-aip nowrap">' + esc(r.ip || '—') + '</td></tr>';
    }).join('') : '<tr><td class="empty" colspan="5">No activity matches.</td></tr>';
    $('activityCount').textContent = 'Showing ' + activity.rows.length + (activity.more ? '+' : '') + ' entries, newest first';
    $('activityMore').hidden = !activity.more;
  }

  var activityTimer = null;
  ['aUser', 'aArea'].forEach(function (id) { $(id).addEventListener('change', function () { loadActivity(false); }); });
  $('aSearch').addEventListener('input', function () {
    clearTimeout(activityTimer);
    activityTimer = setTimeout(function () { loadActivity(false); }, 300);
  });
  $('aClear').addEventListener('click', function () {
    $('aUser').value = ''; $('aArea').value = ''; $('aSearch').value = '';
    loadActivity(false);
  });
  $('activityMore').addEventListener('click', function () { loadActivity(true); });

  /* ================================================================ */
  /* Navigation + modals                                               */
  /* ================================================================ */

  var PAGES = ['mileage', 'customers', 'places', 'export', 'users', 'activity', 'settings'];
  function pageAllowed(name) {
    var b = document.querySelector('.nav button[data-page="' + name + '"]');
    return PAGES.indexOf(name) >= 0 && b && !b.hidden;
  }
  function showPage(name) {
    if (!pageAllowed(name)) name = 'mileage';
    document.querySelectorAll('.nav button').forEach(function (b) {
      b.setAttribute('aria-selected', b.dataset.page === name ? 'true' : 'false');
    });
    PAGES.forEach(function (p) { $('page-' + p).hidden = p !== name; });
    if (name === 'places') renderPlaces();
    if (name === 'customers') renderCustomers();
    if (name === 'export') loadExportSummary();
    if (name === 'users') loadUsers();
    if (name === 'activity') loadActivity(false);
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  }
  // Links like /#settings and the browser's back/forward buttons switch page too.
  window.addEventListener('hashchange', function () { if (S.me) showPage(location.hash.slice(1)); });
  document.querySelector('.nav').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-page]');
    if (b) showPage(b.dataset.page);
  });

  var openModals = [];
  function openModal(id) {
    $(id).hidden = false;
    if (openModals.indexOf(id) < 0) openModals.push(id);
    document.body.classList.add('modal-open');
  }
  function closeModal(id) {
    $(id).hidden = true;
    openModals = openModals.filter(function (m) { return m !== id; });
    if (!openModals.length) document.body.classList.remove('modal-open');
    if (id === 'confirmModal' && confirmResolve) { confirmResolve(false); confirmResolve = null; }
    // Unload maps when closed (each load counts against Google's quota).
    if (id === 'mapModal') $('mapFrame').removeAttribute('src');
    if (id === 'routeModal') $('routeFrame').removeAttribute('src');
  }
  document.querySelectorAll('.modal').forEach(function (m) {
    m.addEventListener('click', function (e) {
      if (e.target === m || e.target.closest('[data-close]')) closeModal(m.id);
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && openModals.length && !document.querySelector('.suggest:not([hidden])')) {
      closeModal(openModals[openModals.length - 1]);
    }
  });

  var confirmResolve = null;
  function confirmBox(title, text, okLabel) {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmYes').textContent = okLabel || 'Delete';
    openModal('confirmModal');
    $('confirmNo').focus();
    return new Promise(function (resolve) { confirmResolve = resolve; });
  }
  $('confirmYes').addEventListener('click', function () {
    var r = confirmResolve; confirmResolve = null;
    closeModal('confirmModal');
    if (r) r(true);
  });
  $('confirmNo').addEventListener('click', function () { closeModal('confirmModal'); });

  /* ================================================================ */
  /* Mileage table                                                     */
  /* ================================================================ */

  function loadLog() {
    return api('GET', '/api/log').then(function (r) {
      S.log = r.rows;
      S.logLoaded = true;
      fillLogFilters();
      renderLog();
    }).catch(function (e) {
      $('logBody').innerHTML = '<tr><td class="empty" colspan="11">' + esc(e.message) + '</td></tr>';
    });
  }

  function fillSelect(sel, values, allLabel, labels) {
    var cur = sel.value;
    sel.innerHTML = '<option value="">' + allLabel + '</option>' + values.map(function (v, i) {
      return '<option value="' + esc(v) + '">' + esc(labels ? labels[i] : v) + '</option>';
    }).join('');
    if (cur === '' || values.indexOf(cur) >= 0) sel.value = cur;
  }

  function fillLogFilters() {
    var years = {}, biz = {};
    S.log.forEach(function (r) { years[r.date.slice(0, 4)] = true; if (r.business) biz[r.business] = true; });
    years[S.today.slice(0, 4)] = true;
    var firstFill = !$('fYear').options.length;
    fillSelect($('fYear'), Object.keys(years).sort().reverse(), 'All years');
    fillSelect($('fBusiness'), Object.keys(biz).sort(function (a, b) { return a.localeCompare(b); }), 'All customers');
    if (firstFill) $('fYear').value = S.today.slice(0, 4);
    if (viewsAll()) {
      fillSelect($('fUser'), S.users.map(function (u) { return String(u.id); }), 'All users', S.users.map(function (u) { return u.name; }));
    fillSelect($('aUser'), S.users.map(function (u) { return String(u.id); }), 'All users', S.users.map(function (u) { return u.name; }));
    }
  }

  function logFiltered() {
    var y = $('fYear').value, m = $('fMonth').value, b = $('fBusiness').value, t = $('fType').value, q = norm($('fSearch').value);
    var u = viewsAll() ? $('fUser').value : '';
    return S.log.filter(function (r) {
      if (u && String(r.userId) !== u) return false;
      if (y && r.date.slice(0, 4) !== y) return false;
      if (m && r.date.slice(5, 7) !== m) return false;
      if (b && r.business !== b) return false;
      if (t && r.type !== t) return false;
      if (q && norm([r.start, r.dest, r.reason, r.business, r.ticket, r.userName, uk(r.date)].join(' ')).indexOf(q) < 0) return false;
      return true;
    });
  }

  function sortRows(rows, sort, tieKey) {
    var k = sort.key, d = sort.dir;
    return rows.slice().sort(function (a, b) {
      var x = a[k], y = b[k], c;
      if (typeof x === 'number' && typeof y === 'number') c = x - y;
      else c = String(x == null ? '' : x).localeCompare(String(y == null ? '' : y), 'en-GB', { sensitivity: 'base' });
      if (c === 0 && tieKey) c = (a[tieKey] || 0) - (b[tieKey] || 0);
      return c * d;
    });
  }

  function markSorted(selector, attr, sort) {
    document.querySelectorAll(selector).forEach(function (th) {
      var on = th.getAttribute(attr) === sort.key;
      th.classList.toggle('sorted', on);
      var base = th.textContent.replace(/ [▲▼]$/, '');
      th.textContent = on ? base + (sort.dir > 0 ? ' ▲' : ' ▼') : base;
    });
  }

  function renderLog() {
    var rows = sortRows(logFiltered(), S.logSort, 'id');
    var miles = 0, claim = 0, days = {};
    rows.forEach(function (r) { miles += r.miles; claim += r.claim; days[r.date] = true; });
    var nDays = Object.keys(days).length;

    $('logKpis').innerHTML =
      kpi('Journey legs', rows.length, nDays + ' day' + (nDays === 1 ? '' : 's')) +
      kpi('Miles', mi(miles), rows.length ? 'avg ' + mi(miles / rows.length) + ' per leg' : '') +
      kpi('Claim', money(claim), rows.filter(function (r) { return r.type === 'Test'; }).length ? 'includes Test rows' : '');

    var shown = rows.slice(0, S.logLimit);
    var routes = S.mapsPicker.configured; // rows open the route map once a browser key is set
    $('logBody').innerHTML = shown.length ? shown.map(function (r) {
      return (routes ? '<tr class="clickable" data-entry="' + esc(r.entryId) + '" title="Show the route on a map">' : '<tr>') +
        '<td class="c-user nowrap">' + esc(r.userName || '—') + '</td>' +
        '<td class="c-date nowrap">' + uk(r.date) + '</td>' +
        '<td class="c-start trunc" title="' + esc(r.start) + '">' + esc(r.start) + '</td>' +
        '<td class="c-dest trunc" title="' + esc(r.dest) + '">' + esc(r.dest) + '</td>' +
        '<td class="c-reason trunc" title="' + esc(r.reason) + '">' + esc(r.reason) + '</td>' +
        '<td class="c-biz" title="' + esc(r.business) + '">' + esc(r.business || '—') + '</td>' +
        '<td class="c-miles num">' + mi(r.miles) + '</td>' +
        '<td class="c-rate num">' + Math.round(r.rate * 10000) / 100 + 'p</td>' +
        '<td class="c-claim num">' + money(r.claim) + '</td>' +
        '<td class="c-type"><span class="badge ' + (r.type === 'Test' ? 'test' : 'live') + '">' + r.type + '</span></td>' +
        '<td class="c-ticket">' + esc(r.ticket) + '</td>' +
        '<td class="c-act">' + (canDelete(r) ? '<button type="button" class="icon-btn del" data-del="' + esc(r.entryId) + '" aria-label="Delete entry">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>' : '') + '</td>' +
        '</tr>';
    }).join('') : '<tr><td class="empty" colspan="12">' + (S.log.length ? 'No entries match these filters.'
      : (role() === 'accounts' ? 'No journeys have been logged yet.' : 'No journeys yet. Click “Add journey” to log your first trip.')) + '</td></tr>';

    $('logFoot').innerHTML = rows.length ? '<tr><td class="c-user"></td><td colspan="5">Total · ' + rows.length + ' legs</td><td class="num">' + mi(miles) +
      '</td><td class="c-rate"></td><td class="num">' + money(claim) + '</td><td colspan="3"></td></tr>' : '';
    $('logCount').textContent = 'Showing ' + shown.length + ' of ' + rows.length + ' matching entries (' + S.log.length + ' in total)';
    $('logMore').hidden = rows.length <= S.logLimit;
    markSorted('.grid.log th[data-sort]', 'data-sort', S.logSort);
  }

  function kpi(label, value, sub) {
    return '<div class="kpi"><span>' + esc(label) + '</span><b>' + esc(value) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>';
  }

  ['fUser', 'fYear', 'fMonth', 'fBusiness', 'fType'].forEach(function (id) {
    $(id).addEventListener('change', function () { S.logLimit = 200; renderLog(); });
  });
  $('fSearch').addEventListener('input', function () { S.logLimit = 200; renderLog(); });
  $('fClear').addEventListener('click', function () {
    $('fUser').value = ''; $('fYear').value = ''; $('fMonth').value = ''; $('fBusiness').value = ''; $('fType').value = ''; $('fSearch').value = '';
    renderLog();
  });
  $('logMore').addEventListener('click', function () { S.logLimit += 200; renderLog(); });

  document.querySelector('.grid.log thead').addEventListener('click', function (e) {
    var th = e.target.closest('th[data-sort]');
    if (!th) return;
    var k = th.dataset.sort;
    S.logSort = S.logSort.key === k ? { key: k, dir: -S.logSort.dir } : { key: k, dir: (k === 'date' || k === 'miles' || k === 'claim') ? -1 : 1 };
    renderLog();
  });

  $('logBody').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-del]');
    if (!b) {
      var tr = e.target.closest('tr[data-entry]');
      if (tr) openRouteMap(tr.dataset.entry);
      return;
    }
    var r = S.log.filter(function (x) { return x.entryId === b.dataset.del; })[0];
    if (!r) return;
    confirmBox('Delete this entry?', uk(r.date) + '\n' + r.start + ' → ' + r.dest + '\n' + mi(r.miles) + ' mi · ' + money(r.claim) +
      '\n\nThis cannot be undone.').then(function (ok) {
      if (!ok) return;
      api('DELETE', '/api/log/' + encodeURIComponent(r.entryId)).then(function (res) {
        toast(res.message);
        return loadLog();
      }).catch(function (err) { toast(err.message); });
    });
  });

  /* ================================================================ */
  /* Add journey (route builder)                                      */
  /* ================================================================ */

  $('btnAddTrip').addEventListener('click', openTripModal);

  function openTripModal() {
    $('tDate').value = S.today;
    $('tDate').max = S.today;
    $('tDateLabel').textContent = ukLong(S.today);
    $('tReason').value = 'Site visit';
    $('tTicket').value = '';
    $('tCustomer').value = '';
    $('tRate').value = S.me.ratePence;
    document.querySelector('input[name="tType"][value="Live"]').checked = true;
    S.stops = [homePlace(), ''];
    S.previewKey = null;
    S.previewOk = false;
    $('preview').hidden = true;
    showMsg('tripMsg', '');
    renderStops();
    openModal('tripModal');
    var empty = document.querySelector('#stops .place-input[data-i="1"]');
    if (empty && window.matchMedia('(min-width: 701px)').matches) empty.focus();
  }

  function renderStops(focusIndex) {
    $('stops').innerHTML = S.stops.map(function (v, i) {
      return '<li class="stop"><span class="n">' + (i + 1) + '</span>' +
        '<div class="combo"><input class="place-input" type="text" autocomplete="off" autocorrect="off" spellcheck="false" data-i="' + i +
        '" value="' + esc(v) + '" placeholder="' + (i === 0 ? 'Start' : 'Stop ' + (i + 1)) + '…" aria-label="Stop ' + (i + 1) + '">' +
        '<div class="suggest" hidden></div></div>' +
        '<button type="button" class="sbtn" data-act="up" data-i="' + i + '" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '>▲</button>' +
        '<button type="button" class="sbtn" data-act="down" data-i="' + i + '" aria-label="Move down"' + (i === S.stops.length - 1 ? ' disabled' : '') + '>▼</button>' +
        '<button type="button" class="sbtn" data-act="remove" data-i="' + i + '" aria-label="Remove stop"' + (S.stops.length <= 2 ? ' disabled' : '') + '>✕</button></li>';
    }).join('');
    document.querySelectorAll('#stops .place-input').forEach(markValidity);
    if (focusIndex != null) {
      var inp = document.querySelector('#stops .place-input[data-i="' + focusIndex + '"]');
      if (inp) inp.focus();
    }
    tripChanged();
  }

  function markValidity(inp) {
    var v = inp.value.trim();
    inp.classList.toggle('invalid', !!v && !S.placeMap[norm(v)]);
  }

  function placeMatches(q) {
    q = norm(q);
    var list = S.places.slice().sort(function (a, b) {
      return (isHome(a.place) ? 0 : 1) - (isHome(b.place) ? 0 : 1) || a.place.localeCompare(b.place);
    });
    if (!q) return list;
    var starts = [], contains = [];
    list.forEach(function (p) {
      var n = norm(p.place);
      if (n.indexOf(q) === 0) starts.push(p);
      else if (n.indexOf(q) >= 0 || norm(p.address).indexOf(q) >= 0 || norm(p.business).indexOf(q) >= 0) contains.push(p);
    });
    return starts.concat(contains);
  }

  function openSuggest(inp) {
    var box = inp.parentNode.querySelector('.suggest');
    var list = placeMatches(inp.value).slice(0, 60);
    box.innerHTML = list.length ? list.map(function (p, k) {
      return '<button type="button" data-place="' + esc(p.place) + '"' + (k === 0 ? ' class="active"' : '') + '><b>' + esc(p.place) + '</b>' +
        (p.lat === null ? ' <span class="badge missing">no coords</span>' : '') +
        '<small>' + esc(p.address || p.business || '') + '</small></button>';
    }).join('') : '<div class="none">No match. Add it on the Places page.</div>';
    box.hidden = false;
  }
  function closeSuggest(inp) { inp.parentNode.querySelector('.suggest').hidden = true; }

  function choosePlace(inp, place) {
    var i = +inp.dataset.i;
    S.stops[i] = place;
    inp.value = place;
    markValidity(inp);
    closeSuggest(inp);
    tripChanged();
    var next = document.querySelector('#stops .place-input[data-i="' + (i + 1) + '"]');
    if (next && !next.value) next.focus(); else inp.blur();
  }

  var stopsEl = $('stops');
  stopsEl.addEventListener('focusin', function (e) {
    if (e.target.classList.contains('place-input')) { e.target.select(); openSuggest(e.target); }
  });
  stopsEl.addEventListener('input', function (e) {
    var inp = e.target;
    if (!inp.classList.contains('place-input')) return;
    S.stops[+inp.dataset.i] = inp.value;
    inp.classList.remove('invalid');
    openSuggest(inp);
    tripChanged();
  });
  stopsEl.addEventListener('focusout', function (e) {
    var inp = e.target;
    if (!inp.classList.contains('place-input')) return;
    setTimeout(function () {
      var p = S.placeMap[norm(inp.value)];
      if (p && inp.value !== p.place) { inp.value = p.place; S.stops[+inp.dataset.i] = p.place; tripChanged(); }
      markValidity(inp);
      closeSuggest(inp);
    }, 150);
  });
  stopsEl.addEventListener('keydown', function (e) {
    var inp = e.target;
    if (!inp.classList.contains('place-input')) return;
    var box = inp.parentNode.querySelector('.suggest');
    var items = Array.prototype.slice.call(box.querySelectorAll('button'));
    var cur = items.findIndex(function (b) { return b.classList.contains('active'); });
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      var nxt = e.key === 'ArrowDown' ? Math.min(items.length - 1, cur + 1) : Math.max(0, cur - 1);
      items.forEach(function (b, k) { b.classList.toggle('active', k === nxt); });
      items[nxt].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!box.hidden && items[cur]) choosePlace(inp, items[cur].dataset.place);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeSuggest(inp);
    }
  });
  stopsEl.addEventListener('mousedown', function (e) { if (e.target.closest('.suggest')) e.preventDefault(); });
  stopsEl.addEventListener('click', function (e) {
    var sug = e.target.closest('.suggest button[data-place]');
    if (sug) { choosePlace(sug.closest('.combo').querySelector('.place-input'), sug.dataset.place); return; }
    var b = e.target.closest('button[data-act]');
    if (!b) return;
    var i = +b.dataset.i, s = S.stops, t;
    if (b.dataset.act === 'up' && i > 0) { t = s[i - 1]; s[i - 1] = s[i]; s[i] = t; }
    if (b.dataset.act === 'down' && i < s.length - 1) { t = s[i + 1]; s[i + 1] = s[i]; s[i] = t; }
    if (b.dataset.act === 'remove' && s.length > 2) s.splice(i, 1);
    renderStops();
  });

  $('addStop').addEventListener('click', function () {
    if (S.stops.length >= 15) { toast('Maximum 15 stops.'); return; }
    S.stops.push('');
    renderStops(S.stops.length - 1);
  });
  $('returnStart').addEventListener('click', function () {
    var first = S.stops[0].trim();
    if (!first) { toast('Pick the first stop first.'); return; }
    var last = S.stops.length - 1;
    if (norm(S.stops[last]) === norm(first)) { toast('Route already returns to ' + first + '.'); return; }
    if (!S.stops[last].trim()) S.stops[last] = first; else S.stops.push(first);
    renderStops();
  });
  $('roundHome').addEventListener('click', function () {
    var home = homePlace();
    if (!home) { toast('Set your home place first (Settings → My account).'); return; }
    var mid = S.stops.map(function (s) { return s.trim(); }).filter(Boolean);
    if (mid.length && norm(mid[0]) === norm(home)) mid.shift();
    if (mid.length && norm(mid[mid.length - 1]) === norm(home)) mid.pop();
    S.stops = [home].concat(mid.length ? mid : ['']).concat([home]);
    var empty = S.stops.indexOf('');
    renderStops(empty >= 0 ? empty : null);
  });

  $('tDate').addEventListener('input', function () { $('tDateLabel').textContent = ukLong($('tDate').value); });
  $('tripForm').addEventListener('input', tripChanged);
  $('tripForm').addEventListener('change', tripChanged);
  $('tripForm').addEventListener('submit', function (e) { e.preventDefault(); });

  function tripPayload() {
    var type = document.querySelector('input[name="tType"]:checked');
    return {
      date: $('tDate').value,
      stops: S.stops.map(function (s) { return s.trim(); }),
      reason: $('tReason').value.trim(),
      ticket: $('tTicket').value.trim(),
      customerId: $('tCustomer').value,
      ratePence: $('tRate').value === '' ? '' : Number($('tRate').value),
      dataType: type ? type.value : 'Live',
    };
  }

  /** Save is only enabled for the exact trip that was previewed. */
  function tripChanged() {
    var fresh = S.previewKey !== null && JSON.stringify(tripPayload()) === S.previewKey;
    $('btnSave').disabled = !(fresh && S.previewOk);
    if (!$('preview').hidden) $('preview').classList.toggle('stale', !fresh);
  }

  function clientCheck(p) {
    if (!p.date) return 'Pick a date.';
    if (p.date > S.today) return 'Date cannot be in the future.';
    for (var i = 0; i < p.stops.length; i++) {
      if (!p.stops[i]) return 'Stop ' + (i + 1) + ' is empty.';
      if (!S.placeMap[norm(p.stops[i])]) return '"' + p.stops[i] + '" is not a saved place. Pick from the list or add it on the Places page.';
    }
    if (!(p.ratePence > 0 && p.ratePence <= 200)) return 'Rate must be between 1 and 200 pence.';
    return '';
  }

  function renderPreview(r) {
    var html = '<h3>Preview · ' + esc(ukLong(r.date)) + '</h3>';
    if (r.duplicates.length) {
      html += '<div class="msg bad">Already logged on ' + esc(r.dateUk) + ' with this Ticket ID:\n' + esc(r.duplicates.join('\n')) +
        '\nSaving is blocked. Change the date or ticket, or delete the old entry.</div>';
    }
    r.warnings.forEach(function (w) { html += '<div class="msg warn">' + esc(w) + '</div>'; });
    if (r.skipped.length) html += '<div class="msg info">Skipped (same place): ' + esc(r.skipped.join(', ')) + '</div>';
    html += '<table><thead><tr><th>#</th><th>Leg</th><th class="num">Miles</th><th class="num">Claim</th></tr></thead><tbody>' +
      r.legs.map(function (l) {
        return '<tr><td>' + l.n + '</td><td>' + esc(l.from) + ' → ' + esc(l.to) +
          '<span class="sub">' + esc(l.business || 'no business') + ' · <span class="badge ' + l.source + '">' +
          (l.source === 'google' ? 'Google' : 'Cache') + '</span></span></td>' +
          '<td class="num">' + mi(l.miles) + '</td><td class="num">' + money(l.claim) + '</td></tr>';
      }).join('') +
      '</tbody><tfoot><tr><td></td><td>Total · ' + r.legs.length + ' leg' + (r.legs.length === 1 ? '' : 's') + ' @ ' + r.ratePence +
      'p</td><td class="num">' + mi(r.totalMiles) + '</td><td class="num">' + money(r.totalClaim) + '</td></tr></tfoot></table>';
    $('preview').innerHTML = html;
    $('preview').hidden = false;
    $('preview').classList.remove('stale');
  }

  $('btnPreview').addEventListener('click', function () {
    showMsg('tripMsg', '');
    var p = tripPayload();
    var err = clientCheck(p);
    if (err) { showMsg('tripMsg', err, 'bad'); return; }
    S.previewKey = null;
    S.previewOk = false;
    tripChanged();
    busy(this, api('POST', '/api/trips/preview', p)).then(function (r) {
      S.previewKey = JSON.stringify(p);
      S.previewOk = !r.duplicates.length;
      renderPreview(r);
      tripChanged();
      $('preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }).catch(function (e) {
      $('preview').hidden = true;
      showMsg('tripMsg', e.message, 'bad');
    });
  });

  $('btnSave').addEventListener('click', function () {
    var p = tripPayload();
    if (JSON.stringify(p) !== S.previewKey) { showMsg('tripMsg', 'Preview again before saving.', 'warn'); return; }
    showMsg('tripMsg', '');
    busy(this, api('POST', '/api/trips', p)).then(function (r) {
      closeModal('tripModal');
      toast(r.message);
      // Make sure the new rows are visible in the table.
      if ($('fYear').value && $('fYear').value !== p.date.slice(0, 4)) $('fYear').value = p.date.slice(0, 4);
      if ($('fMonth').value && $('fMonth').value !== p.date.slice(5, 7)) $('fMonth').value = '';
      return loadLog();
    }).catch(function (e) {
      showMsg('tripMsg', e.message, 'bad');
    }).finally(tripChanged);
  });

  /* ================================================================ */
  /* Places                                                            */
  /* ================================================================ */

  function renderPlaces() {
    var q = norm($('pSearch').value), onlyMissing = $('pMissingOnly').checked;
    var rows = S.places.filter(function (p) {
      if (onlyMissing && p.lat !== null) return false;
      return !q || norm(p.place + ' ' + p.address + ' ' + p.business + ' ' + p.notes).indexOf(q) >= 0;
    }).map(function (p) { return Object.assign({ status: p.lat === null ? 0 : 1 }, p); });
    rows = sortRows(rows, S.placeSort);
    var missing = S.places.filter(function (p) { return p.lat === null; }).length;
    $('pCount').textContent = S.places.length + ' places' + (missing ? ' · ' + missing + ' missing coordinates' : '');
    $('placeBody').innerHTML = rows.length ? rows.map(function (p) {
      return '<tr class="clickable" data-id="' + p.id + '">' +
        '<td class="c-place">' + esc(p.place) + '</td>' +
        '<td class="c-addr trunc" title="' + esc(p.address) + '">' + esc(p.address || '—') + '</td>' +
        '<td class="c-coords nowrap">' + (p.lat === null ? '—' : p.lat.toFixed(5) + ', ' + p.lng.toFixed(5)) + '</td>' +
        '<td class="c-biz" title="' + esc(p.business) + '">' + esc(p.business || '—') + '</td>' +
        '<td class="c-notes trunc">' + esc(p.notes) + '</td>' +
        '<td class="c-status">' + (p.lat === null ? '<span class="badge missing">No coordinates</span>' : '<span class="badge okc">Ready</span>') + '</td>' +
        '</tr>';
    }).join('') : '<tr><td class="empty" colspan="6">' + (S.places.length ? 'No places match.' : 'No places yet. Click “Add place”.') + '</td></tr>';
    markSorted('.grid.places th[data-psort]', 'data-psort', S.placeSort);
  }
  $('pSearch').addEventListener('input', renderPlaces);
  $('pMissingOnly').addEventListener('change', renderPlaces);
  document.querySelector('.grid.places thead').addEventListener('click', function (e) {
    var th = e.target.closest('th[data-psort]');
    if (!th) return;
    var k = th.dataset.psort;
    S.placeSort = S.placeSort.key === k ? { key: k, dir: -S.placeSort.dir } : { key: k, dir: 1 };
    renderPlaces();
  });
  $('placeBody').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    openPlaceModal(S.places.filter(function (p) { return String(p.id) === tr.dataset.id; })[0]);
  });
  $('btnAddPlace').addEventListener('click', function () { openPlaceModal(null); });

  function openPlaceModal(p) {
    $('pId').value = p ? p.id : '';
    $('pPlace').value = p ? p.place : '';
    $('pAddress').value = p ? p.address : '';
    $('pCoords').value = '';
    $('pCoords').classList.remove('invalid');
    $('gpsStatus').hidden = true;
    $('pLat').value = p && p.lat !== null ? p.lat : '';
    $('pLng').value = p && p.lng !== null ? p.lng : '';
    $('pCustomer').value = p && p.customerId ? String(p.customerId) : '';
    $('pNotes').value = p ? p.notes : '';
    $('placeTitle').textContent = p ? 'Edit ' + p.place : 'Add place';
    $('btnDeletePlace').hidden = !p || role() !== 'admin';
    $('btnMapPick').hidden = !S.mapsPicker.configured;
    showMsg('placeMsg', '');
    updateMapLink();
    openModal('placeModal');
    if (window.matchMedia('(min-width: 701px)').matches) $('pPlace').focus();
  }

  function updateMapLink() {
    var lat = $('pLat').value.trim(), lng = $('pLng').value.trim();
    $('pMapLink').innerHTML = lat && lng && isFinite(lat) && isFinite(lng)
      ? '<a href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(lat + ',' + lng) + '" target="_blank" rel="noopener">Check on Google Maps ↗</a>'
      : '';
  }
  $('pCoords').addEventListener('input', function () {
    var m = /^\s*\(?\s*(-?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?\s*$/.exec(this.value);
    this.classList.toggle('invalid', !!this.value.trim() && !m);
    if (m) { $('pLat').value = m[1]; $('pLng').value = m[2]; updateMapLink(); }
  });
  /* ---- "Use my location": fill Lat/Lng from the device GPS ---- */
  function gpsMsg(text, kind) {
    var el = $('gpsStatus');
    el.className = 'hint ' + (kind || '');
    el.textContent = text;
    el.hidden = !text;
  }

  $('btnGps').addEventListener('click', function () {
    var btn = this;
    if (!window.isSecureContext) {
      gpsMsg('Location only works over HTTPS (or on the PC via localhost). Open the site through your HTTPS address to use GPS.', 'bad');
      return;
    }
    if (!navigator.geolocation) { gpsMsg('This browser does not support location.', 'bad'); return; }
    var label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Locating…';
    gpsMsg('Getting a GPS fix… stand outside or near a window for best accuracy.');
    var done = function () { btn.disabled = false; btn.innerHTML = label; };
    navigator.geolocation.getCurrentPosition(function (pos) {
      done();
      var lat = pos.coords.latitude.toFixed(6), lng = pos.coords.longitude.toFixed(6);
      var acc = Math.round(pos.coords.accuracy);
      $('pLat').value = lat;
      $('pLng').value = lng;
      $('pCoords').value = '';
      $('pCoords').classList.remove('invalid');
      updateMapLink();
      if (acc > 100) {
        gpsMsg('Location filled in, but accuracy is poor (±' + acc + ' m). Try again outdoors, or check it on the map.', 'warn');
      } else {
        gpsMsg('Location filled in (±' + acc + ' m). Check it on the map, then save.', 'ok');
      }
    }, function (err) {
      done();
      var why = {
        1: 'Location permission was denied. Allow location for this site in your browser settings, then try again.',
        2: 'Your location could not be determined. Check GPS / Location is switched on.',
        3: 'Timed out getting a GPS fix. Try again, ideally outdoors.',
      }[err.code] || ('Could not get location: ' + err.message);
      gpsMsg(why, 'bad');
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });

  /* ---- Route map: the driving route for one Mileage entry (route-map.html in an iframe) ---- */

  function openRouteMap(entryId) {
    var r = S.log.filter(function (x) { return x.entryId === entryId; })[0];
    $('routeTitle').textContent = r ? 'Route · ' + uk(r.date) : 'Route';
    $('routeFrame').src = '/route-map.html?entry=' + encodeURIComponent(entryId);
    openModal('routeModal');
  }

  /* ---- Map picker: a Google map in an iframe (map-picker.html) that posts the pin back here ---- */

  var mapPin = null; // last {lat, lng, address} from the picker

  function openMapPicker() {
    var lat = $('pLat').value.trim(), lng = $('pLng').value.trim();
    var q = $('pAddress').value.trim() || $('pPlace').value.trim();
    var params = lat && lng && isFinite(lat) && isFinite(lng)
      ? 'lat=' + encodeURIComponent(lat) + '&lng=' + encodeURIComponent(lng)
      : (q ? 'q=' + encodeURIComponent(q) : '');
    mapPin = null;
    $('btnMapUse').disabled = true;
    $('mapFrame').src = '/map-picker.html' + (params ? '?' + params : '');
    openModal('mapModal');
  }
  $('btnMapPick').addEventListener('click', openMapPicker);

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || e.source !== $('mapFrame').contentWindow) return;
    var m = e.data || {};
    if (m.type !== 'waymark-map-pin' || !isFinite(m.lat) || !isFinite(m.lng)) return;
    mapPin = { lat: Number(m.lat), lng: Number(m.lng), address: String(m.address || '') };
    $('btnMapUse').disabled = false;
  });

  $('btnMapUse').addEventListener('click', function () {
    if (!mapPin) return;
    $('pLat').value = mapPin.lat;
    $('pLng').value = mapPin.lng;
    $('pCoords').value = '';
    $('pCoords').classList.remove('invalid');
    if (!$('pAddress').value.trim() && mapPin.address) $('pAddress').value = mapPin.address.slice(0, 300);
    updateMapLink();
    closeModal('mapModal');
  });

  $('pLat').addEventListener('input', updateMapLink);
  $('pLng').addEventListener('input', updateMapLink);
  $('placeForm').addEventListener('submit', function (e) { e.preventDefault(); $('btnSavePlace').click(); });

  function afterPlaceChange(r) {
    setPlaces(r.places);
    setCustomers(r.customers);
    renderPlaces();
    closeModal('placeModal');
    toast(r.message);
  }

  $('btnSavePlace').addEventListener('click', function () {
    var id = $('pId').value;
    var body = {
      place: $('pPlace').value.trim(), address: $('pAddress').value.trim(),
      lat: $('pLat').value.trim(), lng: $('pLng').value.trim(),
      customerId: $('pCustomer').value, notes: $('pNotes').value.trim(),
    };
    if (!body.place) { showMsg('placeMsg', 'Place name is required.', 'bad'); return; }
    busy(this, api(id ? 'PUT' : 'POST', id ? '/api/places/' + id : '/api/places', body))
      .then(afterPlaceChange)
      .catch(function (e) { showMsg('placeMsg', e.message, 'bad'); });
  });

  $('btnDeletePlace').addEventListener('click', function () {
    var id = $('pId').value, name = $('pPlace').value;
    confirmBox('Delete ' + name + '?', 'The place and its cached distances will be removed.\nExisting log rows keep the name and are not affected.')
      .then(function (ok) {
        if (!ok) return;
        api('DELETE', '/api/places/' + id).then(afterPlaceChange).catch(function (e) { showMsg('placeMsg', e.message, 'bad'); });
      });
  });

  /* ================================================================ */
  /* Export                                                            */
  /* ================================================================ */

  function exportQuery() {
    var range = document.querySelector('input[name="xMode"]:checked').value === 'range';
    var q = range ? { mode: 'range', from: $('xFrom').value, to: $('xTo').value } : { mode: 'month', month: $('xMonth').value.trim() };
    if (viewsAll()) q.userId = $('xUser').value;
    var ok = range ? !!(q.from && q.to) : /^\d{4}-\d{2}$/.test(q.month);
    return { q: q, ok: ok, qs: new URLSearchParams(q).toString() };
  }

  function loadExportSummary() {
    var x = exportQuery();
    $('btnDownload').href = x.ok ? '/api/export/csv?' + x.qs : '#';
    if (!x.ok) { $('xSummary').innerHTML = ''; return; }
    showMsg('exportMsg', '');
    api('GET', '/api/export/summary?' + x.qs).then(function (r) {
      var s = r.summary;
      $('xSummary').innerHTML =
        '<div class="kpis summary-kpis">' + kpi('Legs', s.legs) + kpi('Miles', mi(s.miles)) + kpi('Claim', money(s.claim)) + '</div>' +
        (s.byUser.length > 1 || (viewsAll() && !$('xUser').value) ? '<div class="panel mb16"><div class="panel-body"><h2 class="section-title">' + esc(r.label) + ' · by user</h2>' +
          (s.byUser.length ? '<table class="breakdown"><tr><th>User</th><th class="num">Legs</th><th class="num">Miles</th><th class="num">Claim</th></tr>' +
            s.byUser.map(function (u) {
              return '<tr><td>' + esc(u.user) + '</td><td class="num">' + u.legs + '</td><td class="num">' + mi(u.miles) +
                '</td><td class="num">' + money(u.claim) + '</td></tr>';
            }).join('') + '</table>' : '<p class="muted">No Live entries in this period.</p>') + '</div></div>' : '') +
        '<div class="panel"><div class="panel-body"><h2 class="section-title">' + esc(r.label) + ' · ' + esc(r.scope) + ' · by customer</h2>' +
        (s.byBusiness.length ? '<table class="breakdown"><tr><th>Customer</th><th class="num">Legs</th><th class="num">Miles</th><th class="num">Claim</th></tr>' +
          s.byBusiness.map(function (b) {
            return '<tr><td>' + esc(b.business) + '</td><td class="num">' + b.legs + '</td><td class="num">' + mi(b.miles) +
              '</td><td class="num">' + money(b.claim) + '</td></tr>';
          }).join('') + '</table>' : '<p class="muted">No Live entries in this period.</p>') +
        '<p class="hint">File: ' + esc(r.filename) + '</p></div></div>';
    }).catch(function (e) { $('xSummary').innerHTML = ''; showMsg('exportMsg', e.message, 'bad'); });
  }

  document.querySelectorAll('input[name="xMode"]').forEach(function (r) {
    r.addEventListener('change', function () {
      var range = document.querySelector('input[name="xMode"]:checked').value === 'range';
      $('xMonthBox').hidden = range;
      $('xRangeBox').hidden = !range;
      loadExportSummary();
    });
  });
  ['xUser', 'xMonth', 'xFrom', 'xTo'].forEach(function (id) { $(id).addEventListener('change', loadExportSummary); });
  $('btnDownload').addEventListener('click', function (e) {
    if (!exportQuery().ok) { e.preventDefault(); showMsg('exportMsg', 'Pick a month or both dates first.', 'warn'); }
  });

  /* ================================================================ */
  /* Settings                                                          */
  /* ================================================================ */

  function fillSettings() {
    $('sRate').value = S.settings.ratePence;
    $('sHome').value = S.settings.homePlaces.join(',');
  }

  $('settingsForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = this.querySelector('button[type="submit"]');
    busy(btn, api('PUT', '/api/settings', {
      ratePence: Number($('sRate').value), homePlaces: $('sHome').value,
    })).then(function (r) {
      S.settings = r.settings;
      fillSettings();
      showMsg('settingsMsg', r.message, 'ok');
    }).catch(function (err) { showMsg('settingsMsg', err.message, 'bad'); });
  });

  /* ---- Google Maps API key (write-only: the server only ever reports whether one is set) ---- */

  function renderGoogle(g) {
    var st = $('gStatus');
    if (g.configured) {
      st.className = 'key-status on';
      st.textContent = g.source === 'env' ? 'Key set (from the server .env file)' : 'Key saved';
      $('gKeyLabel').textContent = 'Replace key';
    } else {
      st.className = 'key-status off';
      st.textContent = g.source === 'unreadable'
        ? 'Saved key can no longer be read (server secret changed). Please enter it again.'
        : 'No key set. Only distances already in the cache can be used.';
      $('gKeyLabel').textContent = 'API key';
    }
    $('btnTestKey').disabled = !g.configured;
    $('btnRemoveKey').hidden = g.source !== 'app';
    var banner = $('globalMsg');
    if (!g.configured) {
      banner.className = 'msg warn';
      banner.textContent = 'No Google Maps API key set: new distances cannot be looked up. ' +
        (role() === 'admin' ? 'Add one under Settings.' : 'Ask an administrator to add one.');
      banner.hidden = false;
    } else if (banner.classList.contains('warn')) {
      banner.hidden = true;
    }
  }

  $('googleForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var key = $('gKey').value.trim();
    if (!key) { showMsg('settingsMsg', 'Paste a key first.', 'warn'); return; }
    busy($('btnSaveKey'), api('PUT', '/api/settings/google-key', { key: key })).then(function (r) {
      $('gKey').value = '';
      renderGoogle(r.google);
      showMsg('settingsMsg', r.message + ' Click "Test key" to check it works.', 'ok');
    }).catch(function (err) { showMsg('settingsMsg', err.message, 'bad'); });
  });

  $('btnTestKey').addEventListener('click', function () {
    showMsg('settingsMsg', '');
    busy(this, api('POST', '/api/settings/google-key/test')).then(function (r) { showMsg('settingsMsg', r.message, 'ok'); })
      .catch(function (err) { showMsg('settingsMsg', err.message, 'bad'); });
  });

  $('btnRemoveKey').addEventListener('click', function () {
    var btn = this;
    confirmBox('Remove Google API key?', 'New distances will not be looked up until a key is added again.\nCached distances keep working.', 'Remove')
      .then(function (ok) {
        if (!ok) return;
        busy(btn, api('DELETE', '/api/settings/google-key')).then(function (r) {
          renderGoogle(r.google);
          showMsg('settingsMsg', r.message, 'ok');
        }).catch(function (err) { showMsg('settingsMsg', err.message, 'bad'); });
      });
  });

  /* ---- Map picker browser key (admin). Not secret: Google restricts it to this site's address. ---- */

  function renderMapsKey(st) {
    S.mapsPicker = st;
    var el = $('mStatus');
    el.className = 'key-status ' + (st.configured ? 'on' : 'off');
    el.textContent = st.configured ? (st.source === 'env' ? 'Key set (from the server .env file)' : 'Key saved')
      : 'No key set. The "Pick on map" button is hidden until one is added.';
    $('btnRemoveMapsKey').hidden = st.source !== 'app';
    $('mOrigins').textContent = location.origin + '/*';
    if (S.logLoaded) renderLog(); // Mileage rows open the route map only when a key is set
  }

  $('mapsKeyForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var key = $('mKey').value.trim();
    if (!key) { showMsg('settingsMsg', 'Paste a key first.', 'warn'); return; }
    busy($('btnSaveMapsKey'), api('PUT', '/api/settings/maps-browser-key', { key: key })).then(function (r) {
      $('mKey').value = '';
      renderMapsKey(r.mapsPicker);
      showMsg('settingsMsg', r.message + ' Open a place and click "Pick on map" to check it works.', 'ok');
    }).catch(function (err) { showMsg('settingsMsg', err.message, 'bad'); });
  });

  $('btnRemoveMapsKey').addEventListener('click', function () {
    var btn = this;
    confirmBox('Remove map picker key?', 'The "Pick on map" button will be hidden. Coordinates can still be pasted or typed in.', 'Remove')
      .then(function (ok) {
        if (!ok) return;
        busy(btn, api('DELETE', '/api/settings/maps-browser-key')).then(function (r) {
          renderMapsKey(r.mapsPicker);
          showMsg('settingsMsg', r.message, 'ok');
        }).catch(function (err) { showMsg('settingsMsg', err.message, 'bad'); });
      });
  });

  /* ---- My account ---- */
  var ROLE_LABELS = { admin: 'Administrator', user: 'User', accounts: 'Accounts' };

  function fillProfile() {
    $('meName').value = S.me.name;
    $('meHome').value = S.me.homePlaceId ? String(S.me.homePlaceId) : '';
    $('meRate').value = S.me.ratePenceOwn != null ? S.me.ratePenceOwn : '';
    $('meLine').textContent = 'Signed in as ' + S.me.username + ' · ' + ROLE_LABELS[S.me.role];
    $('whoami').innerHTML = '<b>' + esc(S.me.name) + '</b><small>' + esc(ROLE_LABELS[S.me.role]) + '</small>';
    renderSecurity();
  }

  $('profileForm').addEventListener('submit', function (e) {
    e.preventDefault();
    busy(this.querySelector('button[type="submit"]'), api('PUT', '/api/me', {
      name: $('meName').value.trim(), homePlaceId: $('meHome').value, ratePence: $('meRate').value,
    })).then(function (r) {
      setMe(r.me);
      showMsg('settingsMsg', r.message, 'ok');
    }).catch(function (err) { showMsg('settingsMsg', err.message, 'bad'); });
  });

  $('passwordForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if ($('pwNew').value !== $('pwNew2').value) { showMsg('settingsMsg', 'The new passwords do not match.', 'bad'); return; }
    busy(this.querySelector('button[type="submit"]'), api('PUT', '/api/me/password', {
      current: $('pwCurrent').value, next: $('pwNew').value,
    })).then(function (r) {
      $('pwCurrent').value = $('pwNew').value = $('pwNew2').value = '';
      S.me.mustChangePassword = false;
      $('pwBanner').hidden = true;
      showMsg('settingsMsg', r.message, 'ok');
    }).catch(function (err) { showMsg('settingsMsg', err.message, 'bad'); });
  });

  function setMe(me) {
    // ratePence from the server is the effective rate; keep the user's own override separately for the form.
    S.me = me;
    S.me.ratePenceOwn = me.ratePenceOwn !== undefined ? me.ratePenceOwn : null;
    fillProfile();
  }

  /* ---- Users (admin) ---- */
  var USERS = [];
  function loadUsers() {
    $('userBody').innerHTML = '<tr><td class="empty" colspan="8"><span class="spinner"></span></td></tr>';
    api('GET', '/api/users').then(function (r) { USERS = r.users; renderUsers(); })
      .catch(function (e) { $('userBody').innerHTML = '<tr><td class="empty" colspan="8">' + esc(e.message) + '</td></tr>'; });
  }
  function renderUsers() {
    $('userBody').innerHTML = USERS.map(function (u) {
      return '<tr class="clickable" data-id="' + u.id + '">' +
        '<td class="c-uname"><b>' + esc(u.name) + '</b>' + (u.id === S.me.id ? ' <span class="muted">(you)</span>' : '') + '</td>' +
        '<td class="c-ulogin">' + esc(u.username) + '</td>' +
        '<td class="c-urole"><span class="badge role-' + u.role + '">' + esc(u.roleLabel) + '</span></td>' +
        '<td class="c-uhome">' + esc(u.homePlace || '—') + '</td>' +
        '<td class="c-ulegs num">' + u.legs + '</td>' +
        '<td class="c-usec">' + (u.twoFactorEnabled ? '<span class="badge live">2FA</span> ' : '') +
          (u.passkeys ? '<span class="badge role-accounts">' + u.passkeys + ' passkey' + (u.passkeys === 1 ? '' : 's') + '</span>' : '') +
          (!u.twoFactorEnabled && !u.passkeys ? '<span class="muted">Password only</span>' : '') + '</td>' +
        '<td class="c-ulast nowrap">' + (u.lastLogin ? uk(u.lastLogin.slice(0, 10)) : 'never') + '</td>' +
        '<td class="c-ustatus">' + (u.active ? (u.mustChangePassword ? '<span class="badge test">Temp password</span>' : '<span class="badge live">Active</span>')
          : '<span class="badge inactive">Inactive</span>') + '</td></tr>';
    }).join('');
  }
  $('userBody').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-id]');
    if (tr) openUserModal(USERS.filter(function (u) { return String(u.id) === tr.dataset.id; })[0]);
  });
  $('btnAddUser').addEventListener('click', function () { openUserModal(null); });

  function syncUserRoleFields() { $('uLoggerFields').hidden = $('uRole').value === 'accounts'; }
  $('uRole').addEventListener('change', syncUserRoleFields);

  function randomPassword() {
    var chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    var a = new Uint32Array(14);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (n) { return chars[n % chars.length]; }).join('');
  }
  $('btnGenPw').addEventListener('click', function () { $('uPassword').value = randomPassword(); });

  function openUserModal(u) {
    $('uId').value = u ? u.id : '';
    $('uName').value = u ? u.name : '';
    $('uUsername').value = u ? u.username : '';
    $('uUsername').disabled = !!u;
    $('uEmail').value = u ? (u.email || '') : '';
    $('uReset2fa').checked = false;
    $('uReset2faRow').hidden = !(u && u.twoFactorEnabled);
    $('uRole').value = u ? u.role : 'user';
    $('uHome').value = u && u.homePlaceId ? String(u.homePlaceId) : '';
    $('uRate').value = u && u.ratePence != null ? u.ratePence : '';
    $('uPassword').value = u ? '' : randomPassword();
    $('uPasswordLabel').textContent = u ? 'Reset password (optional)' : 'Temporary password';
    $('uPasswordHint').textContent = u ? 'Leave blank to keep their current password. A reset signs them out and asks them to change it.'
      : "At least 10 characters. Give it to them; they'll be asked to change it after signing in.";
    $('uActive').checked = u ? u.active : true;
    $('uActiveRow').hidden = !u;
    $('btnDeleteUser').hidden = !u || u.id === S.me.id;
    $('userTitle').textContent = u ? 'Edit ' + u.name : 'Add user';
    syncUserRoleFields();
    showMsg('userMsg', '');
    openModal('userModal');
  }

  $('userForm').addEventListener('submit', function (e) { e.preventDefault(); $('btnSaveUser').click(); });
  $('btnSaveUser').addEventListener('click', function () {
    var id = $('uId').value;
    var body = {
      name: $('uName').value.trim(), role: $('uRole').value, homePlaceId: $('uHome').value, ratePence: $('uRate').value,
      password: $('uPassword').value, active: $('uActive').checked,
      email: $('uEmail').value.trim(), resetTwoFactor: $('uReset2fa').checked,
    };
    if (!id) body.username = $('uUsername').value.trim();
    var pw = body.password;
    busy(this, api(id ? 'PUT' : 'POST', id ? '/api/users/' + id : '/api/users', body)).then(function (r) {
      USERS = r.users;
      renderUsers();
      S.users = r.users.map(function (u) { return { id: u.id, name: u.name, username: u.username, role: u.role, active: u.active }; });
      fillUserPickers();
      closeModal('userModal');
      toast(r.message);
      if (pw) showMsg('globalMsg', 'Password for ' + (body.username || $('uUsername').value) + ': ' + pw +
        '\nCopy it now; it will not be shown again.', 'info');
    }).catch(function (e) { showMsg('userMsg', e.message, 'bad'); });
  });

  $('btnDeleteUser').addEventListener('click', function () {
    var id = $('uId').value, name = $('uName').value;
    confirmBox('Delete ' + name + '?', 'This removes their account for good. People with logged journeys can\'t be deleted; untick "Active" to deactivate them instead.')
      .then(function (ok) {
        if (!ok) return;
        api('DELETE', '/api/users/' + id).then(function (r) {
          USERS = r.users;
          renderUsers();
          S.users = r.users.map(function (u) { return { id: u.id, name: u.name, username: u.username, role: u.role, active: u.active }; });
          fillUserPickers();
          closeModal('userModal');
          toast(r.message);
        }).catch(function (e) { showMsg('userMsg', e.message, 'bad'); });
      });
  });

  function fillUserPickers() {
    if (!viewsAll()) return;
    fillSelect($('xUser'), S.users.map(function (u) { return String(u.id); }), 'All users', S.users.map(function (u) { return u.name; }));
    fillSelect($('fUser'), S.users.map(function (u) { return String(u.id); }), 'All users', S.users.map(function (u) { return u.name; }));
  }

  /* ---- Sign-in security: two-factor + passkeys (both optional) ---- */

  var pwResolve = null;
  /** Ask for the user's password in a small modal. Resolves with the password, or null if cancelled. */
  function askPassword(title, text, okLabel) {
    $('pwModalTitle').textContent = title;
    $('pwModalText').textContent = text || '';
    $('pwModalOk').textContent = okLabel || 'Continue';
    $('pwModalInput').value = '';
    showMsg('pwModalMsg', '');
    openModal('pwModal');
    setTimeout(function () { $('pwModalInput').focus(); }, 50);
    return new Promise(function (resolve) { pwResolve = resolve; });
  }
  function finishPassword(value) {
    var r = pwResolve; pwResolve = null;
    closeModal('pwModal');
    if (r) r(value);
  }
  $('pwModalOk').addEventListener('click', function () {
    var v = $('pwModalInput').value;
    if (!v) { showMsg('pwModalMsg', 'Enter your password.', 'warn'); return; }
    finishPassword(v);
  });
  $('pwModalCancel').addEventListener('click', function () { finishPassword(null); });
  $('pwModalForm').addEventListener('submit', function (e) { e.preventDefault(); $('pwModalOk').click(); });
  $('pwModal').addEventListener('click', function (e) { if (e.target === this) finishPassword(null); });

  var pendingCodes = [];

  function renderSecurity() {
    var on = !!S.me.twoFactorEnabled;
    $('tfBadge').textContent = on ? 'On' : 'Off';
    $('tfBadge').className = 'badge ' + (on ? 'live' : 'inactive');
    $('btnTfOn').hidden = on;
    $('btnTfOff').hidden = !on;
    $('btnTfCodes').hidden = !on;
    loadPasskeys();
  }

  function showCodes(codes) {
    pendingCodes = codes || [];
    $('tfCodesList').innerHTML = pendingCodes.map(function (c) { return '<li><code>' + esc(c) + '</code></li>'; }).join('');
    $('tfSetup').hidden = false;
    $('tfStepScan').hidden = true;
    $('tfStepCodes').hidden = false;
    $('tfSetup').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  $('btnTfOn').addEventListener('click', function () {
    var btn = this;
    askPassword('Turn on two-factor sign-in', 'Enter your password to start.', 'Continue').then(function (pw) {
      if (!pw) return;
      busy(btn, waymarkAuth.call('POST', '/two-factor/enable', { password: pw })).then(function (r) {
        var secret = new URL(r.totpURI).searchParams.get('secret') || '';
        var qr = qrcode(0, 'M');
        qr.addData(r.totpURI);
        qr.make();
        $('tfQr').src = qr.createDataURL(5, 2);
        $('tfSecret').textContent = secret.replace(/(.{4})/g, '$1 ').trim();
        pendingCodes = r.backupCodes || [];
        $('tfCode').value = '';
        $('tfSetup').hidden = false;
        $('tfStepScan').hidden = false;
        $('tfStepCodes').hidden = true;
        $('tfCode').focus();
      }).catch(function (e) { showMsg('settingsMsg', e.message, 'bad'); });
    });
  });

  $('btnTfVerify').addEventListener('click', function () {
    var code = $('tfCode').value.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) { showMsg('settingsMsg', 'Enter the 6-digit code from your authenticator app.', 'warn'); return; }
    busy(this, waymarkAuth.call('POST', '/two-factor/verify-totp', { code: code })).then(function () {
      S.me.twoFactorEnabled = true;
      showMsg('settingsMsg', 'Two-factor sign-in is on. You will be asked for a code after your password.', 'ok');
      showCodes(pendingCodes);
      renderSecurity();
    }).catch(function (e) { showMsg('settingsMsg', e.message, 'bad'); });
  });
  $('tfCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('btnTfVerify').click(); } });

  // The suggestion shown after first-run setup. "Skip" stops it for good; "Set up now" starts the normal flow
  // (the server stops suggesting once two-factor is on; if they abandon it half way, it's suggested again next time).
  $('btnTfPromptSkip').addEventListener('click', function () {
    closeModal('tfPromptModal');
    api('PUT', '/api/me/two-factor-prompt').then(function () {
      toast('Skipped. You can turn on two-factor sign-in any time in Settings.');
    }).catch(function () { /* it'll just be suggested again next time */ });
  });
  $('btnTfPromptGo').addEventListener('click', function () {
    closeModal('tfPromptModal');
    showPage('settings');
    $('btnTfOn').click();
  });

  $('btnTfCancel').addEventListener('click', function () { $('tfSetup').hidden = true; showMsg('settingsMsg', ''); });
  $('btnTfDone').addEventListener('click', function () { $('tfSetup').hidden = true; pendingCodes = []; });
  $('btnTfCopy').addEventListener('click', function () {
    var text = pendingCodes.join('\n');
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(function () { toast('Backup codes copied.'); })
      .catch(function () { toast('Copy failed: select the codes and copy them manually.'); });
  });

  $('btnTfOff').addEventListener('click', function () {
    var btn = this;
    askPassword('Turn off two-factor sign-in', 'You will only need your password (or a passkey) to sign in.', 'Turn off').then(function (pw) {
      if (!pw) return;
      busy(btn, waymarkAuth.call('POST', '/two-factor/disable', { password: pw })).then(function () {
        S.me.twoFactorEnabled = false;
        $('tfSetup').hidden = true;
        renderSecurity();
        showMsg('settingsMsg', 'Two-factor sign-in is off.', 'ok');
      }).catch(function (e) { showMsg('settingsMsg', e.message, 'bad'); });
    });
  });

  $('btnTfCodes').addEventListener('click', function () {
    var btn = this;
    askPassword('New backup codes', 'Your old backup codes will stop working.', 'Create new codes').then(function (pw) {
      if (!pw) return;
      busy(btn, waymarkAuth.call('POST', '/two-factor/generate-backup-codes', { password: pw })).then(function (r) {
        showCodes(r.backupCodes);
      }).catch(function (e) { showMsg('settingsMsg', e.message, 'bad'); });
    });
  });

  function deviceName() {
    var ua = navigator.userAgent;
    var dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone'
      : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'This device';
    return dev + ' (' + uk(S.today) + ')';
  }

  function loadPasskeys() {
    var ok = waymarkAuth.passkeysSupported();
    $('btnPkAdd').disabled = !ok;
    $('pkHint').textContent = ok ? 'Add one on each device you use (phone, laptop).'
      : 'Passkeys need a supported browser and the site opened over HTTPS (or on this PC via localhost).';
    waymarkAuth.call('GET', '/passkey/list-user-passkeys').then(function (list) {
      list = list || [];
      $('pkBadge').textContent = list.length ? list.length + ' added' : 'None';
      $('pkBadge').className = 'badge ' + (list.length ? 'live' : 'inactive');
      $('pkList').innerHTML = list.map(function (k) {
        return '<li><span><b>' + esc(k.name || 'Passkey') + '</b><small>Added ' + esc(uk(String(k.createdAt).slice(0, 10))) +
          (k.backedUp ? ' · synced' : '') + '</small></span>' +
          '<button type="button" class="btn small danger-outline" data-pk="' + esc(k.id) + '" data-name="' + esc(k.name || 'Passkey') + '">Remove</button></li>';
      }).join('');
    }).catch(function () { $('pkList').innerHTML = ''; });
  }

  $('btnPkAdd').addEventListener('click', function () {
    var btn = this;
    busy(btn, waymarkAuth.registerPasskey(deviceName())).then(function () {
      toast('Passkey added. You can now sign in with it.');
      loadPasskeys();
    }).catch(function (e) { showMsg('settingsMsg', e.message, 'bad'); });
  });

  $('pkList').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-pk]');
    if (!b) return;
    confirmBox('Remove passkey?', b.dataset.name + ' will no longer be able to sign in.', 'Remove').then(function (ok) {
      if (!ok) return;
      waymarkAuth.call('POST', '/passkey/delete-passkey', { id: b.dataset.pk }).then(function () {
        toast('Passkey removed.');
        loadPasskeys();
      }).catch(function (err) { showMsg('settingsMsg', err.message, 'bad'); });
    });
  });

  $('pwBannerGo').addEventListener('click', function () { showPage('settings'); $('pwCurrent').focus(); });

  $('btnBackup').addEventListener('click', function () {
    busy(this, api('POST', '/api/backup')).then(function (r) { showMsg('settingsMsg', r.message, 'ok'); })
      .catch(function (e) { showMsg('settingsMsg', e.message, 'bad'); });
  });

  /* ================================================================ */
  /* Init                                                              */
  /* ================================================================ */

  /* ---- Theme: System -> Light -> Dark ---- */
  var THEME_ICONS = {
    system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  };
  var THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
  function renderThemeBtn() {
    var t = window.waymarkTheme ? window.waymarkTheme.get() : 'system';
    $('btnTheme').innerHTML = THEME_ICONS[t] + '<span>' + THEME_LABELS[t] + '</span>';
    $('btnTheme').title = 'Theme: ' + THEME_LABELS[t] + ' (click to change)';
  }
  $('btnTheme').addEventListener('click', function () {
    var order = ['system', 'light', 'dark'];
    var next = order[(order.indexOf(window.waymarkTheme.get()) + 1) % order.length];
    window.waymarkTheme.set(next);
    renderThemeBtn();
  });
  renderThemeBtn();

  function prevMonth(iso) {
    var y = +iso.slice(0, 4), m = +iso.slice(5, 7) - 1;
    if (m === 0) { y--; m = 12; }
    return y + '-' + (m < 10 ? '0' : '') + m;
  }

  api('GET', '/api/init').then(function (d) {
    S.today = d.today;
    S.settings = d.settings;
    S.users = d.users || [];
    setMe(d.me);
    applyRoles();
    setPlaces(d.places);
    setCustomers(d.customers);
    fillUserPickers();
    fillProfile();

    $('xMonth').value = prevMonth(d.today);
    $('xFrom').value = d.today.slice(0, 8) + '01';
    $('xTo').value = d.today;
    fillSettings();

    $('globalMsg').hidden = true;
    renderGoogle(d.google);
    renderMapsKey(d.mapsPicker);
    $('pwBanner').hidden = !d.me.mustChangePassword;
    if (d.me.promptTwoFactor) openModal('tfPromptModal'); // suggested once after first-run setup
    showPage(location.hash.slice(1));
    return loadLog();
  }).catch(function (e) {
    showMsg('globalMsg', 'Could not load: ' + e.message, 'bad');
  });
})();
