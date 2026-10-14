/*
 * Renderer shell: navigation, view lifecycle (mount/unmount with automatic
 * listener and timer cleanup), ticker wiring and global error handling.
 */
import { h, replace } from './ui/dom.js';
import { Ticker } from './ui/ticker.js';
import { req, on, setTicker, logToMain, ApiError } from './ui/api.js';
import { state, refresh } from './ui/state.js';
import { computeAlerts, summarize } from './ui/alerts.js';
import { openDialog, confirmDialog } from './ui/modal.js';
import { table } from './ui/widgets.js';
import { VIEWS, NAV, FEATURES, extensions } from './views/registry.js';

const viewEl = document.getElementById('view');
const titleEl = document.getElementById('view-title');
const navList = document.getElementById('nav-list');
const ticker = new Ticker(document.getElementById('ticker'));
setTicker(ticker);

// ----------------------------------------------------------------- errors
// Log, show a ticker message, keep running.
window.addEventListener('error', (event) => {
  const msg = event && event.message ? event.message : 'Unknown error';
  logToMain('ERROR', 'Renderer error: ' + msg + (event && event.filename ? ' at ' + String(event.filename).replace(/^.*\//, '') + ':' + event.lineno : ''));
  ticker.error('Something went wrong on this screen. You can keep working; details were logged.');
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  event.preventDefault();
  if (reason instanceof ApiError && reason.shown) return;
  logToMain('ERROR', 'Renderer unhandled rejection: ' + (reason && reason.message ? reason.message : String(reason)));
  ticker.error(reason instanceof ApiError ? reason.message : 'A background task failed. You can keep working; details were logged.');
});

ticker.setHistoryHandler((items) => {
  openDialog({
    title: 'Recent messages',
    size: 'wide',
    body: items.length
      ? table(['Time', 'Level', 'Message'], items.map((m) => [m.at.toLocaleTimeString(), m.level, m.text]), { caption: 'Recent ticker messages' })
      : h('p', null, 'No messages yet.'),
    actions: [{ label: 'Close', value: true, kind: 'primary' }]
  });
});

// ------------------------------------------------------------------ clock
const clockTime = document.getElementById('clock-time');
const clockDate = document.getElementById('clock-date');
function tick() {
  const now = new Date();
  clockTime.textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  clockDate.textContent = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
tick();
setInterval(tick, 15000);

// ----------------------------------------------------------------- router
let current = null;
let navToken = 0;

function buildNav() {
  replace(navList, NAV.map((item) => (item.group ? h('li', { class: 'nav-group', 'aria-hidden': 'true' }, item.group) : h('li', null,
    h('button', { type: 'button', class: 'nav-btn', dataset: { view: item.id }, onclick: () => navigate(item.id), title: item.shortcut ? item.label + ' (' + item.shortcut + ')' : item.label },
      h('span', { class: 'nav-label' }, item.label), item.shortcut && !item.compact ? h('span', { class: 'nav-key', 'aria-hidden': 'true' }, item.shortcut) : null)))));
}

function teardown() {
  if (!current) return;
  try { if (current.handle && current.handle.unmount) current.handle.unmount(); } catch (e) { logToMain('WARN', 'View unmount failed: ' + e.message); }
  current.controller.abort();
  current.timers.forEach((t) => clearTimeout(t));
  current.timers.clear();
  current = null;
}

export async function navigate(id, params) {
  const view = VIEWS.find((v) => v.id === id) || VIEWS[0];
  teardown();
  const token = ++navToken;
  const controller = new AbortController();
  const timers = new Set();
  const entry = { view, controller, timers, handle: null, params: params || {} };
  current = entry;
  titleEl.textContent = view.title;
  document.title = view.title + ' - AquaStar 5000';
  navList.querySelectorAll('.nav-btn').forEach((b) => {
    if (b.dataset.view === view.id) { b.setAttribute('aria-current', 'page'); b.scrollIntoView({ block: 'nearest' }); } else b.removeAttribute('aria-current');
  });
  replace(viewEl, h('p', { class: 'loading' }, 'Loading...'));
  const container = h('div', { class: 'view-inner view-' + view.id });
  const ctx = {
    signal: controller.signal,
    params: params || {},
    ticker,
    navigate: (v, p) => navigate(v, typeof p === 'string' ? { action: p } : p),
    dataChanged: (external) => dataChanged(external),
    addPhoto,
    log: (level, message) => logToMain(level, message),
    setTimer: (fn, ms) => {
      const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
      timers.add(t);
      return t;
    },
    clearTimer: (t) => { clearTimeout(t); timers.delete(t); },
    hasCollection: (name) => FEATURES.has(name),
    upcomingMaintenance: extensions.upcomingMaintenance,
    settingsSections: extensions.settingsSections
  };
  try {
    const handle = await view.mount(container, ctx);
    if (token !== navToken) {
      if (handle && handle.unmount) handle.unmount();
      return;
    }
    entry.handle = handle || {};
    replace(viewEl, container);
    if (!container.contains(document.activeElement)) viewEl.focus({ preventScroll: true });
  } catch (err) {
    if (token !== navToken) return;
    logToMain('ERROR', 'View ' + view.id + ' failed to load: ' + (err && err.message));
    replace(viewEl, h('div', { class: 'panel' }, h('h2', null, 'This screen could not be loaded'), h('p', null, 'The rest of the app still works. Details were written to the log.')));
    if (!(err instanceof ApiError && err.shown)) ticker.error('The ' + view.title + ' screen could not be loaded.');
  }
}

async function addPhoto(owner) {
  try {
    const res = await req('photos:add', owner);
    if (res.canceled) return false;
    if (res.added.length) ticker.info('Added ' + res.added.length + ' photo' + (res.added.length === 1 ? '' : 's') + '.');
    res.errors.forEach((e) => ticker.warn(e));
    return res.added.length > 0;
  } catch (e) {
    return false;
  }
}

async function updateTickerSummary(announce) {
  try {
    const { all } = await computeAlerts();
    const extra = extensions.tickerExtras ? await extensions.tickerExtras() : [];
    ticker.setIdle(summarize(all, extra.map((x) => x.text)));
    if (announce) {
      const alerts = all.filter((a) => a.level === 'ALERT');
      if (alerts.length) ticker.warn(alerts.length + (alerts.length === 1 ? ' alert needs' : ' alerts need') + ' attention: ' + alerts.slice(0, 3).map((a) => a.message).join(' / '));
      extra.filter((x) => x.announce).forEach((x) => ticker.push(x.level || 'WARN', x.text));
    }
  } catch (e) {
    /* computeAlerts uses quiet calls; nothing else to do */
  }
}

async function dataChanged(external) {
  if (external) {
    try { await refresh(); } catch (e) { /* shown */ }
    if (current) navigate(current.view.id, current.params);
  }
  updateTickerSummary(false);
}

// ---------------------------------------------------------------- startup
async function handleCorrupt(info) {
  if (!info.corrupt.length) return;
  ticker.error('Some data files are damaged and were not loaded: ' + info.corrupt.join(', ') + '. Other data is fine.');
  const ok = await confirmDialog('Damaged data files',
    'These data files could not be read: ' + info.corrupt.join(', ') + '. They were left untouched. Start fresh for them now? (The damaged files are kept as .corrupt copies. You can also restore a backup via Settings > Import.)',
    { confirmLabel: 'Start fresh', cancelLabel: 'Not now', danger: true });
  if (!ok) {
    ticker.warn('Damaged files are read-only until you start fresh (Settings & Data).');
    return;
  }
  for (const name of info.corrupt) {
    try { await req('app:resetStore', { name }); } catch (e) { /* shown */ }
  }
  ticker.ack();
  ticker.info('Started fresh for the damaged files.');
  await refresh();
}

async function start() {
  buildNav();
  on('menu:navigate', (msg) => {
    if (!msg || typeof msg.view !== 'string') return;
    navigate(msg.view, msg.action ? { action: msg.action } : {});
  });
  on('app:ticker', (msg) => {
    if (msg && typeof msg.text === 'string') ticker.push(msg.level, msg.text);
  });
  let info = null;
  try {
    info = await req('app:info');
    state.info = info;
    await refresh();
  } catch (e) {
    ticker.error('Data could not be loaded. Try restarting AquaStar 5000.');
  }
  if (info) {
    if (info.migratedFrom !== null && info.migratedFrom !== undefined) ticker.info('Your data was upgraded to the latest format.');
    await handleCorrupt(info);
  }
  if (extensions.onStartup) {
    try { await extensions.onStartup({ ticker }); } catch (e) { logToMain('WARN', 'Startup extension failed: ' + e.message); }
  }
  await navigate(state.tanks.length ? 'dashboard' : 'tanks', state.tanks.length ? {} : { action: 'new' });
  updateTickerSummary(true);
}

start();
