'use strict';
/*
 * AquaStar 5000 - main process.
 * App lifecycle, the single window, the app:// protocol, security policy,
 * menu and IPC wiring. Data logic lives in lib/ (testable without Electron).
 */
const { app, BrowserWindow, ipcMain, protocol, dialog, Menu, screen, shell, session, Notification, Tray, clipboard, nativeImage } = require('electron');
const path = require('path');
const fsp = require('fs').promises;
const crypto = require('crypto');

const { createLogger } = require('./lib/logger.js');
const { Storage, writeFileAtomic } = require('./lib/storage.js');
const { CURRENT_SCHEMA_VERSION, COLLECTIONS, SETTINGS_DEFAULTS, migrate } = require('./lib/migrations.js');
const { createService, mergeSettings } = require('./lib/service.js');
const V = require('./lib/validate.js');
const { INVOKE_CHANNELS } = require('./lib/channels.js');
const { importImage, resolveInside, MIME, PHOTO_FILE_RE } = require('./lib/photos.js');
const { parseCsv, toCsv } = require('./lib/csv.js');
const transfer = require('./lib/transfer.js');
const { createKeeper, importCheckers } = require('./lib/keeper.js');
const { pickNotifications } = require('./lib/reminders.js');
const backup = require('./lib/backup.js');
const { setLinuxAutostart } = require('./lib/autostart.js');

const APP_SCHEME = 'app';
const APP_HOST = 'aquastar';
const APP_ORIGIN = APP_SCHEME + '://' + APP_HOST;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_CSV_BYTES = 20 * 1024 * 1024;
const PENDING_TTL_MS = 30 * 60 * 1000;
const QUIT_TIMEOUT_MS = 15000;
const APP_ID = 'io.github.bigpolloloco.aquastar5000';
const REMINDER_CHECK_MS = 60 * 1000;
const DAILY_BACKUP_CHECK_MS = 60 * 60 * 1000;

// Must run before the app is ready. A standard + secure scheme gives the UI a
// real origin, so CSP 'self', relative URLs and ES modules behave predictably.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }
]);

let logger = null;
let storage = null;
let service = null;
let keeper = null;
let tray = null;
let trayHintShown = false;
let mainWindow = null;
let initResult = { corrupt: [], migratedFrom: null };
let env = { LOG_LEVEL: 'INFO', OPEN_DEVTOOLS: false };
let quitState = 'running'; // running -> finishing -> ready
const pending = new Map();
const shutdownHooks = [];
const devMode = !app.isPackaged && process.argv.includes('--dev');
const startHidden = process.argv.includes('--hidden');

const log = {
  info: (m, e) => (logger ? logger.info(m, e) : console.log(m, e || '')),
  warn: (m, e) => (logger ? logger.warn(m, e) : console.warn(m, e || '')),
  error: (m, e) => (logger ? logger.error(m, e) : console.error(m, e || ''))
};

// --------------------------------------------------------------------------
// Fatal and background error handling
// --------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  // Node does not consider the process safe after an uncaught exception, so
  // log synchronously, tell the user, and exit. Saved data is on disk already
  // (every write is atomic), so nothing half-written can be left behind.
  try {
    if (logger) logger.fatalSync('Uncaught exception; quitting', err);
    else console.error('Uncaught exception', err);
  } catch (e) { /* ignore */ }
  try {
    dialog.showErrorBox('AquaStar 5000 has to close',
      'An unexpected error occurred and the app must restart. Your saved data is safe.\n\nDetails were written to the log file (Help > Open Log Folder).');
  } catch (e) { /* ignore */ }
  app.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
  sendTicker('ERROR', 'A background task failed. The app keeps running; details are in the log.');
});

// --------------------------------------------------------------------------
// Single instance: a second launch focuses the existing window.
// --------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => focusMainWindow());
  bootstrap();
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady() && storage) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function sendTicker(level, text) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:ticker', { level, text });
}

// --------------------------------------------------------------------------
// Configuration (.env holds developer settings only)
// --------------------------------------------------------------------------
function loadEnv() {
  // Explicit path: project root in development, the user data folder when
  // packaged (the install folder may be read-only). A missing file is normal.
  const envPath = app.isPackaged ? path.join(app.getPath('userData'), '.env') : path.join(__dirname, '.env');
  try {
    require('dotenv').config({ path: envPath, quiet: true });
  } catch (e) { /* defaults below */ }
  const level = String(process.env.LOG_LEVEL || '').toUpperCase();
  return {
    LOG_LEVEL: ['INFO', 'WARN', 'ERROR'].includes(level) ? level : 'INFO',
    // DevTools are never available in packaged builds.
    OPEN_DEVTOOLS: !app.isPackaged && (devMode || String(process.env.OPEN_DEVTOOLS).toLowerCase() === 'true')
  };
}

