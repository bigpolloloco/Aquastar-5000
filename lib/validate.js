'use strict';
/*
 * Validation of every IPC payload arriving in the main process.
 *
 * Small combinator library: each validator is (value, path) => cleanValue and
 * throws ValidationError. Object validators build brand-new plain objects that
 * contain only the declared keys, so unknown fields, "__proto__" tricks and
 * oversized payloads never reach storage.
 */
const Presets = require('./presets.js');
const Dates = require('./dates.js');
const Units = require('./units.js');

class ValidationError extends Error {
  constructor(path, message) {
    super((path || 'payload') + ': ' + message);
    this.name = 'ValidationError';
    this.path = path;
    this.userMessage = humanize(path) + ' ' + message + '.';
  }
}

function humanize(path) {
  if (!path) return 'The request';
  const last = String(path).split('.').pop().replace(/\[\d+\]/g, '');
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const fail = (path, msg) => { throw new ValidationError(path, msg); };
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Wrap a validator with .optional(default) and .nullable(). */
function make(fn) {
  fn.optional = (def) => make((val, p) => {
    if (val === undefined || val === null) return typeof def === 'function' ? def() : def;
    return fn(val, p);
  });
  fn.nullable = () => fn.optional(null);
  return fn;
}

// Control characters other than tab/newline are stripped from text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function str(o) {
  const opts = Object.assign({ min: 0, max: 200, multiline: false }, o);
  return make((val, p) => {
    if (typeof val !== 'string') fail(p, 'must be text');
    if (val.length > opts.max * 4 + 16) fail(p, 'is too long');
    let s = val.replace(CONTROL_CHARS, '');
    if (!opts.multiline) s = s.replace(/[\r\n\t]+/g, ' ');
    else s = s.replace(/\r\n?/g, '\n');
    s = s.trim();
    if (s.length < opts.min) fail(p, opts.min === 1 ? 'is required' : 'must be at least ' + opts.min + ' characters');
    if (s.length > opts.max) fail(p, 'must be at most ' + opts.max + ' characters');
    if (opts.pattern && !opts.pattern.test(s)) fail(p, 'has an invalid format');
    return s;
  });
}

function num(o) {
  const opts = Object.assign({}, o);
  return make((val, p) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) fail(p, 'must be a number');
    if (opts.integer && !Number.isInteger(val)) fail(p, 'must be a whole number');
    if (opts.min !== undefined && val < opts.min) fail(p, opts.min === 0 ? 'cannot be negative' : 'must be at least ' + opts.min);
    if (opts.max !== undefined && val > opts.max) fail(p, 'must be at most ' + opts.max);
    if (opts.positive && val <= 0) fail(p, 'must be greater than zero');
    return val;
  });
}

const int = (o) => num(Object.assign({}, o, { integer: true }));

function bool() {
  return make((val, p) => {
    if (typeof val !== 'boolean') fail(p, 'must be true or false');
    return val;
  });
}

