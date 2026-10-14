/*
 * Builds the plain-text "help post" summary and the printable parameter
 * report. Pure renderer code working on data already loaded through IPC.
 */
import { h } from './dom.js';
import { U, D, S, settings, typeLabel, styleLabel, maintenanceLabel, waterChangePercent } from './widgets.js';
import { tankDefs, defById } from './state.js';

const STATUS_LABEL = { alive: 'alive', died: 'died', sold: 'sold', traded: 'traded', moved: 'moved out' };

function age(startDate) {
  if (!startDate) return null;
  const days = -D.daysUntilDate(startDate);
  if (days < 0) return null;
  if (days < 60) return days + ' days';
  const months = Math.floor(days / 30.44);
  if (months < 24) return months + ' months';
  return Math.floor(months / 12) + ' years ' + (months % 12) + ' months';
}

/**
 * Plain-text summary of a tank to paste into a forum or show a fish store.
 * data: {tank, entries, maintenance, dosing, livestock, treatments, schedules, equipment}
 */
export function helpPost(data, now) {
  const at = now || new Date();
  const s = settings();
  const { tank } = data;
  const L = [];
  const since30 = at.getTime() - 30 * D.MS_PER_DAY;
  L.push('=== ' + tank.name + ' - ' + typeLabel(tank.type) + ' / ' + styleLabel(tank.type, tank.style) + ' ===');
  const vol = 'System volume: ' + U.formatVolume(tank.totalVolumeL, s) + (tank.displayVolumeL ? ' (display ' + U.formatVolume(tank.displayVolumeL, s) + ', rest in sump/plumbing)' : '');
  L.push(vol + (tank.startDate ? '. Running since ' + tank.startDate + (age(tank.startDate) ? ' (' + age(tank.startDate) + ')' : '') : '') + '.');
  if (tank.dimensions) {
    const d = tank.dimensions;
    const f = (cm) => U.formatNumber(U.lengthToDisplay(cm, s), 0);
    L.push('Dimensions: ' + f(d.lengthCm) + ' x ' + f(d.widthCm) + ' x ' + f(d.heightCm) + ' ' + U.lengthLabel(s) + '.');
  }
  if (tank.cycling && tank.cycling.active) L.push('Currently cycling (since ' + tank.cycling.startedAt + ').');
  L.push('');

  const alive = data.livestock.filter((l) => l.tankId === tank.id && l.status === 'alive');
  L.push('LIVESTOCK (' + alive.reduce((a, b) => a + b.quantity, 0) + ' alive)');
  if (!alive.length) L.push('- none recorded');
  ['fish', 'coral', 'invert', 'plant', 'other'].forEach((cat) => {
    alive.filter((l) => l.category === cat).forEach((l) => {
      L.push('- ' + l.quantity + ' x ' + l.commonName + (l.scientificName ? ' (' + l.scientificName + ')' : '') + ' [' + cat + '], added ' + l.dateAdded + (l.qt && l.qt.inQt ? ', IN QUARANTINE' : ''));
    });
  });
  L.push('');

  const defs = tankDefs(tank);
  const latest = S.latestByParam(data.entries);
  L.push('LATEST PARAMETERS');
  if (!defs.length) L.push('- no parameters enabled');
  defs.forEach((def) => {
    const r = latest[def.id];
    const cfg = tank.params[def.id];
    if (!r) { L.push('- ' + def.name + ': not tested'); return; }
    const st = S.rangeStatus(def, cfg, r);
    L.push('- ' + def.name + ': ' + U.formatReading(def, r, s) + ' (' + D.formatDaysAgo(D.daysSince(r.takenAt, at)) + (r.bdl ? ', below kit detection limit' : '') + ')' +
      (st.level !== 'NONE' ? ' [' + st.level + '; target ' + S.formatRange(def, cfg, s) + ']' : ''));
  });
  const methods = Array.from(new Set(data.entries.map((e) => e.method).filter(Boolean)));
  if (methods.length) L.push('Test kits used: ' + methods.join(', ') + '.');
  L.push('');

  L.push('TRENDS (last 30 days)');
  let anyTrend = false;
  defs.filter((d) => d.kind !== 'choice').forEach((def) => {
    const series = S.seriesFor(data.entries, def.id).filter((p) => p.t >= since30);
    if (series.length < 2) return;
    anyTrend = true;
    const nums = series.filter((p) => !p.bdl).map((p) => U.toDisplay(def, p.value, s));
    const dp = U.displayDecimals(def, s);
    const first = U.formatReading(def, series[0], s, { unit: false });
    const last = U.formatReading(def, series[series.length - 1], s);
    L.push('- ' + def.name + ': ' + first + ' -> ' + last + ' over ' + series.length + ' tests' +
      (nums.length >= 2 ? ', range ' + U.formatNumber(Math.min.apply(null, nums), dp) + '-' + U.formatNumber(Math.max.apply(null, nums), dp) : '') +
      (S.swingsInSeries(series, tank.params[def.id] && tank.params[def.id].maxDelta).length ? ' (had swings above the alert threshold)' : ''));
  });
  if (!anyTrend) L.push('- not enough tests in the last 30 days');
  L.push('');

  L.push('RECENT CHANGES (last 30 days)');
  const changes = [];
  data.maintenance.filter((m) => m.tankId === tank.id && Date.parse(m.performedAt) >= since30).forEach((m) => {
    const pct = m.type === 'water_change' ? waterChangePercent(m.volumeL, tank) : null;
    changes.push([m.performedAt, maintenanceLabel(m) + (m.type === 'water_change' ? ' ' + U.formatVolume(m.volumeL, s) + (pct !== null ? ' (' + U.formatNumber(pct, 0) + '%)' : '') : '') + (m.note ? ' - ' + m.note : '')]);
  });
  data.dosing.filter((d) => d.tankId === tank.id && Date.parse(d.dosedAt) >= since30).forEach((d) => {
    changes.push([d.dosedAt, d.kind === 'daily' ? 'Daily dose of ' + d.product + ' set to ' + d.amount + ' ' + d.unit + '/day' : d.kind === 'stop' ? 'Stopped dosing ' + d.product : 'One-time dose: ' + d.amount + ' ' + d.unit + ' ' + d.product]);
  });
  data.livestock.forEach((l) => (l.history || []).forEach((x) => {
    const when = x.date ? D.localNoonIso(x.date) : x.at;
    if (!when || Date.parse(when) < since30) return;
    if ((x.type === 'added' || x.type === 'fragged_from') && (x.tankId || l.tankId) === tank.id && !l.splitFromId) changes.push([when, 'Added ' + (x.quantity || x.count || l.quantity) + ' x ' + l.commonName]);
    if (x.type === 'moved' && x.toTankId === tank.id) changes.push([when, 'Moved in ' + x.quantity + ' x ' + l.commonName]);
    if ((x.type === 'moved' || x.type === 'moved_out') && x.fromTankId === tank.id) changes.push([when, 'Moved out ' + x.quantity + ' x ' + l.commonName]);
    if (x.type === 'status' && l.tankId === tank.id && x.to !== 'alive') changes.push([when, (x.quantity || '') + ' x ' + l.commonName + ' ' + (STATUS_LABEL[x.to] || x.to) + (x.cause ? ' (suspected: ' + x.cause + ')' : '')]);
  }));
  data.treatments.filter((t) => t.tankId === tank.id && (Date.parse(D.localNoonIso(t.startDate)) >= since30 || !t.endDate)).forEach((t) => {
    changes.push([D.localNoonIso(t.startDate), 'Treatment: ' + t.medication + (t.dose ? ' (' + t.dose + ')' : '') + (t.endDate ? ', ended ' + t.endDate + ' - ' + t.outcome : ', ongoing')]);
  });
  changes.sort((a, b) => (a[0] < b[0] ? 1 : -1));
  if (!changes.length) L.push('- none logged');
  changes.slice(0, 30).forEach(([when, text]) => L.push('- ' + D.localDateString(new Date(when)) + ': ' + text));
  L.push('');

  L.push('MAINTENANCE ROUTINE');
  const sched = data.schedules.filter((x) => x.tankId === tank.id && x.active !== false);
  sched.forEach((x) => L.push('- ' + x.title + ' every ' + x.intervalDays + ' day(s)'));
  const wcs = data.maintenance.filter((m) => m.tankId === tank.id && m.type === 'water_change' && Date.parse(m.performedAt) >= at.getTime() - 90 * D.MS_PER_DAY);
  if (wcs.length) {
    const avgPct = wcs.reduce((a, m) => a + (waterChangePercent(m.volumeL, tank) || 0), 0) / wcs.length;
    L.push('- ' + wcs.length + ' water changes in the last 90 days, average ' + U.formatNumber(avgPct, 0) + '% (about every ' + U.formatNumber(90 / wcs.length, 0) + ' days)');
  } else if (!sched.length) {
    L.push('- no routine or water changes logged in the last 90 days');
  }
  const regimen = S.currentRegimen(data.dosing.filter((d) => d.tankId === tank.id));
  if (regimen.length) L.push('- Daily dosing: ' + regimen.map((r) => r.product + ' ' + r.amount + ' ' + r.unit + '/day').join(', '));
  L.push('');

  const eq = data.equipment.filter((e) => e.tankId === tank.id);
  if (eq.length) {
    L.push('EQUIPMENT');
    eq.forEach((e) => L.push('- ' + e.category.replace(/_/g, ' ') + ': ' + [e.brand, e.model].filter(Boolean).join(' ')));
    if (tank.lighting && tank.lighting.photoperiod && tank.lighting.photoperiod.length) {
      L.push('- Lighting: ' + tank.lighting.photoperiod.map((p) => (p.label ? p.label + ' ' : '') + p.start + '-' + p.end + (p.intensity !== null && p.intensity !== undefined ? ' at ' + p.intensity + '%' : '')).join(', '));
    }
    L.push('');
  }
  if (tank.notes) { L.push('NOTES'); L.push(tank.notes); L.push(''); }
  L.push('(Summary generated by AquaStar 5000 on ' + D.localDateString(at) + '.)');
  return L.join('\n');
}

