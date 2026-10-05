/* Sign-in: password, then a two-factor code if the user has turned it on; or a passkey.
 * On a brand-new install (no accounts yet) the page instead offers to create the administrator account. */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  var mode = 'password'; // 'setup' | 'password' | 'totp' | 'backup'

  function show(msg) { $('loginMsg').textContent = msg; $('loginMsg').hidden = !msg; }
  function busy(btn, on, label) {
    btn.disabled = on;
    if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span>'; }
    else if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
  function done() { location.replace('/'); }

  function setMode(m) {
    mode = m;
    $('stepSetup').hidden = m !== 'setup';
    $('stepPassword').hidden = m !== 'password';
    $('stepCode').hidden = m !== 'totp' && m !== 'backup';
    if (m === 'totp') {
      $('codeHint').textContent = 'Enter the 6-digit code from your authenticator app.';
      $('codeLabel').textContent = 'Authentication code';
      $('btnUseBackup').textContent = 'Use a backup code instead';
    } else if (m === 'backup') {
      $('codeHint').textContent = 'Enter one of the backup codes you saved when you turned on two-factor sign-in. Each code works once.';
      $('codeLabel').textContent = 'Backup code';
      $('btnUseBackup').textContent = 'Use my authenticator app instead';
    }
    if (m !== 'password') { $('code').value = ''; $('code').focus(); }
  }

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    show('');
    if (mode === 'setup') {
      var su = $('setupUsername').value.trim(), se = $('setupEmail').value.trim();
      var sp = $('setupPassword').value, sc = $('setupConfirm').value;
      if (!su || !se || !sp) { show('Enter a username, email and password.'); return; }
      if (sp.length < 10) { show('Password must be at least 10 characters.'); return; }
      if (sp !== sc) { show("The passwords don't match."); $('setupConfirm').focus(); return; }
      busy($('btnSetup'), true);
      fetch('/api/setup', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'waymark' },
        body: JSON.stringify({ username: su, email: se, password: sp }),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || 'Could not create the account.');
        });
      }).then(done).catch(function (err) {
        busy($('btnSetup'), false);
        show(err.message);
        if (/already been set up/.test(err.message)) setMode('password'); // someone else got there first
      });
      return;
    }
    if (mode === 'password') {
      var u = $('username').value.trim(), p = $('password').value;
      if (!u || !p) { show('Enter your username and password.'); return; }
      busy($('btnSignIn'), true);
      waymarkAuth.call('POST', '/sign-in/username', { username: u, password: p, rememberMe: true }).then(function (r) {
        if (r && r.twoFactorRedirect) { busy($('btnSignIn'), false); setMode('totp'); return; }
        done();
      }).catch(function (err) { busy($('btnSignIn'), false); show(err.message); });
    } else {
      var code = $('code').value.replace(/\s+/g, '');
      if (!code) { show('Enter the code.'); return; }
      busy($('btnVerify'), true);
      var path = mode === 'totp' ? '/two-factor/verify-totp' : '/two-factor/verify-backup-code';
      waymarkAuth.call('POST', path, { code: code, trustDevice: $('trustDevice').checked }).then(done).catch(function (err) {
        busy($('btnVerify'), false);
        if (err.status === 401 && /two.?factor|session/i.test(err.message) && !/code/i.test(err.message)) {
          setMode('password');
          show('That took too long. Sign in again.');
          return;
        }
        show(err.message);
      });
    }
  });

  $('btnUseBackup').addEventListener('click', function () { show(''); setMode(mode === 'totp' ? 'backup' : 'totp'); });
  $('btnBack').addEventListener('click', function () { show(''); setMode('password'); $('password').value = ''; $('password').focus(); });

  // Brand-new install? Offer to create the first account instead of signing in.
  fetch('/api/setup', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
    if (j && j.needed) { setMode('setup'); $('setupUsername').focus(); }
  }).catch(function () { /* stay on the sign-in form */ });

  if (waymarkAuth.passkeysSupported()) {
    $('passkeyBox').hidden = false;
    $('btnPasskey').addEventListener('click', function () {
      show('');
      var btn = this;
      busy(btn, true);
      waymarkAuth.signInWithPasskey().then(done).catch(function (err) { busy(btn, false); show(err.message); });
    });
  }
})();
