/* Shared Better Auth helpers for the login page and Settings (no build step).
   Needs /vendor/simplewebauthn.js loaded first for passkeys. */
(function () {
  'use strict';
  var BASE = '/api/auth';

  /** Call a Better Auth endpoint. Resolves with the JSON body; rejects with Error(message) (err.status set). */
  function call(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { 'X-Requested-With': 'waymark' } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(BASE + path, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error(friendly(res.status, data && (data.message || data.error)));
          err.status = res.status;
          err.code = data && data.code;
          throw err;
        }
        return data;
      });
    });
  }

  function friendly(status, msg) {
    if (status === 429) return msg || 'Too many attempts. Try again in 15 minutes.';
    if (/invalid username or password/i.test(msg || '')) return 'Wrong username or password.';
    if (/banned/i.test(msg || '')) return 'This account has been deactivated. Ask an administrator.';
    if (/invalid code|invalid backup code/i.test(msg || '')) return 'That code is not right. Try again.';
    if (/invalid password/i.test(msg || '')) return 'Password is wrong.';
    return msg || ('Request failed (' + status + ')');
  }

  /** WebAuthn errors (cancelled prompt, wrong device…) -> readable message. */
  function webauthnMessage(e) {
    var name = (e && (e.name || '')) + ' ' + (e && (e.code || ''));
    if (/NotAllowed|ERROR_CEREMONY_ABORTED|AbortError/i.test(name)) return 'Passkey prompt was cancelled or timed out.';
    if (/PREVIOUSLY_REGISTERED|InvalidStateError/i.test(name)) return 'This device already has a passkey for your account.';
    if (/SecurityError|ERROR_INVALID_DOMAIN|ERROR_INVALID_RP_ID/i.test(name)) {
      return 'Passkeys need the site to be opened at its proper address (the APP_URL), over HTTPS or on localhost.';
    }
    return (e && e.message) || 'Passkey failed.';
  }

  function passkeysSupported() {
    return !!(window.PublicKeyCredential && window.isSecureContext && window.SimpleWebAuthnBrowser);
  }

  function strip(resp) {
    var copy = {};
    Object.keys(resp).forEach(function (k) { if (k !== 'clientExtensionResults') copy[k] = resp[k]; });
    return copy;
  }

  function signInWithPasskey() {
    return call('GET', '/passkey/generate-authenticate-options').then(function (opts) {
      return window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: opts }).catch(function (e) {
        throw new Error(webauthnMessage(e));
      });
    }).then(function (resp) {
      return call('POST', '/passkey/verify-authentication', { response: strip(resp) });
    });
  }

  function registerPasskey(name) {
    var q = name ? '?name=' + encodeURIComponent(name) : '';
    return call('GET', '/passkey/generate-register-options' + q).then(function (opts) {
      return window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: opts }).catch(function (e) {
        throw new Error(webauthnMessage(e));
      });
    }).then(function (resp) {
      return call('POST', '/passkey/verify-registration', { response: strip(resp), name: name || undefined });
    });
  }

  window.waymarkAuth = {
    call: call,
    passkeysSupported: passkeysSupported,
    signInWithPasskey: signInWithPasskey,
    registerPasskey: registerPasskey,
  };
})();
