'use strict';
/*
 * Calculator tests. Every case here is a worked example from README.md
 * ("Calculators"), in both metric and US units.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/calc.js');
const U = require('../lib/units.js');

const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= (eps || 1e-6), 'expected ' + b + ', got ' + a);

test('Example 1 (metric): tank volume with sand and rock displacement', () => {
  const r = C.tankVolume({ lengthCm: 120, widthCm: 60, heightCm: 60, waterDepthCm: 55, substrateDepthCm: 5, rockKg: 20 });
  near(r.grossL, 432);
  near(r.waterL, 396);
  near(r.substrateL, 21.6);
  near(r.rockL, 8);
  near(r.netL, 366.4);
});

test('Example 1 (US): 48 x 24 x 24 in, water 22 in, 2 in sand, 44 lb rock', () => {
  const lbToKg = 0.45359237;
  const r = C.tankVolume({
    lengthCm: U.inchesToCm(48), widthCm: U.inchesToCm(24), heightCm: U.inchesToCm(24),
    waterDepthCm: U.inchesToCm(22), substrateDepthCm: U.inchesToCm(2), rockKg: 44 * lbToKg
  });
  near(U.litresToGallons(r.grossL), 119.69, 0.01);
  near(U.litresToGallons(r.waterL), 109.71, 0.01);
  near(U.litresToGallons(r.substrateL), 5.98, 0.01);
  near(U.litresToGallons(r.rockL), 2.11, 0.01);
  near(U.litresToGallons(r.netL), 101.62, 0.01);
});

test('Example 2: water change volume and expected nitrate reduction', () => {
  const m = C.waterChange({ systemL: 400, percent: 20, current: 20, newWater: 0 });
  near(m.volumeL, 80);
  near(m.after, 16);
  const twice = C.waterChange({ systemL: 400, percent: 20, current: 20, changes: 2 });
  near(twice.after, 12.8);
  const us = C.waterChange({ systemL: U.gallonsToLitres(100), percent: 25, current: 40, newWater: 2 });
  near(U.litresToGallons(us.volumeL), 25);
  near(us.after, 30.5);
  near(C.percentForTarget({ current: 40, target: 20 }), 50);
  near(C.percentForTarget({ current: 0.2, target: 0.05, newWater: 0 }), 75);
  assert.equal(C.percentForTarget({ current: 5, target: 10 }), 0);
});

test('Example 3: salt mix from the label rate', () => {
  near(C.saltMix({ volume: 20, rateAmount: 0.5, ratePerVolume: 1 }).amount, 10); // 0.5 cup per gal x 20 gal
  near(C.saltMix({ volume: 50, rateAmount: 38, ratePerVolume: 1 }).amount, 1900); // 38 g per L x 50 L
  near(C.saltMix({ volume: 75, rateAmount: 1, ratePerVolume: 25 }).amount, 3); // 1 kg per 25 L x 75 L
  assert.throws(() => C.saltMix({ volume: 10 }), /salt rate/);
});

test('Example 4: dose to raise alkalinity from current to target', () => {
  // Metric: label "10 ml raises 1 dKH in 100 L", 400 L system, 7.5 -> 8.5 dKH
  const m = C.dose({ current: 7.5, target: 8.5, systemL: 400, productAmount: 10, productRaise: 1, productPerL: 100 });
  near(m.amount, 40);
  // Spread so alkalinity rises at most 0.5 dKH per day
  const spread = C.dose({ current: 7.5, target: 8.5, systemL: 400, productAmount: 10, productRaise: 1, productPerL: 100, maxDailyRaise: 0.5 });
  assert.equal(spread.days, 2);
  near(spread.perDay, 20);
  // US: label "5 ml raises 1.4 dKH in 25 gal", 120 gal system, +1 dKH
  const us = C.dose({ current: 7.8, target: 8.8, systemL: U.gallonsToLitres(120), productAmount: 5, productRaise: 1.4, productPerL: U.gallonsToLitres(25) });
  near(us.amount, 17.142857, 1e-5);
  assert.equal(C.dose({ current: 9, target: 8, systemL: 100, productAmount: 1, productRaise: 1, productPerL: 1 }).amount, 0);
});

test('Example 5: daily consumption from test history and dosing', () => {
  const DAY = 86400000;
  const t0 = Date.parse('2026-01-01T09:00:00Z');
  // No dosing: 8.0 -> 7.4 dKH over 3 days => 0.2 dKH/day consumption
  const s1 = [8.0, 7.8, 7.6, 7.4].map((v, i) => ({ t: t0 + i * DAY, value: v }));
  const a = C.consumption({ series: s1, systemL: 400 });
  near(a.trendPerDay, -0.2);
  near(a.consumptionPerDay, 0.2);
  // Dosing 20 ml/day of "10 ml raises 1 dKH in 100 L" in 400 L (= +0.5 dKH/day)
  // while tests still drop 0.1 dKH/day => consumption 0.6 dKH/day, 24 ml/day holds steady
  const s2 = [8.0, 7.9, 7.8, 7.7].map((v, i) => ({ t: t0 + i * DAY, value: v }));
  const b = C.consumption({ series: s2, systemL: 400, dailyDose: 20, productAmount: 10, productRaise: 1, productPerL: 100 });
  near(b.doseRisePerDay, 0.5);
  near(b.consumptionPerDay, 0.6);
  near(b.holdSteadyDose, 24);
  assert.throws(() => C.consumption({ series: [{ t: t0, value: 8 }], systemL: 400 }), /at least two tests/);
});

test('Example 6: unit converter values', () => {
  near(U.cToF(25), 77);
  near(U.fToC(80), 26.6667, 1e-4);
  near(U.dkhToMeq(8.4), 3);
  near(U.dkhToPpm(8.4), 149.9232);
  near(U.pptToSg(35), 1.02637);
  near(U.gallonsToLitres(10), 37.85411784);
});

test('slope ignores series shorter than half a day', () => {
  const t0 = Date.now();
  assert.equal(C.slopePerDay([{ t: t0, value: 1 }, { t: t0 + 3600000, value: 2 }]), null);
});
