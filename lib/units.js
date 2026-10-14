/*
 * Unit conversion shared by the main process (CommonJS) and the sandboxed
 * renderer (loaded as a classic <script>, exposed as globalThis.AquaUnits).
 *
 * Canonical storage units:
 *   temperature °C, volume litres, length cm, salinity specific gravity (25/25),
 *   alkalinity / KH dKH, everything else in the parameter's own unit (ppm, dGH...).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AquaUnits = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LITRES_PER_US_GALLON = 3.785411784;
  const CM_PER_INCH = 2.54;
  const DKH_PER_MEQ = 2.8;
  const PPM_CACO3_PER_DKH = 17.848;

  // Seawater specific gravity (density relative to pure water, both at 25 °C)
  // versus practical salinity in ppt. Generated once from the UNESCO EOS-80
  // one-atmosphere equation of state at 25 °C. Conversions between SG and ppt
  // depend on temperature, so every converted value is labelled approximate.
  const SALINITY_TABLE_25C = [
    [0, 1.00000], [1, 1.00076], [2, 1.00151], [3, 1.00227], [4, 1.00302], [5, 1.00377],
    [6, 1.00452], [7, 1.00528], [8, 1.00603], [9, 1.00678], [10, 1.00753], [11, 1.00828],
    [12, 1.00903], [13, 1.00978], [14, 1.01054], [15, 1.01129], [16, 1.01204], [17, 1.01279],
    [18, 1.01354], [19, 1.01429], [20, 1.01505], [21, 1.01580], [22, 1.01655], [23, 1.01731],
    [24, 1.01806], [25, 1.01881], [26, 1.01957], [27, 1.02032], [28, 1.02108], [29, 1.02183],
    [30, 1.02259], [31, 1.02334], [32, 1.02410], [33, 1.02486], [34, 1.02562], [35, 1.02637],
    [36, 1.02713], [37, 1.02789], [38, 1.02865], [39, 1.02941], [40, 1.03017], [41, 1.03093],
    [42, 1.03169], [43, 1.03245], [44, 1.03321], [45, 1.03398], [46, 1.03474], [47, 1.03550],
    [48, 1.03627], [49, 1.03703], [50, 1.03780]
  ];

  const UNIT_OPTIONS = {
    temperature: [{ value: 'F', label: '°F' }, { value: 'C', label: '°C' }],
    volume: [{ value: 'gal', label: 'US gallons' }, { value: 'L', label: 'Litres' }],
    salinity: [{ value: 'sg', label: 'Specific gravity' }, { value: 'ppt', label: 'ppt (approx.)' }],
    alkalinity: [{ value: 'dkh', label: 'dKH' }, { value: 'meq', label: 'meq/L' }, { value: 'ppm', label: 'ppm CaCO3' }]
  };

  const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'BRL', 'MXN', 'INR', 'ZAR', 'SGD', 'HKD', 'CNY', 'KRW'];

  const DEFAULT_UNITS = Object.freeze({ temperature: 'F', volume: 'gal', salinity: 'sg', alkalinity: 'dkh', currency: 'USD' });

  function interpolate(table, x, fromIdx, toIdx) {
    const first = table[0];
    const last = table[table.length - 1];
    if (x <= first[fromIdx]) {
      const next = table[1];
      const slope = (next[toIdx] - first[toIdx]) / (next[fromIdx] - first[fromIdx]);
      return first[toIdx] + (x - first[fromIdx]) * slope;
    }
    if (x >= last[fromIdx]) {
      const prev = table[table.length - 2];
      const slope = (last[toIdx] - prev[toIdx]) / (last[fromIdx] - prev[fromIdx]);
      return last[toIdx] + (x - last[fromIdx]) * slope;
    }
    for (let i = 1; i < table.length; i++) {
      const a = table[i - 1];
      const b = table[i];
      if (x <= b[fromIdx]) {
        const f = (x - a[fromIdx]) / (b[fromIdx] - a[fromIdx]);
        return a[toIdx] + f * (b[toIdx] - a[toIdx]);
      }
    }
    return last[toIdx];
  }

  const cToF = (c) => c * 9 / 5 + 32;
  const fToC = (f) => (f - 32) * 5 / 9;
  const litresToGallons = (l) => l / LITRES_PER_US_GALLON;
  const gallonsToLitres = (g) => g * LITRES_PER_US_GALLON;
  const cmToInches = (cm) => cm / CM_PER_INCH;
  const inchesToCm = (inch) => inch * CM_PER_INCH;
  const sgToPpt = (sg) => interpolate(SALINITY_TABLE_25C, sg, 1, 0);
  const pptToSg = (ppt) => interpolate(SALINITY_TABLE_25C, ppt, 0, 1);
  const dkhToMeq = (dkh) => dkh / DKH_PER_MEQ;
  const meqToDkh = (meq) => meq * DKH_PER_MEQ;
  const dkhToPpm = (dkh) => dkh * PPM_CACO3_PER_DKH;
  const ppmToDkh = (ppm) => ppm / PPM_CACO3_PER_DKH;

  function units(settings) {
    const u = (settings && settings.units) || settings || {};
    return {
      temperature: u.temperature === 'C' ? 'C' : 'F',
      volume: u.volume === 'L' ? 'L' : 'gal',
      salinity: u.salinity === 'ppt' ? 'ppt' : 'sg',
      alkalinity: ['meq', 'ppm'].includes(u.alkalinity) ? u.alkalinity : 'dkh',
      currency: CURRENCIES.includes(u.currency) ? u.currency : 'USD'
    };
  }

  /** Unit label shown next to a parameter value. */
  function unitLabel(def, settings) {
    const u = units(settings);
    switch (def.unitKind) {
      case 'temperature': return u.temperature === 'C' ? '°C' : '°F';
      case 'salinity': return u.salinity === 'ppt' ? 'ppt' : 'SG';
      case 'alkalinity': return u.alkalinity === 'meq' ? 'meq/L' : u.alkalinity === 'ppm' ? 'ppm' : (def.unit || 'dKH');
      default: return def.unit || '';
    }
  }

  function displayDecimals(def, settings) {
    const u = units(settings);
    switch (def.unitKind) {
      case 'temperature': return 1;
      case 'salinity': return u.salinity === 'ppt' ? 1 : 3;
      case 'alkalinity': return u.alkalinity === 'ppm' ? 0 : u.alkalinity === 'meq' ? 2 : (def.decimals ?? 1);
      default: return def.decimals ?? 2;
    }
  }

  /** True when the displayed value is derived from an approximate conversion. */
  function isApproximate(def, settings) {
    return def.unitKind === 'salinity' && units(settings).salinity === 'ppt';
  }

  function toDisplay(def, canonical, settings) {
    if (typeof canonical !== 'number' || !Number.isFinite(canonical)) return canonical;
    const u = units(settings);
    switch (def.unitKind) {
      case 'temperature': return u.temperature === 'F' ? cToF(canonical) : canonical;
      case 'salinity': return u.salinity === 'ppt' ? sgToPpt(canonical) : canonical;
      case 'alkalinity':
        if (u.alkalinity === 'meq') return dkhToMeq(canonical);
        if (u.alkalinity === 'ppm') return dkhToPpm(canonical);
        return canonical;
      default: return canonical;
    }
  }

  function fromDisplay(def, display, settings) {
    if (typeof display !== 'number' || !Number.isFinite(display)) return display;
    const u = units(settings);
    switch (def.unitKind) {
      case 'temperature': return u.temperature === 'F' ? fToC(display) : display;
      case 'salinity': return u.salinity === 'ppt' ? pptToSg(display) : display;
      case 'alkalinity':
        if (u.alkalinity === 'meq') return meqToDkh(display);
        if (u.alkalinity === 'ppm') return ppmToDkh(display);
        return display;
      default: return display;
    }
  }

  /**
   * Convert a difference (a swing threshold, a change between tests) rather than
   * an absolute value. Temperature differences have no 32° offset; salinity
   * differences use the local slope of the 25 °C table around natural seawater.
   */
  function deltaToDisplay(def, delta, settings) {
    if (typeof delta !== 'number' || !Number.isFinite(delta)) return delta;
    const u = units(settings);
    switch (def.unitKind) {
      case 'temperature': return u.temperature === 'F' ? delta * 9 / 5 : delta;
      case 'salinity': return u.salinity === 'ppt' ? delta * salinitySlope() : delta;
      case 'alkalinity':
        if (u.alkalinity === 'meq') return delta / DKH_PER_MEQ;
        if (u.alkalinity === 'ppm') return delta * PPM_CACO3_PER_DKH;
        return delta;
      default: return delta;
    }
  }

  function deltaFromDisplay(def, delta, settings) {
    if (typeof delta !== 'number' || !Number.isFinite(delta)) return delta;
    const u = units(settings);
    switch (def.unitKind) {
      case 'temperature': return u.temperature === 'F' ? delta * 5 / 9 : delta;
      case 'salinity': return u.salinity === 'ppt' ? delta / salinitySlope() : delta;
      case 'alkalinity':
        if (u.alkalinity === 'meq') return delta * DKH_PER_MEQ;
        if (u.alkalinity === 'ppm') return delta / PPM_CACO3_PER_DKH;
        return delta;
      default: return delta;
    }
  }

  // ppt per SG unit around 35 ppt (from the table rows 34 and 36).
  function salinitySlope() {
    return (36 - 34) / (1.02713 - 1.02562);
  }

  function round(value, decimals) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return value;
    const f = Math.pow(10, decimals);
    return Math.round(value * f) / f;
  }

  function formatNumber(value, decimals) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
    return round(value, decimals).toFixed(decimals);
  }

  /**
   * Human readable reading: handles "below detection" (<limit or ND), choice
   * parameters (drop checker) and approximate conversions.
   */
  function formatReading(def, reading, settings, opts) {
    const withUnit = !opts || opts.unit !== false;
    if (!reading) return '--';
    if (def.kind === 'choice') {
      const opt = (def.options || []).find((o) => o.value === reading.value);
      return opt ? opt.label : String(reading.value);
    }
    const unit = withUnit ? unitLabel(def, settings) : '';
    const decimals = displayDecimals(def, settings);
    let text;
    if (reading.bdl) {
      text = reading.value > 0 ? '<' + formatNumber(toDisplay(def, reading.value, settings), decimals) : 'ND';
    } else {
      text = formatNumber(toDisplay(def, reading.value, settings), decimals);
    }
    if (isApproximate(def, settings)) text = '~' + text;
    return unit ? text + ' ' + unit : text;
  }

  function volumeToDisplay(litres, settings) {
    if (typeof litres !== 'number' || !Number.isFinite(litres)) return litres;
    return units(settings).volume === 'gal' ? litresToGallons(litres) : litres;
  }
  function volumeFromDisplay(value, settings) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return value;
    return units(settings).volume === 'gal' ? gallonsToLitres(value) : value;
  }
  function volumeLabel(settings) {
    return units(settings).volume === 'gal' ? 'gal' : 'L';
  }
  function formatVolume(litres, settings) {
    if (typeof litres !== 'number' || !Number.isFinite(litres)) return '--';
    return formatNumber(volumeToDisplay(litres, settings), 1) + ' ' + volumeLabel(settings);
  }
  // Length follows the volume system: gallons -> inches, litres -> cm.
  function lengthToDisplay(cm, settings) {
    if (typeof cm !== 'number' || !Number.isFinite(cm)) return cm;
    return units(settings).volume === 'gal' ? cmToInches(cm) : cm;
  }
  function lengthFromDisplay(value, settings) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return value;
    return units(settings).volume === 'gal' ? inchesToCm(value) : value;
  }
  function lengthLabel(settings) {
    return units(settings).volume === 'gal' ? 'in' : 'cm';
  }
  function temperatureLabel(settings) {
    return units(settings).temperature === 'C' ? '°C' : '°F';
  }

  function formatMoney(amount, settings, locale) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return '--';
    const currency = units(settings).currency;
    try {
      return new Intl.NumberFormat(locale || undefined, { style: 'currency', currency }).format(amount);
    } catch (e) {
      return currency + ' ' + amount.toFixed(2);
    }
  }

  /**
   * Parse a user typed reading. Accepts decimals with "." or ",", and a leading
   * "<" for below detection ("<0.02", or just "<" / "ND" for "not detected").
   * Returns {empty:true} | {error} | {value, bdl}.
   */
  function parseReadingInput(text) {
    if (text === undefined || text === null) return { empty: true };
    let s = String(text).trim();
    if (s === '') return { empty: true };
    let bdl = false;
    if (/^nd$/i.test(s) || s === '<') return { value: 0, bdl: true };
    if (s[0] === '<') { bdl = true; s = s.slice(1).trim(); }
    s = s.replace(',', '.');
    if (/^-\s*\d/.test(s)) return { error: 'Cannot be negative' };
    if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return { error: 'Not a number' };
    const value = Number(s);
    if (!Number.isFinite(value)) return { error: 'Not a number' };
    if (value < 0) return { error: 'Cannot be negative' };
    return { value, bdl };
  }

  return {
    LITRES_PER_US_GALLON, CM_PER_INCH, DKH_PER_MEQ, PPM_CACO3_PER_DKH,
    SALINITY_TABLE_25C, UNIT_OPTIONS, CURRENCIES, DEFAULT_UNITS,
    cToF, fToC, litresToGallons, gallonsToLitres, cmToInches, inchesToCm,
    sgToPpt, pptToSg, dkhToMeq, meqToDkh, dkhToPpm, ppmToDkh,
    units, unitLabel, displayDecimals, isApproximate, toDisplay, fromDisplay,
    deltaToDisplay, deltaFromDisplay, round, formatNumber, formatReading,
    volumeToDisplay, volumeFromDisplay, volumeLabel, formatVolume,
    lengthToDisplay, lengthFromDisplay, lengthLabel, temperatureLabel,
    formatMoney, parseReadingInput
  };
});
