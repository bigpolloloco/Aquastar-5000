/*
 * Stability, range and overdue checks. Shared by main and renderer
 * (globalThis.AquaStats). Works on canonical values only; formatting for
 * people goes through lib/units.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./units.js'), require('./dates.js'));
  else root.AquaStats = factory(root.AquaUnits, root.AquaDates);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Units, Dates) {
  'use strict';

  const EPSILON = 1e-9;
  const LEVEL_ORDER = { NONE: 0, OK: 1, WATCH: 2, ALERT: 3 };

  /** Sorted readings of one parameter: [{t, value, bdl, entryId}] oldest first. */
  function seriesFor(entries, paramId) {
    const out = [];
    (entries || []).forEach((e) => {
      const t = Date.parse(e.takenAt);
      if (Number.isNaN(t)) return;
      (e.readings || []).forEach((r) => {
        if (r.parameterId === paramId) out.push({ t, value: r.value, bdl: Boolean(r.bdl), entryId: e.id });
      });
    });
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /** Latest reading per parameter: { [paramId]: {value, bdl, takenAt, t, entryId} }. */
  function latestByParam(entries) {
    const out = Object.create(null);
    (entries || []).forEach((e) => {
      const t = Date.parse(e.takenAt);
      if (Number.isNaN(t)) return;
      (e.readings || []).forEach((r) => {
        const cur = out[r.parameterId];
        if (!cur || t > cur.t) out[r.parameterId] = { value: r.value, bdl: Boolean(r.bdl), takenAt: e.takenAt, t, entryId: e.id };
      });
    });
    return out;
  }

  function watchBand(def, cfg) {
    if (cfg && typeof cfg.watchBand === 'number') return cfg.watchBand;
    if (def && typeof def.watchBand === 'number') return def.watchBand;
    if (cfg && typeof cfg.min === 'number' && typeof cfg.max === 'number') return (cfg.max - cfg.min) * 0.1;
    return 0;
  }

  function hasRange(cfg) {
    return Boolean(cfg) && (typeof cfg.min === 'number' || typeof cfg.max === 'number');
  }

  /**
   * Status of one reading against the tank's ideal range.
   * Returns {level: 'OK'|'WATCH'|'ALERT'|'NONE', direction: 'low'|'high'|null, note?}.
   * Below-detection readings are only known to be under their limit.
   */
  function rangeStatus(def, cfg, reading) {
    if (!reading || !def) return { level: 'NONE', direction: null };
    if (def.kind === 'choice') {
      const opt = (def.options || []).find((o) => o.value === reading.value);
      return { level: opt ? opt.status : 'NONE', direction: null };
    }
    if (typeof reading.value !== 'number') return { level: 'NONE', direction: null };
    if (!hasRange(cfg)) return { level: 'NONE', direction: null };
    const band = watchBand(def, cfg);
    const min = typeof cfg.min === 'number' ? cfg.min : null;
    const max = typeof cfg.max === 'number' ? cfg.max : null;
    const v = reading.value;
    if (reading.bdl) {
      // The true value lies somewhere in [0, v).
      if (min !== null && v <= min + EPSILON) {
        return { level: (min - v) > band + EPSILON ? 'ALERT' : 'WATCH', direction: 'low', note: 'below detection limit' };
      }
      if (max !== null && v - max > band + EPSILON) {
        return { level: 'WATCH', direction: null, note: 'detection limit is above the ideal maximum' };
      }
      return { level: 'OK', direction: null, note: 'below detection limit' };
    }
    if (min !== null && v < min - EPSILON) {
      return { level: (min - v) > band + EPSILON ? 'ALERT' : 'WATCH', direction: 'low' };
    }
    if (max !== null && v > max + EPSILON) {
      return { level: (v - max) > band + EPSILON ? 'ALERT' : 'WATCH', direction: 'high' };
    }
    return { level: 'OK', direction: null };
  }

  /**
   * Change between the two most recent tests of a parameter.
   * - delta and the time between tests are always reported;
   * - perDay is only computed when the tests are at least 24 h apart, so a
   *   normal day/night pH swing measured hours apart is not scaled up;
   * - a long gap between tests is called out because it can hide swings.
   */
  function lastChange(series, cfg) {
    if (!series || series.length < 2) return null;
    const a = series[series.length - 2];
    const b = series[series.length - 1];
    const ms = b.t - a.t;
    const hours = ms / Dates.MS_PER_HOUR;
    const result = {
      from: { t: a.t, value: a.value, bdl: a.bdl },
      to: { t: b.t, value: b.value, bdl: b.bdl },
      ms, hours, delta: null, perDay: null, perDayNote: null, gapNote: null,
      threshold: cfg && typeof cfg.maxDelta === 'number' ? cfg.maxDelta : null,
      flagged: false
    };
    if (a.bdl || b.bdl || typeof a.value !== 'number' || typeof b.value !== 'number') {
      result.perDayNote = 'A below-detection reading is involved, so the change cannot be measured.';
      return result;
    }
    result.delta = b.value - a.value;
    if (hours >= 24) {
      result.perDay = result.delta / (hours / 24);
    } else {
      result.perDayNote = 'Tests were less than 24 h apart; per-day rate not extrapolated.';
    }
    const interval = cfg && typeof cfg.intervalDays === 'number' ? cfg.intervalDays : null;
    const longGapDays = interval ? Math.max(interval * 2, 3) : 7;
    const gapDays = hours / 24;
    if (gapDays > longGapDays) {
      result.gapNote = Math.round(gapDays) + ' days between tests; swings in between would not show up.';
    }
    if (result.threshold !== null && Math.abs(result.delta) > result.threshold + EPSILON) result.flagged = true;
    return result;
  }

  /** Every consecutive pair whose change exceeds the threshold (for chart highlights). */
  function swingsInSeries(series, maxDelta) {
    if (typeof maxDelta !== 'number' || !series) return [];
    const out = [];
    for (let i = 1; i < series.length; i++) {
      const a = series[i - 1];
      const b = series[i];
      if (a.bdl || b.bdl) continue;
      const d = b.value - a.value;
      if (Math.abs(d) > maxDelta + EPSILON) out.push({ fromT: a.t, toT: b.t, delta: d });
    }
    return out;
  }

  function overdueStatus(series, cfg, now) {
    const interval = cfg && typeof cfg.intervalDays === 'number' && cfg.intervalDays > 0 ? cfg.intervalDays : null;
    const last = series && series.length ? series[series.length - 1] : null;
    const days = last ? Dates.daysSince(last.t, now) : null;
    return {
      intervalDays: interval,
      daysSince: days,
      lastT: last ? last.t : null,
      overdue: interval !== null && (days === null || days > interval),
      dueInDays: interval !== null && days !== null ? interval - days : null
    };
  }

  /** Full stability report for one parameter. */
  function stability(entries, paramId, def, cfg, now) {
    const series = seriesFor(entries, paramId);
    const latest = series.length ? series[series.length - 1] : null;
    return {
      parameterId: paramId,
      count: series.length,
      latest,
      range: latest ? rangeStatus(def, cfg, latest) : { level: 'NONE', direction: null },
      change: def && def.kind === 'choice' ? null : lastChange(series, cfg),
      overdue: overdueStatus(series, cfg, now)
    };
  }

  function formatRange(def, cfg, settings) {
    if (!hasRange(cfg) || def.kind === 'choice') return 'no range set';
    const d = Units.displayDecimals(def, settings);
    const unit = Units.unitLabel(def, settings);
    const fmt = (v) => Units.formatNumber(Units.toDisplay(def, v, settings), d);
    let s;
    if (typeof cfg.min === 'number' && typeof cfg.max === 'number') s = fmt(cfg.min) + '-' + fmt(cfg.max);
    else if (typeof cfg.min === 'number') s = 'min ' + fmt(cfg.min);
    else s = 'max ' + fmt(cfg.max);
    return (unit ? s + ' ' + unit : s) + (Units.isApproximate(def, settings) ? ' (approx.)' : '');
  }

  function formatDelta(def, delta, settings) {
    const d = Units.displayDecimals(def, settings);
    const v = Units.deltaToDisplay(def, delta, settings);
    const unit = Units.unitLabel(def, settings);
    const sign = v > 0 ? '+' : '';
    return sign + Units.formatNumber(v, d) + (unit ? ' ' + unit : '');
  }

  /**
   * All alerts for one tank: swings, out of range, overdue tests.
   * Returns [{tankId, paramId, kind, level, message}], most severe first.
   */
  function tankAlerts(tank, defs, entries, settings, now) {
    const out = [];
    if (!tank || !tank.params) return out;
    Object.keys(tank.params).forEach((paramId) => {
      const cfg = tank.params[paramId];
      if (!cfg || !cfg.enabled) return;
      const def = defs.find((d) => d.id === paramId);
      if (!def) return;
      const st = stability(entries, paramId, def, cfg, now);
      const name = tank.name + ': ' + def.name;
      if (st.change && st.change.flagged) {
        const c = st.change;
        let msg = name + ' changed ' + formatDelta(def, c.delta, settings) + ' in ' + Dates.formatDuration(c.ms);
        if (c.perDay !== null && c.hours >= 48) msg += ' (' + formatDelta(def, c.perDay, settings) + '/day)';
        msg += '; limit ' + formatDelta(def, c.threshold, settings).replace(/^\+/, '') + ' between tests';
        if (c.gapNote) msg += '. ' + c.gapNote;
        out.push({ tankId: tank.id, paramId, kind: 'swing', level: 'ALERT', message: msg });
      }
      if (st.latest && (st.range.level === 'WATCH' || st.range.level === 'ALERT')) {
        const reading = Units.formatReading(def, st.latest, settings);
        let msg;
        if (def.kind === 'choice') msg = name + ' reads ' + reading;
        else if (st.range.direction) msg = name + ' ' + reading + ' is ' + (st.range.direction === 'low' ? 'LOW' : 'HIGH') + ' (ideal ' + formatRange(def, cfg, settings) + ')';
        else msg = name + ' ' + reading + ': ' + (st.range.note || 'check range') + ' (ideal ' + formatRange(def, cfg, settings) + ')';
        out.push({ tankId: tank.id, paramId, kind: 'range', level: st.range.level, message: msg });
      }
      if (st.overdue.overdue) {
        const msg = st.overdue.daysSince === null
          ? name + ' has never been tested (test every ' + st.overdue.intervalDays + ' days)'
          : name + ' test overdue: last ' + Dates.formatDaysAgo(st.overdue.daysSince) + ', due every ' + st.overdue.intervalDays + ' days';
        out.push({ tankId: tank.id, paramId, kind: 'overdue', level: 'WATCH', message: msg });
      }
    });
    out.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]);
    return out;
  }

  /**
   * Break a series into segments wherever the gap between tests is far longer
   * than usual, so charts do not draw a line across months without testing.
   * Returns the gap threshold in ms.
   */
  function gapThreshold(series, opts) {
    const minDays = (opts && opts.minDays) || 7;
    const factor = (opts && opts.factor) || 4;
    if (!series || series.length < 3) return minDays * Dates.MS_PER_DAY * factor;
    const gaps = [];
    for (let i = 1; i < series.length; i++) gaps.push(series[i].t - series[i - 1].t);
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    return Math.max(minDays * Dates.MS_PER_DAY, median * factor);
  }

  /**
   * Current daily dosing regimen: for each product (case-insensitive) the most
   * recent 'daily' or 'stop' record decides; only active daily doses are returned.
   */
  function currentRegimen(doses) {
    const latest = new Map();
    (doses || []).forEach((d) => {
      if (d.kind !== 'daily' && d.kind !== 'stop') return;
      const key = String(d.product).trim().toLowerCase();
      const cur = latest.get(key);
      if (!cur || d.dosedAt > cur.dosedAt) latest.set(key, d);
    });
    return Array.from(latest.values())
      .filter((d) => d.kind === 'daily')
      .map((d) => ({ id: d.id, product: d.product, amount: d.amount, unit: d.unit, category: d.category, since: d.dosedAt }))
      .sort((a, b) => a.product.localeCompare(b.product));
  }

  function worstLevel(levels) {
    return levels.reduce((w, l) => (LEVEL_ORDER[l] > LEVEL_ORDER[w] ? l : w), 'NONE');
  }

  return {
    LEVEL_ORDER, seriesFor, latestByParam, rangeStatus, lastChange, swingsInSeries,
    overdueStatus, stability, formatRange, formatDelta, tankAlerts, gapThreshold,
    worstLevel, hasRange, currentRegimen
  };
});
