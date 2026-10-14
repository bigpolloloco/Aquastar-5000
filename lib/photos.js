'use strict';
/*
 * Photo file handling for the main process.
 * - Type is decided by the file's magic bytes, never by its extension.
 * - Only PNG, JPEG, WebP and GIF are accepted (Chromium cannot show HEIC).
 * - Files are copied into <userData>/photos/<tankId>/<uuid>.<ext>; the user's
 *   original file name never appears in any path we create.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const PHOTO_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** Detect image type from the first bytes. Returns 'png'|'jpg'|'webp'|'gif'|null. */
function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  const ascii = (start, end) => buf.toString('latin1', start, end);
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

async function readHeader(file) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const buf = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buf, 0, 16, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    if (handle) await handle.close();
  }
}

class PhotoError extends Error {
  constructor(message, userMessage) {
    super(message);
    this.name = 'PhotoError';
    this.userMessage = userMessage;
  }
}

/** Check a candidate file: regular file, size limit, real image signature. */
async function inspectImage(file) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (err) {
    throw new PhotoError('stat failed ' + err.code, 'The selected file could not be read.');
  }
  if (!stat.isFile()) throw new PhotoError('not a file', 'The selection is not a file.');
  if (stat.size > MAX_PHOTO_BYTES) throw new PhotoError('too large', 'Photos must be ' + (MAX_PHOTO_BYTES / 1024 / 1024) + ' MB or smaller.');
  if (stat.size < 16) throw new PhotoError('too small', 'That file is not a valid image.');
  const type = detectImageType(await readHeader(file));
  if (!type) throw new PhotoError('bad signature', 'Only PNG, JPEG, WebP and GIF images are supported (HEIC is not).');
  return { type, size: stat.size, mtimeMs: stat.mtimeMs };
}

/** Copy a validated image into the photos folder. Returns {fileName, type, size}. */
async function importImage(sourceFile, photosRoot, tankId) {
  const info = await inspectImage(sourceFile);
  const dir = path.join(photosRoot, tankId);
  await fsp.mkdir(dir, { recursive: true });
  const fileName = crypto.randomUUID() + '.' + info.type;
  const dest = path.join(dir, fileName);
  await fsp.copyFile(sourceFile, dest, fs.constants.COPYFILE_EXCL);
  return { fileName, type: info.type, size: info.size, mtimeMs: info.mtimeMs };
}

/**
 * Resolve a requested path inside a root folder, rejecting traversal
 * ("..", absolute paths, encoded separators). Returns null when outside.
 */
function resolveInside(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\0')) return null;
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, '.' + path.sep + relative);
  const rel = path.relative(rootResolved, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

module.exports = { MAX_PHOTO_BYTES, PHOTO_FILE_RE, MIME, detectImageType, inspectImage, importImage, resolveInside, PhotoError };
