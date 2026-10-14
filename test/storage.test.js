'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage, WriteQueue, writeFileAtomic, renameWithRetry } = require('../lib/storage.js');
const { migrate, CURRENT_SCHEMA_VERSION, COLLECTIONS, SETTINGS_DEFAULTS } = require('../lib/migrations.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aquastar-test-'));
}

function makeStorage(dir, extra) {
  return new Storage(Object.assign({
    dir, collections: COLLECTIONS, objects: { settings: SETTINGS_DEFAULTS }, schemaVersion: CURRENT_SCHEMA_VERSION, migrate
  }, extra || {}));
}

test('writeFileAtomic writes the full content and leaves no temp files', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'x.json');
  await writeFileAtomic(file, '{"a":1}');
  await writeFileAtomic(file, '{"a":2}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}');
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
});

test('rename is retried on EPERM/EBUSY (Windows antivirus) and gives up on other errors', async () => {
  let calls = 0;
  const flaky = async () => { calls++; if (calls < 3) throw Object.assign(new Error('locked'), { code: calls === 1 ? 'EPERM' : 'EBUSY' }); };
  await renameWithRetry('a', 'b', { rename: flaky, baseDelay: 1 });
  assert.equal(calls, 3);
  let calls2 = 0;
  const broken = async () => { calls2++; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  await assert.rejects(renameWithRetry('a', 'b', { rename: broken, baseDelay: 1 }), /nope/);
  assert.equal(calls2, 1);
  let calls3 = 0;
  const always = async () => { calls3++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  await assert.rejects(renameWithRetry('a', 'b', { rename: always, baseDelay: 1, retries: 3 }), /busy/);
  assert.equal(calls3, 4);
});

test('write queue runs tasks for the same key strictly in order, even after a failure', async () => {
  const q = new WriteQueue();
  const order = [];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const p1 = q.run('k', async () => { await delay(20); order.push(1); });
  const p2 = q.run('k', async () => { order.push(2); throw new Error('boom'); });
  const p3 = q.run('k', async () => { await delay(1); order.push(3); });
  const p4 = q.run('other', async () => { order.push('other'); });
  await p1; await assert.rejects(p2, /boom/); await p3; await p4;
  assert.deepEqual(order.filter((x) => x !== 'other'), [1, 2, 3]);
  assert.equal(order[0], 'other', 'different keys do not wait for each other');
  await q.idle();
});

test('two quick saves cannot overwrite each other', async () => {
  const dir = tmpDir();
  const s = makeStorage(dir);
  await s.init();
  const saves = [];
  for (let i = 0; i < 25; i++) saves.push(s.save('entries', { tankId: 't', takenAt: '2026-01-01T00:00:00.000Z', readings: [], n: i }));
  await Promise.all(saves);
  assert.equal(s.list('entries').length, 25);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'entries.json'), 'utf8'));
  assert.equal(onDisk.records.length, 25);
  assert.equal(onDisk.schemaVersion, CURRENT_SCHEMA_VERSION);
  const again = makeStorage(dir);
  await again.init();
  assert.equal(again.list('entries').length, 25);
});

test('records get stable ids and timestamps; updates keep createdAt', async () => {
  const s = makeStorage(tmpDir());
  await s.init();
  const a = await s.save('tanks', { name: 'A' });
  assert.match(a.id, /^[0-9a-f-]{36}$/);
  assert.ok(a.createdAt && a.updatedAt);
  await new Promise((r) => setTimeout(r, 5));
  const b = await s.save('tanks', Object.assign({}, a, { name: 'B', createdAt: 'forged' }));
  assert.equal(b.id, a.id);
  assert.equal(b.createdAt, a.createdAt);
  assert.notEqual(b.updatedAt, a.updatedAt);
  assert.ok(Object.isFrozen(b), 'stored records are immutable');
  await assert.rejects(s.save('tanks', { id: '00000000-0000-4000-8000-000000000000', name: 'ghost' }), (e) => /no longer exists/.test(e.userMessage));
});

