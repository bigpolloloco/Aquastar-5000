'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/stats.js');
const Presets = require('../lib/presets.js');

const H = 3600000;
const DAY = 24 * H;
const T0 = Date.parse('2026-05-01T08:00:00.000Z');
const entry = (t, readings) => ({ id: 'e' + t, takenAt: new Date(t).toISOString(), readings });
const alk = Presets.getParam('alk');
const ph = Presets.getParam('ph');
const nitrate = Presets.getParam('nitrate');
const phosphate = Presets.getParam('phosphate');

test('a large alkalinity swing between two tests is flagged', () => {
  const entries = [
    entry(T0, [{ parameterId: 'alk', value: 8.0, bdl: false }]),
    entry(T0 + 2 * DAY, [{ parameterId: 'alk', value: 9.4, bdl: false }])
  ];
  const cfg = { enabled: true, min: 7.5, max: 9, maxDelta: 0.5, intervalDays: 3 };
  const st = S.stability(entries, 'alk', alk, cfg, new Date(T0 + 2 * DAY + H));
  assert.equal(st.change.flagged, true);
  assert.ok(Math.abs(st.change.delta - 1.4) < 1e-9);
  assert.ok(Math.abs(st.change.perDay - 0.7) < 1e-9);
  assert.equal(st.change.hours, 48);
  assert.equal(st.range.level, 'WATCH'); // 9.4 is 0.4 above max, band 0.4
  const tank = { id: 't1', name: 'Reef', params: { alk: cfg } };
  const alerts = S.tankAlerts(tank, [alk], entries, { units: { alkalinity: 'dkh' } }, new Date(T0 + 2 * DAY + H));
  const swing = alerts.find((a) => a.kind === 'swing');
  assert.ok(swing, 'swing alert present');
  assert.equal(swing.level, 'ALERT');
  assert.match(swing.message, /\+1\.40 dKH in 2 days/);
  assert.match(swing.message, /limit 0\.50 dKH/);
});

test('tests hours apart are not scaled up to a per-day rate', () => {
  const entries = [
    entry(T0, [{ parameterId: 'ph', value: 7.9 }]),
    entry(T0 + 6 * H, [{ parameterId: 'ph', value: 8.3 }])
  ];
  const ch = S.lastChange(S.seriesFor(entries, 'ph'), { maxDelta: 0.3 });
  assert.equal(ch.perDay, null);
  assert.match(ch.perDayNote, /less than 24 h/);
  assert.equal(ch.flagged, true);
  assert.ok(Math.abs(ch.delta - 0.4) < 1e-9);
});

test('a long gap between tests is called out', () => {
  const entries = [
    entry(T0, [{ parameterId: 'alk', value: 8.0 }]),
    entry(T0 + 20 * DAY, [{ parameterId: 'alk', value: 8.2 }])
  ];
  const ch = S.lastChange(S.seriesFor(entries, 'alk'), { maxDelta: 0.5, intervalDays: 3 });
  assert.equal(ch.flagged, false);
  assert.match(ch.gapNote, /20 days between tests/);
});

test('below-detection readings are not used for change math', () => {
  const entries = [
    entry(T0, [{ parameterId: 'phosphate', value: 0.02, bdl: true }]),
    entry(T0 + DAY, [{ parameterId: 'phosphate', value: 0.1, bdl: false }])
  ];
  const ch = S.lastChange(S.seriesFor(entries, 'phosphate'), { maxDelta: 0.03 });
  assert.equal(ch.delta, null);
  assert.equal(ch.flagged, false);
});

