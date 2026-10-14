'use strict';
/*
 * JSON file storage for the main process.
 *
 * - One file per collection under <userData>/data/<name>.json:
 *     { "schemaVersion": N, "savedAt": ISO, "records": [...] }   (collections)
 *     { "schemaVersion": N, "savedAt": ISO, "value": {...} }       (objects, e.g. settings)
 * - Writes are atomic: write a temp file in the same folder, fsync, rename.
 *   On Windows the rename is retried on EPERM/EBUSY/EACCES, which antivirus or
 *   search indexers cause by briefly holding the file open.
 * - Writes are serialized per file with an in-memory queue. A mutation runs
 *   inside the queue against the last committed state and only becomes visible
 *   once the file has been written, so two quick saves can never overwrite
 *   each other and a failed write leaves memory consistent with disk.
 * - A file that cannot be parsed is marked corrupt: it is left untouched on
 *   disk, writes to it are refused, and the UI offers to start fresh (which
 *   moves the damaged file aside instead of deleting it).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

class StorageError extends Error {
  constructor(message, userMessage, code) {
    super(message);
    this.name = 'StorageError';
    this.userMessage = userMessage || message;
    if (code) this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function renameWithRetry(from, to, opts) {
  const retries = (opts && opts.retries) !== undefined ? opts.retries : 8;
  const baseDelay = (opts && opts.baseDelay) || 25;
  const rename = (opts && opts.rename) || fsp.rename;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (!RETRY_CODES.has(err.code) || attempt >= retries) throw err;
      await sleep(Math.min(baseDelay * Math.pow(2, attempt), 1000));
    }
  }
}

/** Atomically replace `file` with `data`. */
async function writeFileAtomic(file, data, opts) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + crypto.randomUUID() + '.tmp');
  let handle;
  try {
    handle = await fsp.open(tmp, 'w');
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } catch (err) {
    if (handle) { try { await handle.close(); } catch (e) { /* ignore */ } handle = null; }
    try { await fsp.unlink(tmp); } catch (e) { /* ignore */ }
    throw err;
  } finally {
    if (handle) await handle.close();
  }
  try {
    await renameWithRetry(tmp, file, opts);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch (e) { /* ignore */ }
    throw err;
  }
}

/** Per-key serialized task queue. A failed task does not block later ones. */
class WriteQueue {
  constructor() {
    this.tails = new Map();
  }
  run(key, task) {
    const prev = this.tails.get(key) || Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return next;
  }
  async idle() {
    while (this.tails.size) await Promise.all(Array.from(this.tails.values()));
  }
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    Object.keys(obj).forEach((k) => deepFreeze(obj[k]));
  }
  return obj;
}

class Storage {
  /**
   * @param {object} o
   * @param {string} o.dir           folder for the JSON files
   * @param {string[]} o.collections record collections
   * @param {object} o.objects       object stores and their default values
   * @param {number} o.schemaVersion current schema version
   * @param {function} o.migrate     (db, fromVersion) => db
   * @param {object} [o.logger]
   */
  constructor(o) {
    this.dir = o.dir;
    this.collections = o.collections.slice();
    this.objects = Object.assign({}, o.objects);
    this.schemaVersion = o.schemaVersion;
    this.migrate = o.migrate || ((db) => db);
    this.logger = o.logger || null;
    this.queue = new WriteQueue();
    this.state = Object.create(null);
    this.corrupt = new Set();
    this.writeOpts = o.writeOpts || {};
  }

  fileFor(name) {
    if (!this.isKnown(name)) throw new StorageError('Unknown store ' + name, 'Internal error: unknown data store.');
    return path.join(this.dir, name + '.json');
  }

  isKnown(name) {
    return this.collections.includes(name) || Object.prototype.hasOwnProperty.call(this.objects, name);
  }

  isObject(name) {
    return Object.prototype.hasOwnProperty.call(this.objects, name);
  }

  async readFile(name) {
    const file = this.fileFor(name);
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { missing: true };
      throw err;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    try {
      const parsed = JSON.parse(text);
      return { parsed };
    } catch (err) {
      return { corrupt: true };
    }
  }

