'use strict';
/*
 * One shared leveled logger (INFO / WARN / ERROR) for the main process.
 * - Appends to <logs>/main.log, writes serialized through a promise chain.
 * - Size-based rotation: main.log -> main.1.log -> ... -> main.<maxFiles>.log.
 * - Every line is sanitized: the home folder, the app data folder and the OS
 *   user name are replaced so logs never reveal personal paths.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const LEVELS = { INFO: 10, WARN: 20, ERROR: 30 };
const MAX_LINE = 4000;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a function that strips personal data from log text.
 * `paths` are replaced by their labels (longest first), then generic
 * home-directory patterns, then the bare OS user name.
 */
function createSanitizer(paths) {
  const rules = [];
  const add = (p, label) => {
    if (!p || typeof p !== 'string' || p.length < 2) return;
    const variants = new Set([p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')]);
    variants.forEach((variant) => rules.push({ re: new RegExp(escapeRegExp(variant), 'gi'), label, len: variant.length }));
  };
  (paths || []).forEach(([p, label]) => add(p, label));
  let home = '';
  try { home = os.homedir(); } catch (e) { home = ''; }
  add(home, '~');
  rules.sort((a, b) => b.len - a.len);

  let user = '';
  try { user = os.userInfo().username || ''; } catch (e) { user = ''; }
  const userRe = user.length >= 3 ? new RegExp('\\b' + escapeRegExp(user) + '\\b', 'gi') : null;

  return function sanitize(text) {
    let s = String(text);
    rules.forEach((r) => { s = s.replace(r.re, r.label); });
    s = s.replace(/([A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])[^\\/\s"']+/gi, '$1<user>');
    s = s.replace(/(\/(?:home|Users)\/)[^/\s"']+/g, '$1<user>');
    if (userRe) s = s.replace(userRe, '<user>');
    // Never write raw binary/base64 blobs (e.g. image data URLs).
    s = s.replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, 'data:<omitted>');
    if (s.length > MAX_LINE) s = s.slice(0, MAX_LINE) + '...[truncated]';
    return s;
  };
}

function formatError(err) {
  if (!err) return '';
  if (err instanceof Error) {
    const code = err.code ? ' [' + err.code + ']' : '';
    return err.name + code + ': ' + err.message + (err.stack ? '\n' + err.stack.split('\n').slice(1, 8).join('\n') : '');
  }
  if (typeof err === 'object') {
    try { return JSON.stringify(err); } catch (e) { return String(err); }
  }
  return String(err);
}

function createLogger(options) {
  const opts = Object.assign({ fileName: 'main.log', maxBytes: 1024 * 1024, maxFiles: 3, level: 'INFO', console: false }, options);
  const dir = opts.dir;
  const file = path.join(dir, opts.fileName);
  const base = opts.fileName.replace(/\.log$/, '');
  const sanitize = createSanitizer(opts.sanitizePaths || []);
  let threshold = LEVELS[opts.level] || LEVELS.INFO;
  let size = null;
  let chain = Promise.resolve();
  let dirReady = false;

  const rotatedName = (i) => path.join(dir, base + '.' + i + '.log');

  async function rotate() {
    for (let i = opts.maxFiles - 1; i >= 1; i--) {
      try { await fsp.rename(rotatedName(i), rotatedName(i + 1)); } catch (e) { /* missing file is fine */ }
    }
    try { await fsp.rename(file, rotatedName(1)); } catch (e) { /* nothing to rotate */ }
    try { await fsp.unlink(rotatedName(opts.maxFiles + 1)); } catch (e) { /* not present */ }
    size = 0;
  }

  async function write(line) {
    if (!dirReady) {
      await fsp.mkdir(dir, { recursive: true });
      dirReady = true;
    }
    if (size === null) {
      try { size = (await fsp.stat(file)).size; } catch (e) { size = 0; }
    }
    const bytes = Buffer.byteLength(line, 'utf8');
    if (size > 0 && size + bytes > opts.maxBytes) await rotate();
    await fsp.appendFile(file, line, 'utf8');
    size += bytes;
  }

  function format(level, message, err) {
    const text = sanitize(String(message) + (err ? ' | ' + formatError(err) : ''));
    return new Date().toISOString() + ' [' + level + '] ' + text.replace(/\r?\n/g, '\n    ') + '\n';
  }

  function log(level, message, err) {
    if ((LEVELS[level] || 0) < threshold) return chain;
    const line = format(level, message, err);
    if (opts.console) {
      const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
      fn(line.trimEnd());
    }
    chain = chain.then(() => write(line)).catch((e) => {
      if (opts.console) console.error('Logger write failed: ' + e.code);
    });
    return chain;
  }

  return {
    info: (m, e) => log('INFO', m, e),
    warn: (m, e) => log('WARN', m, e),
    error: (m, e) => log('ERROR', m, e),
    log,
    sanitize,
    setLevel(level) { if (LEVELS[level]) threshold = LEVELS[level]; },
    flush() { return chain; },
    /** Synchronous write for the fatal path (uncaughtException) where we exit right after. */
    fatalSync(message, err) {
      const line = format('ERROR', message, err);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(file, line, 'utf8');
      } catch (e) { /* nothing else we can do */ }
    },
    file
  };
}

module.exports = { createLogger, createSanitizer, formatError, LEVELS };
