'use strict';
/*
 * Automatic and manual backups in <userData>/backups/.
 * A backup is the same folder format as an export (data.json + photos/), so
 * restoring is a normal import with preview. Photos are hard-linked when the
 * file system allows it (photos are never modified in place), so frequent
 * backups cost almost no extra disk space; otherwise they are copied.
 */
const fsp = require('fs').promises;
const path = require('path');
const transfer = require('./transfer.js');

const BACKUP_RE = /^(auto|manual|pre-import)-(\d{8})-(\d{6})(?:-(\d+))?$/;

async function listBackups(backupsDir) {
  let names;
  try {
    names = await fsp.readdir(backupsDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    const m = BACKUP_RE.exec(name);
    if (!m) continue;
    try {
      const st = await fsp.stat(path.join(backupsDir, name, 'data.json'));
      if (!st.isFile()) continue;
    } catch (e) {
      continue;
    }
    const d = m[2];
    const t = m[3];
    out.push({
      name,
      kind: m[1],
      createdAt: new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6)).toISOString()
    });
  }
  out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return out;
}

/** Keep the newest `keep` automatic/manual backups and the newest 5 pre-import copies. */
async function rotateBackups(backupsDir, keep) {
  const list = await listBackups(backupsDir);
  const regular = list.filter((b) => b.kind !== 'pre-import');
  const preImport = list.filter((b) => b.kind === 'pre-import');
  const doomed = regular.slice(Math.max(1, keep)).concat(preImport.slice(5));
  for (const b of doomed) {
    await fsp.rm(path.join(backupsDir, b.name), { recursive: true, force: true });
  }
  return doomed.map((b) => b.name);
}

async function createBackup(o) {
  await fsp.mkdir(o.backupsDir, { recursive: true });
  const out = await transfer.exportTo(o.backupsDir, {
    storage: o.storage,
    photosRoot: o.photosRoot,
    schemaVersion: o.schemaVersion,
    appVersion: o.appVersion,
    prefix: o.kind || 'auto',
    linkPhotos: true
  });
  const removed = await rotateBackups(o.backupsDir, o.keep || 10);
  return { name: out.folderName, photoCount: out.photoCount, removed };
}

module.exports = { listBackups, rotateBackups, createBackup, BACKUP_RE };
