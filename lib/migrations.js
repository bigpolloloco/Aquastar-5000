'use strict';
/*
 * Schema versions and migrations.
 *
 *   0 -> files without a schemaVersion (hand-edited or pre-release data):
 *        bare arrays, records possibly missing id/createdAt/updatedAt.
 *   1 -> Phase 1 collections.
 *   2 -> Phase 2: livestock, treatments, schedules, equipment, journal,
 *        expenses; tank cycling/lighting fields; maintenance.scheduleId;
 *        tray / login / notification / backup settings.
 *
 * Each step receives the whole database ({collection: records[], settings: {}})
 * so a step can move data between collections. Steps must be pure and must
 * never drop records they do not understand.
 */
const crypto = require('crypto');

const CURRENT_SCHEMA_VERSION = 2;

const PHASE1_COLLECTIONS = ['tanks', 'parameters', 'entries', 'maintenance', 'dosing', 'photos'];
const PHASE2_COLLECTIONS = ['livestock', 'treatments', 'schedules', 'equipment', 'journal', 'expenses'];
const COLLECTIONS = PHASE1_COLLECTIONS.concat(PHASE2_COLLECTIONS);

const SETTINGS_DEFAULTS = {
  units: { temperature: 'F', volume: 'gal', salinity: 'sg', alkalinity: 'dkh', currency: 'USD' },
  lastTankId: null,
  dashboard: { rotateSeconds: 12, autoRotate: true },
  locale: null,
  keepInTray: false,
  startAtLogin: false,
  notifications: true,
  reagentWarnDays: 30,
  backups: { keep: 10, onClose: true, daily: true }
};

function withTimestamps(record, nowIso) {
  const r = Object.assign({}, record);
  if (typeof r.id !== 'string' || !r.id) r.id = crypto.randomUUID();
  if (typeof r.createdAt !== 'string') r.createdAt = nowIso;
  if (typeof r.updatedAt !== 'string') r.updatedAt = r.createdAt;
  return r;
}

function mergeSettingsDefaults(s, defaults) {
  const src = s && typeof s === 'object' ? s : {};
  const out = Object.assign({}, defaults, src);
  Object.keys(defaults).forEach((k) => {
    const d = defaults[k];
    if (d && typeof d === 'object' && !Array.isArray(d)) out[k] = Object.assign({}, d, src[k] && typeof src[k] === 'object' ? src[k] : {});
  });
  return out;
}

const steps = {
  1(db) {
    const now = new Date().toISOString();
    const out = Object.assign({}, db);
    PHASE1_COLLECTIONS.forEach((name) => {
      out[name] = (Array.isArray(db[name]) ? db[name] : []).map((r) => withTimestamps(r, now));
    });
    out.entries = out.entries.map((e) => Object.assign({}, e, {
      readings: Array.isArray(e.readings) ? e.readings.map((r) => Object.assign({ bdl: false }, r)) : []
    }));
    out.tanks = out.tanks.map((t) => Object.assign({ archived: false, params: {}, notes: '' }, t));
    const s = db.settings && typeof db.settings === 'object' ? db.settings : {};
    out.settings = Object.assign({}, s, {
      units: Object.assign({}, SETTINGS_DEFAULTS.units, s.units || {}),
      dashboard: Object.assign({}, SETTINGS_DEFAULTS.dashboard, s.dashboard || {})
    });
    if (out.settings.lastTankId === undefined) out.settings.lastTankId = null;
    return out;
  },

  2(db) {
    const now = new Date().toISOString();
    const out = Object.assign({}, db);
    PHASE2_COLLECTIONS.forEach((name) => {
      out[name] = (Array.isArray(db[name]) ? db[name] : []).map((r) => withTimestamps(r, now));
    });
    out.tanks = (db.tanks || []).map((t) => Object.assign({ cycling: null, lighting: null }, t));
    out.maintenance = (db.maintenance || []).map((m) => Object.assign({ equipmentId: null, scheduleId: null }, m));
    out.settings = mergeSettingsDefaults(db.settings, SETTINGS_DEFAULTS);
    return out;
  }
};

function migrate(db, fromVersion) {
  let current = db;
  for (let v = fromVersion + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
    if (!steps[v]) throw new Error('Missing migration step ' + v);
    current = steps[v](current);
  }
  return current;
}

module.exports = { CURRENT_SCHEMA_VERSION, COLLECTIONS, PHASE1_COLLECTIONS, PHASE2_COLLECTIONS, SETTINGS_DEFAULTS, migrate, steps };
