/*
 * Phase 2 settings sections: desktop integration (tray, start at login,
 * notifications, reagent warnings) and automatic backups.
 */
import { h, replace, button, field } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, refresh } from '../ui/state.js';
import { openDialog } from '../ui/modal.js';
import { D, table, settings } from '../ui/widgets.js';

export function desktopSection(host, ctx) {
  const { signal } = ctx;
  const s = settings();
  const check = (key, labelText, hint) => {
    const input = h('input', { type: 'checkbox', id: 'set-' + key, checked: Boolean(s[key]) });
    input.addEventListener('change', () => save({ [key]: input.checked }, labelText + (input.checked ? ' on.' : ' off.')), { signal });
    return h('div', { class: 'field' }, h('span', { class: 'checkbox' }, input, h('label', { for: input.id }, labelText)), hint ? h('span', { class: 'hint' }, hint) : null);
  };
  const warn = h('input', { type: 'number', min: 1, max: 180, value: String(s.reagentWarnDays) });
  warn.addEventListener('change', () => {
    const v = Math.round(Number(warn.value));
    if (!Number.isFinite(v) || v < 1 || v > 180) { ctx.ticker.warn('Enter 1-180 days.'); warn.value = String(s.reagentWarnDays); return; }
    save({ reagentWarnDays: v }, 'Reagent warnings ' + v + ' days before expiry.');
  }, { signal });
  async function save(patch, message) {
    try {
      state.settings = await req('settings:save', patch);
      ctx.ticker.info(message);
      await refresh(['settings']);
    } catch (e) { /* ticker */ }
  }
  replace(host,
    h('h2', null, 'Reminders and desktop'),
    h('p', { class: 'hint' }, 'Reminders and notifications only work while AquaStar 5000 is running. Keep it in the tray to get reminders with the window closed.'),
    check('notifications', 'Desktop notifications for due tasks, treatment end dates and expiring reagents'),
    check('keepInTray', 'Keep running in the tray when the window is closed', 'Some Linux desktops (e.g. stock GNOME) need the AppIndicator extension to show tray icons.'),
    check('startAtLogin', 'Start at login', 'Works for the installed app. On Linux an autostart entry is written to ~/.config/autostart.'),
    field('Warn about test-kit reagents this many days before they expire', warn).wrap);
}

export function backupSection(host, ctx) {
  const { signal } = ctx;
  const s = settings();
  const keep = h('input', { type: 'number', min: 1, max: 100, value: String(s.backups.keep) });
  const onClose = h('input', { type: 'checkbox', id: 'bk-close', checked: s.backups.onClose });
  const daily = h('input', { type: 'checkbox', id: 'bk-daily', checked: s.backups.daily });
  const listHost = h('div');
  const save = async (patch, message) => {
    try {
      state.settings = await req('settings:save', { backups: patch });
      ctx.ticker.info(message);
    } catch (e) { /* ticker */ }
  };
  keep.addEventListener('change', () => {
    const v = Math.round(Number(keep.value));
    if (!Number.isFinite(v) || v < 1 || v > 100) { ctx.ticker.warn('Keep 1-100 backups.'); keep.value = String(s.backups.keep); return; }
    save({ keep: v }, 'Keeping the last ' + v + ' backups.');
  }, { signal });
  onClose.addEventListener('change', () => save({ onClose: onClose.checked }, onClose.checked ? 'Backup on close enabled.' : 'Backup on close disabled.'), { signal });
  daily.addEventListener('change', () => save({ daily: daily.checked }, daily.checked ? 'Daily backup enabled.' : 'Daily backup disabled.'), { signal });

  async function renderList() {
    let list = [];
    try { list = await req('backups:list', null, { quiet: true }); } catch (e) { list = []; }
    replace(listHost, list.length ? table(['Backup', 'Created', ''], list.slice(0, 30).map((b) => [
      b.kind === 'pre-import' ? 'Before import' : b.kind === 'manual' ? 'Manual' : 'Automatic',
      D.formatDateTime(b.createdAt),
      button('Restore...', () => restore(b), { attrs: { signal, 'aria-label': 'Restore backup from ' + D.formatDateTime(b.createdAt) } })
    ]), { caption: 'Backups' }) : h('p', { class: 'muted' }, 'No backups yet.'));
  }

  async function restore(b) {
    let preview;
    try { preview = await req('backups:restore', { name: b.name }); } catch (e) { return; }
    const rows = Object.keys(preview.counts).filter((k) => preview.counts[k] || preview.skipped[k]).map((k) => [k, String(preview.counts[k]), String(preview.skipped[k] || 0)]);
    rows.push(['photos', String(preview.photos), String(preview.badPhotos || 0)]);
    const ok = await openDialog({
      title: 'Restore backup from ' + D.formatDateTime(b.createdAt) + '?',
      size: 'wide',
      body: [table(['Data', 'Will restore', 'Skipped'], rows, { caption: 'Restore preview', rowHeaders: true }), h('p', { class: 'warning-text' }, 'Restoring REPLACES all current data. A safety copy of the current data is saved first.')],
      actions: [{ label: 'Cancel', value: false }, { label: 'Restore this backup', value: true, kind: 'danger' }]
    });
    if (!(ok === true || ok === 'true')) { req('data:importCancel', { token: preview.token }, { quiet: true }).catch(() => undefined); return; }
    try {
      const res = await req('data:importConfirm', { token: preview.token });
      ctx.ticker.info(res.message);
      ctx.dataChanged(true);
    } catch (e) { /* ticker */ }
  }

  replace(host,
    h('h2', null, 'Backups'),
    h('p', { class: 'hint' }, 'Backups are full copies (data + photos) in the backups folder (Help > Open Backups Folder). Restoring works like an import, with a preview.'),
    h('div', { class: 'form-row' },
      h('div', { class: 'field' }, h('span', { class: 'checkbox' }, onClose, h('label', { for: onClose.id }, 'Back up when the app closes'))),
      h('div', { class: 'field' }, h('span', { class: 'checkbox' }, daily, h('label', { for: daily.id }, 'Back up daily while running'))),
      field('Backups to keep', keep).wrap),
    h('div', { class: 'actions' }, button('Back up now', async () => {
      try {
        const res = await req('backups:create');
        ctx.ticker.info(res.message);
        renderList();
      } catch (e) { /* ticker */ }
    }, { kind: 'primary', attrs: { signal } })),
    listHost);
  renderList();
}
