'use strict';
/*
 * Phase 2 data operations: livestock (moves, frags, status splits, QT),
 * treatments, maintenance schedules, equipment (reagents, calibrations),
 * journal and expenses. Extends the Phase 1 service with chart event sources
 * and tank-deletion cascades. No Electron imports (unit-testable).
 */
const V = require('./validate.js');
const Dates = require('./dates.js');
const crypto = require('crypto');
const { computeReminders, scheduleStatus } = require('./reminders.js');

function createKeeper(ctx) {
  const { storage, service } = ctx;
  const { ServiceError } = service;
  const today = () => Dates.localDateString(new Date());

  // ---------------------------------------------------------- generic CRUD
  function crud(collection, ownerType, validator, dateField, hooks) {
    const h = hooks || {};
    return {
      list: (q) => {
        const rows = service.listByTank(collection, dateField, { tankId: q && q.tankId });
        return h.filterList ? h.filterList(rows, q || {}) : rows;
      },
      get: ({ id }) => service.requireExisting(collection, id),
      save: async (payload) => {
        const rec = validator(payload);
        if (rec.tankId) service.requireTank(rec.tankId);
        const existing = rec.id ? service.requireExisting(collection, rec.id) : null;
        const prepared = h.beforeSave ? h.beforeSave(rec, existing) : rec;
        return storage.save(collection, existing ? Object.assign({}, existing, prepared) : prepared);
      },
      remove: (q) => service.deleteRecord(collection, ownerType, q)
    };
  }

  // -------------------------------------------------------------- livestock
  function historyEntry(type, fields) {
    return Object.assign({ at: new Date().toISOString(), type }, fields || {});
  }

  const livestock = crud('livestock', 'livestock', V.livestock, 'dateAdded', {
    beforeSave(rec, existing) {
      if (rec.motherId) {
        if (existing && rec.motherId === existing.id) throw new ServiceError('self mother', 'A frag cannot be its own mother colony.');
        if (!storage.get('livestock', rec.motherId)) rec.motherId = null;
      }
      const history = existing && Array.isArray(existing.history) ? existing.history.slice() : [historyEntry('added', { tankId: rec.tankId, quantity: rec.quantity, date: rec.dateAdded })];
      if (existing) {
        if (existing.status !== rec.status) history.push(historyEntry('status', { from: existing.status, to: rec.status, date: rec.statusDate, cause: rec.lossCause || '' }));
        if (existing.quantity !== rec.quantity) history.push(historyEntry('quantity', { from: existing.quantity, to: rec.quantity }));
        if (existing.tankId !== rec.tankId) history.push(historyEntry('moved', { fromTankId: existing.tankId, toTankId: rec.tankId, quantity: rec.quantity, date: today() }));
        const wasQt = Boolean(existing.qt && existing.qt.inQt);
        const isQt = Boolean(rec.qt && rec.qt.inQt);
        if (wasQt !== isQt) history.push(historyEntry(isQt ? 'qt_start' : 'qt_end', { date: isQt ? rec.qt.startDate : today() }));
      } else if (rec.qt && rec.qt.inQt) {
        history.push(historyEntry('qt_start', { date: rec.qt.startDate }));
      }
      return Object.assign({}, rec, { history });
    }
  });

  /** Split `quantity` off a record into a new record (same history), returning both. */
  async function splitOff(rec, quantity, changes, historyForNew, historyForOld) {
    if (quantity > rec.quantity) throw new ServiceError('too many', 'Only ' + rec.quantity + ' available.');
    const baseHistory = Array.isArray(rec.history) ? rec.history.slice() : [];
    if (quantity === rec.quantity) {
      const updated = await storage.save('livestock', Object.assign({}, rec, changes, { history: baseHistory.concat([historyForNew]) }));
      return { moved: updated, remaining: null };
    }
    const remaining = await storage.save('livestock', Object.assign({}, rec, { quantity: rec.quantity - quantity, history: baseHistory.concat([historyForOld]) }));
    const copy = Object.assign({}, rec, changes, { quantity, splitFromId: rec.id, history: baseHistory.concat([historyForNew]) });
    delete copy.id; delete copy.createdAt; delete copy.updatedAt;
    const moved = await storage.save('livestock', copy);
    return { moved, remaining };
  }

  async function moveLivestock(payload) {
    const m = V.livestockMove(payload);
    const rec = service.requireExisting('livestock', m.id);
    service.requireTank(m.toTankId);
    if (rec.tankId === m.toTankId) throw new ServiceError('same tank', 'It is already in that tank.');
    if (rec.status !== 'alive') throw new ServiceError('not alive', 'Only living stock can be moved.');
    const target = service.requireTank(m.toTankId);
    const fields = { fromTankId: rec.tankId, toTankId: m.toTankId, quantity: m.quantity, date: m.date, note: m.note };
    const changes = { tankId: m.toTankId };
    // Moving out of quarantine into a non-quarantine tank ends the quarantine.
    if (rec.qt && rec.qt.inQt && target.type !== 'quarantine') {
      changes.qt = Object.assign({}, rec.qt, { inQt: false });
      fields.note = (fields.note ? fields.note + '; ' : '') + 'quarantine ended';
    }
    return splitOff(rec, m.quantity, changes, historyEntry('moved', fields), historyEntry('moved_out', fields));
  }

  async function setLivestockStatus(payload) {
    const s = V.livestockStatus(payload);
    const rec = service.requireExisting('livestock', s.id);
    if (rec.status !== 'alive') throw new ServiceError('not alive', 'Change the status from the edit form instead.');
    const qty = s.quantity || rec.quantity;
    const fields = { from: 'alive', to: s.status, quantity: qty, date: s.date, cause: s.cause, note: s.note };
    const changes = { status: s.status, statusDate: s.status === 'alive' ? null : s.date, lossCause: s.status === 'died' ? s.cause : '' };
    if (changes.status !== 'alive' && changes.status !== 'died') changes.qt = rec.qt ? Object.assign({}, rec.qt, { inQt: false }) : null;
    return splitOff(rec, qty, changes, historyEntry('status', fields), historyEntry('status_split', fields));
  }

  async function fragLivestock(payload) {
    const f = V.livestockFrag(payload);
    const mother = service.requireExisting('livestock', f.motherId);
    const tankId = f.tankId || mother.tankId;
    service.requireTank(tankId);
    const motherHistory = (mother.history || []).concat([historyEntry('fragged', { count: f.count, date: f.date, tankId })]);
    await storage.save('livestock', Object.assign({}, mother, { history: motherHistory }));
    return storage.save('livestock', {
      tankId,
      commonName: f.name || mother.commonName + ' (frag)',
      scientificName: mother.scientificName || '',
      category: mother.category,
      quantity: f.count,
      dateAdded: f.date,
      source: 'own_frag',
      cost: null,
      status: 'alive',
      statusDate: null,
      lossCause: '',
      motherId: mother.id,
      fragDate: f.date,
      qt: null,
      notes: '',
      history: [historyEntry('fragged_from', { motherId: mother.id, count: f.count, date: f.date, tankId })]
    });
  }

  // ------------------------------------------------------------- treatments
  const treatments = crud('treatments', 'treatment', V.treatment, 'startDate', {
    beforeSave(rec) {
      if (rec.targetLivestockId) {
        const l = storage.get('livestock', rec.targetLivestockId);
        if (!l || l.tankId !== rec.tankId) rec.targetLivestockId = null;
      }
      return rec;
    }
  });

  // -------------------------------------------------------------- schedules
  const schedules = crud('schedules', 'schedule', V.schedule, 'startDate', {
    beforeSave(rec, existing) {
      if (rec.kind === 'test' && !service.paramDefs().some((d) => d.id === rec.parameterId)) throw new ServiceError('bad param', 'Unknown parameter for the test reminder.');
      return Object.assign({ lastDoneAt: existing ? existing.lastDoneAt || null : null }, rec);
    },
    filterList: (rows, q) => (q.includeInactive ? rows : rows.filter((r) => r.active !== false))
  });

  function reminderContext() {
    return {
      tanks: storage.list('tanks'),
      schedules: storage.list('schedules'),
      entries: storage.list('entries'),
      maintenance: storage.list('maintenance'),
      treatments: storage.list('treatments'),
      equipment: storage.list('equipment'),
      livestock: storage.list('livestock'),
      settings: service.getSettings()
    };
  }

  function reminders(now) {
    return computeReminders(reminderContext(), now || new Date());
  }

  function schedulesWithStatus(q) {
    const c = reminderContext();
    return schedules.list(q).map((s) => Object.assign({}, s, { status: scheduleStatus(s, c, new Date()) }));
  }

  /**
   * Complete a schedule: creates the matching maintenance log entry and marks
   * the schedule done. Test reminders are completed by logging the test, so
   * the renderer is told to open quick entry instead.
   */
  async function completeSchedule(payload) {
    const c = V.scheduleComplete(payload);
    const s = service.requireExisting('schedules', c.id);
    const tank = service.requireTank(s.tankId);
    if (s.kind === 'test') return { openQuickEntry: true, tankId: s.tankId, parameterId: s.parameterId };
    const performedAt = c.performedAt || new Date().toISOString();
    let volumeL = null;
    if (s.kind === 'water_change') {
      volumeL = c.volumeL || (s.volumePercent ? tank.totalVolumeL * s.volumePercent / 100 : null);
      if (!(volumeL > 0)) throw new ServiceError('no volume', 'Enter how much water was changed (or set a % on the reminder).');
    }
    const record = await service.saveMaintenance({
      tankId: s.tankId,
      performedAt,
      type: s.kind,
      customType: s.kind === 'custom' ? s.title : '',
      media: s.kind === 'media' ? 'other' : null,
      mediaAction: s.kind === 'media' ? 'clean' : null,
      volumeL,
      scheduleId: s.id,
      equipmentId: null,
      note: c.note || ('Completed from reminder: ' + s.title)
    });
    await storage.save('schedules', Object.assign({}, s, { lastDoneAt: performedAt }));
    return { maintenance: record };
  }

  // -------------------------------------------------------------- equipment
  const equipment = crud('equipment', 'equipment', V.equipment, 'purchaseDate', {
    beforeSave(rec) {
      const withIds = (list) => list.map((x) => Object.assign({}, x, { id: x.id || crypto.randomUUID() }));
      return Object.assign({}, rec, { reagents: withIds(rec.reagents), calibrations: withIds(rec.calibrations).sort((a, b) => (a.date < b.date ? 1 : -1)) });
    }
  });
  // Equipment without a tank (spares, test kits) must still be listed.
  equipment.list = (q) => storage.list('equipment')
    .filter((e) => !q || !q.tankId || e.tankId === q.tankId || !e.tankId)
    .slice()
    .sort((a, b) => (a.category + a.brand + a.model).localeCompare(b.category + b.brand + b.model));

  // ------------------------------------------------------- journal/expenses
  const journal = crud('journal', 'journal', V.journal, 'date');
  const expenses = crud('expenses', 'expense', V.expense, 'date');
  expenses.list = (q) => storage.list('expenses')
    .filter((x) => !q || !q.tankId || x.tankId === q.tankId)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  // ---------------------------------------------------- chart event sources
  service.addEventSource(({ tankId, from, to, inRange }) => {
    const out = [];
    const noon = (d) => Dates.localNoonIso(d);
    storage.list('livestock').forEach((l) => {
      (l.history || []).forEach((h) => {
        const date = h.date ? noon(h.date) : h.at;
        if (!date || !inRange(date, from, to)) return;
        if ((h.type === 'added' || h.type === 'fragged_from') && (h.tankId || l.tankId) === tankId && !l.splitFromId) {
          out.push({ t: date, kind: 'livestock_add', label: 'ADD', detail: 'Added ' + (h.quantity || h.count || l.quantity) + ' x ' + l.commonName });
        } else if (h.type === 'moved' && h.toTankId === tankId) {
          out.push({ t: date, kind: 'livestock_add', label: 'ADD', detail: 'Moved in: ' + h.quantity + ' x ' + l.commonName });
        } else if ((h.type === 'moved' || h.type === 'moved_out') && h.fromTankId === tankId) {
          out.push({ t: date, kind: 'livestock_out', label: 'OUT', detail: 'Moved out: ' + h.quantity + ' x ' + l.commonName });
        } else if (h.type === 'status' && h.to === 'died' && l.tankId === tankId) {
          out.push({ t: date, kind: 'livestock_loss', label: 'LOSS', detail: 'Died: ' + (h.quantity || l.quantity) + ' x ' + l.commonName + (h.cause ? ' (' + h.cause + ')' : '') });
        }
      });
    });
    storage.list('treatments').forEach((t) => {
      if (t.tankId !== tankId) return;
      const start = noon(t.startDate);
      if (inRange(start, from, to)) out.push({ t: start, kind: 'treatment', label: 'TX', detail: 'Treatment started: ' + t.medication + (t.dose ? ' (' + t.dose + ')' : '') });
      if (t.endDate) {
        const end = noon(t.endDate);
        if (inRange(end, from, to)) out.push({ t: end, kind: 'treatment', label: 'TX', detail: 'Treatment ended: ' + t.medication + ' - ' + t.outcome });
      }
    });
    return out;
  });

  // ------------------------------------------------------- tank deletion
  service.addTankCascade(async (tankId) => {
    const owned = (r) => r.tankId === tankId;
    for (const c of ['livestock', 'treatments', 'schedules', 'journal', 'expenses']) await storage.removeWhere(c, owned);
    // Equipment is physical gear the keeper still owns: unassign rather than delete.
    await storage.updateWhere('equipment', (e) => (e.tankId === tankId ? Object.assign({}, e, { tankId: null }) : null));
  });

  return {
    livestock, moveLivestock, setLivestockStatus, fragLivestock,
    treatments, schedules, schedulesWithStatus, completeSchedule, reminders,
    equipment, journal, expenses
  };
}

