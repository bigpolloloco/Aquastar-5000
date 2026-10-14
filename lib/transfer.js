'use strict';
/*
 * Full data export / import as a plain folder (no zip library needed):
 *
 *   AquaStar-5000-export-YYYYMMDD-HHMMSS/
 *     data.json                  { app, schemaVersion, exportedAt, collections: {...}, settings }
 *     photos/<tankId>/<uuid>.<ext>
 *
 * Import reads and validates everything first and returns a preview; nothing
 * is overwritten until the user confirms. Photos are only copied when their
 * name matches our own uuid pattern and their bytes are a real image.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { inspectImage, PHOTO_FILE_RE, resolveInside } = require('./photos.js');
const { renameWithRetry, writeFileAtomic } = require('./storage.js');
const V = require('./validate.js');
const Dates = require('./dates.js');

const APP_ID = 'aquastar-5000';
const MAX_DATA_BYTES = 200 * 1024 * 1024;

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** Export everything into a new folder inside parentDir. */
async function exportTo(parentDir, { storage, photosRoot, schemaVersion, appVersion, prefix }) {
  await storage.flush();
  const folderName = (prefix || 'AquaStar-5000-export') + '-' + stamp(new Date());
  const target = path.join(parentDir, folderName);
  await fsp.mkdir(target, { recursive: false });
  const snap = storage.snapshot();
  const collections = {};
  storage.collections.forEach((n) => { collections[n] = snap[n]; });
  const body = {
    app: APP_ID,
    appVersion: appVersion || null,
    schemaVersion,
    exportedAt: new Date().toISOString(),
    collections,
    settings: snap.settings
  };
  await writeFileAtomic(path.join(target, 'data.json'), JSON.stringify(body, null, 1));
  let photoCount = 0;
  let missing = 0;
  for (const p of snap.photos || []) {
    if (!PHOTO_FILE_RE.test(p.fileName) || !V.UUID_RE.test(p.tankId)) continue;
    const src = resolveInside(photosRoot, p.tankId + '/' + p.fileName);
    if (!src) continue;
    const destDir = path.join(target, 'photos', p.tankId);
    await fsp.mkdir(destDir, { recursive: true });
    try {
      await fsp.copyFile(src, path.join(destDir, p.fileName));
      photoCount++;
    } catch (err) {
      missing++;
    }
  }
  const counts = {};
  storage.collections.forEach((n) => { counts[n] = (collections[n] || []).length; });
  return { folderName, target, counts, photoCount, missingPhotos: missing };
}

// Validators per collection used to sanity check imported records. Records
// keep their id and timestamps; anything that fails is skipped and counted.
function makeRecordCheckers(extra) {
  const base = {
    tanks: (r) => V.tank(r),
    parameters: (r) => V.customParam(Object.assign({}, r, { id: undefined })),
    entries: (r) => V.entry(r),
    maintenance: (r) => V.maintenance(r),
    dosing: (r) => V.dosing(r),
    photos: (r) => {
      if (!V.UUID_RE.test(r.tankId) || !PHOTO_FILE_RE.test(r.fileName)) throw new Error('bad photo record');
      return {
        tankId: r.tankId.toLowerCase(),
        ownerType: V.OWNER_TYPES.includes(r.ownerType) ? r.ownerType : 'tank',
        ownerId: typeof r.ownerId === 'string' && V.UUID_RE.test(r.ownerId) ? r.ownerId.toLowerCase() : null,
        fileName: r.fileName,
        mime: typeof r.mime === 'string' ? r.mime.slice(0, 10) : '',
        size: typeof r.size === 'number' ? r.size : 0,
        caption: typeof r.caption === 'string' ? r.caption.slice(0, 200) : '',
        takenAt: Dates.isIsoUtc(r.takenAt) ? r.takenAt : new Date().toISOString()
      };
    }
  };
  return Object.assign(base, extra || {});
}

function checkRecord(checker, raw) {
  if (!V.isPlainObject(raw) || typeof raw.id !== 'string' || !V.UUID_RE.test(raw.id)) throw new Error('missing id');
  const clean = checker(Object.assign({}, raw, { id: undefined }));
  const now = new Date().toISOString();
  return Object.assign({}, clean, {
    // Keep extra stored fields that validators recompute (e.g. tank.marine).
    ...(raw.marine !== undefined && typeof raw.marine === 'boolean' ? { marine: raw.marine } : {}),
    ...(typeof raw.archivedAt === 'string' && Dates.isIsoUtc(raw.archivedAt) ? { archivedAt: raw.archivedAt } : {}),
    id: raw.id.toLowerCase(),
    createdAt: Dates.isIsoUtc(raw.createdAt) ? raw.createdAt : now,
    updatedAt: Dates.isIsoUtc(raw.updatedAt) ? raw.updatedAt : now
  });
}

/**
 * Read and validate an export folder. Returns a pending import object:
 * { db, counts, skipped, photos: [{src, tankId, fileName}], fromVersion }.
 */
