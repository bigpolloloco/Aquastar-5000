'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../lib/storage.js');
const { migrate, CURRENT_SCHEMA_VERSION, COLLECTIONS, SETTINGS_DEFAULTS } = require('../lib/migrations.js');
const { createService } = require('../lib/service.js');
const { createKeeper, importCheckers } = require('../lib/keeper.js');
const { computeReminders, scheduleStatus, pickNotifications } = require('../lib/reminders.js');
const backup = require('../lib/backup.js');
const transfer = require('../lib/transfer.js');
const { desktopEntry, quoteExecArg, setLinuxAutostart } = require('../lib/autostart.js');
const D = require('../lib/dates.js');

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquastar-keeper-'));
  const storage = new Storage({ dir: path.join(root, 'data'), collections: COLLECTIONS, objects: { settings: SETTINGS_DEFAULTS }, schemaVersion: CURRENT_SCHEMA_VERSION, migrate });
  await storage.init();
  const photosRoot = path.join(root, 'photos');
  const service = createService({ storage, photosRoot });
  const keeper = createKeeper({ storage, service });
  const reef = await service.saveTank({ name: 'Reef', type: 'reef', style: 'mixed', totalVolumeL: 400 });
  const qt = await service.saveTank({ name: 'QT', type: 'quarantine', style: 'marine', totalVolumeL: 40 });
  return { root, storage, service, keeper, reef, qt, photosRoot };
}

const fish = (tankId, extra) => Object.assign({ tankId, commonName: 'Yellow tang', category: 'fish', quantity: 3, dateAdded: '2026-01-10', source: 'store', cost: 90 }, extra || {});

test('Phase 1 data migrates to schema 2 without loss', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquastar-mig-'));
  const tank = { id: '6f1c2b0e-8a1d-4c3e-9f2a-1b2c3d4e5f60', name: 'Old', type: 'reef', style: 'sps', totalVolumeL: 300, params: {}, archived: false, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' };
  const entry = { id: '6f1c2b0e-8a1d-4c3e-9f2a-1b2c3d4e5f61', tankId: tank.id, takenAt: '2025-02-01T00:00:00.000Z', readings: [{ parameterId: 'alk', value: 8.1, bdl: false }], createdAt: 'x', updatedAt: 'x' };
  const wc = { id: '6f1c2b0e-8a1d-4c3e-9f2a-1b2c3d4e5f62', tankId: tank.id, performedAt: '2025-02-02T00:00:00.000Z', type: 'water_change', volumeL: 30, createdAt: 'x', updatedAt: 'x' };
  fs.writeFileSync(path.join(dir, 'tanks.json'), JSON.stringify({ schemaVersion: 1, records: [tank] }));
  fs.writeFileSync(path.join(dir, 'entries.json'), JSON.stringify({ schemaVersion: 1, records: [entry] }));
  fs.writeFileSync(path.join(dir, 'maintenance.json'), JSON.stringify({ schemaVersion: 1, records: [wc] }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ schemaVersion: 1, value: { units: { temperature: 'C', volume: 'L', salinity: 'ppt', alkalinity: 'meq', currency: 'EUR' }, lastTankId: tank.id, dashboard: { rotateSeconds: 20, autoRotate: false } } }));
  const s = new Storage({ dir, collections: COLLECTIONS, objects: { settings: SETTINGS_DEFAULTS }, schemaVersion: CURRENT_SCHEMA_VERSION, migrate });
  const res = await s.init();
  assert.equal(res.migratedFrom, 1);
  assert.deepEqual(s.list('entries')[0].readings, entry.readings);
  assert.equal(s.list('tanks')[0].name, 'Old');
  assert.equal(s.list('tanks')[0].cycling, null);
  assert.equal(s.list('maintenance')[0].scheduleId, null);
  assert.equal(s.list('maintenance')[0].volumeL, 30);
  const st = s.getObject('settings');
  assert.equal(st.units.currency, 'EUR');
  assert.equal(st.dashboard.rotateSeconds, 20);
  assert.equal(st.lastTankId, tank.id);
  assert.equal(st.backups.keep, 10);
  assert.equal(st.keepInTray, false);
  assert.deepEqual(s.list('livestock'), []);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'entries.json'), 'utf8'));
  assert.equal(onDisk.schemaVersion, 2);
});