function photosRoot() {
  return path.join(app.getPath('userData'), 'photos');
}

// --------------------------------------------------------------------------
// Startup
// --------------------------------------------------------------------------
function bootstrap() {
  // Windows only: notifications are not shown unless the AppUserModelID
  // matches the installed shortcut (electron-builder uses build.appId).
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  app.whenReady().then(async () => {
    env = loadEnv();
    const userData = app.getPath('userData');
    logger = createLogger({
      dir: app.getPath('logs'),
      level: env.LOG_LEVEL,
      console: !app.isPackaged,
      sanitizePaths: [[userData, '<userData>'], [app.getPath('logs'), '<logs>'], [__dirname, '<app>'], [app.getPath('temp'), '<temp>']]
    });
    log.info('Starting AquaStar 5000 v' + app.getVersion() + ' (Electron ' + process.versions.electron + ', ' + process.platform + ')');

    storage = new Storage({
      dir: path.join(userData, 'data'),
      collections: COLLECTIONS,
      objects: { settings: SETTINGS_DEFAULTS, windowState: {}, appState: { notified: {}, lastBackupAt: null } },
      schemaVersion: CURRENT_SCHEMA_VERSION,
      migrate,
      logger
    });
    try {
      initResult = await storage.init();
    } catch (err) {
      log.error('Data folder could not be opened', err);
      dialog.showErrorBox('AquaStar 5000 cannot start', 'The data folder could not be opened (' + (err.code || 'error') + '). Check that your user account can write to it.');
      app.exit(1);
      return;
    }
    service = createService({ storage, photosRoot: photosRoot(), logger });
    keeper = createKeeper({ storage, service });

    protocol.handle(APP_SCHEME, handleAppRequest);
    applySecurityPolicy();
    registerIpc();
    buildMenu();
    createWindow();
    applyDesktopSettings(service.getSettings()).catch((err) => log.warn('Desktop settings not applied', err));
    startBackgroundTasks();
    shutdownHooks.push(backupOnClose);
  }).catch((err) => {
    log.error('Startup failed', err);
    try { dialog.showErrorBox('AquaStar 5000 cannot start', 'Startup failed. Details were written to the log file.'); } catch (e) { /* ignore */ }
    app.exit(1);
  });

  // Windows and Linux: closing the last window quits the app, unless the
  // user chose "keep running in tray" (then reminders keep working).
  app.on('window-all-closed', () => {
    if (tray && service && service.getSettings().keepInTray && quitState === 'running') return;
    app.quit();
  });

  // Electron does not wait for async work in quit events: hold the quit,
  // finish pending writes (and the Phase 2 backup), then quit for real. A
  // timeout guarantees a failing task can never block quitting.
  app.on('before-quit', (event) => {
    if (quitState === 'ready') return;
    event.preventDefault();
    if (quitState === 'finishing') return;
    quitState = 'finishing';
    const work = (async () => {
      saveWindowState();
      for (const hook of shutdownHooks) {
        try { await hook(); } catch (err) { log.error('Shutdown task failed', err); }
      }
      if (storage) await storage.flush();
      if (logger) await logger.flush();
    })();
    const timeout = new Promise((resolve) => setTimeout(() => { log.warn('Shutdown tasks timed out'); resolve(); }, QUIT_TIMEOUT_MS));
    Promise.race([work, timeout]).finally(() => {
      quitState = 'ready';
      app.quit();
    });
  });
}

// --------------------------------------------------------------------------
// app:// protocol: UI files, Chart.js and photos. Nothing else is reachable.
// --------------------------------------------------------------------------
const STATIC_FILES = new Set(['index.html', 'styles.css', 'renderer.js']);
const SHARED_LIB = new Set(['lib/units.js', 'lib/dates.js', 'lib/presets.js', 'lib/stats.js', 'lib/calc.js']);
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8'
};

function resolveAppPath(rel) {
  if (rel.startsWith('photos/')) {
    const sub = rel.slice('photos/'.length);
    const parts = sub.split('/');
    if (parts.length !== 2 || !V.UUID_RE.test(parts[0]) || !PHOTO_FILE_RE.test(parts[1])) return null;
    return resolveInside(photosRoot(), sub);
  }
  if (rel === 'vendor/chart.umd.js') return path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
  if (STATIC_FILES.has(rel) || SHARED_LIB.has(rel) ||
      /^(views|ui)\/[a-z0-9-]+\.js$/.test(rel) ||
      /^assets\/(fonts|icons|img)\/[A-Za-z0-9._-]+$/.test(rel)) {
    return resolveInside(__dirname, rel);
  }
  return null;
}

