'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/validate.js');
const Presets = require('../lib/presets.js');

const TANK_ID = '6f1c2b0e-8a1d-4c3e-9f2a-1b2c3d4e5f60';
const goodTank = () => ({
  name: 'Main Reef', type: 'reef', style: 'sps', displayVolumeL: 300, totalVolumeL: 400,
  dimensions: null, startDate: '2025-01-15', notes: 'hi', params: { alk: { enabled: true, min: 7.5, max: 9, maxDelta: 0.3, intervalDays: 1 } }
});
const goodEntry = () => ({ tankId: TANK_ID, takenAt: '2026-05-01T08:00:00.000Z', method: 'Hanna', note: '', readings: [{ parameterId: 'alk', value: 8.2 }] });

test('valid payloads pass and are normalized', () => {
  const t = V.tank(goodTank());
  assert.equal(t.name, 'Main Reef');
  assert.equal(t.archived, false);
  const e = V.entry(goodEntry());
  assert.equal(e.readings[0].bdl, false);
  assert.equal(e.takenAt, '2026-05-01T08:00:00.000Z');
});

test('unknown fields are stripped and prototype pollution is impossible', () => {
  const payload = JSON.parse('{"name":"X","type":"freshwater","style":"community","totalVolumeL":50,"isAdmin":true,"__proto__":{"polluted":1}}');
  const t = V.tank(payload);
  assert.equal(t.isAdmin, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(t), Object.prototype);
  assert.throws(() => V.tank(Object.assign(goodTank(), { params: JSON.parse('{"__proto__":{"enabled":true}}') })), V.ValidationError);
  assert.throws(() => V.tank(Object.assign(goodTank(), { params: { constructor: { enabled: true } } })), V.ValidationError);
});

test('wrong types, NaN, Infinity and negative numbers are rejected', () => {
  assert.throws(() => V.tank(Object.assign(goodTank(), { totalVolumeL: 'lots' })), /must be a number/);
  assert.throws(() => V.tank(Object.assign(goodTank(), { totalVolumeL: NaN })), /must be a number/);
  assert.throws(() => V.tank(Object.assign(goodTank(), { totalVolumeL: Infinity })), /must be a number/);
  assert.throws(() => V.tank(Object.assign(goodTank(), { totalVolumeL: -5 })), /greater than zero/);
  assert.throws(() => V.entry(Object.assign(goodEntry(), { readings: [{ parameterId: 'alk', value: -1 }] })), /negative/);
  assert.throws(() => V.entry(Object.assign(goodEntry(), { readings: [{ parameterId: 'alk', value: null }] })), V.ValidationError);
  assert.throws(() => V.entry(Object.assign(goodEntry(), { readings: [] })), /at least one/);
});

test('length limits and malicious strings', () => {
  assert.throws(() => V.tank(Object.assign(goodTank(), { name: 'x'.repeat(81) })), /at most 80/);
  assert.throws(() => V.tank(Object.assign(goodTank(), { name: 'x'.repeat(100000) })), /too long/);
  assert.throws(() => V.tank(Object.assign(goodTank(), { name: '   ' })), /required/);
  // Control characters are stripped, HTML is kept as plain text (rendered via textContent)
  const t = V.tank(Object.assign(goodTank(), { name: 'Reef\u0000\u0007<img src=x onerror=alert(1)>' }));
  assert.equal(t.name, 'Reef<img src=x onerror=alert(1)>'.slice(0, 80));
  assert.throws(() => V.entry(Object.assign(goodEntry(), { readings: new Array(101).fill({ parameterId: 'alk', value: 1 }) })), /too many/);
});

test('ids must be UUIDs; path traversal strings are rejected', () => {
  assert.throws(() => V.idPayload({ id: '../../etc/passwd' }), /valid id/);
  assert.throws(() => V.entry(Object.assign(goodEntry(), { tankId: '..\\..\\Windows' })), /valid id/);
  assert.throws(() => V.photoAdd({ tankId: TANK_ID, ownerType: 'tank', ownerId: 'C:\\x' }), /valid id/);
  assert.throws(() => V.photoAdd({ tankId: TANK_ID, ownerType: '../x' }), /allowed value/);
  assert.throws(() => V.paramIdPayload({ id: 'custom-../../x' }), /invalid format/);
  assert.deepEqual(V.idPayload({ id: TANK_ID.toUpperCase() }), { id: TANK_ID });
});