test('livestock moves between tanks keep full history (whole and partial)', async () => {
  const { keeper, reef, qt, storage } = await setup();
  const l = await keeper.livestock.save(fish(qt.id, { qt: { inQt: true, startDate: '2026-01-10', releaseDate: '2026-02-10' } }));
  assert.deepEqual(l.history.map((h) => h.type), ['added', 'qt_start']);
  const part = await keeper.moveLivestock({ id: l.id, toTankId: reef.id, quantity: 1, date: '2026-02-11' });
  assert.equal(part.remaining.quantity, 2);
  assert.equal(part.remaining.tankId, qt.id);
  assert.equal(part.moved.quantity, 1);
  assert.equal(part.moved.tankId, reef.id);
  assert.equal(part.moved.splitFromId, l.id);
  assert.deepEqual(part.moved.history.map((h) => h.type), ['added', 'qt_start', 'moved']);
  assert.equal(part.moved.qt.inQt, false, 'moving out of a QT tank ends quarantine');
  assert.equal(part.remaining.qt.inQt, true);
  assert.equal(part.remaining.history.slice(-1)[0].type, 'moved_out');
  const whole = await keeper.moveLivestock({ id: l.id, toTankId: reef.id, quantity: 2, date: '2026-02-12' });
  assert.equal(whole.remaining, null);
  assert.equal(whole.moved.id, l.id);
  assert.equal(whole.moved.tankId, reef.id);
  assert.equal(storage.list('livestock').length, 2);
  await assert.rejects(keeper.moveLivestock({ id: l.id, toTankId: reef.id, quantity: 1, date: '2026-02-12' }), (e) => /already in that tank/.test(e.userMessage));
  await assert.rejects(keeper.moveLivestock({ id: l.id, toTankId: qt.id, quantity: 5, date: '2026-02-12' }), (e) => /Only 2 available/.test(e.userMessage));
});

test('status changes split quantities and record losses as chart markers', async () => {
  const { keeper, service, reef } = await setup();
  const l = await keeper.livestock.save(fish(reef.id));
  const res = await keeper.setLivestockStatus({ id: l.id, status: 'died', date: '2026-03-01', quantity: 1, cause: 'ich' });
  assert.equal(res.remaining.quantity, 2);
  assert.equal(res.moved.status, 'died');
  assert.equal(res.moved.lossCause, 'ich');
  const events = service.events({ tankId: reef.id });
  assert.ok(events.some((e) => e.kind === 'livestock_add'));
  const loss = events.find((e) => e.kind === 'livestock_loss');
  assert.ok(loss, 'loss marker');
  assert.match(loss.detail, /Died: 1 x Yellow tang \(ich\)/);
});

test('frags link to their mother colony', async () => {
  const { keeper, reef, storage } = await setup();
  const mother = await keeper.livestock.save({ tankId: reef.id, commonName: 'Green slimer', category: 'coral', quantity: 1, dateAdded: '2025-06-01' });
  const frag = await keeper.fragLivestock({ motherId: mother.id, count: 4, date: '2026-04-01' });
  assert.equal(frag.motherId, mother.id);
  assert.equal(frag.quantity, 4);
  assert.equal(frag.source, 'own_frag');
  assert.equal(frag.fragDate, '2026-04-01');
  const m2 = storage.get('livestock', mother.id);
  assert.equal(m2.history.slice(-1)[0].type, 'fragged');
  const sold = await keeper.setLivestockStatus({ id: frag.id, status: 'sold', date: '2026-05-01', quantity: 2 });
  assert.equal(sold.moved.motherId, mother.id, 'sold frags stay linked');
  assert.equal(sold.remaining.quantity, 2);
  await assert.rejects(keeper.livestock.save(Object.assign({}, mother, { motherId: mother.id })), (e) => /own mother/.test(e.userMessage));
});

test('schedules: due/overdue status, completion creates a log entry, manual logs count', async () => {
  const { keeper, service, reef, storage } = await setup();
  const wc = await keeper.schedules.save({ tankId: reef.id, title: '20% water change', kind: 'water_change', intervalDays: 7, startDate: '2026-01-01', volumePercent: 20 });
  const now = new Date(2026, 0, 3, 10);
  let st = scheduleStatus(wc, { maintenance: [], entries: [] }, now);
  assert.equal(st.state, 'overdue');
  assert.equal(st.dueIn, -2);
  const res = await keeper.completeSchedule({ id: wc.id, performedAt: new Date(2026, 0, 3, 9).toISOString() });
  assert.equal(res.maintenance.type, 'water_change');
  assert.equal(res.maintenance.volumeL, 80);
  assert.equal(res.maintenance.scheduleId, wc.id);
  const after = storage.get('schedules', wc.id);
  st = scheduleStatus(after, { maintenance: storage.list('maintenance'), entries: [] }, now);
  assert.equal(st.dueDate, '2026-01-10');
  assert.equal(st.state, 'upcoming');
  // A manual water change also resets the schedule
  await service.saveMaintenance({ tankId: reef.id, performedAt: new Date(2026, 0, 6, 9).toISOString(), type: 'water_change', volumeL: 50 });
  st = scheduleStatus(after, { maintenance: storage.list('maintenance'), entries: [] }, now);
  assert.equal(st.dueDate, '2026-01-13');
  // Test reminders are completed by logging the test
  const alk = await keeper.schedules.save({ tankId: reef.id, title: 'Test Alk', kind: 'test', parameterId: 'alk', intervalDays: 1, startDate: '2026-01-01' });
  assert.deepEqual(await keeper.completeSchedule({ id: alk.id }), { openQuickEntry: true, tankId: reef.id, parameterId: 'alk' });
  await service.saveEntry({ tankId: reef.id, takenAt: new Date(2026, 0, 3, 8).toISOString(), readings: [{ parameterId: 'alk', value: 8 }] });
  st = scheduleStatus(storage.get('schedules', alk.id), { entries: storage.list('entries'), maintenance: [] }, now);
  assert.equal(st.dueDate, '2026-01-04');
});

