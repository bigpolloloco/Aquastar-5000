'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../lib/storage.js');
const { migrate, CURRENT_SCHEMA_VERSION, COLLECTIONS, SETTINGS_DEFAULTS } = require('../lib/migrations.js');
const { createService } = require('../lib/service.js');
const { parseCsv } = require('../lib/csv.js');
const transfer = require('../lib/transfer.js');

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquastar-svc-'));
  const storage = new Storage({ dir: path.join(root, 'data'), collections: COLLECTIONS, objects: { settings: SETTINGS_DEFAULTS }, schemaVersion: CURRENT_SCHEMA_VERSION, migrate });
  await storage.init();
  const photosRoot = path.join(root, 'photos');
  const svc = createService({ storage, photosRoot });
  return { root, storage, photosRoot, svc };
}

const reef = { name: 'Main Reef', type: 'reef', style: 'sps', displayVolumeL: 300, totalVolumeL: 400 };

test('creating a tank applies the style preset and marine flag', async () => {
  const { svc } = await setup();
  const t = await svc.saveTank(reef);
  assert.equal(t.marine, true);
  assert.equal(t.params.alk.enabled, true);
  assert.equal(t.params.alk.maxDelta, 0.3);
  assert.equal(t.params.alk.min, 7.5);
  const fw = await svc.saveTank({ name: 'Community', type: 'freshwater', style: 'community', totalVolumeL: 150 });
  assert.equal(fw.marine, false);
  assert.ok(!fw.params.alk);
  const qt = await svc.saveTank({ name: 'QT', type: 'quarantine', style: 'fresh', totalVolumeL: 40 });
  assert.equal(qt.params.salinity.enabled, false, 'salinity only for marine QT');
  const planted = await svc.saveTank({ name: 'P', type: 'planted', style: 'hightech', totalVolumeL: 60 });
  assert.ok(planted.params.co2dc && planted.params.iron && planted.params.gh);
});

test('entries validate against parameter limits and remember the last tank', async () => {
  const { svc } = await setup();
  const t = await svc.saveTank(reef);
  const e = await svc.saveEntry({ tankId: t.id, takenAt: '2026-05-01T08:00:00.000Z', readings: [{ parameterId: 'alk', value: 8.2 }, { parameterId: 'phosphate', value: 0.02, bdl: true }] });
  assert.equal(e.readings[1].bdl, true);
  assert.equal(svc.getSettings().lastTankId, t.id);
  await assert.rejects(svc.saveEntry({ tankId: t.id, takenAt: '2026-05-01T08:00:00.000Z', readings: [{ parameterId: 'ph', value: 20 }] }), (err) => /pH must be between/.test(err.userMessage));
  await assert.rejects(svc.saveEntry({ tankId: '6f1c2b0e-8a1d-4c3e-9f2a-1b2c3d4e5f60', takenAt: '2026-05-01T08:00:00.000Z', readings: [{ parameterId: 'ph', value: 8 }] }), (err) => /no longer exists/.test(err.userMessage));
  const edited = await svc.saveEntry(Object.assign({}, e, { readings: [{ parameterId: 'alk', value: 8.4 }] }));
  assert.equal(edited.id, e.id);
  assert.equal(svc.listEntries({ tankId: t.id }).length, 1);
  await svc.deleteEntry({ id: e.id });
  assert.equal(svc.listEntries({ tankId: t.id }).length, 0);
});

test('custom parameters: create, use, refuse delete while in use', async () => {
  const { svc } = await setup();
  const t = await svc.saveTank(reef);
  const iodine = await svc.saveCustomParam({ name: 'Iodine', unit: 'ppm', decimals: 3, defaultMin: 0.04, defaultMax: 0.08 });
  assert.match(iodine.id, /^custom-[0-9a-f-]{36}$/);
  await svc.saveTank(Object.assign({}, t, { params: Object.assign({}, t.params, { [iodine.id]: { enabled: true, min: 0.04, max: 0.08, maxDelta: null, intervalDays: 14 } }) }));
  await svc.saveEntry({ tankId: t.id, takenAt: '2026-05-01T08:00:00.000Z', readings: [{ parameterId: iodine.id, value: 0.06 }] });
  await assert.rejects(svc.deleteCustomParam({ id: iodine.id }), (e) => /used by 1 logged test/.test(e.userMessage));
  await assert.rejects(svc.saveCustomParam({ name: 'iodine' }), (e) => /already exists/.test(e.userMessage));
});

