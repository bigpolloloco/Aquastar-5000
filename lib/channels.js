'use strict';
/*
 * The complete IPC contract. preload.js keeps an identical copy of these two
 * lists (sandboxed preloads cannot require local files); test/channels.test.js
 * fails if the copies drift apart.
 *
 * Every invoke channel returns { ok: true, data } or { ok: false, error }.
 *
 * | Channel                | Payload                                   | Returns (data)                     |
 * |------------------------|-------------------------------------------|------------------------------------|
 * | app:info               | none                                      | version, schema, corrupt stores    |
 * | app:resetStore         | {name}                                    | true (damaged file moved aside)    |
 * | settings:get           | none                                      | Settings                           |
 * | settings:save          | partial Settings                          | Settings                           |
 * | parameters:list        | none                                      | ParameterDef[] (built-in + custom) |
 * | parameters:save        | custom parameter                          | ParameterDef                       |
 * | parameters:delete      | {id}                                      | {ok}                               |
 * | tanks:list             | {includeArchived?}                        | Tank[]                             |
 * | tanks:get              | {id}                                      | Tank                               |
 * | tanks:save             | Tank                                      | Tank                               |
 * | tanks:delete           | {id, confirmName}                         | {ok}                               |
 * | entries:list           | {tankId?, from?, to?}                     | Entry[] (newest first)             |
 * | entries:get            | {id}                                      | Entry                              |
 * | entries:save           | Entry                                     | Entry                              |
 * | entries:delete         | {id}                                      | {ok}                               |
 * | maintenance:list/get/save/delete | as entries                      | Maintenance                        |
 * | dosing:list/get/save/delete      | as entries                      | Dose                               |
 * | photos:list            | {tankId?, ownerType?, ownerId?}           | Photo[] (with app:// url)          |
 * | photos:get             | {id}                                      | Photo + {url, exists}              |
 * | photos:add             | {tankId, ownerType, ownerId?} (main opens picker) | {added: Photo[], errors}   |
 * | photos:save            | {id, caption, takenAt?}                   | Photo                              |
 * | photos:delete          | {id}                                      | {ok}                               |
 * | stats:stability        | {tankId, parameterId}                     | stability report                   |
 * | stats:events           | {tankId, from?, to?}                      | chart markers                      |
 * | data:export            | none (main opens folder picker)           | {message}                          |
 * | data:import            | none (main opens folder picker)           | preview + token                    |
 * | data:importConfirm     | {token}                                   | {message}                          |
 * | data:importCancel      | {token}                                   | true                               |
 * | csv:export             | {kind, tankId?} (main opens save dialog)  | {message}                          |
 * | csv:import             | none (main opens file picker)             | headers, sample rows, token        |
 * | csv:importCommit       | {token, tankId, mapping...}               | {imported, skipped, problems}      |
 * | log:write              | {level, message}                          | true                               |
 *
 * Events (main -> renderer): menu:navigate {view, action?}, app:ticker {level, text}
 */
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
  'log:write'
];

const EVENT_CHANNELS = ['menu:navigate', 'app:ticker'];

module.exports = { INVOKE_CHANNELS, EVENT_CHANNELS };
