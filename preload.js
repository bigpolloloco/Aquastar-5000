'use strict';
/*
 * Sandboxed preload. Only `contextBridge` and `ipcRenderer` are used and no
 * local files are required (sandboxed preloads cannot). The renderer gets a
 * tiny API: call(channel, payload) for whitelisted request channels and
 * on(channel, cb) for whitelisted events. ipcRenderer itself is never exposed.
 *
 * Keep these lists identical to lib/channels.js (enforced by the test suite).
 */
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = [
  'app:info', 'app:resetStore',
  'settings:get', 'settings:save',
  'parameters:list', 'parameters:save', 'parameters:delete',
  'tanks:list', 'tanks:get', 'tanks:save', 'tanks:delete',
  'entries:list', 'entries:get', 'entries:save', 'entries:delete',
  'maintenance:list', 'maintenance:get', 'maintenance:save', 'maintenance:delete',
  'dosing:list', 'dosing:get', 'dosing:save', 'dosing:delete',
  'photos:list', 'photos:get', 'photos:add', 'photos:save', 'photos:delete',
  'stats:stability', 'stats:events',
  'data:export', 'data:import', 'data:importConfirm', 'data:importCancel',
  'csv:export', 'csv:import', 'csv:importCommit',
  'log:write',
  'livestock:list', 'livestock:get', 'livestock:save', 'livestock:delete', 'livestock:move', 'livestock:frag', 'livestock:status',
  'treatments:list', 'treatments:get', 'treatments:save', 'treatments:delete',
  'schedules:list', 'schedules:get', 'schedules:save', 'schedules:delete', 'schedules:complete',
  'reminders:list',
  'equipment:list', 'equipment:get', 'equipment:save', 'equipment:delete',
  'journal:list', 'journal:get', 'journal:save', 'journal:delete',
  'expenses:list', 'expenses:get', 'expenses:save', 'expenses:delete',
  'reports:copy', 'reports:pdf',
  'backups:list', 'backups:create', 'backups:restore'
];

const EVENT_CHANNELS = ['menu:navigate', 'app:ticker'];

const invokeAllowed = new Set(INVOKE_CHANNELS);
const eventAllowed = new Set(EVENT_CHANNELS);

contextBridge.exposeInMainWorld('aqua', Object.freeze({
  call(channel, payload) {
    if (typeof channel !== 'string' || !invokeAllowed.has(channel)) {
      return Promise.resolve({ ok: false, error: 'Unknown request.' });
    }
    return ipcRenderer.invoke(channel, payload).catch(() => ({ ok: false, error: 'The request could not be completed.' }));
  },
  on(channel, callback) {
    if (typeof channel !== 'string' || !eventAllowed.has(channel) || typeof callback !== 'function') return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
}));