function oneOf(values) {
  return make((val, p) => {
    if (!values.includes(val)) fail(p, 'is not an allowed value');
    return val;
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid() {
  return make((val, p) => {
    if (typeof val !== 'string' || !UUID_RE.test(val)) fail(p, 'is not a valid id');
    return val.toLowerCase();
  });
}

const PARAM_ID_RE = /^(?:[a-z][a-z0-9]{0,23}|custom-[0-9a-f-]{36})$/;
function paramId() {
  return make((val, p) => {
    if (typeof val !== 'string' || !PARAM_ID_RE.test(val) || FORBIDDEN_KEYS.has(val)) fail(p, 'is not a valid parameter id');
    return val;
  });
}

function isoDateTime() {
  return make((val, p) => {
    if (!Dates.isIsoUtc(val)) fail(p, 'must be a date and time');
    const d = new Date(val);
    const y = d.getUTCFullYear();
    if (y < 1970 || y > 2200) fail(p, 'is out of range');
    return d.toISOString();
  });
}

function dateOnly() {
  return make((val, p) => {
    if (!Dates.isDateString(val)) fail(p, 'must be a date (YYYY-MM-DD)');
    const y = Number(val.slice(0, 4));
    if (y < 1970 || y > 2200) fail(p, 'is out of range');
    return val;
  });
}

function obj(shape, o) {
  const opts = Object.assign({ strict: false }, o);
  return make((val, p) => {
    if (!isPlainObject(val)) fail(p, 'must be an object');
    const keys = Object.keys(val);
    if (keys.length > Object.keys(shape).length + 20) fail(p, 'has too many fields');
    if (opts.strict) keys.forEach((k) => { if (!Object.prototype.hasOwnProperty.call(shape, k)) fail(p ? p + '.' + k : k, 'is not allowed'); });
    const out = {};
    Object.keys(shape).forEach((k) => {
      const v = shape[k](Object.prototype.hasOwnProperty.call(val, k) ? val[k] : undefined, p ? p + '.' + k : k);
      if (v !== undefined) out[k] = v;
    });
    return out;
  });
}

function arr(item, o) {
  const opts = Object.assign({ min: 0, max: 1000 }, o);
  return make((val, p) => {
    if (!Array.isArray(val)) fail(p, 'must be a list');
    if (val.length < opts.min) fail(p, opts.min === 1 ? 'needs at least one item' : 'needs at least ' + opts.min + ' items');
    if (val.length > opts.max) fail(p, 'has too many items');
    return val.map((v, i) => item(v, (p || '') + '[' + i + ']'));
  });
}

/** Map with validated dynamic keys. */
function dict(keyValidator, valueValidator, o) {
  const opts = Object.assign({ max: 200 }, o);
  return make((val, p) => {
    if (!isPlainObject(val)) fail(p, 'must be an object');
    const keys = Object.keys(val);
    if (keys.length > opts.max) fail(p, 'has too many entries');
    const out = {};
    keys.forEach((k) => {
      if (FORBIDDEN_KEYS.has(k)) fail(p, 'contains a forbidden key');
      const key = keyValidator(k, (p || '') + '.' + k);
      out[key] = valueValidator(val[k], (p || '') + '.' + k);
    });
    return out;
  });
}

const values = (list) => list.map((x) => (typeof x === 'object' ? x.value : x));

// ---------------------------------------------------------------------------
// Domain schemas
// ---------------------------------------------------------------------------

const MAX_VOLUME_L = 1000000;
const notes = (max) => str({ max: max || 5000, multiline: true }).optional('');

const tankParamConfig = obj({
  enabled: bool().optional(true),
  min: num({ min: 0, max: 1000000 }).nullable(),
  max: num({ min: 0, max: 1000000 }).nullable(),
  maxDelta: num({ min: 0, max: 1000000 }).nullable(),
  intervalDays: int({ min: 1, max: 365 }).nullable()
});

const tankShape = {
  id: uuid().optional(),
  name: str({ min: 1, max: 80 }),
  type: oneOf(Presets.TANK_TYPE_IDS),
  style: str({ min: 1, max: 40, pattern: /^[a-z0-9_-]+$/ }),
  displayVolumeL: num({ min: 0, max: MAX_VOLUME_L }).nullable(),
  totalVolumeL: num({ positive: true, max: MAX_VOLUME_L }),
  dimensions: obj({
    lengthCm: num({ positive: true, max: 10000 }),
    widthCm: num({ positive: true, max: 10000 }),
    heightCm: num({ positive: true, max: 10000 })
  }).nullable(),
  startDate: dateOnly().nullable(),
  notes: notes(),
  archived: bool().optional(false),
  params: dict(paramId(), tankParamConfig, { max: 120 }).optional(() => ({}))
};

function tank(val) {
  const t = obj(tankShape)(val, '');
  if (!Presets.TANK_TYPES[t.type].styles[t.style]) fail('style', 'does not match the tank type');
  if (typeof t.displayVolumeL === 'number' && t.displayVolumeL > t.totalVolumeL + 1e-9) {
    fail('totalVolumeL', 'must be at least the display volume (display + sump)');
  }
  Object.keys(t.params).forEach((id) => {
    const c = t.params[id];
    if (typeof c.min === 'number' && typeof c.max === 'number' && c.min > c.max) fail('params.' + id, 'minimum is above the maximum');
  });
  return t;
}

const customParamShape = {
  id: str({ max: 60, pattern: /^custom-[0-9a-f-]{36}$/ }).optional(),
  name: str({ min: 1, max: 40 }),
  unit: str({ max: 15 }).optional(''),
  decimals: int({ min: 0, max: 4 }).optional(2),
  hardMax: num({ positive: true, max: 1000000 }).optional(1000000),
  defaultMin: num({ min: 0, max: 1000000 }).nullable(),
  defaultMax: num({ min: 0, max: 1000000 }).nullable(),
  defaultMaxDelta: num({ min: 0, max: 1000000 }).nullable(),
  defaultIntervalDays: int({ min: 1, max: 365 }).nullable()
};

function customParam(val) {
  const p = obj(customParamShape)(val, '');
  if (typeof p.defaultMin === 'number' && typeof p.defaultMax === 'number' && p.defaultMin > p.defaultMax) {
    fail('defaultMin', 'is above the maximum');
  }
  const builtinNames = Presets.BUILTIN_PARAMS.map((b) => b.name.toLowerCase());
  if (builtinNames.includes(p.name.toLowerCase())) fail('name', 'is already a built-in parameter');
  return p;
}

const reading = make((val, p) => {
  if (!isPlainObject(val)) fail(p, 'must be an object');
  const parameterId = paramId()(val.parameterId, p + '.parameterId');
  const bdl = bool().optional(false)(val.bdl, p + '.bdl');
  let value;
  if (typeof val.value === 'number') value = num({ min: 0, max: 1000000 })(val.value, p + '.value');
  else if (typeof val.value === 'string') value = str({ min: 1, max: 40, pattern: /^[a-z0-9_-]+$/ })(val.value, p + '.value');
  else fail(p + '.value', 'must be a number');
  return { parameterId, value, bdl };
});

const entryShape = {
  id: uuid().optional(),
  tankId: uuid(),
  takenAt: isoDateTime(),
  method: str({ max: 60 }).optional(''),
  note: notes(2000),
  readings: arr(reading, { min: 1, max: 100 })
};

function entry(val) {
  const e = obj(entryShape)(val, '');
  const seen = new Set();
  e.readings.forEach((r, i) => {
    if (seen.has(r.parameterId)) fail('readings[' + i + ']', 'repeats a parameter');
    seen.add(r.parameterId);
  });
  return e;
}

/**
 * Check readings against the parameter definitions (physical limits, kind).
 * `defs` is built-in + custom definitions.
 */
function readingsAgainstDefinitions(readings, defs) {
  readings.forEach((r, i) => {
    const def = defs.find((d) => d.id === r.parameterId);
    const p = 'readings[' + i + ']';
    if (!def) fail(p, 'uses an unknown parameter');
    if (def.kind === 'choice') {
      if (typeof r.value !== 'string' || !def.options.some((o) => o.value === r.value)) fail(p, def.name + ' must be one of the listed options');
      if (r.bdl) fail(p, def.name + ' cannot be below detection');
      return;
    }
    if (typeof r.value !== 'number') fail(p, def.name + ' must be a number');
    const min = typeof def.hardMin === 'number' ? def.hardMin : 0;
    const max = typeof def.hardMax === 'number' ? def.hardMax : 1000000;
    if (r.value < min || r.value > max) {
      const settings = {};
      const lo = Units.formatNumber(Units.toDisplay(def, min, settings), Units.displayDecimals(def, settings));
      const hi = Units.formatNumber(Units.toDisplay(def, max, settings), Units.displayDecimals(def, settings));
      fail(p, def.name + ' must be between ' + lo + ' and ' + hi + ' ' + Units.unitLabel(def, settings));
    }
  });
}

const maintenanceShape = {
  id: uuid().optional(),
  tankId: uuid(),
  performedAt: isoDateTime(),
  type: oneOf(values(Presets.MAINTENANCE_TYPES)),
  customType: str({ max: 60 }).optional(''),
  media: oneOf(values(Presets.MEDIA_TYPES)).nullable(),
  mediaAction: oneOf(values(Presets.MEDIA_ACTIONS)).nullable(),
  volumeL: num({ min: 0, max: MAX_VOLUME_L }).nullable(),
  equipmentId: uuid().nullable(),
  note: notes(2000)
};

function maintenance(val) {
  const m = obj(maintenanceShape)(val, '');
  if (m.type === 'custom' && !m.customType) fail('customType', 'is required for a custom maintenance type');
  if (m.type === 'water_change' && !(m.volumeL > 0)) fail('volumeL', 'is required for a water change');
  if (m.type !== 'water_change') m.volumeL = null;
  if (m.type !== 'media') { m.media = null; m.mediaAction = null; }
  if (m.type !== 'custom') m.customType = '';
  return m;
}

const dosingShape = {
  id: uuid().optional(),
  tankId: uuid(),
  dosedAt: isoDateTime(),
  product: str({ min: 1, max: 80 }),
  category: oneOf(values(Presets.DOSING_CATEGORIES)).optional('other'),
  amount: num({ min: 0, max: 1000000 }),
  unit: oneOf(Presets.DOSE_UNITS),
  kind: oneOf(['once', 'daily', 'stop']),
  note: notes(2000)
};

function dosing(val) {
  const d = obj(dosingShape)(val, '');
  if (d.kind !== 'stop' && !(d.amount > 0)) fail('amount', 'must be greater than zero');
  if (d.kind === 'stop') d.amount = 0;
  return d;
}

const OWNER_TYPES = ['tank', 'entry', 'maintenance', 'livestock', 'journal', 'treatment', 'equipment'];

const photoAdd = obj({
  tankId: uuid(),
  ownerType: oneOf(OWNER_TYPES).optional('tank'),
  ownerId: uuid().nullable()
});

const photoUpdate = obj({
  id: uuid(),
  caption: str({ max: 200 }).optional(''),
  takenAt: isoDateTime().optional()
});

const settingsPatch = obj({
  units: obj({
    temperature: oneOf(['F', 'C']).optional(),
    volume: oneOf(['gal', 'L']).optional(),
    salinity: oneOf(['sg', 'ppt']).optional(),
    alkalinity: oneOf(['dkh', 'meq', 'ppm']).optional(),
    currency: oneOf(Units.CURRENCIES).optional()
  }).optional(),
  lastTankId: uuid().optional(),
  dashboard: obj({
    rotateSeconds: int({ min: 5, max: 120 }).optional(),
    autoRotate: bool().optional()
  }).optional()
}, { strict: true });

const idPayload = obj({ id: uuid() });
const listQuery = obj({
  tankId: uuid().optional(),
  from: isoDateTime().optional(),
  to: isoDateTime().optional(),
  includeArchived: bool().optional(false)
}).optional(() => ({}));
const tankListQuery = obj({ includeArchived: bool().optional(false) }).optional(() => ({ includeArchived: false }));
const photoListQuery = obj({
  tankId: uuid().optional(),
  ownerType: oneOf(OWNER_TYPES).optional(),
  ownerId: uuid().optional()
}).optional(() => ({}));
const tankDelete = obj({ id: uuid(), confirmName: str({ min: 1, max: 80 }) });
const paramIdPayload = obj({ id: str({ max: 60, pattern: /^custom-[0-9a-f-]{36}$/ }) });
const stabilityQuery = obj({ tankId: uuid(), parameterId: paramId() });
const eventsQuery = obj({ tankId: uuid(), from: isoDateTime().optional(), to: isoDateTime().optional() });
const logWrite = obj({ level: oneOf(['INFO', 'WARN', 'ERROR']), message: str({ min: 1, max: 2000, multiline: true }) });
const csvExport = obj({ kind: oneOf(['entries', 'maintenance', 'dosing']), tankId: uuid().optional() });
const token = obj({ token: str({ min: 32, max: 64, pattern: /^[a-f0-9]+$/ }) });
const DATE_FORMATS = ['iso', 'ymd', 'mdy', 'dmy'];
const csvImportCommit = obj({
  token: str({ min: 32, max: 64, pattern: /^[a-f0-9]+$/ }),
  tankId: uuid(),
  dateColumn: int({ min: 0, max: 499 }),
  timeColumn: int({ min: 0, max: 499 }).nullable(),
  dateFormat: oneOf(DATE_FORMATS),
  methodColumn: int({ min: 0, max: 499 }).nullable(),
  noteColumn: int({ min: 0, max: 499 }).nullable(),
  columns: arr(obj({
    index: int({ min: 0, max: 499 }),
    parameterId: paramId(),
    unit: oneOf(['canonical', 'F', 'C', 'sg', 'ppt', 'dkh', 'meq', 'ppm']).optional('canonical')
  }), { min: 1, max: 100 })
});
const storeName = (names) => obj({ name: oneOf(names) });

module.exports = {
  ValidationError, isPlainObject,
  str, num, int, bool, oneOf, uuid, paramId, isoDateTime, dateOnly, obj, arr, dict,
  tank, customParam, entry, readingsAgainstDefinitions, maintenance, dosing,
  photoAdd, photoUpdate, settingsPatch, idPayload, listQuery, tankListQuery, photoListQuery,
  tankDelete, paramIdPayload, stabilityQuery, eventsQuery, logWrite, csvExport, token,
  csvImportCommit, storeName, OWNER_TYPES, DATE_FORMATS, PARAM_ID_RE, UUID_RE
};