async function handleAppRequest(request) {
  try {
    const url = new URL(request.url);
    if (url.host !== APP_HOST || request.method !== 'GET') return new Response('Not found', { status: 404 });
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch (e) { return new Response('Bad request', { status: 400 }); }
    if (pathname.includes('\\') || pathname.includes('\0')) return new Response('Bad request', { status: 400 });
    let rel = pathname.replace(/^\/+/, '');
    if (rel === '') rel = 'index.html';
    const file = resolveAppPath(rel);
    if (!file) return new Response('Not found', { status: 404 });
    const ext = path.extname(file).toLowerCase();
    let type = CONTENT_TYPES[ext];
    if (rel.startsWith('photos/')) type = MIME[ext.slice(1)] || 'application/octet-stream';
    const body = await fsp.readFile(file);
    const headers = { 'Content-Type': type || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' };
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;
    return new Response(body, { status: 200, headers });
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('app:// request failed', err);
    return new Response('Not found', { status: 404 });
  }
}

// --------------------------------------------------------------------------
// Security policy for every web contents
// --------------------------------------------------------------------------
function applySecurityPolicy() {
  const ses = session.defaultSession;
  // No network access at all: the spellchecker would otherwise download
  // Hunspell dictionaries from Google's servers on Windows and Linux.
  try {
    ses.setSpellCheckerEnabled(false);
    ses.setSpellCheckerLanguages([]);
  } catch (err) { /* not supported on this platform */ }
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // Never load remote content, even if something tried to.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*', 'file://*/*'] }, (details, callback) => {
    log.warn('Blocked request to a non-app URL scheme');
    callback({ cancel: true });
  });
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (event) => {
      event.preventDefault();
      log.warn('Blocked navigation attempt');
    });
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

function isTrustedSender(event) {
  const frame = event.senderFrame;
  if (!frame || frame.parent) return false;
  try {
    const url = new URL(frame.url);
    return url.protocol === APP_SCHEME + ':' && url.host === APP_HOST;
  } catch (e) {
    return false;
  }
}

// --------------------------------------------------------------------------
// Window
// --------------------------------------------------------------------------
const DEFAULT_BOUNDS = { width: 1280, height: 820 };

function restoreBounds() {
  const saved = storage ? storage.getObject('windowState') : null;
  const ok = saved && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(saved[k]));
  if (!ok) return { bounds: Object.assign({}, DEFAULT_BOUNDS), maximized: false };
  const rect = { x: Math.round(saved.x), y: Math.round(saved.y), width: Math.max(900, Math.round(saved.width)), height: Math.max(600, Math.round(saved.height)) };
  // The title bar area must overlap a connected display; otherwise the window
  // was on a monitor that is gone and would open off-screen.
  const visible = screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    const ix = Math.min(rect.x + rect.width, wa.x + wa.width) - Math.max(rect.x, wa.x);
    const iy = Math.min(rect.y + 40, wa.y + wa.height) - Math.max(rect.y, wa.y);
    return ix >= 120 && iy >= 20;
  });
  if (visible) return { bounds: rect, maximized: Boolean(saved.maximized) };
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(rect.width, wa.width);
  const height = Math.min(rect.height, wa.height);
  return {
    bounds: { width, height, x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2) },
    maximized: Boolean(saved.maximized)
  };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || !storage) return;
  try {
    const b = mainWindow.getNormalBounds();
    storage.setObject('windowState', { x: b.x, y: b.y, width: b.width, height: b.height, maximized: mainWindow.isMaximized() })
      .catch((err) => log.warn('Window state not saved', err));
  } catch (err) {
    log.warn('Window state not saved', err);
  }
}