test('water changes and dose changes become chart events', async () => {
  const { svc } = await setup();
  const t = await svc.saveTank(reef);
  await svc.saveMaintenance({ tankId: t.id, performedAt: '2026-05-02T08:00:00.000Z', type: 'water_change', volumeL: 40 });
  await svc.saveMaintenance({ tankId: t.id, performedAt: '2026-05-03T08:00:00.000Z', type: 'glass' });
  await svc.saveDosing({ tankId: t.id, dosedAt: '2026-05-04T08:00:00.000Z', product: 'Alk A', category: 'alk', amount: 12, unit: 'ml', kind: 'daily' });
  const ev = svc.events({ tankId: t.id });
  assert.deepEqual(ev.map((e) => e.kind), ['water_change', 'dose_change']);
  assert.match(ev[0].detail, /Water change/);
});

test('deleting a tank requires the typed name and removes history and photos', async () => {
  const { svc, storage, photosRoot } = await setup();
  const t = await svc.saveTank(reef);
  const keep = await svc.saveTank({ name: 'Other', type: 'freshwater', style: 'community', totalVolumeL: 100 });
  await svc.saveEntry({ tankId: t.id, takenAt: '2026-05-01T08:00:00.000Z', readings: [{ parameterId: 'alk', value: 8 }] });
  await svc.saveEntry({ tankId: keep.id, takenAt: '2026-05-01T08:00:00.000Z', readings: [{ parameterId: 'ph', value: 7 }] });
  fs.mkdirSync(path.join(photosRoot, t.id), { recursive: true });
  const fileName = '11111111-2222-4333-8444-555555555555.jpg';
  fs.writeFileSync(path.join(photosRoot, t.id, fileName), JPG);
  await svc.addPhotoRecord({ tankId: t.id, ownerType: 'tank', ownerId: null }, { fileName, type: 'jpg', size: JPG.length, mtimeMs: Date.now() });
  await assert.rejects(svc.deleteTank({ id: t.id, confirmName: 'main reef' }), (e) => /does not match/.test(e.userMessage));
  assert.equal(storage.list('tanks').length, 2);
  await svc.deleteTank({ id: t.id, confirmName: 'Main Reef' });
  assert.equal(storage.list('tanks').length, 1);
  assert.equal(storage.list('entries').length, 1);
  assert.equal(storage.list('photos').length, 0);
  assert.ok(!fs.existsSync(path.join(photosRoot, t.id)));
});

test('missing photo file is reported, not fatal', async () => {
  const { svc } = await setup();
  const t = await svc.saveTank(reef);
  const rec = await svc.addPhotoRecord({ tankId: t.id, ownerType: 'tank', ownerId: null }, { fileName: '11111111-2222-4333-8444-555555555555.png', type: 'png', size: 10, mtimeMs: 0 });
  const p = await svc.getPhoto({ id: rec.id });
  assert.equal(p.exists, false);
  assert.match(p.url, /^app:\/\/aquastar\/photos\//);
});

test('CSV import with \\r\\n line endings via column mapping', async () => {
  const { svc } = await setup();
  const t = await svc.saveTank(reef);
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'reef-history-crlf.csv'), 'utf8');
  const rows = parseCsv(text).rows.slice(1);
  const mapping = {
    tankId: t.id, dateColumn: 0, timeColumn: null, dateFormat: 'ymd', methodColumn: null, noteColumn: 5,
    columns: [
      { index: 1, parameterId: 'alk', unit: 'dkh' },
      { index: 2, parameterId: 'calcium', unit: 'canonical' },
      { index: 3, parameterId: 'nitrate', unit: 'canonical' },
      { index: 4, parameterId: 'phosphate', unit: 'canonical' }
    ]
  };
  const res = await svc.importCsvEntries(rows, mapping);
  assert.equal(res.imported, 4);
  assert.equal(res.skipped, 1);
  assert.match(res.problems[0], /Line 5: Alkalinity "abc" is not a number/);
  const entries = svc.listEntries({ tankId: t.id });
  const bdl = entries.find((e) => e.takenAt.startsWith('2025-11-08'));
  assert.deepEqual(bdl.readings.find((r) => r.parameterId === 'phosphate'), { parameterId: 'phosphate', value: 0.02, bdl: true });
  const noCa = entries.find((e) => e.note === 'calcium skipped');
  assert.ok(!noCa.readings.some((r) => r.parameterId === 'calcium'), 'empty cells are skipped');
  assert.equal(entries.find((e) => e.takenAt.startsWith('2025-11-04')).note, 'after water change, 20%');
});

