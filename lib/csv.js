'use strict';
/*
 * CSV parsing and writing (RFC 4180 style), standard library only.
 *
 * Parsing accepts \n, \r\n and lone \r line endings, a UTF-8 BOM, quoted
 * fields with embedded separators/newlines and doubled quotes, and detects
 * comma / semicolon / tab separators (European spreadsheets often use ';').
 *
 * Writing produces Excel- and LibreOffice-friendly files: UTF-8 BOM, \r\n line
 * endings, quoting where needed, and protection against formula injection:
 * any TEXT cell starting with = + - @ tab or carriage return is prefixed with
 * a single quote. Numeric cells are written untouched.
 */

function detectDelimiter(text) {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && counts[ch] !== undefined) counts[ch]++;
  }
  let best = ',';
  Object.keys(counts).forEach((k) => { if (counts[k] > counts[best]) best = k; });
  return best;
}

/** Parse CSV text into an array of rows (arrays of strings). */
function parseCsv(input, opts) {
  let text = String(input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = (opts && opts.delimiter) || detectDelimiter(text);
  const maxRows = (opts && opts.maxRows) || Infinity;
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const endRow = () => {
    row.push(field);
    field = '';
    // Skip completely empty lines.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') {
      endRow();
      i += text[i + 1] === '\n' ? 2 : 1;
      if (rows.length >= maxRows) return { rows, delimiter, truncated: true };
      continue;
    }
    if (ch === '\n') {
      endRow(); i++;
      if (rows.length >= maxRows) return { rows, delimiter, truncated: true };
      continue;
    }
    field += ch; i++;
  }
  if (field !== '' || row.length) endRow();
  return { rows, delimiter, truncated: false, unterminatedQuote: inQuotes };
}

const DANGEROUS_START = /^[=+\-@\t\r]/;

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  let s = String(value);
  if (DANGEROUS_START.test(s)) s = "'" + s;
  if (/[",\r\n;\t]/.test(s) || /^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Serialize rows to a CSV string with BOM and \r\n line endings. */
function toCsv(rows) {
  return '﻿' + rows.map((r) => r.map(escapeCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * Parse a date cell according to a chosen format. Returns an ISO UTC string.
 * Date-only values are placed at local noon so DST changes cannot move them to
 * another day. Optional time "HH:mm[:ss]" may follow the date or come from a
 * separate column.
 */
function parseDateCell(dateText, format, timeText) {
  const s = String(dateText || '').trim();
  if (!s) return null;
  if (format === 'iso') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    // ISO without zone = local time.
    return parseParts(s, 'ymd', timeText);
  }
  return parseParts(s, format, timeText);
}

function parseParts(s, format, timeText) {
  const m = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(s);
  if (!m) return null;
  let y, mo, d;
  if (format === 'ymd') { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if (format === 'mdy') { mo = +m[1]; d = +m[2]; y = +m[3]; }
  else if (format === 'dmy') { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else return null;
  if (y < 100) y += 2000;
  let hh = m[4] !== undefined ? +m[4] : null;
  let mm = m[5] !== undefined ? +m[5] : 0;
  let ss = m[6] !== undefined ? +m[6] : 0;
  let ampm = m[7];
  if (hh === null && timeText) {
    const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(String(timeText).trim());
    if (t) { hh = +t[1]; mm = +t[2]; ss = t[3] ? +t[3] : 0; ampm = t[4]; }
  }
  if (ampm && hh !== null) {
    if (hh < 1 || hh > 12) return null;
    const pm = /p/i.test(ampm);
    if (hh === 12) hh = pm ? 12 : 0; else if (pm) hh += 12;
  }
  if (hh === null) { hh = 12; mm = 0; ss = 0; }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return null;
  const date = new Date(y, mo - 1, d, hh, mm, ss);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.toISOString();
}

module.exports = { parseCsv, toCsv, escapeCell, detectDelimiter, parseDateCell };