/** Printable parameter report (DOM) for a date range. chartImage(def, cfg, series, from, to) -> data URL or null. */
export function printableReport(data, from, to, chartImage) {
  const s = settings();
  const { tank } = data;
  const inRange = (iso) => { const t = Date.parse(iso); return t >= from && t <= to; };
  const entries = data.entries.filter((e) => inRange(e.takenAt));
  const defs = tankDefs(tank).concat(Array.from(new Set(entries.flatMap((e) => e.readings.map((r) => r.parameterId)))).filter((id) => !tank.params[id] || !tank.params[id].enabled).map(defById).filter(Boolean));
  const sections = defs.map((def) => {
    const cfg = tank.params[def.id] || null;
    const series = S.seriesFor(entries, def.id);
    if (!series.length) return null;
    const nums = series.filter((p) => !p.bdl && typeof p.value === 'number').map((p) => U.toDisplay(def, p.value, s));
    const dp = U.displayDecimals(def, s);
    const stats = nums.length ? [
      ['Tests', String(series.length)],
      ['Lowest', U.formatNumber(Math.min.apply(null, nums), dp)],
      ['Highest', U.formatNumber(Math.max.apply(null, nums), dp)],
      ['Average', U.formatNumber(nums.reduce((a, b) => a + b, 0) / nums.length, dp)],
      ['Latest', U.formatReading(def, series[series.length - 1], s)],
      ['Ideal range', S.formatRange(def, cfg, s)]
    ] : [['Tests', String(series.length)], ['Latest', U.formatReading(def, series[series.length - 1], s)]];
    const img = def.kind !== 'choice' && chartImage ? chartImage(def, cfg, series, from, to) : null;
    return h('section', { class: 'print-section' },
      h('h2', null, def.name + ' (' + (U.unitLabel(def, s) || 'no unit') + ')'),
      h('table', { class: 'print-stats' }, h('tbody', null, stats.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v))))),
      img ? h('img', { src: img, alt: def.name + ' chart', class: 'print-chart' }) : null,
      h('table', { class: 'print-table' }, h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Value'), h('th', null, 'Status'))),
        h('tbody', null, series.slice(-60).reverse().map((p) => h('tr', null,
          h('td', null, D.formatDateTime(p.t)), h('td', null, U.formatReading(def, p, s)), h('td', null, S.rangeStatus(def, cfg, p).level.replace('NONE', '-')))))));
  }).filter(Boolean);
  const events = [];
  data.maintenance.filter((m) => m.tankId === tank.id && inRange(m.performedAt)).forEach((m) => events.push([m.performedAt, maintenanceLabel(m) + (m.volumeL ? ' ' + U.formatVolume(m.volumeL, s) : '')]));
  data.dosing.filter((d) => d.tankId === tank.id && inRange(d.dosedAt)).forEach((d) => events.push([d.dosedAt, d.product + ': ' + (d.kind === 'stop' ? 'stopped' : d.amount + ' ' + d.unit + (d.kind === 'daily' ? '/day' : ''))]));
  events.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return h('div', { class: 'print-report' },
    h('header', { class: 'print-header' },
      h('h1', null, 'AquaStar 5000 - Parameter report'),
      h('p', null, tank.name + ' - ' + typeLabel(tank.type) + ' / ' + styleLabel(tank.type, tank.style) + ' - ' + U.formatVolume(tank.totalVolumeL, s) + ' system'),
      h('p', null, 'Period: ' + D.formatDate(new Date(from)) + ' to ' + D.formatDate(new Date(to)) + ' - generated ' + D.formatDateTime(new Date()))),
    sections.length ? sections : h('p', null, 'No tests in this period.'),
    events.length ? h('section', { class: 'print-section' }, h('h2', null, 'Maintenance and dosing in this period'),
      h('table', { class: 'print-table' }, h('tbody', null, events.map(([t, x]) => h('tr', null, h('td', null, D.formatDateTime(t)), h('td', null, x)))))) : null);
}