test('dates must be real ISO UTC timestamps / calendar dates', () => {
  assert.throws(() => V.entry(Object.assign(goodEntry(), { takenAt: '2026-05-01' })), /date and time/);
  assert.throws(() => V.entry(Object.assign(goodEntry(), { takenAt: 'yesterday' })), /date and time/);
  assert.throws(() => V.entry(Object.assign(goodEntry(), { takenAt: '1800-01-01T00:00:00Z' })), /out of range/);
  assert.throws(() => V.tank(Object.assign(goodTank(), { startDate: '2026-02-30' })), /YYYY-MM-DD/);
});

test('cross-field rules', () => {
  assert.throws(() => V.tank(Object.assign(goodTank(), { style: 'cichlid' })), /does not match/);
  assert.throws(() => V.tank(Object.assign(goodTank(), { displayVolumeL: 500 })), /at least the display volume/);
  assert.throws(() => V.tank(Object.assign(goodTank(), { params: { alk: { enabled: true, min: 10, max: 8 } } })), /minimum is above/);
  assert.throws(() => V.entry(Object.assign(goodEntry(), { readings: [{ parameterId: 'alk', value: 1 }, { parameterId: 'alk', value: 2 }] })), /repeats/);
  assert.throws(() => V.maintenance({ tankId: TANK_ID, performedAt: '2026-05-01T08:00:00Z', type: 'water_change' }), /required for a water change/);
  assert.throws(() => V.maintenance({ tankId: TANK_ID, performedAt: '2026-05-01T08:00:00Z', type: 'custom' }), /required for a custom/);
  assert.throws(() => V.dosing({ tankId: TANK_ID, dosedAt: '2026-05-01T08:00:00Z', product: 'Alk', amount: 0, unit: 'ml', kind: 'daily' }), /greater than zero/);
  const stop = V.dosing({ tankId: TANK_ID, dosedAt: '2026-05-01T08:00:00Z', product: 'Alk', amount: 5, unit: 'ml', kind: 'stop' });
  assert.equal(stop.amount, 0);
});

test('readings are checked against parameter definitions', () => {
  const defs = Presets.BUILTIN_PARAMS;
  V.readingsAgainstDefinitions([{ parameterId: 'ph', value: 8.1, bdl: false }], defs);
  assert.throws(() => V.readingsAgainstDefinitions([{ parameterId: 'ph', value: 15, bdl: false }], defs), /between 0.00 and 14.00/);
  assert.throws(() => V.readingsAgainstDefinitions([{ parameterId: 'salinity', value: 35, bdl: false }], defs), /Salinity must be between/);
  assert.throws(() => V.readingsAgainstDefinitions([{ parameterId: 'nope', value: 1, bdl: false }], defs), /unknown parameter/);
  assert.throws(() => V.readingsAgainstDefinitions([{ parameterId: 'co2dc', value: 'purple', bdl: false }], defs), /listed options/);
  V.readingsAgainstDefinitions([{ parameterId: 'co2dc', value: 'green', bdl: false }], defs);
});

test('settings patch is strict', () => {
  assert.deepEqual(V.settingsPatch({ units: { temperature: 'C' } }), { units: { temperature: 'C' } });
  assert.throws(() => V.settingsPatch({ units: { temperature: 'K' } }), /allowed value/);
  assert.throws(() => V.settingsPatch({ evil: true }), /not allowed/);
  assert.throws(() => V.settingsPatch('units'), /must be an object/);
  assert.throws(() => V.settingsPatch([]), /must be an object/);
});

test('custom parameter definitions', () => {
  const p = V.customParam({ name: 'Iodine', unit: 'ppm', decimals: 3, defaultMin: 0.04, defaultMax: 0.08 });
  assert.equal(p.hardMax, 1000000);
  assert.throws(() => V.customParam({ name: 'Alkalinity' }), /built-in/);
  assert.throws(() => V.customParam({ name: 'X', decimals: 9 }), /at most 4/);
});

test('log and CSV commit payloads', () => {
  assert.throws(() => V.logWrite({ level: 'DEBUG', message: 'x' }), /allowed value/);
  assert.throws(() => V.csvImportCommit({ token: 'zz', tankId: TANK_ID }), V.ValidationError);
});
