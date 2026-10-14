/*
 * Aquarium calculators, shared by main and renderer (globalThis.AquaCalc).
 * All inputs are canonical (litres, cm, kg) unless stated; the UI converts
 * from the user's unit settings. Product strengths are never built in: the
 * user enters them from the label. Worked examples live in README.md and
 * test/calc.test.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AquaCalc = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // About 40 % of a sand/gravel bed is water-filled pore space, so only 60 %
  // of its bulk volume displaces water.
  const SUBSTRATE_SOLID_FRACTION = 0.6;
  // Solid density of aragonite / limestone rock (kg per litre of rock).
  const ROCK_DENSITY_KG_PER_L = 2.5;
  const DAY_MS = 86400000;

  const finite = (x) => typeof x === 'number' && Number.isFinite(x);
  function need(cond, msg) { if (!cond) throw new Error(msg); }

  /**
   * Tank volume from inside dimensions (cm) with displacement estimates.
   * waterDepthCm defaults to heightCm; substrateDepthCm and rockKg default to 0.
   */
  function tankVolume(o) {
    need(finite(o.lengthCm) && o.lengthCm > 0 && finite(o.widthCm) && o.widthCm > 0 && finite(o.heightCm) && o.heightCm > 0, 'Enter length, width and height.');
    const depth = finite(o.waterDepthCm) && o.waterDepthCm > 0 ? Math.min(o.waterDepthCm, o.heightCm) : o.heightCm;
    const sand = finite(o.substrateDepthCm) && o.substrateDepthCm > 0 ? Math.min(o.substrateDepthCm, depth) : 0;
    const rockKg = finite(o.rockKg) && o.rockKg > 0 ? o.rockKg : 0;
    const grossL = (o.lengthCm * o.widthCm * o.heightCm) / 1000;
    const waterL = (o.lengthCm * o.widthCm * depth) / 1000;
    const substrateL = (o.lengthCm * o.widthCm * sand * SUBSTRATE_SOLID_FRACTION) / 1000;
    const rockL = rockKg / ROCK_DENSITY_KG_PER_L;
    const netL = Math.max(0, waterL - substrateL - rockL);
    return { grossL, waterL, substrateL, rockL, netL };
  }

  /**
   * Water change: volume for a target percentage of the total system volume and
   * the expected concentration afterwards (complete mixing):
   *   after = new + (current - new) x (1 - p)^changes
   */
  function waterChange(o) {
    need(finite(o.systemL) && o.systemL > 0, 'Total system volume is required.');
    need(finite(o.percent) && o.percent > 0 && o.percent <= 100, 'Percentage must be between 0 and 100.');
    const p = o.percent / 100;
    const changes = finite(o.changes) && o.changes >= 1 ? Math.floor(o.changes) : 1;
    const newWater = finite(o.newWater) && o.newWater >= 0 ? o.newWater : 0;
    const res = { volumeL: o.systemL * p, changes };
    if (finite(o.current)) res.after = newWater + (o.current - newWater) * Math.pow(1 - p, changes);
    return res;
  }

  /** Percentage to change once to bring `current` down to `target` (complete mixing). */
  function percentForTarget(o) {
    const newWater = finite(o.newWater) && o.newWater >= 0 ? o.newWater : 0;
    need(finite(o.current) && finite(o.target), 'Enter current and target values.');
    need(o.target >= newWater, 'The target cannot be below the new water concentration.');
    if (o.target >= o.current) return 0;
    return (1 - (o.target - newWater) / (o.current - newWater)) * 100;
  }

  /** Salt for `volume` of new water from the label rate "rateAmount per ratePerVolume" (same volume unit). */
  function saltMix(o) {
    need(finite(o.volume) && o.volume > 0, 'Enter the volume of new water.');
    need(finite(o.rateAmount) && o.rateAmount > 0 && finite(o.ratePerVolume) && o.ratePerVolume > 0, 'Enter the salt rate from the label.');
    return { amount: o.volume * o.rateAmount / o.ratePerVolume };
  }

  /**
   * Dose to raise a parameter from current to target with a product whose
   * label says "productAmount raises productRaise units in productPerL litres".
   *   dose = (target - current) / productRaise x productAmount x systemL / productPerL
   * maxDailyRaise (optional) spreads the dose over several days.
   */
  function dose(o) {
    need(finite(o.systemL) && o.systemL > 0, 'Total system volume is required.');
    need(finite(o.current) && finite(o.target), 'Enter current and target values.');
    need(finite(o.productAmount) && o.productAmount > 0 && finite(o.productRaise) && o.productRaise > 0 && finite(o.productPerL) && o.productPerL > 0, 'Enter the product strength from the label.');
    const diff = o.target - o.current;
    if (diff <= 0) return { amount: 0, days: 0, perDay: 0, diff, note: 'Target is not above the current value; no dose needed.' };
    const amount = (diff / o.productRaise) * o.productAmount * (o.systemL / o.productPerL);
    let days = 1;
    if (finite(o.maxDailyRaise) && o.maxDailyRaise > 0) days = Math.max(1, Math.ceil(diff / o.maxDailyRaise - 1e-9));
    return { amount, days, perDay: amount / days, diff };
  }

  /** Least-squares slope (units per day) of [{t, value}] (t in ms). */
  function slopePerDay(series) {
    const pts = (series || []).filter((p) => finite(p.t) && finite(p.value));
    if (pts.length < 2) return null;
    const span = pts[pts.length - 1].t - pts[0].t;
    if (span < DAY_MS * 0.5) return null;
    const t0 = pts[0].t;
    const xs = pts.map((p) => (p.t - t0) / DAY_MS);
    const ys = pts.map((p) => p.value);
    const n = pts.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) * (xs[i] - mx); }
    return den === 0 ? null : num / den;
  }

  /**
   * Daily consumption of Alkalinity / Calcium / Magnesium:
   *   doseRise/day = dailyDose x productRaise / productAmount x productPerL / systemL
   *   consumption/day = doseRise/day - trend/day        (trend from test history)
   *   dose to hold steady = consumption/day / (rise per unit of product)
   * Without a daily dose, consumption is simply the falling trend.
   */
  function consumption(o) {
    need(finite(o.systemL) && o.systemL > 0, 'Total system volume is required.');
    const trend = slopePerDay(o.series);
    need(trend !== null, 'Need at least two tests spread over half a day or more.');
    const hasProduct = finite(o.productAmount) && o.productAmount > 0 && finite(o.productRaise) && o.productRaise > 0 && finite(o.productPerL) && o.productPerL > 0;
    const risePerUnit = hasProduct ? (o.productRaise / o.productAmount) * (o.productPerL / o.systemL) : null;
    const daily = finite(o.dailyDose) && o.dailyDose > 0 ? o.dailyDose : 0;
    if (daily > 0 && !hasProduct) {
      return { trendPerDay: trend, consumptionPerDay: null, holdSteadyDose: null, note: 'Enter the product strength to include the daily dose in the estimate.' };
    }
    const doseRisePerDay = daily > 0 ? daily * risePerUnit : 0;
    const consumptionPerDay = doseRisePerDay - trend;
    return {
      trendPerDay: trend,
      doseRisePerDay,
      consumptionPerDay,
      holdSteadyDose: risePerUnit ? Math.max(0, consumptionPerDay) / risePerUnit : null
    };
  }

  return {
    SUBSTRATE_SOLID_FRACTION, ROCK_DENSITY_KG_PER_L,
    tankVolume, waterChange, percentForTarget, saltMix, dose, slopePerDay, consumption
  };
});
