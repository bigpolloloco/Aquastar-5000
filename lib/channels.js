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
 * | livestock:list/get/save/delete | as entries (save keeps history)   | Livestock                          |
 * | livestock:move         | {id, toTankId, quantity, date, note?}     | {moved, remaining}                 |
 * | livestock:frag         | {motherId, count, date, tankId?, name?}   | Livestock (the new frag)           |
 * | livestock:status       | {id, status, date, quantity?, cause?}     | {moved, remaining}                 |
 * | treatments:list/get/save/delete | as entries                       | Treatment                          |
 * | schedules:list         | {tankId?, includeInactive?}               | Schedule[] with due status         |
 * | schedules:get/save/delete | as entries                             | Schedule                           |
 * | schedules:complete     | {id, performedAt?, volumeL?, note?}       | {maintenance} or {openQuickEntry}  |
 * | reminders:list         | none                                      | due/overdue/upcoming reminders     |
 * | equipment:list/get/save/delete | as entries                        | Equipment                          |
 * | journal:list/get/save/delete   | as entries                        | Journal entry                      |
 * | expenses:list/get/save/delete  | as entries                        | Expense                            |
 * | reports:copy           | {text}                                    | true (copied to clipboard)         |
 * | reports:pdf            | {title} (main opens save dialog)          | {message}                          |
 * | backups:list           | none                                      | Backup[]                           |
 * | backups:create         | none                                      | {message}                          |
 * | backups:restore        | {name}                                    | import preview + token             |
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

module.exports = { INVOKE_CHANNELS, EVENT_CHANNELS };