test('reminders: overdue tasks, treatment end dates, expiring reagents, QT release', async () => {
  const { keeper, reef, qt } = await setup();
  await keeper.schedules.save({ tankId: reef.id, title: 'Clean skimmer cup', kind: 'skimmer', intervalDays: 3, startDate: D.addDaysToDateString(D.localDateString(new Date()), -5) });
  await keeper.treatments.save({ tankId: qt.id, medication: 'Copper', method: 'medication', dose: 'per label', startDate: D.addDaysToDateString(D.localDateString(new Date()), -14), plannedEndDate: D.localDateString(new Date()) });
  await keeper.equipment.save({ tankId: null, category: 'test_kit', brand: 'Salifert', model: 'Alk', reagents: [{ name: 'Reagent 2', lot: 'A1', expires: D.addDaysToDateString(D.localDateString(new Date()), 10) }, { name: 'Old', expires: D.addDaysToDateString(D.localDateString(new Date()), -1) }] });
  await keeper.livestock.save(fish(qt.id, { qt: { inQt: true, startDate: '2026-01-01', releaseDate: D.addDaysToDateString(D.localDateString(new Date()), -1) } }));
  const r = keeper.reminders();
  const kinds = r.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['qt', 'reagent', 'reagent', 'schedule', 'treatment']);
  const expired = r.find((x) => x.kind === 'reagent' && x.level === 'ALERT');
  assert.match(expired.message, /Expired reagent: Salifert Alk - Old/);
  assert.match(r.find((x) => x.kind === 'treatment').message, /reaches its planned end today/);
  assert.match(r.find((x) => x.kind === 'schedule').message, /overdue by 5 days/);
  // Notifications: once per key per day
  const first = pickNotifications(r, {}, new Date());
  assert.equal(first.toNotify.length, r.length);
  const second = pickNotifications(r, first.notified, new Date());
  assert.equal(second.toNotify.length, 0);
  const tomorrow = new Date(Date.now() + 86400000);
  assert.equal(pickNotifications(r, first.notified, tomorrow).toNotify.length, r.length, 'still-due items are shown again the next day / next launch');
});

test('reminders ignore archived tanks and inactive schedules', () => {
  const tanks = [{ id: 'a', name: 'A', archived: true }, { id: 'b', name: 'B' }];
  const schedules = [
    { id: '1', tankId: 'a', title: 'x', kind: 'glass', intervalDays: 1, startDate: '2020-01-01', active: true },
    { id: '2', tankId: 'b', title: 'y', kind: 'glass', intervalDays: 1, startDate: '2020-01-01', active: false }
  ];
  assert.deepEqual(computeReminders({ tanks, schedules }, new Date()), []);
});

test('deleting a tank removes its keeper records but keeps equipment', async () => {
  const { keeper, service, reef, storage } = await setup();
  await keeper.livestock.save(fish(reef.id));
  await keeper.journal.save({ tankId: reef.id, date: '2026-01-01T10:00:00.000Z', title: 'Spawning!', text: 'clownfish eggs' });
  await keeper.expenses.save({ tankId: reef.id, date: '2026-01-01', category: 'food', description: 'Mysis', amount: 12.5 });
  const heater = await keeper.equipment.save({ tankId: reef.id, category: 'heater', brand: 'Eheim', model: 'Jager 300' });
  await service.deleteTank({ id: reef.id, confirmName: 'Reef' });
  assert.equal(storage.list('livestock').length, 0);
  assert.equal(storage.list('journal').length, 0);
  assert.equal(storage.list('expenses').length, 0);
  assert.equal(storage.get('equipment', heater.id).tankId, null);
});