test('a failed write leaves memory consistent with disk', async () => {
  const dir = tmpDir();
  const s = makeStorage(dir);
  await s.init();
  await s.save('tanks', { name: 'kept' });
  const realPersist = s.persist.bind(s);
  s.persist = async () => { throw Object.assign(new Error('disk full'), { userMessage: 'Could not save tanks.' }); };
  await assert.rejects(s.save('tanks', { name: 'lost' }), /disk full/);
  assert.equal(s.list('tanks').length, 1);
  s.persist = realPersist;
  await s.save('tanks', { name: 'next' });
  assert.deepEqual(s.list('tanks').map((t) => t.name), ['kept', 'next']);
});

test('corrupted data file: app starts, file untouched, writes refused until reset', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'entries.json'), '{"schemaVersion":1,"records":[{"id":"x"');
  fs.writeFileSync(path.join(dir, 'tanks.json'), JSON.stringify({ schemaVersion: 1, records: [{ id: 'a', name: 'ok', createdAt: 'x', updatedAt: 'x' }] }));
  const s = makeStorage(dir);
  const res = await s.init();
  assert.deepEqual(res.corrupt, ['entries']);
  assert.equal(s.list('entries').length, 0);
  assert.equal(s.list('tanks').length, 1);
  await assert.rejects(s.save('entries', { a: 1 }), (e) => /damaged/.test(e.userMessage));
  assert.equal(fs.readFileSync(path.join(dir, 'entries.json'), 'utf8'), '{"schemaVersion":1,"records":[{"id":"x"');
  await s.resetStore('entries');
  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => /^entries\.corrupt-.*\.json$/.test(f)), 'damaged file kept for recovery');
  await s.save('entries', { a: 1 });
  assert.equal(s.list('entries').length, 1);
});

test('empty data folder and missing files start empty with defaults', async () => {
  const dir = path.join(tmpDir(), 'does', 'not', 'exist');
  const s = makeStorage(dir);
  const res = await s.init();
  assert.deepEqual(res.corrupt, []);
  assert.equal(s.getObject('settings').units.temperature, 'F');
  assert.deepEqual(s.list('tanks'), []);
});

test('files from a newer schema are never modified', async () => {
  const dir = tmpDir();
  const content = JSON.stringify({ schemaVersion: 999, records: [] });
  fs.writeFileSync(path.join(dir, 'tanks.json'), content);
  const s = makeStorage(dir);
  const res = await s.init();
  assert.deepEqual(res.corrupt, ['tanks']);
  assert.equal(fs.readFileSync(path.join(dir, 'tanks.json'), 'utf8'), content);
});

test('migration from unversioned (v0) files adds ids, timestamps and defaults without losing data', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'tanks.json'), JSON.stringify([{ name: 'Old tank', type: 'reef', style: 'sps', totalVolumeL: 100 }]));
  fs.writeFileSync(path.join(dir, 'entries.json'), JSON.stringify([{ tankId: 'x', takenAt: '2020-01-01T00:00:00.000Z', readings: [{ parameterId: 'alk', value: 8 }] }]));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ units: { temperature: 'C' } }));
  const s = makeStorage(dir);
  const res = await s.init();
  assert.equal(res.migratedFrom, 0);
  const t = s.list('tanks')[0];
  assert.equal(t.name, 'Old tank');
  assert.match(t.id, /^[0-9a-f-]{36}$/);
  assert.equal(t.archived, false);
  assert.equal(s.list('entries')[0].readings[0].bdl, false);
  assert.equal(s.getObject('settings').units.temperature, 'C');
  assert.equal(s.getObject('settings').units.volume, 'gal');
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'tanks.json'), 'utf8'));
  assert.equal(disk.schemaVersion, CURRENT_SCHEMA_VERSION);
});

test('migrate() is a pure function over the whole database', () => {
  const db = { tanks: [{ id: 'keep', name: 'T', createdAt: 'a', updatedAt: 'b' }], settings: {} };
  const out = migrate(db, 0);
  assert.equal(out.tanks[0].id, 'keep');
  assert.equal(out.tanks[0].createdAt, 'a');
  assert.deepEqual(db.tanks[0], { id: 'keep', name: 'T', createdAt: 'a', updatedAt: 'b' }, 'input not mutated');
  assert.ok(Array.isArray(out.entries));
});
