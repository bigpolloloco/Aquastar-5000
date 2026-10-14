'use strict';
/* The sandboxed preload keeps its own copy of the channel lists; they must match lib/channels.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { INVOKE_CHANNELS, EVENT_CHANNELS } = require('../lib/channels.js');

function preloadLists() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const grab = (name) => {
    const m = new RegExp('const ' + name + ' = (\\[[\\s\\S]*?\\]);').exec(src);
    assert.ok(m, name + ' found in preload.js');
    return vm.runInNewContext(m[1]);
  };
  return { invoke: grab('INVOKE_CHANNELS'), events: grab('EVENT_CHANNELS'), src };
}

test('preload whitelist matches the IPC contract', () => {
  const p = preloadLists();
  assert.deepEqual(Array.from(p.invoke), INVOKE_CHANNELS);
  assert.deepEqual(Array.from(p.events), EVENT_CHANNELS);
});

test('channel names follow <collection>:<action>', () => {
  INVOKE_CHANNELS.concat(EVENT_CHANNELS).forEach((c) => assert.match(c, /^[a-z]+:[a-zA-Z]+$/));
  assert.equal(new Set(INVOKE_CHANNELS).size, INVOKE_CHANNELS.length);
});

test('preload never exposes ipcRenderer itself', () => {
  const { src } = preloadLists();
  assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(src));
  assert.ok(!/ipcRenderer\s*[,}]\s*\)\s*;?\s*$/m.test(src.split('exposeInMainWorld')[1] || ''));
});

test('every channel has a handler registered in main.js', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const extra = fs.readdirSync(path.join(__dirname, '..', 'lib'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8')).join('\n');
  INVOKE_CHANNELS.forEach((c) => {
    assert.ok(main.includes("'" + c + "'") || extra.includes("'" + c + "'"), c + ' has a handler');
  });
});
