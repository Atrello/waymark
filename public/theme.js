/* Theme: 'system' (follow the device), 'light' or 'dark'. Loaded in <head> so the page never flashes the wrong theme. */
(function () {
  var KEY = 'waymark-theme';
  function get() {
    try { return localStorage.getItem(KEY) || 'system'; } catch (e) { return 'system'; }
  }
  function apply(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  apply(get());
  window.waymarkTheme = {
    get: get,
    set: function (t) {
      try { localStorage.setItem(KEY, t); } catch (e) { /* private mode: still applies for this page */ }
      apply(t);
    },
  };
})();
