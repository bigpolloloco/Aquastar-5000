'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseCsv, toCsv, escapeCell, parseDateCell } = require('../lib/csv.js');

const FIXTURES = path.join(__dirname, 'fixtures');

test('parses \\n and \\r\\n line endings identically', () => {
  const lf = 'Date,Alk,Note\n2026-01-01,8.2,"a, b"\n2026-01-02,8.4,"line1\nline2"\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const a = parseCsv(lf).rows;
  const b = parseCsv(crlf).rows;
  assert.deepEqual(a, [['Date', 'Alk', 'Note'], ['2026-01-01', '8.2', 'a, b'], ['2026-01-02', '8.4', 'line1\nline2']]);
  assert.deepEqual(b.slice(0, 2), a.slice(0, 2));
  assert.equal(b[2][2], 'line1\r\nline2'); // embedded newline preserved as written
});

test('fixture file with CRLF line endings and BOM', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'reef-history-crlf.csv'), 'utf8');
  assert.ok(text.includes('\r\n'), 'fixture really uses CRLF');
  const { rows, delimiter } = parseCsv(text);
  assert.equal(delimiter, ',');
  assert.deepEqual(rows[0], ['Date', 'Alk (dKH)', 'Calcium', 'Nitrate', 'Phosphate', 'Notes']);
  assert.equal(rows.length, 6);
  assert.equal(rows[3][4], '<0.02');
});

test('lone \\r line endings, blank lines, quotes and semicolons', () => {
  assert.deepEqual(parseCsv('a,b\r1,2\r\r3,4').rows, [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.deepEqual(parseCsv('"he said ""hi""",x').rows, [['he said "hi"', 'x']]);
  const semi = parseCsv('Date;Alk\n01.02.2026;8,2\n');
  assert.equal(semi.delimiter, ';');
  assert.deepEqual(semi.rows[1], ['01.02.2026', '8,2']);
  assert.deepEqual(parseCsv('a\tb\n1\t2').rows[1], ['1', '2']);
});

test('escaping: quoting, BOM, CRLF and formula injection protection', () => {
  const out = toCsv([['Name', 'Value'], ['=HYPERLINK("x")', 5], ['-12', -12], ['@SUM(A1)', 1.5], ['plain, text', 0], ['\tTab', null], ['+1', true]]);
  assert.ok(out.startsWith('﻿'));
  assert.ok(out.endsWith('\r\n'));
  const lines = out.slice(1).split('\r\n');
  assert.equal(lines[1], '"\'=HYPERLINK(""x"")",5');
  assert.equal(lines[2], "'-12,-12", 'text cell prefixed, numeric cell untouched');
  assert.equal(lines[3], "'@SUM(A1),1.5");
  assert.equal(lines[4], '"plain, text",0');
  assert.equal(lines[5], '"\'\tTab",');
  assert.equal(lines[6], "'+1,TRUE");
  assert.equal(escapeCell('\rx'), '"\'\rx"');
  assert.equal(escapeCell(NaN), '');
});

test('round trip: what we write we can read back', () => {
  const rows = [['A', 'B'], ['x"y', 'multi\nline'], ['=1+1', 3]];
  const parsed = parseCsv(toCsv(rows)).rows;
  assert.deepEqual(parsed[1], ['x"y', 'multi\nline']);
  assert.deepEqual(parsed[2], ["'=1+1", '3']);
});

test('date cells in several formats', () => {
  const old = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    assert.equal(parseDateCell('2026-03-08', 'ymd'), new Date(2026, 2, 8, 12).toISOString());
    assert.equal(parseDateCell('03/08/2026', 'mdy'), new Date(2026, 2, 8, 12).toISOString());
    assert.equal(parseDateCell('08/03/2026', 'dmy'), new Date(2026, 2, 8, 12).toISOString());
    assert.equal(parseDateCell('8.3.26', 'dmy'), new Date(2026, 2, 8, 12).toISOString());
    assert.equal(parseDateCell('2026-03-08 18:30', 'iso'), new Date(2026, 2, 8, 18, 30).toISOString());
    assert.equal(parseDateCell('2026-03-08T18:30:00Z', 'iso'), '2026-03-08T18:30:00.000Z');
    assert.equal(parseDateCell('03/08/2026', 'mdy', '7:15 PM'), new Date(2026, 2, 8, 19, 15).toISOString());
    assert.equal(parseDateCell('02/30/2026', 'mdy'), null);
    assert.equal(parseDateCell('13/13/2026', 'dmy'), null);
    assert.equal(parseDateCell('', 'ymd'), null);
    assert.equal(parseDateCell('hello', 'ymd'), null);
  } finally {
    if (old === undefined) delete process.env.TZ; else process.env.TZ = old;
  }
});
