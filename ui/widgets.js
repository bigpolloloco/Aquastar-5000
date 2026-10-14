/*
 * Small reusable UI pieces: status badges, tank selector, formatting shortcuts.
 */
import { h, options } from './dom.js';
import { state } from './state.js';

export const U = globalThis.AquaUnits;
export const D = globalThis.AquaDates;
export const P = globalThis.AquaPresets;
export const S = globalThis.AquaStats;

const STATUS_TEXT = { OK: 'OK', WATCH: 'WATCH', ALERT: 'ALERT', NONE: 'NO RANGE' };
const STATUS_ICON = { OK: '+', WATCH: '!', ALERT: 'X', NONE: '-' };

/**
 * Status badge: color plus an icon character and a word, so it never relies
 * on color alone (color-blind and grayscale friendly).
 */
export function statusBadge(level, extra) {
  const lvl = STATUS_TEXT[level] ? level : 'NONE';
  const text = STATUS_TEXT[lvl] + (extra ? ' ' + extra : '');
  return h('span', { class: 'status status-' + lvl.toLowerCase() },
    h('span', { class: 'status-icon', 'aria-hidden': 'true' }, STATUS_ICON[lvl]),
    h('span', { class: 'status-word' }, text));
}

export function tankOptions(includeArchived) {
  const list = includeArchived ? state.allTanks : state.tanks;
  return list.map((t) => ({ value: t.id, label: t.name + (t.archived ? ' (archived)' : '') }));
}

/** <select> of tanks. */
export function tankSelect(selected, onChange, opts) {
  const o = opts || {};
  const sel = h('select', { class: 'tank-select', 'aria-label': o.label || 'Tank' },
    o.allowAll ? h('option', { value: '' }, 'All tanks') : null,
    options(tankOptions(o.includeArchived), selected));
  if (onChange) sel.addEventListener('change', () => onChange(sel.value), o.signal ? { signal: o.signal } : undefined);
  return sel;
}

export function settings() {
  return state.settings || { units: U.DEFAULT_UNITS };
}

export function fmtReading(def, reading, opts) {
  return U.formatReading(def, reading, settings(), opts);
}

export function fmtVolume(litres) {
  return U.formatVolume(litres, settings());
}

export function fmtMoney(amount) {
  return U.formatMoney(amount, settings());
}

export function typeLabel(type) {
  return (P.TANK_TYPES[type] && P.TANK_TYPES[type].label) || type;
}

export function styleLabel(type, style) {
  const s = P.styleFor(type, style);
  return s ? s.label : style;
}

export function maintenanceLabel(m) {
  const t = P.MAINTENANCE_TYPES.find((x) => x.value === m.type);
  if (m.type === 'custom') return m.customType || 'Custom';
  if (m.type === 'media') {
    const media = P.MEDIA_TYPES.find((x) => x.value === m.media);
    const action = P.MEDIA_ACTIONS.find((x) => x.value === m.mediaAction);
    return 'Filter media' + (media ? ': ' + media.label : '') + (action ? ' (' + action.label.toLowerCase() + ')' : '');
  }
  return t ? t.label : m.type;
}

export function waterChangePercent(volumeL, tank) {
  if (!tank || !(tank.totalVolumeL > 0) || !(volumeL > 0)) return null;
  return (volumeL / tank.totalVolumeL) * 100;
}

/** Simple empty-state panel. */
export function emptyState(title, text, action) {
  return h('div', { class: 'empty-state' }, h('h3', null, title), text ? h('p', null, text) : null, action || null);
}

/** Table helper: headers [string], rows [[cells]] where cells may be nodes. */
export function table(headers, rows, opts) {
  const o = opts || {};
  return h('table', { class: ['data-table', o.class || ''].join(' ') },
    o.caption ? h('caption', { class: o.captionVisible ? '' : 'sr-only' }, o.caption) : null,
    h('thead', null, h('tr', null, headers.map((x) => h('th', { scope: 'col' }, x)))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => (i === 0 && o.rowHeaders ? h('th', { scope: 'row' }, c) : h('td', null, c)))))));
}