function createWindow() {
  const { bounds, maximized } = restoreBounds();
  mainWindow = new BrowserWindow(Object.assign({}, bounds, {
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'AquaStar 5000',
    backgroundColor: '#06123d',
    icon: path.join(__dirname, 'assets', 'icons', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
      spellcheck: false,
      navigateOnDragDrop: false
    }
  }));
  if (maximized) mainWindow.maximize();
  const keepHidden = startHidden && service && service.getSettings().keepInTray;
  mainWindow.once('ready-to-show', () => { if (!keepHidden) mainWindow.show(); });
  mainWindow.on('close', (event) => {
    saveWindowState();
    if (quitState === 'running' && tray && service && service.getSettings().keepInTray) {
      event.preventDefault();
      mainWindow.hide();
      if (!trayHintShown) {
        trayHintShown = true;
        notify('AquaStar 5000 is still running', 'Reminders stay active. Use the tray icon to open or quit the app.');
      }
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error('Renderer process gone: ' + details.reason);
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  });
  mainWindow.webContents.on('console-message', (e, level, message) => {
    const msg = typeof (e && e.message) === 'string' ? e.message : message;
    const lvl = e && e.level !== undefined ? e.level : level;
    if (lvl === 'warning' || lvl === 'error' || lvl === 2 || lvl === 3) log.warn('Renderer console: ' + String(msg).slice(0, 500));
  });
  mainWindow.loadURL(APP_ORIGIN + '/index.html');
  if (env.OPEN_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

// --------------------------------------------------------------------------
// Menu (in-app accelerators; globalShortcut is deliberately not used)
// --------------------------------------------------------------------------
function navigate(view, action) {
  focusMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu:navigate', { view, action: action || null });
}

const VIEW_MENU = [
  { label: 'Current Conditions', view: 'dashboard', accelerator: 'CmdOrCtrl+1' },
  { label: 'Log a Test', view: 'quick-entry', accelerator: 'CmdOrCtrl+2' },
  { label: 'Trend Charts', view: 'charts', accelerator: 'CmdOrCtrl+3' },
  { label: 'Maintenance', view: 'maintenance', accelerator: 'CmdOrCtrl+4' },
  { label: 'Dosing', view: 'dosing', accelerator: 'CmdOrCtrl+5' },
  { label: 'Photos', view: 'photos', accelerator: 'CmdOrCtrl+6' },
  { label: 'Tanks', view: 'tanks', accelerator: 'CmdOrCtrl+7' },
  { label: 'Settings & Data', view: 'settings', accelerator: 'CmdOrCtrl+,' }
];

const KEEPER_MENU = [
  { label: 'Livestock', view: 'livestock', accelerator: 'CmdOrCtrl+Shift+L' },
  { label: 'Reminders & Schedules', view: 'schedules', accelerator: 'CmdOrCtrl+Shift+R' },
  { label: 'Treatments', view: 'treatments' },
  { label: 'Equipment', view: 'equipment' },
  { label: 'Cycling Mode', view: 'cycling' },
  { label: 'Journal', view: 'journal' },
  { label: 'Expenses', view: 'expenses' },
  { label: 'Calculators', view: 'calculators', accelerator: 'CmdOrCtrl+Shift+C' },
  { label: 'Reports & Sharing', view: 'reports' }
];

function buildMenu() {
  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'Log a Test...', accelerator: 'CmdOrCtrl+T', click: () => navigate('quick-entry') },
        { type: 'separator' },
        { label: 'Export All Data...', click: () => navigate('settings', 'export') },
        { label: 'Import Data...', click: () => navigate('settings', 'import') },
        { label: 'Import Test History from CSV...', click: () => navigate('settings', 'csv-import') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '&View',
      submenu: VIEW_MENU.map((v) => ({ label: v.label, accelerator: v.accelerator, click: () => navigate(v.view) })).concat([
        { type: 'separator' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ], devMode ? [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] : [])
    },
    {
      label: '&Keeper',
      submenu: KEEPER_MENU.map((v) => ({ label: v.label, accelerator: v.accelerator, click: () => navigate(v.view) }))
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Open Data Folder', click: () => shell.openPath(app.getPath('userData')) },
        { label: 'Open Log Folder', click: () => shell.openPath(app.getPath('logs')) },
        { label: 'Open Backups Folder', click: () => fsp.mkdir(backupsDir(), { recursive: true }).then(() => shell.openPath(backupsDir())) },
        { type: 'separator' },
        {
          label: 'About AquaStar 5000',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'About AquaStar 5000',
            message: 'AquaStar 5000 v' + app.getVersion(),
            detail: 'Offline aquarium-keeping companion.\nElectron ' + process.versions.electron + '\n\nFont: VT323 (SIL Open Font License 1.1).\nCharts: Chart.js (MIT).'
          })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --------------------------------------------------------------------------
// IPC
// --------------------------------------------------------------------------
const registered = new Set();

function noPayload(p, label) {
  if (p === undefined || p === null) return undefined;
  if (V.isPlainObject(p) && Object.keys(p).length === 0) return undefined;
  throw new V.ValidationError(label || 'payload', 'must be empty');
}

/**
 * Register a handler. Checks the sender, validates the payload, and always
 * resolves to {ok, data} or {ok:false, error} so no exception crosses IPC.
 */
function handle(channel, validator, fn) {
  if (!INVOKE_CHANNELS.includes(channel)) throw new Error('Channel not in contract: ' + channel);
  registered.add(channel);
  ipcMain.handle(channel, async (event, payload) => {
    if (!isTrustedSender(event)) {
      log.warn('Rejected IPC call from an untrusted frame on ' + channel);
      return { ok: false, error: 'Request rejected.' };
    }
    try {
      const input = validator ? validator(payload) : noPayload(payload);
      const data = await fn(input, event);
      return { ok: true, data: data === undefined ? null : data };
    } catch (err) {
      if (err && err.userMessage) {
        log.warn(channel + ' refused: ' + err.message);
        return { ok: false, error: err.userMessage };
      }
      log.error('Unexpected error in ' + channel, err);
      return { ok: false, error: 'Something went wrong. Details were written to the log file.' };
    }
  });
}

function newToken(kind, data) {
  const now = Date.now();
  pending.forEach((v, k) => { if (v.expires < now) pending.delete(k); });
  const token = crypto.randomBytes(24).toString('hex');
  pending.set(token, { kind, data, expires: now + PENDING_TTL_MS });
  return token;
}

function takeToken(token, kind, keep) {
  const p = pending.get(token);
  if (!p || p.kind !== kind || p.expires < Date.now()) {
    pending.delete(token);
    throw Object.assign(new Error('token expired'), { userMessage: 'That import has expired. Please start it again.' });
  }
  if (!keep) pending.delete(token);
  return p.data;
}

function sanitizeImportedSettings(raw) {
  const out = {};
  const s = V.isPlainObject(raw) ? raw : {};
  try { if (s.units) out.units = V.settingsPatch({ units: s.units }).units; } catch (e) { /* keep current */ }
  try { if (s.dashboard) out.dashboard = V.settingsPatch({ dashboard: s.dashboard }).dashboard; } catch (e) { /* keep current */ }
  return mergeSettings(Object.assign({}, storage.getObject('settings'), out));
}

/** Read a text file picked by the user, tolerating Windows-1252 exports. */
async function readTextFile(file, maxBytes) {
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw Object.assign(new Error('not file'), { userMessage: 'Please choose a file.' });
  if (stat.size > maxBytes) throw Object.assign(new Error('too big'), { userMessage: 'That file is too large (limit ' + Math.round(maxBytes / 1048576) + ' MB).' });
  const buf = await fsp.readFile(file);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try { return new TextDecoder('windows-1252').decode(buf); } catch (e2) { return buf.toString('latin1'); }
  }
}

// GTK file filters are case-sensitive, so list both cases.
const both = (list) => list.concat(list.map((x) => x.toUpperCase()));

function registerIpc() {
  const s = service;

  handle('app:info', null, () => ({
    version: app.getVersion(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    corrupt: Array.from(storage.corrupt),
    migratedFrom: initResult.migratedFrom,
    packaged: app.isPackaged,
    dataFolder: app.getPath('userData')
  }));
  handle('app:resetStore', V.storeName(COLLECTIONS.concat(['settings'])), async ({ name }) => {
    if (!storage.corrupt.has(name)) return true;
    await storage.resetStore(name);
    return true;
  });

  handle('settings:get', null, () => s.getSettings());
  handle('settings:save', V.settingsPatch, async (patch) => {
    const next = await s.saveSettings(patch);
    if (patch.keepInTray !== undefined || patch.startAtLogin !== undefined) await applyDesktopSettings(next);
    return next;
  });

  handle('parameters:list', null, () => s.paramDefs());
  handle('parameters:save', (p) => p, (p) => s.saveCustomParam(p));
  handle('parameters:delete', V.paramIdPayload, (p) => s.deleteCustomParam(p));

  handle('tanks:list', V.tankListQuery, (q) => s.listTanks(q));
  handle('tanks:get', V.idPayload, ({ id }) => s.requireTank(id));
  handle('tanks:save', (p) => p, (p) => s.saveTank(p));
  handle('tanks:delete', V.tankDelete, (p) => s.deleteTank(p));

  handle('entries:list', V.listQuery, (q) => s.listEntries(q));
  handle('entries:get', V.idPayload, (q) => s.getEntry(q));
  handle('entries:save', (p) => p, (p) => s.saveEntry(p));
  handle('entries:delete', V.idPayload, (q) => s.deleteEntry(q));

  handle('maintenance:list', V.listQuery, (q) => s.listMaintenance(q));
  handle('maintenance:get', V.idPayload, (q) => s.getMaintenance(q));
  handle('maintenance:save', (p) => p, (p) => s.saveMaintenance(p));
  handle('maintenance:delete', V.idPayload, (q) => s.deleteMaintenance(q));

  handle('dosing:list', V.listQuery, (q) => s.listDosing(q));
  handle('dosing:get', V.idPayload, (q) => s.getDosing(q));
  handle('dosing:save', (p) => p, (p) => s.saveDosing(p));
  handle('dosing:delete', V.idPayload, (q) => s.deleteDosing(q));

  handle('photos:list', V.photoListQuery, (q) => s.listPhotos(q));
  handle('photos:get', V.idPayload, (q) => s.getPhoto(q));
  handle('photos:save', (p) => p, (p) => s.updatePhoto(p));
  handle('photos:delete', V.idPayload, (q) => s.deletePhoto(q));
  handle('photos:add', V.photoAdd, async (input) => {
    s.requireTank(input.tankId);
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Add photos',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images (PNG, JPEG, WebP, GIF)', extensions: both(['png', 'jpg', 'jpeg', 'webp', 'gif']) }]
    });
    if (res.canceled || !res.filePaths.length) return { added: [], errors: [], canceled: true };
    const added = [];
    const errors = [];
    for (const file of res.filePaths.slice(0, 50)) {
      let imported = null;
      try {
        imported = await importImage(file, photosRoot(), input.tankId);
        const rec = await s.addPhotoRecord(input, imported);
        added.push(Object.assign({}, rec, { url: s.photoUrl(rec) }));
      } catch (err) {
        if (imported) {
          const orphan = resolveInside(photosRoot(), input.tankId + '/' + imported.fileName);
          if (orphan) fsp.unlink(orphan).catch(() => undefined);
        }
        log.warn('Photo was not added: ' + (err.userMessage || err.code || err.name));
        errors.push(err.userMessage || 'A photo could not be added.');
      }
    }
    if (res.filePaths.length > 50) errors.push('Only the first 50 photos were added.');
    return { added, errors, canceled: false };
  });

  handle('stats:stability', V.stabilityQuery, (q) => s.stability(q));
  handle('stats:events', V.eventsQuery, (q) => s.events(q));

  handle('data:export', null, async () => {
    const res = await dialog.showOpenDialog(mainWindow, { title: 'Choose where to save the export folder', properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const out = await transfer.exportTo(res.filePaths[0], { storage, photosRoot: photosRoot(), schemaVersion: CURRENT_SCHEMA_VERSION, appVersion: app.getVersion() });
    log.info('Data exported (' + out.photoCount + ' photos)');
    let message = 'Exported ' + out.counts.tanks + ' tanks, ' + out.counts.entries + ' tests and ' + out.photoCount + ' photos to folder "' + out.folderName + '".';
    if (out.missingPhotos) message += ' ' + out.missingPhotos + ' photo files were missing and skipped.';
    return { canceled: false, message };
  });
  handle('data:import', null, async () => {
    const res = await dialog.showOpenDialog(mainWindow, { title: 'Choose an AquaStar 5000 export folder', properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const preview = await transfer.readImport(res.filePaths[0], {
      schemaVersion: CURRENT_SCHEMA_VERSION, migrate, collections: COLLECTIONS, checkers: importCheckers(), sanitizeSettings: sanitizeImportedSettings
    });
    const token = newToken('import', preview);
    return {
      canceled: false, token, counts: preview.counts, skipped: preview.skipped,
      photos: preview.photos.length, badPhotos: preview.badPhotos, exportedAt: preview.exportedAt, fromVersion: preview.fromVersion
    };
  });
  handle('data:importConfirm', V.token, async ({ token }) => {
    const preview = takeToken(token, 'import');
    // Safety net: keep a copy of the current data before replacing it.
    await backup.createBackup({
      storage, photosRoot: photosRoot(), backupsDir: backupsDir(), schemaVersion: CURRENT_SCHEMA_VERSION,
      appVersion: app.getVersion(), kind: 'pre-import', keep: service.getSettings().backups.keep
    });
    const result = await transfer.applyImport(preview, { storage, photosRoot: photosRoot(), collections: COLLECTIONS });
    log.info('Data imported (' + result.photos + ' photos)');
    return { message: 'Import complete: ' + preview.counts.tanks + ' tanks, ' + preview.counts.entries + ' tests and ' + result.photos + ' photos restored. Your previous data was saved in the backups folder.' };
  });
  handle('data:importCancel', V.token, ({ token }) => { pending.delete(token); return true; });

  handle('csv:export', V.csvExport, async ({ kind, tankId }) => {
    if (tankId) s.requireTank(tankId);
    const names = { entries: 'tests', maintenance: 'maintenance', dosing: 'dosing' };
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export CSV',
      defaultPath: 'aquastar-' + names[kind] + '-' + transfer.stamp(new Date()) + '.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    let file = res.filePath;
    if (!/\.csv$/i.test(file)) file += '.csv';
    const rows = s.csvRows(kind, tankId);
    await writeFileAtomic(file, toCsv(rows));
    return { canceled: false, message: 'Exported ' + (rows.length - 1) + ' rows to ' + path.basename(file) + '.' };
  });
  handle('csv:import', null, async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import test history from CSV',
      properties: ['openFile'],
      filters: [{ name: 'CSV or text', extensions: both(['csv', 'txt', 'tsv']) }]
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const text = await readTextFile(res.filePaths[0], MAX_CSV_BYTES);
    const parsed = parseCsv(text, { maxRows: 200001 });
    if (parsed.rows.length < 2) throw Object.assign(new Error('empty csv'), { userMessage: 'The CSV needs a header row and at least one data row.' });
    if (parsed.truncated) throw Object.assign(new Error('csv too long'), { userMessage: 'The CSV has more than 200,000 rows. Split it into smaller files.' });
    const headers = parsed.rows[0].map((h, i) => String(h).trim().slice(0, 80) || 'Column ' + (i + 1));
    const body = parsed.rows.slice(1);
    const token = newToken('csv', { rows: body });
    return {
      canceled: false, token, headers, rowCount: body.length,
      sample: body.slice(0, 8).map((r) => r.map((c) => String(c).slice(0, 80))),
      delimiter: parsed.delimiter === '\t' ? 'tab' : parsed.delimiter, fileName: path.basename(res.filePaths[0])
    };
  });
  handle('csv:importCommit', V.csvImportCommit, async (mapping) => {
    const data = takeToken(mapping.token, 'csv');
    return s.importCsvEntries(data.rows, mapping);
  });

  handle('log:write', V.logWrite, ({ level, message }) => {
    log[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'info']('Renderer: ' + message);
    return true;
  });


  // ------------------------------------------------------------ Phase 2
  const k = keeper;
  const crud = (name, mod, validatorList) => {
    handle(name + ':list', validatorList || V.listByTankOptional, (q) => mod.list(q));
    handle(name + ':get', V.idPayload, (q) => mod.get(q));
    handle(name + ':save', (p) => p, (p) => mod.save(p));
    handle(name + ':delete', V.idPayload, (q) => mod.remove(q));
  };
  crud('livestock', k.livestock);
  handle('livestock:move', (p) => p, (p) => k.moveLivestock(p));
  handle('livestock:frag', (p) => p, (p) => k.fragLivestock(p));
  handle('livestock:status', (p) => p, (p) => k.setLivestockStatus(p));
  crud('treatments', k.treatments);
  crud('schedules', { list: (q) => k.schedulesWithStatus(q), get: k.schedules.get, save: k.schedules.save, remove: k.schedules.remove });
  handle('schedules:complete', (p) => p, (p) => k.completeSchedule(p));
  handle('reminders:list', null, () => k.reminders());
  crud('equipment', k.equipment);
  crud('journal', k.journal);
  crud('expenses', k.expenses);

  handle('reports:copy', V.reportsCopy, async ({ text }) => { await clipboard.writeText(text); return true; });
  handle('reports:pdf', V.reportsPdf, async ({ title }) => {
    const safe = title.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'report';
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save report as PDF',
      defaultPath: 'aquastar-' + safe + '-' + transfer.stamp(new Date()) + '.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    let file = res.filePath;
    if (!/\.pdf$/i.test(file)) file += '.pdf';
    const pdf = await mainWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
    await writeFileAtomic(file, pdf);
    return { canceled: false, message: 'Report saved as ' + path.basename(file) + '.' };
  });

  handle('backups:list', null, () => backup.listBackups(backupsDir()));
  handle('backups:create', null, async () => {
    const res = await runBackup('manual');
    return { message: 'Backup "' + res.name + '" created (' + res.photoCount + ' photos).' + (res.removed.length ? ' ' + res.removed.length + ' old backup(s) removed.' : '') };
  });
  handle('backups:restore', V.backupName, async ({ name }) => {
    const list = await backup.listBackups(backupsDir());
    if (!list.some((b) => b.name === name)) throw Object.assign(new Error('unknown backup'), { userMessage: 'That backup no longer exists.' });
    const preview = await transfer.readImport(path.join(backupsDir(), name), {
      schemaVersion: CURRENT_SCHEMA_VERSION, migrate, collections: COLLECTIONS, checkers: importCheckers(), sanitizeSettings: sanitizeImportedSettings
    });
    const token = newToken('import', preview);
    return { canceled: false, token, counts: preview.counts, skipped: preview.skipped, photos: preview.photos.length, badPhotos: preview.badPhotos, exportedAt: preview.exportedAt, fromVersion: preview.fromVersion };
  });

  const missing = INVOKE_CHANNELS.filter((c) => !registered.has(c));
  if (missing.length) log.error('IPC channels without a handler: ' + missing.join(', '));
}

// --------------------------------------------------------------------------
// Desktop integration: notifications, tray, start at login
// --------------------------------------------------------------------------
function notify(title, body, onClick) {
  try {
    if (!Notification.isSupported()) return false;
    const n = new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icons', 'icon.png') });
    n.on('click', () => { focusMainWindow(); if (onClick) onClick(); });
    n.show();
    return true;
  } catch (err) {
    log.warn('Notification failed', err);
    return false;
  }
}

function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icons', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('AquaStar 5000');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open AquaStar 5000', click: () => focusMainWindow() },
    { label: 'Log a Test', click: () => navigate('quick-entry') },
    { label: 'Reminders', click: () => navigate('schedules') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('click', () => focusMainWindow());
}

async function applyDesktopSettings(settings) {
  if (settings.keepInTray && !tray) buildTray();
  if (!settings.keepInTray && tray) { tray.destroy(); tray = null; }
  // Start at login. Only meaningful for an installed/packaged app.
  if (!app.isPackaged) return;
  const args = settings.keepInTray ? ['--hidden'] : [];
  if (process.platform === 'linux') {
    // setLoginItemSettings does not work on Linux: use an XDG autostart entry.
    // An AppImage must be started through its own path, not the mounted binary.
    await setLinuxAutostart(settings.startAtLogin, {
      configDir: app.getPath('appData'),
      name: 'AquaStar 5000',
      comment: 'Aquarium keeping companion',
      exec: process.env.APPIMAGE || process.execPath,
      args,
      icon: 'aquastar-5000'
    });
  } else {
    app.setLoginItemSettings({ openAtLogin: Boolean(settings.startAtLogin), args });
  }
}

// --------------------------------------------------------------------------
// Background tasks: reminders and daily backups (only while the app runs)
// --------------------------------------------------------------------------
function backupsDir() {
  return path.join(app.getPath('userData'), 'backups');
}

let backupRunning = null;
function runBackup(kind) {
  if (backupRunning) return backupRunning;
  backupRunning = (async () => {
    await storage.flush();
    const res = await backup.createBackup({
      storage, photosRoot: photosRoot(), backupsDir: backupsDir(), schemaVersion: CURRENT_SCHEMA_VERSION,
      appVersion: app.getVersion(), kind, keep: service.getSettings().backups.keep
    });
    await storage.mutate('appState', (st) => ({ next: Object.assign({}, st, { lastBackupAt: new Date().toISOString() }), result: true }));
    log.info('Backup created (' + kind + ', ' + res.photoCount + ' photos, ' + res.removed.length + ' rotated out)');
    return res;
  })().finally(() => { backupRunning = null; });
  return backupRunning;
}

async function backupOnClose() {
  if (!service.getSettings().backups.onClose) return;
  await runBackup('auto');
}

async function dailyBackupCheck() {
  const st = service.getSettings();
  if (!st.backups.daily) return;
  const last = storage.getObject('appState').lastBackupAt;
  if (last && Date.now() - Date.parse(last) < 24 * 3600 * 1000) return;
  try {
    await runBackup('auto');
  } catch (err) {
    log.error('Daily backup failed', err);
    sendTicker('ERROR', 'The daily backup failed. Check free disk space; details are in the log.');
  }
}

async function reminderCheck() {
  const settings = service.getSettings();
  const due = keeper.reminders();
  const state = storage.getObject('appState');
  const { toNotify, notified } = pickNotifications(due, state.notified, new Date());
  if (toNotify.length) {
    await storage.mutate('appState', (cur) => ({ next: Object.assign({}, cur, { notified }), result: true }));
    toNotify.forEach((r) => sendTicker('WARN', r.message));
    if (settings.notifications) {
      if (toNotify.length <= 3) toNotify.forEach((r) => notify('AquaStar 5000 reminder', r.message, () => navigate('schedules')));
      else notify('AquaStar 5000: ' + toNotify.length + ' reminders', toNotify.slice(0, 3).map((r) => r.message).join('\n') + '\n...', () => navigate('schedules'));
    }
  }
}

function startBackgroundTasks() {
  const safe = (fn, label) => () => fn().catch((err) => log.error(label + ' failed', err));
  // First pass shortly after launch: shows anything that came due while the app was closed.
  setTimeout(safe(reminderCheck, 'Reminder check'), 5000);
  setTimeout(safe(dailyBackupCheck, 'Daily backup'), 20000);
  setInterval(safe(reminderCheck, 'Reminder check'), REMINDER_CHECK_MS);
  setInterval(safe(dailyBackupCheck, 'Daily backup'), DAILY_BACKUP_CHECK_MS);
}