test('range status: OK / WATCH / ALERT with one-sided ranges and below detection', () => {
  const cfg = { min: 2, max: 15 };
  assert.equal(S.rangeStatus(nitrate, cfg, { value: 10 }).level, 'OK');
  assert.equal(S.rangeStatus(nitrate, cfg, { value: 17 }).level, 'WATCH');
  assert.equal(S.rangeStatus(nitrate, cfg, { value: 25 }).level, 'ALERT');
  assert.equal(S.rangeStatus(nitrate, cfg, { value: 25 }).direction, 'high');
  assert.equal(S.rangeStatus(nitrate, { min: null, max: 40 }, { value: 0 }).level, 'OK');
  assert.equal(S.rangeStatus(nitrate, {}, { value: 10 }).level, 'NONE');
  // Below detection: "<0.2" when min is 5 means at least 4.8 low (beyond the 3 ppm band)
  const bdl = S.rangeStatus(nitrate, { min: 5, max: 15 }, { value: 0.2, bdl: true });
  assert.equal(bdl.level, 'ALERT');
  assert.equal(bdl.direction, 'low');
  // ...and within the band it is WATCH
  assert.equal(S.rangeStatus(nitrate, cfg, { value: 0.2, bdl: true }).level, 'WATCH');
  // A kit limit at or under the max is fine for a "max only" range
  assert.equal(S.rangeStatus(phosphate, { max: 0.1 }, { value: 0.02, bdl: true }).level, 'OK');
  // Ammonia 0 vs ND
  const amm = Presets.getParam('ammonia');
  assert.equal(S.rangeStatus(amm, { min: null, max: 0 }, { value: 0, bdl: true }).level, 'OK');
  assert.equal(S.rangeStatus(amm, { min: null, max: 0 }, { value: 0.25 }).level, 'ALERT');
  // Choice parameter (drop checker)
  assert.equal(S.rangeStatus(Presets.getParam('co2dc'), null, { value: 'yellow' }).level, 'ALERT');
});

test('overdue tests use local calendar days and test intervals', () => {
  const entries = [entry(T0, [{ parameterId: 'alk', value: 8 }])];
  const series = S.seriesFor(entries, 'alk');
  assert.equal(S.overdueStatus(series, { intervalDays: 3 }, new Date(T0 + 2 * DAY)).overdue, false);
  assert.equal(S.overdueStatus(series, { intervalDays: 3 }, new Date(T0 + 5 * DAY)).overdue, true);
  assert.equal(S.overdueStatus([], { intervalDays: 3 }, new Date()).overdue, true);
  assert.equal(S.overdueStatus(series, { intervalDays: null }, new Date(T0 + 100 * DAY)).overdue, false);
});

test('gap threshold breaks lines across unusually long gaps', () => {
  const series = [0, 1, 2, 3, 4, 60].map((d) => ({ t: T0 + d * DAY, value: 1 }));
  const gap = S.gapThreshold(series);
  assert.equal(gap, 7 * DAY);
  assert.ok(series[5].t - series[4].t > gap);
});

test('latestByParam and swingsInSeries', () => {
  const entries = [
    entry(T0, [{ parameterId: 'alk', value: 8 }, { parameterId: 'ph', value: 8.1 }]),
    entry(T0 + DAY, [{ parameterId: 'alk', value: 9 }]),
    entry(T0 + 2 * DAY, [{ parameterId: 'alk', value: 9.1 }])
  ];
  const latest = S.latestByParam(entries);
  assert.equal(latest.alk.value, 9.1);
  assert.equal(latest.ph.value, 8.1);
  const swings = S.swingsInSeries(S.seriesFor(entries, 'alk'), 0.5);
  assert.equal(swings.length, 1);
  assert.equal(swings[0].toT, T0 + DAY);
  void ph;
});

test('current dosing regimen uses the latest daily/stop record per product', () => {
  const doses = [
    { id: '1', product: 'Alk A', kind: 'daily', amount: 10, unit: 'ml', dosedAt: '2026-01-01T00:00:00.000Z' },
    { id: '2', product: 'alk a', kind: 'daily', amount: 12, unit: 'ml', dosedAt: '2026-02-01T00:00:00.000Z' },
    { id: '3', product: 'Calcium B', kind: 'daily', amount: 12, unit: 'ml', dosedAt: '2026-01-01T00:00:00.000Z' },
    { id: '4', product: 'Calcium B', kind: 'stop', amount: 0, unit: 'ml', dosedAt: '2026-03-01T00:00:00.000Z' },
    { id: '5', product: 'Iodine', kind: 'once', amount: 1, unit: 'drops', dosedAt: '2026-03-01T00:00:00.000Z' }
  ];
  const r = S.currentRegimen(doses);
  assert.equal(r.length, 1);
  assert.equal(r[0].amount, 12);
  assert.equal(r[0].id, '2');
});
