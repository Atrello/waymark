/* Shared UI pieces: toast, confirm dialog, password prompt, and the stack of open modals (for Escape + scroll lock). */

export const ui = $state({
  toast: '',
  confirm: null,   // { title, text, ok, resolve }
  password: null,  // { title, text, ok, resolve }
  modals: [],      // ids of open modals, topmost last
});

let toastTimer;
export function toast(text) {
  ui.toast = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast = ''; }, 4000);
}

/** Ask "are you sure?". Resolves true/false. */
export function confirmBox(title, text, ok = 'Delete') {
  return new Promise((resolve) => { ui.confirm = { title, text, ok, resolve }; });
}

/** Ask for the user's password. Resolves with it, or null if cancelled. */
export function askPassword(title, text, ok = 'Continue') {
  return new Promise((resolve) => { ui.password = { title, text, ok, resolve }; });
}

export function modalOpened(id) {
  if (!ui.modals.includes(id)) ui.modals.push(id);
  document.body.classList.add('modal-open');
}
export function modalClosed(id) {
  ui.modals = ui.modals.filter((m) => m !== id);
  if (!ui.modals.length) document.body.classList.remove('modal-open');
}
export const isTopModal = (id) => ui.modals[ui.modals.length - 1] === id;

/** Run an async action while a busy flag is set: `await busy((b) => (saving = b), () => api(...))`. */
export async function busy(set, fn) {
  set(true);
  try { return await fn(); } finally { set(false); }
}
