'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogger, createSanitizer } = require('../lib/logger.js');
const { detectImageType, inspectImage, importImage, resolveInside } = require('../lib/photos.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aquastar-test-'));

test('logger writes leveled lines and rotates by size', async () => {
  const dir = tmp();
  const log = createLogger({ dir, maxBytes: 400, maxFiles: 2, level: 'INFO' });
  for (let i = 0; i < 30; i++) log.info('message number ' + i + ' with some padding text');
  await log.flush();
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['main.1.log', 'main.2.log', 'main.log']);
  files.forEach((f) => assert.ok(fs.statSync(path.join(dir, f)).size <= 400 + 120));
  assert.match(fs.readFileSync(path.join(dir, 'main.log'), 'utf8'), /\[INFO\] message number 29/);
});

test('logger respects the level threshold', async () => {
  const dir = tmp();
  const log = createLogger({ dir, level: 'WARN' });
  log.info('hidden');
  log.warn('shown');
  log.error('failure', new Error('boom'));
  await log.flush();
  const text = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
  assert.ok(!text.includes('hidden'));
  assert.match(text, /\[WARN\] shown/);
  assert.match(text, /\[ERROR\] failure \| Error: boom/);
});

test('sanitizer removes home folders, app data paths, user names and image data', () => {
  const home = os.homedir();
  const sanitize = createSanitizer([[path.join(home, '.config', 'AquaStar 5000'), '<userData>']]);
  assert.equal(sanitize('open ' + path.join(home, '.config', 'AquaStar 5000', 'data', 'tanks.json')), 'open <userData>' + path.sep + 'data' + path.sep + 'tanks.json');
  assert.equal(sanitize('file ' + path.join(home, 'Pictures', 'reef.jpg')), 'file ~' + path.sep + 'Pictures' + path.sep + 'reef.jpg');
  assert.equal(sanitize('C:\\Users\\alice\\Pictures\\x.png'), 'C:\\Users\\<user>\\Pictures\\x.png');
  assert.equal(sanitize('/home/bob/x'), '/home/<user>/x');
  assert.equal(sanitize('/Users/carol/x'), '/Users/<user>/x');
  assert.equal(sanitize('img data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='), 'img data:<omitted>');
  assert.ok(sanitize('x'.repeat(10000)).length < 4100);
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(10)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(10)]);

test('image type is detected from file signatures, not extensions', () => {
  assert.equal(detectImageType(PNG), 'png');
  assert.equal(detectImageType(JPG), 'jpg');
  assert.equal(detectImageType(GIF), 'gif');
  assert.equal(detectImageType(WEBP), 'webp');
  assert.equal(detectImageType(HEIC), null);
  assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
  assert.equal(detectImageType(Buffer.alloc(3)), null);
});

test('import rejects fakes and oversize files, copies valid ones under a uuid name', async () => {
  const dir = tmp();
  const fake = path.join(dir, 'evil.png');
  fs.writeFileSync(fake, 'MZ this is really an executable ...........');
  await assert.rejects(inspectImage(fake), (e) => /Only PNG, JPEG/.test(e.userMessage));
  const heic = path.join(dir, 'IMG_0001.HEIC');
  fs.writeFileSync(heic, HEIC);
  await assert.rejects(inspectImage(heic), (e) => /HEIC is not/.test(e.userMessage));
  const big = path.join(dir, 'big.jpg');
  const fd = fs.openSync(big, 'w');
  fs.writeSync(fd, JPG);
  fs.ftruncateSync(fd, 26 * 1024 * 1024);
  fs.closeSync(fd);
  await assert.rejects(inspectImage(big), (e) => /25 MB/.test(e.userMessage));

  const real = path.join(dir, 'My Reef ../../photo.JPG'.replace(/[/\\]/g, '_'));
  fs.writeFileSync(real, JPG);
  const photos = path.join(dir, 'photos');
  const tankId = '6f1c2b0e-8a1d-4c3e-9f2a-1b2c3d4e5f60';
  const res = await importImage(real, photos, tankId);
  assert.match(res.fileName, /^[0-9a-f-]{36}\.jpg$/);
  assert.equal(res.type, 'jpg');
  assert.ok(fs.existsSync(path.join(photos, tankId, res.fileName)));
});

test('resolveInside blocks path traversal', () => {
  const root = path.join(os.tmpdir(), 'root');
  assert.equal(resolveInside(root, 'a/b.png'), path.join(root, 'a', 'b.png'));
  assert.equal(resolveInside(root, '../etc/passwd'), null);
  assert.equal(resolveInside(root, 'a/../../x'), null);
  assert.equal(resolveInside(root, '/etc/passwd'), path.join(root, 'etc', 'passwd'), 'absolute input is forced inside the root');
  assert.equal(resolveInside(root, 'a\0b'), null);
  assert.equal(resolveInside(root, ''), null);
  assert.equal(resolveInside(root, '.'), null);
});