const HISTORY_KEYS = ['at', 'type', 'tankId', 'fromTankId', 'toTankId', 'motherId', 'quantity', 'count', 'date', 'from', 'to', 'cause', 'note'];

/** Keep only known, primitive history fields from an imported record. */
function sanitizeHistory(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 2000).filter((h) => V.isPlainObject(h) && typeof h.type === 'string').map((h) => {
    const out = {};
    HISTORY_KEYS.forEach((k) => {
      const v = h[k];
      if (typeof v === 'string') out[k] = v.slice(0, 200);
      else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    });
    return out;
  });
}

/** Validators for Phase 2 records in an import (records keep server-managed fields). */
function importCheckers() {
  const uuidOrNull = (v) => (typeof v === 'string' && V.UUID_RE.test(v) ? v.toLowerCase() : null);
  return {
    livestock: (r) => Object.assign(V.livestock(r), { history: sanitizeHistory(r.history), splitFromId: uuidOrNull(r.splitFromId) }),
    treatments: (r) => V.treatment(r),
    schedules: (r) => Object.assign(V.schedule(r), { lastDoneAt: Dates.isIsoUtc(r.lastDoneAt) ? r.lastDoneAt : null }),
    equipment: (r) => V.equipment(r),
    journal: (r) => V.journal(r),
    expenses: (r) => V.expense(r)
  };
}

module.exports = { createKeeper, importCheckers, sanitizeHistory };
