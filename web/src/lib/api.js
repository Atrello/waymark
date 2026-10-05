/* Talking to the server: the app's JSON API and Better Auth (sign-in, two-factor, passkeys). */
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

const HEADERS = { 'X-Requested-With': 'waymark' }; // the server refuses state-changing requests without it (CSRF guard)

/** JSON API call. Throws Error(message) on failure; bounces to /login when the session has expired. */
export async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: { ...HEADERS } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Session expired. Please sign in again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---- Better Auth ---- */

function friendly(status, msg) {
  if (status === 429) return msg || 'Too many attempts. Try again in 15 minutes.';
  if (/invalid username or password/i.test(msg || '')) return 'Wrong username or password.';
  if (/banned/i.test(msg || '')) return 'This account has been deactivated. Ask an administrator.';
  if (/invalid code|invalid backup code/i.test(msg || '')) return 'That code is not right. Try again.';
  if (/invalid password/i.test(msg || '')) return 'Password is wrong.';
  return msg || `Request failed (${status})`;
}

/** Call a Better Auth endpoint (path under /api/auth). Rejects with Error(message), with .status and .code set. */
export async function authCall(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: { ...HEADERS } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(`/api/auth${path}`, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const err = new Error(friendly(res.status, data && (data.message || data.error)));
    err.status = res.status;
    err.code = data && data.code;
    throw err;
  }
  return data;
}

/** WebAuthn errors (cancelled prompt, wrong device…) -> readable message. */
function webauthnMessage(e) {
  const name = `${(e && e.name) || ''} ${(e && e.code) || ''}`;
  if (/NotAllowed|ERROR_CEREMONY_ABORTED|AbortError/i.test(name)) return 'Passkey prompt was cancelled or timed out.';
  if (/PREVIOUSLY_REGISTERED|InvalidStateError/i.test(name)) return 'This device already has a passkey for your account.';
  if (/SecurityError|ERROR_INVALID_DOMAIN|ERROR_INVALID_RP_ID/i.test(name)) {
    return 'Passkeys need the site to be opened at its proper address (the APP_URL), over HTTPS or on localhost.';
  }
  return (e && e.message) || 'Passkey failed.';
}

export function passkeysSupported() {
  return !!(window.PublicKeyCredential && window.isSecureContext);
}

const strip = ({ clientExtensionResults, ...rest }) => rest; // eslint-disable-line no-unused-vars

export async function signInWithPasskey() {
  const optionsJSON = await authCall('GET', '/passkey/generate-authenticate-options');
  let resp;
  try { resp = await startAuthentication({ optionsJSON }); } catch (e) { throw new Error(webauthnMessage(e)); }
  return authCall('POST', '/passkey/verify-authentication', { response: strip(resp) });
}

export async function registerPasskey(name) {
  const q = name ? `?name=${encodeURIComponent(name)}` : '';
  const optionsJSON = await authCall('GET', `/passkey/generate-register-options${q}`);
  let resp;
  try { resp = await startRegistration({ optionsJSON }); } catch (e) { throw new Error(webauthnMessage(e)); }
  return authCall('POST', '/passkey/verify-registration', { response: strip(resp), name: name || undefined });
}