  /** Normalize a parsed file into {version, data}; returns null if the shape is wrong. */
  unwrap(name, parsed) {
    if (this.isObject(name)) {
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
          return { version: Number(parsed.schemaVersion) || 0, data: parsed.value };
        }
        if (parsed.schemaVersion === undefined) return { version: 0, data: parsed };
      }
      return null;
    }
    if (Array.isArray(parsed)) return { version: 0, data: parsed }; // pre-versioned format
    if (parsed && Array.isArray(parsed.records)) {
      if (!parsed.records.every((r) => r && typeof r === 'object' && !Array.isArray(r))) return null;
      return { version: Number(parsed.schemaVersion) || 0, data: parsed.records };
    }
    return null;
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    // Temp files from a write interrupted by a crash or power loss are useless
    // (the rename never happened, so the real file is intact): remove them.
    try {
      for (const name of await fsp.readdir(this.dir)) {
        if (/^\..+\.tmp$/.test(name)) await fsp.unlink(path.join(this.dir, name)).catch(() => undefined);
      }
    } catch (err) { /* not critical */ }
    const db = {};
    const versions = [];
    const names = this.collections.concat(Object.keys(this.objects));
    for (const name of names) {
      let res;
      try {
        res = await this.readFile(name);
      } catch (err) {
        this.log('error', 'Could not read data file ' + name, err);
        res = { corrupt: true };
      }
      if (res.missing) {
        db[name] = this.isObject(name) ? clone(this.objects[name]) : [];
        continue;
      }
      const unwrapped = res.corrupt ? null : this.unwrap(name, res.parsed);
      if (!unwrapped) {
        this.corrupt.add(name);
        this.log('error', 'Data file ' + name + '.json is damaged; it was left untouched');
        db[name] = this.isObject(name) ? clone(this.objects[name]) : [];
        continue;
      }
      if (unwrapped.version > this.schemaVersion) {
        // Data written by a newer version of the app: do not touch it.
        this.corrupt.add(name);
        this.log('error', 'Data file ' + name + '.json was written by a newer version (schema ' + unwrapped.version + ')');
        db[name] = this.isObject(name) ? clone(this.objects[name]) : [];
        continue;
      }
      versions.push(unwrapped.version);
      db[name] = this.isObject(name) ? Object.assign(clone(this.objects[name]), unwrapped.data) : unwrapped.data;
    }

    const fromVersion = versions.length ? Math.min.apply(null, versions) : this.schemaVersion;
    let migrated = db;
    if (fromVersion < this.schemaVersion) {
      this.log('info', 'Migrating data from schema ' + fromVersion + ' to ' + this.schemaVersion);
      migrated = this.migrate(db, fromVersion);
    }
    names.forEach((name) => {
      this.state[name] = deepFreeze(this.isObject(name) ? migrated[name] : (migrated[name] || []));
    });
    if (fromVersion < this.schemaVersion) {
      for (const name of names) {
        if (!this.corrupt.has(name)) await this.persist(name, this.state[name]);
      }
    }
    return { corrupt: Array.from(this.corrupt), migratedFrom: fromVersion < this.schemaVersion ? fromVersion : null };
  }

  log(level, msg, err) {
    if (this.logger && this.logger[level]) this.logger[level](msg, err);
  }

  serialize(name, data) {
    const body = { schemaVersion: this.schemaVersion, savedAt: new Date().toISOString() };
    if (this.isObject(name)) body.value = data; else body.records = data;
    return JSON.stringify(body, null, 1);
  }

  async persist(name, data) {
    try {
      await writeFileAtomic(this.fileFor(name), this.serialize(name, data), this.writeOpts);
    } catch (err) {
      this.log('error', 'Write failed for ' + name, err);
      const hint = err.code === 'ENOSPC' ? ' The disk is full.' : RETRY_CODES.has(err.code) ? ' The file is locked by another program.' : '';
      throw new StorageError('write failed: ' + name, 'Could not save ' + name + '.' + hint + ' Your last change was not stored.', err.code);
    }
  }

  assertWritable(name) {
    if (this.corrupt.has(name)) {
      throw new StorageError('store corrupt: ' + name, 'The ' + name + ' data file is damaged. Choose "Start fresh" for it in Settings, or restore a backup.');
    }
  }

  /** Run a mutation serialized per store. mutate(current) returns {next, result}. */
  mutate(name, mutate) {
    return this.queue.run(name, async () => {
      this.assertWritable(name);
      const current = this.state[name];
      const { next, result } = mutate(current);
      if (next === current) return result;
      deepFreeze(next);
      await this.persist(name, next);
      this.state[name] = next;
      return result;
    });
  }

  list(name) {
    if (this.isObject(name)) throw new StorageError('not a collection', 'Internal error.');
    return this.state[name] || [];
  }

  get(name, id) {
    return this.list(name).find((r) => r.id === id) || null;
  }

  getObject(name) {
    if (!this.isObject(name)) throw new StorageError('not an object store', 'Internal error.');
    return this.state[name];
  }

  /**
   * Insert or update a record. New records get id/createdAt; updatedAt is
   * always refreshed. Returns the stored record.
   */
  save(name, record) {
    return this.mutate(name, (current) => {
      const now = new Date().toISOString();
      const idx = record.id ? current.findIndex((r) => r.id === record.id) : -1;
      let stored;
      const next = current.slice();
      if (idx >= 0) {
        stored = Object.assign({}, record, { id: current[idx].id, createdAt: current[idx].createdAt, updatedAt: now });
        next[idx] = stored;
      } else {
        if (record.id) throw new StorageError('record not found', 'That item no longer exists. It may have been deleted.');
        stored = Object.assign({}, record, { id: crypto.randomUUID(), createdAt: now, updatedAt: now });
        next.push(stored);
      }
      return { next, result: stored };
    });
  }

  /** Insert many new records in one write (CSV import). */
  insertMany(name, records) {
    return this.mutate(name, (current) => {
      const now = new Date().toISOString();
      const added = records.map((r) => Object.assign({}, r, { id: crypto.randomUUID(), createdAt: now, updatedAt: now }));
      return { next: current.concat(added), result: added };
    });
  }

  remove(name, id) {
    return this.mutate(name, (current) => {
      const next = current.filter((r) => r.id !== id);
      return { next: next.length === current.length ? current : next, result: next.length !== current.length };
    });
  }

  /** Remove every record matching a predicate; returns the removed records. */
  removeWhere(name, predicate) {
    return this.mutate(name, (current) => {
      const removed = current.filter(predicate);
      if (!removed.length) return { next: current, result: [] };
      return { next: current.filter((r) => !predicate(r)), result: removed };
    });
  }

  /** Apply fn(record) => record|null to every record (null = unchanged). */
  updateWhere(name, fn) {
    return this.mutate(name, (current) => {
      let changed = 0;
      const now = new Date().toISOString();
      const next = current.map((r) => {
        const u = fn(r);
        if (!u) return r;
        changed++;
        return Object.assign({}, u, { id: r.id, createdAt: r.createdAt, updatedAt: now });
      });
      return { next: changed ? next : current, result: changed };
    });
  }

  setObject(name, value) {
    return this.mutate(name, () => ({ next: value, result: value }));
  }

  replaceAll(name, data) {
    return this.queue.run(name, async () => {
      const value = deepFreeze(this.isObject(name) ? Object.assign(clone(this.objects[name]), data) : data.slice());
      await this.persist(name, value);
      this.state[name] = value;
      this.corrupt.delete(name);
      return true;
    });
  }

  /** Move a damaged file aside (kept for recovery) and start that store empty. */
  resetStore(name) {
    return this.queue.run(name, async () => {
      const file = this.fileFor(name);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try {
        await renameWithRetry(file, path.join(this.dir, name + '.corrupt-' + stamp + '.json'), this.writeOpts);
      } catch (err) {
        if (err.code !== 'ENOENT') throw new StorageError('reset failed', 'Could not move the damaged ' + name + ' file aside.', err.code);
      }
      const empty = deepFreeze(this.isObject(name) ? clone(this.objects[name]) : []);
      await this.persist(name, empty);
      this.state[name] = empty;
      this.corrupt.delete(name);
      this.log('warn', 'Store ' + name + ' was reset after corruption');
      return true;
    });
  }

  /** Snapshot of everything (for export/backup). */
  snapshot() {
    const out = {};
    this.collections.forEach((n) => { out[n] = this.state[n]; });
    Object.keys(this.objects).forEach((n) => { out[n] = this.state[n]; });
    return out;
  }

  /** Wait for every queued write to finish. */
  flush() {
    return this.queue.idle();
  }
}

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

module.exports = { Storage, StorageError, WriteQueue, writeFileAtomic, renameWithRetry, deepFreeze };
