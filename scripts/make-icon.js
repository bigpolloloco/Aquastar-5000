'use strict';
/*
 * Generates the original pixel-art app icon (assets/icons/icon.png, 512x512)
 * and the tray icon (assets/icons/tray.png, 32x32) from a 32x32 character map,
 * using only zlib from the Node standard library. Run: node scripts/make-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// . background (gradient), b border, y yellow fish, w white, o orange, c cyan water, k black eye
const MAP = [
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'b..............................b',
  'b..............................b',
  'b..........ww..................b',
  'b.........w..w.................b',
  'b..........ww........ww........b',
  'b...................w..w.......b',
  'b....................ww........b',
  'b..............................b',
  'b...........yyyyyy.............b',
  'b.........yyyyyyyyyy......yy...b',
  'b.......yyyyyyyyyyyyy....yyy...b',
  'b......yyyyykyyyyyyyyy..yyyy...b',
  'b.....yyyyyyyyyyyyyyyyyyyyyy...b',
  'b.....yyyyyyyyyyyyyyyyyyyyy....b',
  'b......yyyyyyyyyyyyyyyy.yyyy...b',
  'b.......yyyyyyyyyyyyy....yyy...b',
  'b.........yyyyyyyyyy......yy...b',
  'b...........yyyyyy.............b',
  'b..............................b',
  'b..............................b',
  'b..cc......cc......cc......cc..b',
  'b.c..c....c..c....c..c....c..c.b',
  'bc....c..c....c..c....c..c....cb',
  'b......cc......cc......cc......b',
  'b..............................b',
  'boooooooooooooooooooooooooooooob',
  'bo.o.o.o.o.o.o.o.o.o.o.o.o.o.o.b',
  'boooooooooooooooooooooooooooooob',
  'b..............................b',
  'b..............................b',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
];

const COLORS = {
  b: [255, 154, 31, 255],
  y: [255, 225, 77, 255],
  w: [255, 255, 255, 255],
  o: [255, 154, 31, 255],
  c: [95, 224, 255, 255],
  k: [6, 18, 61, 255]
};

function bgColor(row) {
  const t = row / 31;
  const top = [43, 75, 187];
  const bottom = [12, 26, 94];
  return [0, 1, 2].map((i) => Math.round(top[i] + (bottom[i] - top[i]) * t)).concat([255]);
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function render(size) {
  const scale = size / 32;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    const row = Math.floor(y / scale);
    for (let x = 0; x < size; x++) {
      const col = Math.floor(x / scale);
      const ch = MAP[row][col];
      const rgba = COLORS[ch] || bgColor(row);
      rgba.forEach((v, i) => { raw[y * (size * 4 + 1) + 1 + x * 4 + i] = v; });
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, '..', 'assets', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), render(512));
fs.writeFileSync(path.join(outDir, 'tray.png'), render(32));
console.log('Icons written to assets/icons');
