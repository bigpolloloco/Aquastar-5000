/*
 * Renderer side of the IPC contract. window.aqua is provided by preload.js.
 * Every call resolves to {ok, data, error}; `req` throws an ApiError whose
 * message is already human readable and shows it in the ticker.
 */
export class ApiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApiError';
    this.shown = false;
  }
}

let ticker = null;

export function setTicker(t) { ticker = t; }

export async function call(channel, payload) {
  if (!window.aqua || typeof window.aqua.call !== 'function') {
    return { ok: false, error: 'The app bridge is unavailable. Please restart AquaStar 5000.' };
  }
  try {
    const res = await window.aqua.call(channel, payload);
    if (!res || typeof res !== 'object') return { ok: false, error: 'Unexpected response.' };
    return res;
  } catch (err) {
    return { ok: false, error: 'The request could not be completed.' };
  }
}

/** Call and return data, or show the error in the ticker and throw. */
export async function req(channel, payload, opts) {
  const res = await call(channel, payload);
  if (res.ok) return res.data;
  const err = new ApiError(res.error || 'Request failed.');
  if (!(opts && opts.quiet) && ticker) {
    ticker.error(res.error || 'Request failed.');
    err.shown = true;
  }
  throw err;
}

export function on(channel, cb) {
  if (!window.aqua || typeof window.aqua.on !== 'function') return () => {};
  return window.aqua.on(channel, cb);
}

/** Forward a renderer-side problem to the main process log. */
export function logToMain(level, message) {
  call('log:write', { level, message: String(message).slice(0, 2000) }).catch(() => undefined);
}
