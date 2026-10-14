'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../lib/units.js');
const Presets = require('../lib/presets.js');

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps || 1e-9), (msg || '') + ' expected ' + b + ', got ' + a);
const def = (id) => Presets.getParam(id);

test('temperature conversions', () => {
  near(U.cToF(25), 77);
  near(U.fToC(77), 25);
  near(U.cToF(0), 32);
  near(U.fToC(U.cToF(26.4)), 26.4, 1e-12);
});

test('volume and length conversions', () => {
  near(U.gallonsToLitres(1), 3.785411784);
  near(U.litresToGallons(378.5411784), 100, 1e-9);
  near(U.inchesToCm(48), 121.92);
  near(U.cmToInches(2.54), 1);
});

test('salinity SG <-> ppt uses the 25 °C reference table', () => {
  near(U.sgToPpt(1.02637), 35, 1e-6);
  near(U.pptToSg(35), 1.02637, 1e-9);
  // interpolation between rows
  near(U.pptToSg(34.5), (1.02562 + 1.02637) / 2, 1e-9);
  // round trip
  near(U.sgToPpt(U.pptToSg(31.7)), 31.7, 1e-9);
  // natural seawater refractometer reading 1.026 is about 34.5 ppt
  near(U.sgToPpt(1.026), 34.52, 0.02);
});

test('alkalinity conversions', () => {
  near(U.dkhToMeq(2.8), 1);
  near(U.meqToDkh(3), 8.4);
  near(U.dkhToPpm(1), 17.848);
  near(U.ppmToDkh(142.784), 8, 1e-9);
});

test('display conversion follows settings and is reversible', () => {
  const settings = { units: { temperature: 'F', volume: 'gal', salinity: 'ppt', alkalinity: 'meq' } };
  near(U.toDisplay(def('temp'), 25, settings), 77);
  near(U.fromDisplay(def('temp'), 77, settings), 25);
  near(U.fromDisplay(def('salinity'), U.toDisplay(def('salinity'), 1.025, settings), settings), 1.025, 1e-12);
  near(U.toDisplay(def('alk'), 8.4, settings), 3);
  assert.equal(U.unitLabel(def('alk'), settings), 'meq/L');
  assert.equal(U.unitLabel(def('temp'), { units: { temperature: 'C' } }), '°C');
  assert.equal(U.isApproximate(def('salinity'), settings), true);
  assert.equal(U.isApproximate(def('salinity'), { units: { salinity: 'sg' } }), false);
  // Parameters without a unit kind pass through unchanged.
  near(U.toDisplay(def('nitrate'), 12.5, settings), 12.5);
});

test('delta conversions have no temperature offset', () => {
  const f = { units: { temperature: 'F' } };
  near(U.deltaToDisplay(def('temp'), 1, f), 1.8);
  near(U.deltaFromDisplay(def('temp'), 1.8, f), 1);
  near(U.deltaToDisplay(def('alk'), 2.8, { units: { alkalinity: 'meq' } }), 1);
  const ppt = { units: { salinity: 'ppt' } };
  near(U.deltaFromDisplay(def('salinity'), U.deltaToDisplay(def('salinity'), 0.002, ppt), ppt), 0.002, 1e-12);
});

test('formatReading handles below detection, choice and approximate values', () => {
  const s = { units: { temperature: 'C', salinity: 'ppt' } };
  assert.equal(U.formatReading(def('phosphate'), { value: 0.02, bdl: true }, s), '<0.020 ppm');
  assert.equal(U.formatReading(def('ammonia'), { value: 0, bdl: true }, s), 'ND ppm');
  assert.equal(U.formatReading(def('nitrate'), { value: 5, bdl: false }, s), '5.0 ppm');
  assert.equal(U.formatReading(def('co2dc'), { value: 'green' }, s), 'Green (about 30 ppm)');
  assert.ok(U.formatReading(def('salinity'), { value: 1.026, bdl: false }, s).startsWith('~34.5'));
  assert.equal(U.formatReading(def('temp'), { value: 25.04 }, s, { unit: false }), '25.0');
});

test('parseReadingInput accepts decimals and below-detection, rejects junk', () => {
  assert.deepEqual(U.parseReadingInput('8.3'), { value: 8.3, bdl: false });
  assert.deepEqual(U.parseReadingInput(' 8,3 '), { value: 8.3, bdl: false });
  assert.deepEqual(U.parseReadingInput('.5'), { value: 0.5, bdl: false });
  assert.deepEqual(U.parseReadingInput('<0.02'), { value: 0.02, bdl: true });
  assert.deepEqual(U.parseReadingInput('< 0.25'), { value: 0.25, bdl: true });
  assert.deepEqual(U.parseReadingInput('ND'), { value: 0, bdl: true });
  assert.deepEqual(U.parseReadingInput('<'), { value: 0, bdl: true });
  assert.deepEqual(U.parseReadingInput(''), { empty: true });
  assert.deepEqual(U.parseReadingInput('   '), { empty: true });
  assert.equal(U.parseReadingInput('-1').error, 'Cannot be negative');
  assert.ok(U.parseReadingInput('NaN').error);
  assert.ok(U.parseReadingInput('Infinity').error);
  assert.ok(U.parseReadingInput('1e5').error);
  assert.ok(U.parseReadingInput('8.3.1').error);
  assert.ok(U.parseReadingInput('abc').error);
});

test('formatMoney uses the configured currency', () => {
  const s = U.formatMoney(12.5, { units: { currency: 'EUR' } }, 'en-US');
  assert.ok(s.includes('12.50'));
  assert.ok(s.includes('€'));
});