test('CSV import converts units (°F, ppt, meq/L) to canonical', async () => {
  const { svc } = await setup();
  const t = await svc.saveTank(reef);
  const rows = [['2026-01-01', '77', '35', '3']];
  const res = await svc.importCsvEntries(rows, {
    tankId: t.id, dateColumn: 0, timeColumn: null, dateFormat: 'ymd', methodColumn: null, noteColumn: null,
    columns: [{ index: 1, parameterId: 'temp', unit: 'F' }, { index: 2, parameterId: 'salinity', unit: 'ppt' }, { index: 3, parameterId: 'alk', unit: 'meq' }]
  });
  assert.equal(res.imported, 1);
  const r = svc.listEntries({ tankId: t.id })[0].readings;
  assert.ok(Math.abs(r.find((x) => x.parameterId === 'temp').value - 25) < 1e-6);
  assert.ok(Math.abs(r.find((x) => x.parameterId === 'salinity').value - 1.02637) < 1e-6);
  assert.ok(Math.abs(r.find((x) => x.parameterId === 'alk').value - 8.4) < 1e-6);
});

test('CSV export rows: display units, flags and formula-safe text', async () => {
  const { svc } = await setup();
  const t = await svc.saveTank(Object.assign({}, reef, { name: '=Evil Tank' }));
  await svc.saveEntry({ tankId: t.id, takenAt: '2026-05-01T08:00:00.000Z', method: '+Salifert', readings: [{ parameterId: 'temp', value: 25 }, { parameterId: 'phosphate', value: 0.02, bdl: true }] });
  const rows = svc.csvRows('entries');
  assert.equal(rows[0][0], 'Tank');
  const temp = rows.find((r) => r[3] === 'Temperature');
  assert.equal(temp[4], 77);
  assert.equal(temp[5], '°F');
  const po4 = rows.find((r) => r[3] === 'Phosphate');
  assert.equal(po4[6], 'yes');
  const { toCsv } = require('../lib/csv.js');
  const out = toCsv(rows);
  assert.ok(out.includes("'=Evil Tank"));
  assert.ok(out.includes("'+Salifert"));
});