async function readImport(folder, { schemaVersion, migrate, collections, checkers, sanitizeSettings }) {
  const dataFile = path.join(folder, 'data.json');
  let stat;
  try {
    stat = await fsp.stat(dataFile);
  } catch (err) {
    throw Object.assign(new Error('no data.json'), { userMessage: 'That folder is not an AquaStar export (data.json is missing).' });
  }
  if (stat.size > MAX_DATA_BYTES) throw Object.assign(new Error('too big'), { userMessage: 'The export file is too large to import.' });
  let body;
  try {
    let text = await fsp.readFile(dataFile, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    body = JSON.parse(text);
  } catch (err) {
    throw Object.assign(new Error('bad json'), { userMessage: 'The export file is damaged and cannot be read.' });
  }
  if (!V.isPlainObject(body) || body.app !== APP_ID || !V.isPlainObject(body.collections)) {
    throw Object.assign(new Error('bad shape'), { userMessage: 'That folder does not contain an AquaStar 5000 export.' });
  }
  const version = Number(body.schemaVersion);
  if (!Number.isInteger(version) || version < 0) throw Object.assign(new Error('bad version'), { userMessage: 'The export has an unknown format version.' });
  if (version > schemaVersion) {
    throw Object.assign(new Error('newer version'), { userMessage: 'This export was made by a newer version of AquaStar 5000. Update the app first.' });
  }
  let db = {};
  collections.forEach((n) => { db[n] = Array.isArray(body.collections[n]) ? body.collections[n] : []; });
  db.settings = V.isPlainObject(body.settings) ? body.settings : {};
  if (version < schemaVersion) db = migrate(db, version);

  const allCheckers = makeRecordCheckers(checkers);
  const skipped = {};
  const counts = {};
  const out = {};
  collections.forEach((n) => {
    const checker = allCheckers[n];
    out[n] = [];
    skipped[n] = 0;
    const seen = new Set();
    (db[n] || []).forEach((raw) => {
      try {
        const rec = checker ? checkRecord(checker, raw) : null;
        if (!rec || seen.has(rec.id)) throw new Error('invalid or duplicate');
        seen.add(rec.id);
        out[n].push(rec);
      } catch (err) {
        skipped[n]++;
      }
    });
    counts[n] = out[n].length;
  });
  // Drop records that point at tanks that are not part of the import.
  const tankIds = new Set(out.tanks.map((t) => t.id));
  collections.forEach((n) => {
    if (n === 'tanks') return;
    const before = out[n].length;
    out[n] = out[n].filter((r) => r.tankId === undefined || tankIds.has(r.tankId));
    skipped[n] += before - out[n].length;
    counts[n] = out[n].length;
  });
  out.settings = sanitizeSettings ? sanitizeSettings(db.settings) : {};

  const photos = [];
  let badPhotos = 0;
  for (const p of out.photos || []) {
    const src = resolveInside(folder, path.join('photos', p.tankId, p.fileName));
    if (!src) { badPhotos++; continue; }
    try {
      await inspectImage(src);
      photos.push({ src, tankId: p.tankId, fileName: p.fileName });
    } catch (err) {
      badPhotos++;
    }
  }
  return { db: out, counts, skipped, photos, badPhotos, fromVersion: version, exportedAt: Dates.isIsoUtc(body.exportedAt) ? body.exportedAt : null };
}

/**
 * Replace all current data with a validated pending import.
 * Photos are staged first, then swapped in, so a failure midway leaves the
 * previous photos folder in place.
 */
async function applyImport(pending, { storage, photosRoot, collections }) {
  await storage.flush();
  const parent = path.dirname(photosRoot);
  const staging = path.join(parent, 'photos-import-' + Date.now());
  await fsp.mkdir(staging, { recursive: true });
  try {
    for (const p of pending.photos) {
      const dir = path.join(staging, p.tankId);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.copyFile(p.src, path.join(dir, p.fileName));
    }
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw Object.assign(new Error('photo copy failed'), { userMessage: 'Copying photos failed (' + (err.code || 'error') + '). Nothing was changed.' });
  }
  const copied = new Set(pending.photos.map((p) => p.tankId + '/' + p.fileName));
  const photoRecords = pending.db.photos.filter((p) => copied.has(p.tankId + '/' + p.fileName));

  for (const n of collections) {
    await storage.replaceAll(n, n === 'photos' ? photoRecords : pending.db[n]);
  }
  await storage.replaceAll('settings', Object.assign({}, storage.getObject('settings'), pending.db.settings));

  const old = path.join(parent, 'photos-old-' + Date.now());
  let hadOld = true;
  try {
    await renameWithRetry(photosRoot, old);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    hadOld = false;
  }
  await renameWithRetry(staging, photosRoot);
  if (hadOld) await fsp.rm(old, { recursive: true, force: true });
  return { photos: photoRecords.length };
}

module.exports = { exportTo, readImport, applyImport, makeRecordCheckers, APP_ID, stamp };
