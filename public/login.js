/* Sign-in: password, then a two-factor code if the user has turned it on; or a passkey. */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  var mode = 'password'; // 'password' | 'totp' | 'backup'

  function show(msg) { $('loginMsg').textContent = msg; $('loginMsg').hidden = !msg; }
  function busy(btn, on, label) {
    btn.disabled = on;
    if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span>'; }
    else if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
  function done() { location.replace('/'); }

  function setMode(m) {
    mode = m;
    $('stepPassword').hidden = m !== 'password';
    $('stepCode').hidden = m === 'password';
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
