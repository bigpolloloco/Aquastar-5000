/*
 * Built-in parameter definitions, tank types and style presets.
 * Shared by main and renderer (globalThis.AquaPresets).
 *
 * All numbers are in canonical units (see lib/units.js). Presets are only
 * starting points: every range, swing threshold and test interval is copied
 * into the tank record and can be edited there.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AquaPresets = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // hardMin/hardMax are physical sanity limits used for validation, not ideals.
  // watchBand: how far outside the ideal range a value may be before WATCH becomes ALERT.
  const BUILTIN_PARAMS = [
    { id: 'temp', name: 'Temperature', unit: '°C', unitKind: 'temperature', decimals: 1, hardMin: 0, hardMax: 45, watchBand: 0.6 },
    { id: 'ph', name: 'pH', unit: '', decimals: 2, hardMin: 0, hardMax: 14, watchBand: 0.15 },
    { id: 'salinity', name: 'Salinity', unit: 'SG', unitKind: 'salinity', decimals: 3, hardMin: 1.0, hardMax: 1.04, watchBand: 0.001 },
    { id: 'alk', name: 'Alkalinity', unit: 'dKH', unitKind: 'alkalinity', decimals: 2, hardMin: 0, hardMax: 30, watchBand: 0.4 },
    { id: 'calcium', name: 'Calcium', unit: 'ppm', decimals: 0, hardMin: 0, hardMax: 1000, watchBand: 25 },
    { id: 'magnesium', name: 'Magnesium', unit: 'ppm', decimals: 0, hardMin: 0, hardMax: 3000, watchBand: 60 },
    { id: 'ammonia', name: 'Ammonia', unit: 'ppm', decimals: 2, hardMin: 0, hardMax: 20, watchBand: 0.1 },
    { id: 'nitrite', name: 'Nitrite', unit: 'ppm', decimals: 2, hardMin: 0, hardMax: 20, watchBand: 0.1 },
    { id: 'nitrate', name: 'Nitrate', unit: 'ppm', decimals: 1, hardMin: 0, hardMax: 500, watchBand: 3 },
    { id: 'phosphate', name: 'Phosphate', unit: 'ppm', decimals: 3, hardMin: 0, hardMax: 20, watchBand: 0.03 },
    { id: 'kh', name: 'KH', unit: 'dKH', unitKind: 'alkalinity', decimals: 1, hardMin: 0, hardMax: 50, watchBand: 1 },
    { id: 'gh', name: 'GH', unit: 'dGH', decimals: 1, hardMin: 0, hardMax: 60, watchBand: 1 },
    { id: 'tds', name: 'TDS', unit: 'ppm', decimals: 0, hardMin: 0, hardMax: 5000, watchBand: 20 },
    { id: 'co2', name: 'CO2', unit: 'ppm', decimals: 0, hardMin: 0, hardMax: 200, watchBand: 5 },
    {
      id: 'co2dc', name: 'CO2 drop checker', unit: '', kind: 'choice',
      options: [
        { value: 'blue', label: 'Blue (low CO2)', status: 'WATCH' },
        { value: 'green', label: 'Green (about 30 ppm)', status: 'OK' },
        { value: 'lime', label: 'Lime (high side)', status: 'WATCH' },
        { value: 'yellow', label: 'Yellow (too much CO2)', status: 'ALERT' }
      ]
    },
    { id: 'iron', name: 'Iron', unit: 'ppm', decimals: 2, hardMin: 0, hardMax: 10, watchBand: 0.05 },
    { id: 'potassium', name: 'Potassium', unit: 'ppm', decimals: 1, hardMin: 0, hardMax: 500, watchBand: 3 }
  ].map((p) => Object.freeze(Object.assign({ kind: 'number', builtin: true, unitKind: null }, p)));

  const BY_ID = Object.create(null);
  BUILTIN_PARAMS.forEach((p) => { BY_ID[p.id] = p; });

  const FRESH = ['temp', 'ph', 'ammonia', 'nitrite', 'nitrate', 'kh', 'gh'];
  const PLANTED = FRESH.concat(['tds', 'co2', 'co2dc', 'iron', 'potassium', 'phosphate']);
  const REEF = ['temp', 'salinity', 'ph', 'alk', 'calcium', 'magnesium', 'nitrate', 'phosphate', 'ammonia'];
  const BRACKISH = ['temp', 'salinity', 'ph', 'ammonia', 'nitrite', 'nitrate'];
  const QUARANTINE = ['temp', 'ph', 'ammonia', 'nitrite', 'nitrate', 'salinity'];

  // ranges: [min, max] (null = unbounded side). maxDelta: max change between
  // consecutive tests before a stability alert. interval: test every N days.
  const freshwaterCommon = {
    ranges: { temp: [24, 27], ph: [6.5, 7.8], ammonia: [null, 0], nitrite: [null, 0], nitrate: [null, 40], kh: [3, 8], gh: [4, 12] },
    maxDelta: { temp: 2, ph: 0.4 },
    interval: { temp: 7, ph: 14, ammonia: 14, nitrite: 14, nitrate: 7, kh: 30, gh: 30 }
  };

  const reefCommon = {
    maxDelta: { alk: 0.5, salinity: 0.002, ph: 0.3, temp: 1.5, calcium: 40, magnesium: 100 },
    interval: { temp: 7, salinity: 7, ph: 7, alk: 3, calcium: 7, magnesium: 14, nitrate: 7, phosphate: 7, ammonia: 30 }
  };

  const TANK_TYPES = {
    freshwater: {
      label: 'Freshwater', params: FRESH, marine: false,
      styles: {
        community: { label: 'Community', ...freshwaterCommon },
        cichlid: {
          label: 'Cichlid (African rift lake)',
          ranges: { temp: [24, 28], ph: [7.6, 8.6], ammonia: [null, 0], nitrite: [null, 0], nitrate: [null, 30], kh: [10, 18], gh: [10, 20] },
          maxDelta: { temp: 2, ph: 0.3 },
          interval: freshwaterCommon.interval
        },
        shrimp: {
          label: 'Shrimp',
          extra: ['tds'],
          ranges: { temp: [20, 25], ph: [6.5, 7.5], ammonia: [null, 0], nitrite: [null, 0], nitrate: [null, 20], kh: [1, 6], gh: [4, 8], tds: [150, 250] },
          maxDelta: { temp: 1.5, ph: 0.3, tds: 30 },
          interval: Object.assign({}, freshwaterCommon.interval, { tds: 7 })
        }
      }
    },
    planted: {
      label: 'Planted', params: PLANTED, marine: false,
      styles: {
        lowtech: {
          label: 'Low-tech (no CO2 injection)',
          disabled: ['co2', 'co2dc'],
          ranges: { temp: [22, 26], ph: [6.4, 7.6], ammonia: [null, 0], nitrite: [null, 0], nitrate: [5, 25], kh: [2, 8], gh: [4, 12], tds: [100, 300], iron: [0.05, 0.2], potassium: [5, 20], phosphate: [0.2, 1.5] },
          maxDelta: { temp: 2, ph: 0.5 },
          interval: Object.assign({}, freshwaterCommon.interval, { tds: 14, iron: 14, potassium: 14, phosphate: 14 })
        },
        hightech: {
          label: 'High-tech (CO2 injected)',
          ranges: { temp: [22, 26], ph: [6.2, 7.2], ammonia: [null, 0], nitrite: [null, 0], nitrate: [10, 30], kh: [2, 6], gh: [4, 10], tds: [100, 350], co2: [20, 35], iron: [0.1, 0.5], potassium: [10, 30], phosphate: [0.5, 2] },
          maxDelta: { temp: 2, ph: 1.2, co2: 15 },
          interval: Object.assign({}, freshwaterCommon.interval, { tds: 7, co2: 3, co2dc: 1, iron: 7, potassium: 7, phosphate: 7 })
        }
      }
    },
    reef: {
      label: 'Reef', params: REEF, marine: true,
      styles: {
        soft: {
          label: 'Soft coral',
          ranges: { temp: [24, 27], salinity: [1.024, 1.026], ph: [7.8, 8.4], alk: [7, 11], calcium: [380, 450], magnesium: [1250, 1400], nitrate: [2, 20], phosphate: [0.03, 0.2], ammonia: [null, 0] },
          ...reefCommon
        },
        lps: {
          label: 'LPS',
          ranges: { temp: [24, 27], salinity: [1.025, 1.026], ph: [7.9, 8.4], alk: [7.5, 10], calcium: [400, 450], magnesium: [1280, 1400], nitrate: [2, 15], phosphate: [0.03, 0.15], ammonia: [null, 0] },
          ...reefCommon
        },
        sps: {
          label: 'SPS',
          ranges: { temp: [24.5, 26.5], salinity: [1.025, 1.026], ph: [7.9, 8.4], alk: [7.5, 9], calcium: [410, 450], magnesium: [1300, 1450], nitrate: [1, 10], phosphate: [0.02, 0.08], ammonia: [null, 0] },
          maxDelta: Object.assign({}, reefCommon.maxDelta, { alk: 0.3, calcium: 30 }),
          interval: Object.assign({}, reefCommon.interval, { alk: 1, calcium: 3 })
        },
        mixed: {
          label: 'Mixed reef',
          ranges: { temp: [24, 27], salinity: [1.025, 1.026], ph: [7.9, 8.4], alk: [7.5, 10], calcium: [400, 450], magnesium: [1280, 1420], nitrate: [2, 15], phosphate: [0.03, 0.12], ammonia: [null, 0] },
          ...reefCommon
        }
      }
    },
    fowlr: {
      label: 'Fish-Only / FOWLR', params: REEF, marine: true,
      styles: {
        fishonly: {
          label: 'Fish only',
          disabled: ['calcium', 'magnesium'],
          ranges: { temp: [24, 27], salinity: [1.020, 1.025], ph: [7.8, 8.4], alk: [7, 11], calcium: [350, 450], magnesium: [1200, 1400], nitrate: [null, 40], phosphate: [null, 0.5], ammonia: [null, 0] },
          maxDelta: { salinity: 0.002, ph: 0.3, temp: 1.5 },
          interval: Object.assign({}, reefCommon.interval, { alk: 14, calcium: 30, magnesium: 30 })
        },
        fowlr: {
          label: 'Fish with live rock',
          ranges: { temp: [24, 27], salinity: [1.021, 1.025], ph: [7.8, 8.4], alk: [7, 11], calcium: [380, 450], magnesium: [1250, 1400], nitrate: [null, 30], phosphate: [null, 0.3], ammonia: [null, 0] },
          maxDelta: { salinity: 0.002, ph: 0.3, temp: 1.5 },
          interval: Object.assign({}, reefCommon.interval, { alk: 7, calcium: 14, magnesium: 30 })
        }
      }
    },
    brackish: {
      label: 'Brackish', params: BRACKISH, marine: true,
      styles: {
        low: {
          label: 'Low-end brackish (SG 1.002-1.008)',
          ranges: { temp: [24, 28], salinity: [1.002, 1.008], ph: [7.5, 8.4], ammonia: [null, 0], nitrite: [null, 0], nitrate: [null, 30] },
          maxDelta: { salinity: 0.002, temp: 2 },
          interval: { temp: 7, salinity: 7, ph: 14, ammonia: 14, nitrite: 14, nitrate: 7 }
        },
        high: {
          label: 'High-end brackish (SG 1.010-1.018)',
          ranges: { temp: [24, 28], salinity: [1.010, 1.018], ph: [7.8, 8.4], ammonia: [null, 0], nitrite: [null, 0], nitrate: [null, 30] },
          maxDelta: { salinity: 0.002, temp: 2 },
          interval: { temp: 7, salinity: 7, ph: 14, ammonia: 14, nitrite: 14, nitrate: 7 }
        }
      }
    },
    quarantine: {
      label: 'Quarantine / Hospital', params: QUARANTINE, marine: false,
      styles: {
        fresh: {
          label: 'Freshwater QT',
          disabled: ['salinity'],
          ranges: { temp: [24, 28], ph: [6.5, 7.8], ammonia: [null, 0], nitrite: [null, 0], nitrate: [null, 20] },
          maxDelta: { temp: 2, ph: 0.4 },
          interval: { temp: 2, ph: 7, ammonia: 2, nitrite: 2, nitrate: 7 }
        },
        marine: {
          label: 'Marine QT',
          marine: true,
          ranges: { temp: [24, 27], ph: [7.8, 8.4], ammonia: [null, 0], nitrite: [null, 0], nitrate: [null, 20], salinity: [1.020, 1.026] },
          maxDelta: { temp: 1.5, ph: 0.3, salinity: 0.002 },
          interval: { temp: 2, ph: 7, ammonia: 2, nitrite: 2, nitrate: 7, salinity: 3 }
        }
      }
    }
  };

  const TANK_TYPE_IDS = Object.keys(TANK_TYPES);

  const MAINTENANCE_TYPES = [
    { value: 'water_change', label: 'Water change', marker: 'WC' },
    { value: 'media', label: 'Filter / media clean or replace', marker: 'FLT' },
    { value: 'skimmer', label: 'Skimmer cleaning', marker: 'SKM' },
    { value: 'glass', label: 'Glass cleaning', marker: 'GLS' },
    { value: 'gravel_vac', label: 'Gravel vac', marker: 'VAC' },
    { value: 'pruning', label: 'Pruning / trimming', marker: 'TRM' },
    { value: 'top_off', label: 'Top-off', marker: 'ATO' },
    { value: 'salt_mix', label: 'Salt / water mixing', marker: 'MIX' },
    { value: 'equipment', label: 'Equipment change', marker: 'EQP' },
    { value: 'custom', label: 'Custom', marker: 'MNT' }
  ];
  const MEDIA_TYPES = [
    { value: 'sponge', label: 'Sponge' }, { value: 'floss', label: 'Floss / filter wool' },
    { value: 'carbon', label: 'Carbon' }, { value: 'gfo', label: 'GFO' },
    { value: 'purigen', label: 'Purigen' }, { value: 'ceramic', label: 'Ceramic / bio media' },
    { value: 'sock', label: 'Filter sock / roller' }, { value: 'other', label: 'Other' }
  ];
  const MEDIA_ACTIONS = [{ value: 'clean', label: 'Cleaned' }, { value: 'replace', label: 'Replaced' }];
  const DOSING_CATEGORIES = [
    { value: 'alk', label: '2-part: Alkalinity' }, { value: 'calcium', label: '2-part: Calcium' },
    { value: 'magnesium', label: 'Magnesium' }, { value: 'kalk', label: 'Kalkwasser' },
    { value: 'trace', label: 'Trace elements' }, { value: 'amino', label: 'Amino acids' },
    { value: 'aio', label: 'All-in-one fertilizer' }, { value: 'micros', label: 'Micros' },
    { value: 'macros', label: 'Macros' }, { value: 'roottabs', label: 'Root tabs' },
    { value: 'bacteria', label: 'Bacteria' }, { value: 'other', label: 'Other' }
  ];
  const DOSE_UNITS = ['ml', 'L', 'drops', 'g', 'mg', 'tsp', 'tbsp', 'caps', 'tabs', 'oz'];
  const TEST_METHODS = ['Hanna', 'Salifert', 'Red Sea', 'API', 'API strips', 'Tetra strips', 'Nyos', 'Fauna Marin', 'Seachem', 'Sera', 'JBL', 'Refractometer', 'Probe / controller', 'ICP lab'];

  function getParam(id, customs) {
    if (BY_ID[id]) return BY_ID[id];
    if (customs) return customs.find((c) => c.id === id) || null;
    return null;
  }

  function styleFor(type, style) {
    const t = TANK_TYPES[type];
    if (!t) return null;
    return t.styles[style] || t.styles[Object.keys(t.styles)[0]];
  }

  function isMarine(type, style) {
    const t = TANK_TYPES[type];
    if (!t) return false;
    const s = styleFor(type, style);
    return Boolean(s && s.marine !== undefined ? s.marine : t.marine);
  }

  /**
   * Build the per-tank parameter configuration from a type + style preset.
   * Returns { [paramId]: { enabled, min, max, maxDelta, intervalDays } }.
   */
  function buildTankParams(type, style) {
    const t = TANK_TYPES[type];
    if (!t) return {};
    const s = styleFor(type, style) || {};
    const ids = t.params.concat(s.extra || []);
    const out = {};
    ids.forEach((id) => {
      const r = (s.ranges && s.ranges[id]) || [null, null];
      out[id] = {
        enabled: !(s.disabled || []).includes(id),
        min: r[0],
        max: r[1],
        maxDelta: s.maxDelta && s.maxDelta[id] !== undefined ? s.maxDelta[id] : null,
        intervalDays: s.interval && s.interval[id] !== undefined ? s.interval[id] : null
      };
    });
    return out;
  }

  function styleOptions(type) {
    const t = TANK_TYPES[type];
    if (!t) return [];
    return Object.keys(t.styles).map((k) => ({ value: k, label: t.styles[k].label }));
  }

  function typeOptions() {
    return TANK_TYPE_IDS.map((k) => ({ value: k, label: TANK_TYPES[k].label }));
  }

  return {
    BUILTIN_PARAMS, TANK_TYPES, TANK_TYPE_IDS,
    MAINTENANCE_TYPES, MEDIA_TYPES, MEDIA_ACTIONS, DOSING_CATEGORIES, DOSE_UNITS, TEST_METHODS,
    getParam, styleFor, isMarine, buildTankParams, styleOptions, typeOptions
  };
});
