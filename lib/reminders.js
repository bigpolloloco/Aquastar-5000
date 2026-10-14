'use strict';
/*
 * Reminder engine (pure functions, unit-tested):
 *  - recurring maintenance / test schedules: due, due today, overdue;
 *  - treatments reaching their planned end date;
 *  - test-kit reagents expiring soon or expired;
 *  - livestock due to leave quarantine.
 * All date math uses local calendar days (lib/dates.js), so DST cannot move
 * a due date.
 */
const Dates = require('./dates.js');

/** Latest local calendar date (YYYY-MM-DD) on which this schedule was done. */
function lastDoneDate(schedule, ctx) {
  const candidates = [];
  if (schedule.lastDoneAt) candidates.push(schedule.lastDoneAt);
  if (schedule.kind === 'test' && schedule.parameterId) {
    (ctx.entries || []).forEach((e) => {
      if (e.tankId === schedule.tankId && e.readings.some((r) => r.parameterId === schedule.parameterId)) candidates.push(e.takenAt);
    });
  } else {
    (ctx.maintenance || []).forEach((m) => {
      if (m.tankId !== schedule.tankId || m.type !== schedule.kind) return;
      if (m.type === 'custom' && String(m.customType || '').toLowerCase() !== String(schedule.title).toLowerCase() && m.scheduleId !== schedule.id) return;
      candidates.push(m.performedAt);
    });
  }
  const valid = candidates.filter((c) => !Number.isNaN(Date.parse(c)));
  if (!valid.length) return null;
  const latest = valid.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b));
  return Dates.localDateString(new Date(latest));
}

/** Due date and status of one schedule. */
function scheduleStatus(schedule, ctx, now) {
  const last = lastDoneDate(schedule, ctx);
  // Done at least once (on or after the start date): next = last + interval.
  // Never done: due on the start date.
  const due = last && last >= schedule.startDate ? Dates.addDaysToDateString(last, schedule.intervalDays) : schedule.startDate;
  const dueIn = Dates.daysUntilDate(due, now);
  return {
    scheduleId: schedule.id,
    lastDone: last,
    dueDate: due,
    dueIn,
    state: dueIn < 0 ? 'overdue' : dueIn === 0 ? 'due' : 'upcoming'
  };
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

/**
 * Everything that needs attention.
 * @returns {Array<{key, kind, level, tankId, title, message, dueDate, dueIn, notify, ref}>}
 */
function computeReminders(ctx, now) {
  const at = now || new Date();
  const out = [];
  const tanks = new Map((ctx.tanks || []).map((t) => [t.id, t]));
  const activeTank = (id) => tanks.has(id) && !tanks.get(id).archived;
  const tankName = (id) => (tanks.get(id) ? tanks.get(id).name : '');

  (ctx.schedules || []).forEach((s) => {
    if (!s.active || !activeTank(s.tankId)) return;
    const st = scheduleStatus(s, ctx, at);
    const when = st.state === 'overdue' ? 'overdue by ' + plural(-st.dueIn, 'day')
      : st.state === 'due' ? 'due today' : 'due in ' + plural(st.dueIn, 'day');
    out.push({
      key: 'schedule:' + s.id + ':' + st.dueDate,
      kind: 'schedule',
      level: st.state === 'overdue' ? 'ALERT' : st.state === 'due' ? 'WATCH' : 'OK',
      state: st.state,
      tankId: s.tankId,
      title: s.title,
      message: tankName(s.tankId) + ': ' + s.title + ' ' + when,
      when,
      dueDate: st.dueDate,
      dueIn: st.dueIn,
      lastDone: st.lastDone,
      notify: s.notify !== false && st.state !== 'upcoming',
      ref: s.id
    });
  });

  (ctx.treatments || []).forEach((t) => {
    if (t.endDate || !t.plannedEndDate || !activeTank(t.tankId)) return;
    const dueIn = Dates.daysUntilDate(t.plannedEndDate, at);
    if (dueIn > 0) return;
    out.push({
      key: 'treatment:' + t.id + ':' + t.plannedEndDate,
      kind: 'treatment',
      level: 'WATCH',
      state: dueIn < 0 ? 'overdue' : 'due',
      tankId: t.tankId,
      title: t.medication,
      message: tankName(t.tankId) + ': treatment "' + t.medication + '" ' + (dueIn === 0 ? 'reaches its planned end today' : 'passed its planned end ' + plural(-dueIn, 'day') + ' ago') + '. Record the outcome or extend it.',
      dueDate: t.plannedEndDate,
      dueIn,
      notify: true,
      ref: t.id
    });
  });

  const warnDays = (ctx.settings && ctx.settings.reagentWarnDays) || 30;
  (ctx.equipment || []).forEach((e) => {
    (e.reagents || []).forEach((r) => {
      const dueIn = Dates.daysUntilDate(r.expires, at);
      if (dueIn === null || dueIn > warnDays) return;
      const kit = [e.brand, e.model].filter(Boolean).join(' ');
      out.push({
        key: 'reagent:' + e.id + ':' + (r.id || r.name) + ':' + r.expires,
        kind: 'reagent',
        level: dueIn < 0 ? 'ALERT' : 'WATCH',
        state: dueIn < 0 ? 'overdue' : 'upcoming',
        tankId: e.tankId || null,
        title: kit + ' ' + r.name,
        message: (dueIn < 0 ? 'Expired reagent: ' : 'Reagent expiring: ') + kit + ' - ' + r.name +
          (dueIn < 0 ? ' expired ' + plural(-dueIn, 'day') + ' ago. Expired reagents give wrong readings.' : dueIn === 0 ? ' expires today.' : ' expires in ' + plural(dueIn, 'day') + '.'),
        dueDate: r.expires,
        dueIn,
        notify: true,
        ref: e.id
      });
    });
  });

  (ctx.livestock || []).forEach((l) => {
    if (l.status !== 'alive' || !l.qt || !l.qt.inQt || !l.qt.releaseDate || !activeTank(l.tankId)) return;
    const dueIn = Dates.daysUntilDate(l.qt.releaseDate, at);
    if (dueIn > 0) return;
    out.push({
      key: 'qt:' + l.id + ':' + l.qt.releaseDate,
      kind: 'qt',
      level: 'WATCH',
      state: dueIn < 0 ? 'overdue' : 'due',
      tankId: l.tankId,
      title: l.commonName,
      message: tankName(l.tankId) + ': ' + l.commonName + ' reached its planned quarantine release date' + (dueIn < 0 ? ' (' + plural(-dueIn, 'day') + ' ago)' : ' today') + '.',
      dueDate: l.qt.releaseDate,
      dueIn,
      notify: true,
      ref: l.id
    });
  });

  const rank = { ALERT: 0, WATCH: 1, OK: 2 };
  out.sort((a, b) => rank[a.level] - rank[b.level] || a.dueIn - b.dueIn);
  return out;
}

/**
 * Which reminders to send as desktop notifications now: each key at most
 * once per local day. Returns {toNotify, notified} where `notified` is the
 * updated (and pruned) bookkeeping map.
 */
function pickNotifications(reminders, notified, now) {
  const today = Dates.localDateString(now || new Date());
  const map = Object.assign({}, notified || {});
  const toNotify = reminders.filter((r) => r.notify && map[r.key] !== today);
  toNotify.forEach((r) => { map[r.key] = today; });
  const cutoff = Dates.addDaysToDateString(today, -60);
  Object.keys(map).forEach((k) => { if (map[k] < cutoff) delete map[k]; });
  return { toNotify, notified: map };
}

module.exports = { computeReminders, scheduleStatus, lastDoneDate, pickNotifications };
