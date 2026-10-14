'use strict';
/*
 * Daylight saving tests. TZ is set before any date is created; Node re-reads
 * process.env.TZ when it changes, so each test pins its own zone.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/dates.js');

function withTz(tz, fn) {
  const old = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
}

test('days since counts local calendar days across the spring-forward change (US)', () => {
  withTz('America/New_York', () => {
    // DST starts 2026-03-08 02:00 local. The night of 7->8 March is 23 hours long.
    const before = new Date(2026, 2, 7, 23, 30).toISOString();
    const after = new Date(2026, 2, 8, 0, 30);
    assert.equal(D.daysSince(before, after), 1, 'one calendar day even though only 1 hour passed');
    const sat = new Date(2026, 2, 7, 12, 0).toISOString();
    const sun = new Date(2026, 2, 8, 11, 0); // 22 real hours later
    assert.equal(D.daysSince(sat, sun), 1);
    const week = new Date(2026, 2, 14, 12, 0);
    assert.equal(D.daysSince(sat, week), 7);
  });
});

test('days since across the fall-back change (EU)', () => {
  withTz('Europe/Berlin', () => {
    // DST ends 2026-10-25 03:00 local; that day has 25 hours.
    const a = new Date(2026, 9, 24, 23, 59).toISOString();
    const b = new Date(2026, 9, 25, 23, 59); // 25 hours later
    assert.equal(D.daysSince(a, b), 1);
    const c = new Date(2026, 9, 26, 0, 1); // 25h02 later: still only two calendar days
    assert.equal(D.daysSince(a, c), 2);
  });
});

test('timestamps round-trip through local input values in a DST zone', () => {
  withTz('America/Los_Angeles', () => {
    const iso = D.fromLocalInputValue('2026-03-08T03:30');
    assert.equal(iso, '2026-03-08T10:30:00.000Z');
    assert.equal(D.toLocalInputValue(iso), '2026-03-08T03:30');
    const summer = D.fromLocalInputValue('2026-07-01T09:00');
    assert.equal(summer, '2026-07-01T16:00:00.000Z');
    assert.equal(D.fromLocalInputValue('not a date'), null);
  });
});

test('calendar dates and due dates ignore DST', () => {
  withTz('Europe/London', () => {
    assert.equal(D.addDaysToDateString('2026-03-28', 2), '2026-03-30');
    assert.equal(D.addDaysToDateString('2026-10-24', 7), '2026-10-31');
    assert.equal(D.daysUntilDate('2026-04-01', new Date(2026, 2, 29, 23, 0)), 3);
    assert.equal(D.localNoonIso('2026-03-29'), '2026-03-29T11:00:00.000Z');
  });
});

test('validators for ISO UTC strings and calendar dates', () => {
  assert.ok(D.isIsoUtc('2026-01-01T00:00:00.000Z'));
  assert.ok(D.isIsoUtc('2026-01-01T00:00Z'));
  assert.ok(!D.isIsoUtc('2026-01-01T00:00:00+02:00'));
  assert.ok(!D.isIsoUtc('2026-01-01'));
  assert.ok(!D.isIsoUtc(12345));
  assert.ok(D.isDateString('2024-02-29'));
  assert.ok(!D.isDateString('2026-02-29'));
  assert.ok(!D.isDateString('2026-13-01'));
});

test('formatting helpers', () => {
  assert.equal(D.formatDaysAgo(0), 'today');
  assert.equal(D.formatDaysAgo(1), 'yesterday');
  assert.equal(D.formatDaysAgo(5), '5 days ago');
  assert.equal(D.formatDaysAgo(null), 'never');
  assert.equal(D.formatDuration(6 * 3600000), '6 h');
  assert.equal(D.formatDuration(3 * 86400000), '3 days');
  assert.equal(D.formatDuration(10 * 60000), '10 min');
});
