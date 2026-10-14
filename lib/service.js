'use strict';
/*
 * Data operations behind the IPC handlers. Pure Node (no Electron imports) so
 * everything here is unit-testable. Every function receives already
 * schema-validated payloads from main.js and enforces cross-record rules
 * (the tank exists, readings fit their parameter, typed delete confirmation...).
 */
const fsp = require('fs').promises;
const path = require('path');
const Presets = require('./presets.js');
const Stats = require('./stats.js');
const Units = require('./units.js');
const Dates = require('./dates.js');
const V = require('./validate.js');
const { SETTINGS_DEFAULTS } = require('./migrations.js');
const { PHOTO_FILE_RE, resolveInside } = require('./photos.js');
const { parseDateCell } = require('./csv.js');

class ServiceError extends Error {
  constructor(message, userMessage) {
    super(message);
    this.name = 'ServiceError';
    this.userMessage = userMessage || message;
  }
}

const CUSTOM_PREFIX = 'custom-';

function byDateDesc(field) {
  return (a, b) => (a[field] < b[field] ? 1 : a[field] > b[field] ? -1 : 0);
}

function inRange(iso, from, to) {
  if (from && iso < from) return false;
  if (to && iso > to) return false;
  return true;
}

function mergeSettings(stored) {
  const s = stored || {};
  const out = Object.assign({}, SETTINGS_DEFAULTS, s);
  Object.keys(SETTINGS_DEFAULTS).forEach((k) => {
    const def = SETTINGS_DEFAULTS[k];
    if (def && typeof def === 'object' && !Array.isArray(def)) out[k] = Object.assign({}, def, s[k] || {});
  });
  return out;
}