test('export then import restores all data and photos', async () => {
  const a = await setup();
  const t = await a.svc.saveTank(reef);
  await a.svc.saveEntry({ tankId: t.id, takenAt: '2026-05-01T08:00:00.000Z', readings: [{ parameterId: 'alk', value: 8 }] });
  await a.svc.saveMaintenance({ tankId: t.id, performedAt: '2026-05-02T08:00:00.000Z', type: 'water_change', volumeL: 40 });
  await a.svc.saveDosing({ tankId: t.id, dosedAt: '2026-05-04T08:00:00.000Z', product: 'Alk A', amount: 12, unit: 'ml', kind: 'daily' });
  await a.svc.saveSettings({ units: { temperature: 'C' } });
  const fileName = '11111111-2222-4333-8444-555555555555.jpg';
  fs.mkdirSync(path.join(a.photosRoot, t.id), { recursive: true });
  fs.writeFileSync(path.join(a.photosRoot, t.id, fileName), JPG);
  await a.svc.addPhotoRecord({ tankId: t.id, ownerType: 'tank', ownerId: null }, { fileName, type: 'jpg', size: JPG.length, mtimeMs: Date.now() });

  const exportParent = fs.mkdtempSync(path.join(os.tmpdir(), 'aquastar-export-'));
  const out = await transfer.exportTo(exportParent, { storage: a.storage, photosRoot: a.photosRoot, schemaVersion: CURRENT_SCHEMA_VERSION });
  assert.equal(out.photoCount, 1);
  assert.ok(fs.existsSync(path.join(out.target, 'data.json')));

  // "Another machine": a fresh install with different data
  const b = await setup();
  await b.svc.saveTank({ name: 'To be replaced', type: 'freshwater', style: 'community', totalVolumeL: 50 });
  const preview = await transfer.readImport(out.target, { schemaVersion: CURRENT_SCHEMA_VERSION, migrate, collections: COLLECTIONS });
  assert.equal(preview.counts.tanks, 1);
  assert.equal(preview.counts.entries, 1);
  assert.equal(preview.photos.length, 1);
  assert.equal(b.storage.list('tanks')[0].name, 'To be replaced', 'nothing changes before confirmation');
  await transfer.applyImport(Object.assign({}, preview, { db: Object.assign({}, preview.db, { settings: { units: { temperature: 'C' } } }) }), { storage: b.storage, photosRoot: b.photosRoot, collections: COLLECTIONS });
  assert.deepEqual(b.storage.list('tanks').map((x) => x.id), [t.id]);
  assert.equal(b.storage.list('entries').length, 1);
  assert.equal(b.storage.list('maintenance').length, 1);
  assert.equal(b.storage.list('dosing').length, 1);
  assert.equal(b.storage.getObject('settings').units.temperature, 'C');
  const p = await b.svc.getPhoto({ id: b.storage.list('photos')[0].id });
  assert.equal(p.exists, true);
});

test('import refuses folders that are not exports and skips tampered records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquastar-bad-'));
  await assert.rejects(transfer.readImport(dir, { schemaVersion: 1, migrate, collections: COLLECTIONS }), (e) => /data.json is missing/.test(e.userMessage));
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ app: 'other', collections: {} }));
  await assert.rejects(transfer.readImport(dir, { schemaVersion: 1, migrate, collections: COLLECTIONS }), (e) => /does not contain/.test(e.userMessage));
  const tankId = '6f1c2b0e-8a1d-4c3e-9f2a-1b2c3d4e5f60';
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({
    app: 'aquastar-5000', schemaVersion: 1, collections: {
      tanks: [{ id: tankId, name: 'T', type: 'reef', style: 'sps', totalVolumeL: 100 }],
      entries: [
        { id: '6f1c2b0e-8a1d-4c3e-9f2a-1b2c3d4e5f61', tankId, takenAt: '2026-01-01T00:00:00.000Z', readings: [{ parameterId: 'alk', value: 8 }] },
        { id: '6f1c2b0e-8a1d-4c3e-9f2a-1b2c3d4e5f62', tankId, takenAt: 'bad', readings: [] },
        { id: '../../evil', tankId, takenAt: '2026-01-01T00:00:00.000Z', readings: [{ parameterId: 'alk', value: 8 }] }
      ],
      photos: [{ id: '6f1c2b0e-8a1d-4c3e-9f2a-1b2c3d4e5f63', tankId, fileName: '../../../etc/passwd' }]
    }
  }));
  const res = await transfer.readImport(dir, { schemaVersion: 1, migrate, collections: COLLECTIONS });
  assert.equal(res.counts.entries, 1);
  assert.equal(res.skipped.entries, 2);
  assert.equal(res.skipped.photos, 1);
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ app: 'aquastar-5000', schemaVersion: 99, collections: {} }));
  await assert.rejects(transfer.readImport(dir, { schemaVersion: 1, migrate, collections: COLLECTIONS }), (e) => /newer version/.test(e.userMessage));
});
