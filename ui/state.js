/*
 * Shared renderer state: settings, tanks and parameter definitions.
 * Views read from here and call refresh() after changes; subscribers are
 * notified so headers and selectors stay in sync.
 */
import { req } from './api.js';

const listeners = new Set();

export const state = {
  settings: null,
  tanks: [],          // active (not archived)
  allTanks: [],       // including archived
  defs: [],
  info: null
};

export async function refresh(parts) {
  const want = parts || ['settings', 'tanks', 'defs'];
  const jobs = [];
  if (want.includes('settings')) jobs.push(req('settings:get').then((s) => { state.settings = s; }));
  if (want.includes('tanks')) {
    jobs.push(req('tanks:list', { includeArchived: true }).then((t) => {
      state.allTanks = t;
      state.tanks = t.filter((x) => !x.archived);
    }));
  }
  if (want.includes('defs')) jobs.push(req('parameters:list').then((d) => { state.defs = d; }));
  await Promise.all(jobs);
  listeners.forEach((fn) => { try { fn(state); } catch (e) { /* listener errors must not break others */ } });
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function tankById(id) {
  return state.allTanks.find((t) => t.id === id) || null;
}

export function defById(id) {
  return state.defs.find((d) => d.id === id) || null;
}

/** Enabled parameter definitions of a tank, in the tank-type order. */
export function tankDefs(tank) {
  if (!tank || !tank.params) return [];
  return Object.keys(tank.params)
    .filter((id) => tank.params[id] && tank.params[id].enabled)
    .map((id) => defById(id))
    .filter(Boolean);
}

/** Tank to preselect: last used if it still exists, else the first active tank. */
export function defaultTankId() {
  const last = state.settings && state.settings.lastTankId;
  if (last && state.tanks.some((t) => t.id === last)) return last;
  return state.tanks.length ? state.tanks[0].id : null;
}

export async function rememberTank(id) {
  if (!id || (state.settings && state.settings.lastTankId === id)) return;
  try {
    state.settings = await req('settings:save', { lastTankId: id }, { quiet: true });
  } catch (e) { /* not critical */ }
}
