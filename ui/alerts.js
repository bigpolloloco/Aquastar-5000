/*
 * Cross-tank alert summary for the ticker and dashboard.
 */
import { req } from './api.js';
import { state } from './state.js';
import { S, settings } from './widgets.js';

/** Load entries for all active tanks and compute alerts. Returns {byTank, all, entriesByTank}. */
export async function computeAlerts() {
  const entries = await req('entries:list', {}, { quiet: true });
  const entriesByTank = new Map();
  entries.forEach((e) => {
    if (!entriesByTank.has(e.tankId)) entriesByTank.set(e.tankId, []);
    entriesByTank.get(e.tankId).push(e);
  });
  const byTank = new Map();
  const all = [];
  const now = new Date();
  state.tanks.forEach((tank) => {
    const list = S.tankAlerts(tank, state.defs, entriesByTank.get(tank.id) || [], settings(), now);
    byTank.set(tank.id, list);
    list.forEach((a) => all.push(a));
  });
  return { byTank, all, entriesByTank };
}

/** One-line summary for the ticker's idle state. */
export function summarize(all, extra) {
  const items = all.filter((a) => a.level === 'ALERT' || a.kind === 'swing').concat(all.filter((a) => a.level === 'WATCH' && a.kind !== 'swing'));
  const parts = items.slice(0, 8).map((a) => a.message);
  (extra || []).forEach((x) => parts.push(x));
  if (!parts.length) return state.tanks.length ? 'All tanks within their ideal ranges. No overdue tests.' : 'Welcome to AquaStar 5000. Create a tank to get started.';
  const more = items.length > 8 ? '   +' + (items.length - 8) + ' more on the dashboard' : '';
  return parts.join('   ///   ') + more;
}
