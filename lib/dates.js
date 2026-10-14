/*
 * Date helpers shared by main and renderer (globalThis.AquaDates).
 *
 * Rules:
 *  - Moments in time are stored as ISO 8601 UTC strings ("2026-03-08T14:05:00.000Z").
 *  - Calendar dates without a time (tank start date, due dates) are stored as
 *    "YYYY-MM-DD" and interpreted in the user's local calendar.
 *  - "Days since" and due dates count local calendar days, never 24-hour blocks,
 *    so a daylight saving change (23- or 25-hour day) cannot shift them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AquaDates = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MS_PER_DAY = 86400000;
  const MS_PER_HOUR = 3600000;

  const pad = (n) => String(n).padStart(2, '0');

  function toDate(value) {
    if (value instanceof Date) return value;
    if (typeof value === 'number') return new Date(value);
    if (typeof value === 'string') return new Date(value);
    return new Date(NaN);
  }

  function isValidDate(d) {
    return d instanceof Date && !Number.isNaN(d.getTime());
  }

  /** Integer index of the local calendar day containing `value`. */
  function localDayNumber(value) {
    const d = toDate(value);
    return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_PER_DAY);
  }

  /** Day index of a "YYYY-MM-DD" calendar date. */
  function dayNumberFromDateString(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
    if (!m) return NaN;
    return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PER_DAY);
  }

  function dateStringFromDayNumber(n) {
    const d = new Date(n * MS_PER_DAY);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  /** Whole local calendar days from `fromValue` until `now` (0 = same day). */
  function daysSince(fromValue, now) {
    const from = toDate(fromValue);
    if (!isValidDate(from)) return null;
    return localDayNumber(now === undefined ? new Date() : now) - localDayNumber(from);
  }

  /** Local calendar days from today until a "YYYY-MM-DD" date (negative = past). */
  function daysUntilDate(dateStr, now) {
    const target = dayNumberFromDateString(dateStr);
    if (Number.isNaN(target)) return null;
    return target - localDayNumber(now === undefined ? new Date() : now);
  }

  function addDaysToDateString(dateStr, days) {
    const n = dayNumberFromDateString(dateStr);
    if (Number.isNaN(n)) return null;
    return dateStringFromDayNumber(n + days);
  }

  /** "YYYY-MM-DD" of the local calendar day containing `value`. */
  function localDateString(value) {
    const d = toDate(value === undefined ? new Date() : value);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** Local "YYYY-MM-DDTHH:mm" for <input type="datetime-local">. */
  function toLocalInputValue(value) {
    const d = toDate(value === undefined ? new Date() : value);
    if (!isValidDate(d)) return '';
    return localDateString(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** Parse a datetime-local value (local wall clock) into an ISO UTC string. */
  function fromLocalInputValue(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(str || '');
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
    return isValidDate(d) ? d.toISOString() : null;
  }

  /** ISO UTC string for local noon of a calendar date (safe from DST edges). */
  function localNoonIso(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
    return isValidDate(d) ? d.toISOString() : null;
  }

  function formatDateTime(value, locale) {
    const d = toDate(value);
    if (!isValidDate(d)) return '--';
    return d.toLocaleString(locale || undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function formatDate(value, locale) {
    const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(dayNumberFromDateString(value) * MS_PER_DAY)
      : toDate(value);
    if (!isValidDate(d)) return '--';
    const opts = { year: 'numeric', month: 'short', day: 'numeric' };
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) opts.timeZone = 'UTC';
    return d.toLocaleDateString(locale || undefined, opts);
  }

  function formatDaysAgo(days) {
    if (days === null || days === undefined || Number.isNaN(days)) return 'never';
    if (days <= 0) return days < 0 ? 'in ' + (-days) + (days === -1 ? ' day' : ' days') : 'today';
    if (days === 1) return 'yesterday';
    return days + ' days ago';
  }

  function formatDuration(ms) {
    const hours = ms / MS_PER_HOUR;
    if (hours < 1) return Math.max(1, Math.round(ms / 60000)) + ' min';
    if (hours < 48) return (Math.round(hours * 10) / 10) + ' h';
    return (Math.round((hours / 24) * 10) / 10) + ' days';
  }

  function isIsoUtc(str) {
    return typeof str === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(str) &&
      isValidDate(new Date(str));
  }

  function isDateString(str) {
    if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    const n = dayNumberFromDateString(str);
    return !Number.isNaN(n) && dateStringFromDayNumber(n) === str;
  }

  return {
    MS_PER_DAY, MS_PER_HOUR,
    localDayNumber, dayNumberFromDateString, dateStringFromDayNumber,
    daysSince, daysUntilDate, addDaysToDateString, localDateString,
    toLocalInputValue, fromLocalInputValue, localNoonIso,
    formatDateTime, formatDate, formatDaysAgo, formatDuration,
    isIsoUtc, isDateString, isValidDate
  };
});