test('equipment reagents and calibrations get ids and are sorted', async () => {
  const { keeper } = await setup();
  const e = await keeper.equipment.save({ tankId: null, category: 'refractometer', brand: 'Generic', calibrations: [
    { date: '2026-01-01T10:00:00.000Z', standard: '35 ppt', reading: '1.026' },
    { date: '2026-03-01T10:00:00.000Z', standard: '35 ppt', reading: '1.0265' }
  ] });
  assert.ok(e.calibrations.every((c) => /^[0-9a-f-]{36}$/.test(c.id)));
  assert.equal(e.calibrations[0].date, '2026-03-01T10:00:00.000Z');
});

test('backups rotate and keep only the configured number', async () => {
  const { storage, photosRoot, root, reef } = await setup();
  fs.mkdirSync(path.join(photosRoot, reef.id), { recursive: true });
  const fileName = '11111111-2222-4333-8444-555555555555.jpg';
  fs.writeFileSync(path.join(photosRoot, reef.id, fileName), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]));
  await storage.save('photos', { tankId: reef.id, ownerType: 'tank', ownerId: null, fileName, mime: 'jpg', size: 44, caption: '', takenAt: new Date().toISOString() });
  const dir = path.join(root, 'backups');
  for (let i = 0; i < 5; i++) await backup.createBackup({ storage, photosRoot, backupsDir: dir, schemaVersion: CURRENT_SCHEMA_VERSION, kind: 'auto', keep: 3 });
  const list = await backup.listBackups(dir);
  assert.equal(list.length, 3);
  assert.ok(list.every((b) => b.kind === 'auto'));
  const first = list[0].name;
  assert.ok(fs.existsSync(path.join(dir, first, 'photos', reef.id, fileName)), 'photos included (hard link or copy)');
  // A backup restores like an import
  const preview = await transfer.readImport(path.join(dir, first), { schemaVersion: CURRENT_SCHEMA_VERSION, migrate, collections: COLLECTIONS, checkers: importCheckers() });
  assert.equal(preview.counts.tanks, 2);
  assert.equal(preview.photos.length, 1);
});

test('export/import keeps livestock history and schedule state', async () => {
  const a = await setup();
  const l = await a.keeper.livestock.save(fish(a.qt.id));
  await a.keeper.moveLivestock({ id: l.id, toTankId: a.reef.id, quantity: 3, date: '2026-02-01' });
  const s = await a.keeper.schedules.save({ tankId: a.reef.id, title: 'Glass', kind: 'glass', intervalDays: 2, startDate: '2026-01-01' });
  await a.keeper.completeSchedule({ id: s.id });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'aquastar-exp2-'));
  const out = await transfer.exportTo(parent, { storage: a.storage, photosRoot: a.photosRoot, schemaVersion: CURRENT_SCHEMA_VERSION });
  const preview = await transfer.readImport(out.target, { schemaVersion: CURRENT_SCHEMA_VERSION, migrate, collections: COLLECTIONS, checkers: importCheckers() });
  const imported = preview.db.livestock[0];
  assert.deepEqual(imported.history.map((h) => h.type), ['added', 'moved']);
  assert.ok(preview.db.schedules[0].lastDoneAt);
});

test('Linux autostart desktop entry quoting', async () => {
  assert.equal(quoteExecArg('/opt/aquastar/aquastar-5000'), '/opt/aquastar/aquastar-5000');
  assert.equal(quoteExecArg('/home/me/Apps/AquaStar 5000.AppImage'), '"/home/me/Apps/AquaStar 5000.AppImage"');
  assert.equal(quoteExecArg('/tmp/a$b'), '"/tmp/a\\\\$b"');
  assert.equal(quoteExecArg('100%'), '100%%');
  const entry = desktopEntry({ name: 'AquaStar 5000', comment: 'x\ny', exec: '/opt/A B/app', args: ['--hidden'], icon: 'aquastar-5000' });
  assert.match(entry, /^\[Desktop Entry\]\nType=Application/);
  assert.match(entry, /\nExec="\/opt\/A B\/app" --hidden\n/);
  assert.match(entry, /\nComment=x y\n/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquastar-xdg-'));
  await setLinuxAutostart(true, { configDir: dir, name: 'AquaStar 5000', exec: '/opt/a', args: [] });
  assert.ok(fs.existsSync(path.join(dir, 'autostart', 'aquastar-5000.desktop')));
  await setLinuxAutostart(false, { configDir: dir });
  assert.ok(!fs.existsSync(path.join(dir, 'autostart', 'aquastar-5000.desktop')));
});
