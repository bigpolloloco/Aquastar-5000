'use strict';
/*
 * Schema versions and migrations.
 *
 *   0 -> files without a schemaVersion (hand-edited or pre-release data):
 *        bare arrays, records possibly missing id/createdAt/updatedAt.
 *   1 -> Phase 1 collections.
 *
 * Each step receives the whole database ({collection: records[], settings: {}})
 * so a step can move data between collections. Steps must be pure and must
 * never drop records they do not understand.
 */
const crypto = require('crypto');

const CURRENT_SCHEMA_VERSION = 1;

const COLLECTIONS = ['tanks', 'parameters', 'entries', 'maintenance', 'dosing', 'photos'];

const SETTINGS_DEFAULTS = {
  units: { temperature: 'F', volume: 'gal', salinity: 'sg', alkalinity: 'dkh', currency: 'USD' },
  lastTankId: null,
  dashboard: { rotateSeconds: 12, autoRotate: true },
  locale: null
};

function withTimestamps(record, nowIso) {
  const r = Object.assign({}, record);
  if (typeof r.id !== 'string' || !r.id) r.id = crypto.randomUUID();
  if (typeof r.createdAt !== 'string') r.createdAt = nowIso;
  if (typeof r.updatedAt !== 'string') r.updatedAt = r.createdAt;
  return r;
}

const steps = {
  1(db) {
    const now = new Date().toISOString();
    const out = Object.assign({}, db);
    COLLECTIONS.forEach((name) => {
      out[name] = (Array.isArray(db[name]) ? db[name] : []).map((r) => withTimestamps(r, now));
    });
    out.entries = out.entries.map((e) => Object.assign({}, e, {
      readings: Array.isArray(e.readings) ? e.readings.map((r) => Object.assign({ bdl: false }, r)) : []
    }));
    out.tanks = out.tanks.map((t) => Object.assign({ archived: false, params: {}, notes: '' }, t));
    const s = db.settings && typeof db.settings === 'object' ? db.settings : {};
    out.settings = Object.assign({}, SETTINGS_DEFAULTS, s, {
      units: Object.assign({}, SETTINGS_DEFAULTS.units, s.units || {}),
      dashboard: Object.assign({}, SETTINGS_DEFAULTS.dashboard, s.dashboard || {})
    });
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

module.exports = { CURRENT_SCHEMA_VERSION, COLLECTIONS, SETTINGS_DEFAULTS, migrate, steps };