function createService(ctx) {
  const { storage, photosRoot } = ctx;
  const logger = ctx.logger || { info() {}, warn() {}, error() {} };
  const extraEventSources = [];
  const tankCascade = [];

  // --------------------------------------------------------------- settings
  function getSettings() {
    return mergeSettings(storage.getObject('settings'));
  }

  async function saveSettings(patch) {
    const current = getSettings();
    const next = Object.assign({}, current);
    Object.keys(patch).forEach((k) => {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) next[k] = Object.assign({}, current[k] || {}, v);
      else next[k] = v;
    });
    if (patch.lastTankId && !storage.get('tanks', patch.lastTankId)) next.lastTankId = null;
    await storage.setObject('settings', next);
    return next;
  }

  // ------------------------------------------------------------- parameters
  function customToDef(rec) {
    return {
      id: CUSTOM_PREFIX + rec.id,
      recordId: rec.id,
      name: rec.name,
      unit: rec.unit || '',
      unitKind: null,
      kind: 'number',
      decimals: rec.decimals,
      hardMin: 0,
      hardMax: rec.hardMax || 1000000,
      watchBand: null,
      custom: true,
      builtin: false,
      defaultMin: rec.defaultMin,
      defaultMax: rec.defaultMax,
      defaultMaxDelta: rec.defaultMaxDelta,
      defaultIntervalDays: rec.defaultIntervalDays
    };
  }

  function paramDefs() {
    return Presets.BUILTIN_PARAMS.concat(storage.list('parameters').map(customToDef));
  }

  async function saveCustomParam(payload) {
    const p = V.customParam(payload);
    const record = Object.assign({}, p);
    if (p.id) record.id = p.id.slice(CUSTOM_PREFIX.length);
    const dup = storage.list('parameters').find((x) => x.name.toLowerCase() === p.name.toLowerCase() && x.id !== record.id);
    if (dup) throw new ServiceError('duplicate parameter', 'A custom parameter with that name already exists.');
    const saved = await storage.save('parameters', record);
    return customToDef(saved);
  }

  async function deleteCustomParam({ id }) {
    const recordId = id.slice(CUSTOM_PREFIX.length);
    if (!storage.get('parameters', recordId)) throw new ServiceError('not found', 'That parameter no longer exists.');
    const used = storage.list('entries').filter((e) => e.readings.some((r) => r.parameterId === id)).length;
    if (used) {
      throw new ServiceError('parameter in use', 'This parameter is used by ' + used + ' logged test' + (used === 1 ? '' : 's') + '. Delete or edit those first, or simply disable it on the tank.');
    }
    await storage.updateWhere('tanks', (t) => {
      if (!t.params || !t.params[id]) return null;
      const params = Object.assign({}, t.params);
      delete params[id];
      return Object.assign({}, t, { params });
    });
    await storage.remove('parameters', recordId);
    return { ok: true };
  }

  // ------------------------------------------------------------------ tanks
  function requireTank(id) {
    const t = storage.get('tanks', id);
    if (!t) throw new ServiceError('tank not found', 'That tank no longer exists.');
    return t;
  }

  function listTanks({ includeArchived }) {
    return storage.list('tanks')
      .filter((t) => includeArchived || !t.archived)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function saveTank(payload) {
    const t = V.tank(payload);
    const defs = paramDefs();
    const known = new Set(defs.map((d) => d.id));
    let params = t.params;
    if (!Object.keys(params).length) params = Presets.buildTankParams(t.type, t.style);
    const cleaned = {};
    Object.keys(params).forEach((id) => { if (known.has(id)) cleaned[id] = params[id]; });
    const existing = t.id ? requireTank(t.id) : null;
    const record = Object.assign({}, existing || {}, t, {
      params: cleaned,
      marine: Presets.isMarine(t.type, t.style),
      archivedAt: t.archived ? (existing && existing.archivedAt) || new Date().toISOString() : null
    });
    const saved = await storage.save('tanks', record);
    logger.info('Tank saved (' + saved.type + ')');
    return saved;
  }

  async function deleteTank({ id, confirmName }) {
    const t = requireTank(id);
    if (confirmName !== t.name) throw new ServiceError('confirmation mismatch', 'The typed name does not match the tank name. Nothing was deleted.');
    const owned = (r) => r.tankId === id;
    await storage.removeWhere('entries', owned);
    await storage.removeWhere('maintenance', owned);
    await storage.removeWhere('dosing', owned);
    await storage.removeWhere('photos', owned);
    for (const fn of tankCascade) await fn(id);
    const dir = resolveInside(photosRoot, id);
    if (dir) {
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch (err) { logger.warn('Could not remove photo folder for deleted tank', err); }
    }
    await storage.remove('tanks', id);
    if (getSettings().lastTankId === id) await saveSettings({ lastTankId: null });
    logger.info('Tank deleted with its history and photos');
    return { ok: true };
  }

  // ---------------------------------------------------------------- entries
  function listByTank(collection, dateField, { tankId, from, to }) {
    return storage.list(collection)
      .filter((r) => (!tankId || r.tankId === tankId) && inRange(r[dateField], from, to))
      .slice()
      .sort(byDateDesc(dateField));
  }

  function requireExisting(collection, id) {
    const r = storage.get(collection, id);
    if (!r) throw new ServiceError('not found', 'That item no longer exists. It may have been deleted.');
    return r;
  }

  async function saveEntry(payload) {
    const e = V.entry(payload);
    requireTank(e.tankId);
    if (e.id) requireExisting('entries', e.id);
    V.readingsAgainstDefinitions(e.readings, paramDefs());
    const saved = await storage.save('entries', e);
    if (getSettings().lastTankId !== e.tankId) await saveSettings({ lastTankId: e.tankId });
    return saved;
  }

  /** Photos attached to a deleted record stay as tank photos rather than vanish. */
  async function releasePhotos(ownerType, ownerId) {
    await storage.updateWhere('photos', (p) => (p.ownerType === ownerType && p.ownerId === ownerId
      ? Object.assign({}, p, { ownerType: 'tank', ownerId: null }) : null));
  }

  async function deleteRecord(collection, ownerType, { id }) {
    requireExisting(collection, id);
    await releasePhotos(ownerType, id);
    await storage.remove(collection, id);
    return { ok: true };
  }

  // ------------------------------------------------------------ maintenance
  async function saveMaintenance(payload) {
    const m = V.maintenance(payload);
    requireTank(m.tankId);
    if (m.id) requireExisting('maintenance', m.id);
    if (m.equipmentId && storage.isKnown('equipment') && !storage.get('equipment', m.equipmentId)) m.equipmentId = null;
    return storage.save('maintenance', m);
  }

  // ----------------------------------------------------------------- dosing
  async function saveDosing(payload) {
    const d = V.dosing(payload);
    requireTank(d.tankId);
    if (d.id) requireExisting('dosing', d.id);
    return storage.save('dosing', d);
  }

  // ----------------------------------------------------------------- photos
  function photoUrl(p) {
    return 'app://aquastar/photos/' + p.tankId + '/' + p.fileName;
  }

  function listPhotos({ tankId, ownerType, ownerId }) {
    return storage.list('photos')
      .filter((p) => (!tankId || p.tankId === tankId) && (!ownerType || p.ownerType === ownerType) && (!ownerId || p.ownerId === ownerId))
      .slice()
      .sort(byDateDesc('takenAt'))
      .map((p) => Object.assign({}, p, { url: photoUrl(p) }));
  }

  async function getPhoto({ id }) {
    const p = requireExisting('photos', id);
    const file = resolveInside(photosRoot, p.tankId + '/' + p.fileName);
    let exists = false;
    if (file && PHOTO_FILE_RE.test(p.fileName)) {
      try { exists = (await fsp.stat(file)).isFile(); } catch (e) { exists = false; }
    }
    return Object.assign({}, p, { url: photoUrl(p), exists });
  }

  async function addPhotoRecord({ tankId, ownerType, ownerId }, imported) {
    requireTank(tankId);
    if (ownerType !== 'tank' && ownerId) checkOwner(ownerType, ownerId, tankId);
    return storage.save('photos', {
      tankId,
      ownerType: ownerId ? ownerType : 'tank',
      ownerId: ownerId || null,
      fileName: imported.fileName,
      mime: imported.type,
      size: imported.size,
      caption: '',
      takenAt: new Date(imported.mtimeMs && imported.mtimeMs > 0 ? imported.mtimeMs : Date.now()).toISOString()
    });
  }

  function checkOwner(ownerType, ownerId, tankId) {
    const map = { entry: 'entries', maintenance: 'maintenance', livestock: 'livestock', journal: 'journal', treatment: 'treatments', equipment: 'equipment' };
    const coll = map[ownerType];
    if (!coll || !storage.isKnown(coll)) throw new ServiceError('bad owner', 'Photos cannot be attached to that item.');
    const owner = storage.get(coll, ownerId);
    if (!owner) throw new ServiceError('owner missing', 'The item this photo belongs to no longer exists.');
    if (owner.tankId && owner.tankId !== tankId) throw new ServiceError('owner tank mismatch', 'That item belongs to another tank.');
  }

  async function updatePhoto(payload) {
    const u = V.photoUpdate(payload);
    const p = requireExisting('photos', u.id);
    const saved = await storage.save('photos', Object.assign({}, p, { caption: u.caption, takenAt: u.takenAt || p.takenAt }));
    return Object.assign({}, saved, { url: photoUrl(saved) });
  }

  async function deletePhoto({ id }) {
    const p = requireExisting('photos', id);
    await storage.remove('photos', id);
    const file = resolveInside(photosRoot, p.tankId + '/' + p.fileName);
    if (file && PHOTO_FILE_RE.test(p.fileName)) {
      try { await fsp.unlink(file); } catch (err) { if (err.code !== 'ENOENT') logger.warn('Photo file could not be removed', err); }
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------ stats
  function tankEntries(tankId) {
    return storage.list('entries').filter((e) => e.tankId === tankId);
  }

  function stability({ tankId, parameterId }) {
    const tank = requireTank(tankId);
    const def = paramDefs().find((d) => d.id === parameterId);
    if (!def) throw new ServiceError('unknown parameter', 'Unknown parameter.');
    const cfg = (tank.params && tank.params[parameterId]) || null;
    return Stats.stability(tankEntries(tankId), parameterId, def, cfg, new Date());
  }

  /** Timeline markers for charts: water changes, dose changes, plus Phase 2 sources. */
  function events({ tankId, from, to }) {
    requireTank(tankId);
    const out = [];
    storage.list('maintenance').forEach((m) => {
      if (m.tankId !== tankId || m.type !== 'water_change' || !inRange(m.performedAt, from, to)) return;
      out.push({ t: m.performedAt, kind: 'water_change', label: 'WC', detail: 'Water change ' + Units.formatVolume(m.volumeL, getSettings()) });
    });
    storage.list('dosing').forEach((d) => {
      if (d.tankId !== tankId || !inRange(d.dosedAt, from, to)) return;
      const detail = d.kind === 'stop' ? 'Stopped ' + d.product
        : d.kind === 'daily' ? d.product + ' set to ' + d.amount + ' ' + d.unit + '/day'
          : d.product + ' ' + d.amount + ' ' + d.unit + ' (one-time)';
      out.push({ t: d.dosedAt, kind: d.kind === 'once' ? 'dose_once' : 'dose_change', label: 'DOSE', detail });
    });
    extraEventSources.forEach((fn) => fn({ tankId, from, to, inRange }).forEach((e) => out.push(e)));
    out.sort((a, b) => (a.t < b.t ? -1 : 1));
    return out;
  }

  // -------------------------------------------------------------------- CSV
  function csvRows(kind, tankId) {
    const settings = getSettings();
    const tanks = new Map(storage.list('tanks').map((t) => [t.id, t]));
    const tankName = (id) => (tanks.get(id) ? tanks.get(id).name : 'Deleted tank');
    const keep = (r) => !tankId || r.tankId === tankId;
    const localStamp = (iso) => {
      const d = new Date(iso);
      return Dates.localDateString(d) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    };
    if (kind === 'entries') {
      const defs = paramDefs();
      const rows = [['Tank', 'Local time', 'UTC time', 'Parameter', 'Value', 'Unit', 'Below detection', 'Approximate', 'Method', 'Note']];
      storage.list('entries').filter(keep).slice().sort((a, b) => (a.takenAt < b.takenAt ? -1 : 1)).forEach((e) => {
        e.readings.forEach((r) => {
          const def = defs.find((d) => d.id === r.parameterId) || { id: r.parameterId, name: r.parameterId, unit: '', decimals: 3 };
          let value;
          if (def.kind === 'choice') value = r.value;
          else value = Units.round(Units.toDisplay(def, r.value, settings), Units.displayDecimals(def, settings));
          rows.push([tankName(e.tankId), localStamp(e.takenAt), e.takenAt, def.name, value, Units.unitLabel(def, settings),
            r.bdl ? 'yes' : 'no', Units.isApproximate(def, settings) ? 'yes' : 'no', e.method || '', e.note || '']);
        });
      });
      return rows;
    }
    if (kind === 'maintenance') {
      const types = new Map(Presets.MAINTENANCE_TYPES.map((t) => [t.value, t.label]));
      const rows = [['Tank', 'Local time', 'UTC time', 'Type', 'Detail', 'Volume', 'Volume unit', 'Percent of system', 'Note']];
      storage.list('maintenance').filter(keep).slice().sort((a, b) => (a.performedAt < b.performedAt ? -1 : 1)).forEach((m) => {
        const t = tanks.get(m.tankId);
        const pct = m.volumeL && t && t.totalVolumeL ? Units.round((m.volumeL / t.totalVolumeL) * 100, 1) : '';
        const detail = m.type === 'custom' ? m.customType : m.type === 'media' ? [m.mediaAction, m.media].filter(Boolean).join(' ') : '';
        rows.push([tankName(m.tankId), localStamp(m.performedAt), m.performedAt, types.get(m.type) || m.type, detail,
          m.volumeL ? Units.round(Units.volumeToDisplay(m.volumeL, settings), 2) : '', m.volumeL ? Units.volumeLabel(settings) : '', pct, m.note || '']);
      });
      return rows;
    }
    const cats = new Map(Presets.DOSING_CATEGORIES.map((c) => [c.value, c.label]));
    const rows = [['Tank', 'Local time', 'UTC time', 'Product', 'Category', 'Amount', 'Unit', 'Kind', 'Note']];
    storage.list('dosing').filter(keep).slice().sort((a, b) => (a.dosedAt < b.dosedAt ? -1 : 1)).forEach((d) => {
      rows.push([tankName(d.tankId), localStamp(d.dosedAt), d.dosedAt, d.product, cats.get(d.category) || d.category, d.amount, d.unit,
        d.kind === 'daily' ? 'daily regimen' : d.kind === 'stop' ? 'regimen stopped' : 'one-time', d.note || '']);
    });
    return rows;
  }

  /** Convert a value typed in a CSV column's unit into canonical units. */
  function csvValueToCanonical(def, value, unit) {
    if (unit === 'canonical') return value;
    switch (unit) {
      case 'F': return def.unitKind === 'temperature' ? Units.fToC(value) : value;
      case 'C': return value;
      case 'ppt': return def.unitKind === 'salinity' ? Units.pptToSg(value) : value;
      case 'sg': return value;
      case 'meq': return def.unitKind === 'alkalinity' ? Units.meqToDkh(value) : value;
      case 'ppm': return def.unitKind === 'alkalinity' ? Units.ppmToDkh(value) : value;
      default: return value;
    }
  }

  /**
   * Turn parsed CSV rows into entries according to the user's column mapping.
   * Returns {entries, skipped, problems} without saving.
   */
  function csvToEntries(rows, mapping) {
    const defs = paramDefs();
    const problems = [];
    const entries = [];
    let skipped = 0;
    const cols = mapping.columns.map((c) => {
      const def = defs.find((d) => d.id === c.parameterId);
      if (!def) throw new ServiceError('unknown parameter', 'The mapping uses an unknown parameter.');
      if (def.kind === 'choice') throw new ServiceError('choice param', def.name + ' cannot be imported from CSV.');
      return Object.assign({}, c, { def });
    });
    const seen = new Set();
    cols.forEach((c) => {
      if (seen.has(c.parameterId)) throw new ServiceError('duplicate mapping', 'Each parameter can only be mapped to one column.');
      seen.add(c.parameterId);
    });
    rows.forEach((row, idx) => {
      const lineNo = idx + 2; // header is line 1
      const takenAt = parseDateCell(row[mapping.dateColumn], mapping.dateFormat, mapping.timeColumn !== null ? row[mapping.timeColumn] : null);
      if (!takenAt) {
        skipped++;
        if (problems.length < 20) problems.push('Line ' + lineNo + ': date "' + String(row[mapping.dateColumn] || '').slice(0, 30) + '" not recognized');
        return;
      }
      const readings = [];
      let rowProblem = null;
      cols.forEach((c) => {
        const parsed = Units.parseReadingInput(row[c.index]);
        if (parsed.empty) return;
        if (parsed.error) { rowProblem = rowProblem || c.def.name + ' "' + String(row[c.index]).slice(0, 20) + '" is not a number'; return; }
        const value = csvValueToCanonical(c.def, parsed.value, c.unit);
        if (value < (c.def.hardMin || 0) || value > (c.def.hardMax || 1000000)) {
          rowProblem = rowProblem || c.def.name + ' value is outside the possible range';
          return;
        }
        readings.push({ parameterId: c.parameterId, value: Units.round(value, 6), bdl: parsed.bdl });
      });
      if (rowProblem) {
        skipped++;
        if (problems.length < 20) problems.push('Line ' + lineNo + ': ' + rowProblem);
        return;
      }
      if (!readings.length) { skipped++; return; }
      const method = mapping.methodColumn !== null ? String(row[mapping.methodColumn] || '').trim().slice(0, 60) : '';
      const note = mapping.noteColumn !== null ? String(row[mapping.noteColumn] || '').trim().slice(0, 2000) : '';
      entries.push({ tankId: mapping.tankId, takenAt, method, note, readings });
    });
    return { entries, skipped, problems };
  }

  async function importCsvEntries(rows, mapping) {
    requireTank(mapping.tankId);
    const result = csvToEntries(rows, mapping);
    const valid = [];
    result.entries.forEach((e) => {
      try {
        const clean = V.entry(e);
        V.readingsAgainstDefinitions(clean.readings, paramDefs());
        valid.push(clean);
      } catch (err) {
        result.skipped++;
      }
    });
    if (valid.length) await storage.insertMany('entries', valid);
    logger.info('CSV import: ' + valid.length + ' entries imported, ' + result.skipped + ' rows skipped');
    return { imported: valid.length, skipped: result.skipped, problems: result.problems };
  }

  return {
    ServiceError,
    getSettings, saveSettings,
    paramDefs, saveCustomParam, deleteCustomParam,
    listTanks, saveTank, deleteTank, requireTank,
    listEntries: (q) => listByTank('entries', 'takenAt', q),
    getEntry: ({ id }) => requireExisting('entries', id),
    saveEntry,
    deleteEntry: (q) => deleteRecord('entries', 'entry', q),
    listMaintenance: (q) => listByTank('maintenance', 'performedAt', q),
    getMaintenance: ({ id }) => requireExisting('maintenance', id),
    saveMaintenance,
    deleteMaintenance: (q) => deleteRecord('maintenance', 'maintenance', q),
    listDosing: (q) => listByTank('dosing', 'dosedAt', q),
    getDosing: ({ id }) => requireExisting('dosing', id),
    saveDosing,
    deleteDosing: (q) => deleteRecord('dosing', 'dosing', q),
    listPhotos, getPhoto, addPhotoRecord, updatePhoto, deletePhoto, photoUrl,
    stability, events, tankEntries,
    csvRows, csvToEntries, importCsvEntries,
    // Extension points used by Phase 2 modules.
    addEventSource: (fn) => extraEventSources.push(fn),
    addTankCascade: (fn) => tankCascade.push(fn),
    listByTank, requireExisting, releasePhotos, deleteRecord, byDateDesc, inRange
  };
}

module.exports = { createService, ServiceError, mergeSettings, CUSTOM_PREFIX };
