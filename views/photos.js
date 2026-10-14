/*
 * Photo timeline per tank and side-by-side comparison of any two photos.
 * Photos are served from app://aquastar/photos/... by the main process; a
 * missing or unreadable file shows a placeholder and the app keeps running.
 */
import { h, replace, button, options, field } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, tankById, defaultTankId } from '../ui/state.js';
import { confirmDialog, openDialog } from '../ui/modal.js';
import { D, tankSelect, emptyState } from '../ui/widgets.js';

const PLACEHOLDER = 'assets/img/photo-missing.svg';
const OWNER_LABEL = { tank: 'Tank', entry: 'Test', maintenance: 'Maintenance', livestock: 'Livestock', journal: 'Journal', treatment: 'Treatment', equipment: 'Equipment' };

/** <img> that falls back to the placeholder if the file is missing or corrupt. */
export function photoImg(photo, alt) {
  const img = h('img', { src: photo.url, alt: alt || photo.caption || 'Tank photo', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => {
    if (img.dataset.failed) return;
    img.dataset.failed = '1';
    img.src = PLACEHOLDER;
    img.alt = 'Photo unavailable (file missing or unreadable)';
    img.classList.add('photo-missing');
  }, { once: false });
  return img;
}

export default {
  id: 'photos',
  title: 'Photo Timeline',
  async mount(root, ctx) {
    const { signal } = ctx;
    if (!state.allTanks.length) {
      replace(root, emptyState('No tanks yet', 'Create a tank to start a photo timeline.'));
      return {};
    }
    let tankId = (ctx.params && ctx.params.tankId) || defaultTankId() || state.allTanks[0].id;
    let ownerFilter = '';
    let photos = [];
    const selected = [];

    const tankSel = tankSelect(tankId, (id) => { tankId = id; selected.length = 0; load(); }, { signal, includeArchived: true });
    const ownerSel = h('select', { 'aria-label': 'Filter by attachment' }, h('option', { value: '' }, 'All photos'), options(Object.keys(OWNER_LABEL).map((k) => ({ value: k, label: OWNER_LABEL[k] }))));
    ownerSel.addEventListener('change', () => { ownerFilter = ownerSel.value; render(); }, { signal });
    const addBtn = button('Add photos...', () => add(), { kind: 'primary', attrs: { signal } });
    const compareHost = h('section', { class: 'panel compare', 'aria-label': 'Photo comparison' });
    const gridHost = h('section', { class: 'panel' });
    replace(root,
      h('div', { class: 'panel controls-row' }, field('Tank', tankSel).wrap, field('Show', ownerSel).wrap, h('div', { class: 'field' }, h('span', { class: 'label' }, ' '), addBtn)),
      compareHost, gridHost);

    async function add() {
      const res = await ctx.addPhoto({ tankId, ownerType: 'tank', ownerId: null });
      if (res) await load();
    }

    function toggleSelect(p, checkbox) {
      const i = selected.findIndex((x) => x.id === p.id);
      if (i >= 0) selected.splice(i, 1);
      else {
        selected.push(p);
        if (selected.length > 2) selected.shift();
      }
      render();
      const again = gridHost.querySelector('input[data-photo="' + p.id + '"]');
      if (again) again.focus(); else if (checkbox) checkbox.focus();
    }

    async function editCaption(p) {
      const caption = h('input', { type: 'text', maxlength: 200, value: p.caption || '' });
      const when = h('input', { type: 'datetime-local', value: D.toLocalInputValue(p.takenAt) });
      const res = await openDialog({
        title: 'Edit photo details',
        body: [field('Caption', caption).wrap, field('Taken', when).wrap],
        actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, kind: 'primary' }],
        validate: () => (D.fromLocalInputValue(when.value) ? null : 'Enter a valid date and time.')
      });
      if (!res) return;
      try {
        await req('photos:save', { id: p.id, caption: caption.value, takenAt: D.fromLocalInputValue(when.value) });
        ctx.ticker.info('Photo details saved.');
        await load();
      } catch (e) { /* ticker */ }
    }

    async function remove(p) {
      const ok = await confirmDialog('Delete photo?', 'Delete this photo from AquaStar? The copy in the AquaStar data folder is removed; your original file is not touched.', { confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await req('photos:delete', { id: p.id });
        const i = selected.findIndex((x) => x.id === p.id);
        if (i >= 0) selected.splice(i, 1);
        ctx.ticker.info('Photo deleted.');
        await load();
      } catch (e) { /* ticker */ }
    }

    function renderCompare() {
      if (selected.length < 2) {
        replace(compareHost, h('h2', null, 'Compare'), h('p', null, selected.length === 1
          ? 'Select one more photo to compare side by side.'
          : 'Tick "Compare" on any two photos to see them side by side (great for coral growth, plant fill-in or algae).'));
        return;
      }
      const [a, b] = selected.slice().sort((x, y) => (x.takenAt < y.takenAt ? -1 : 1));
      const days = Math.abs(D.daysSince(a.takenAt, new Date(b.takenAt)));
      replace(compareHost,
        h('h2', null, 'Compare - ' + days + ' days apart'),
        h('div', { class: 'compare-grid' },
          [a, b].map((p) => h('figure', { class: 'compare-item' }, photoImg(p), h('figcaption', null, D.formatDateTime(p.takenAt) + (p.caption ? ' - ' + p.caption : ''))))),
        button('Clear comparison', () => { selected.length = 0; render(); }, { attrs: { signal } }));
    }

    function render() {
      renderCompare();
      const list = photos.filter((p) => !ownerFilter || p.ownerType === ownerFilter);
      if (!list.length) {
        replace(gridHost, h('h2', null, 'Timeline'), h('p', null, 'No photos yet for ' + (tankById(tankId) || {}).name + '.'));
        return;
      }
      const groups = new Map();
      list.forEach((p) => {
        const key = new Date(p.takenAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      });
      const sections = [];
      groups.forEach((items, label) => {
        sections.push(h('h3', { class: 'timeline-month' }, label));
        sections.push(h('div', { class: 'photo-grid' }, items.map((p) => {
          const isSel = selected.some((x) => x.id === p.id);
          const cb = h('input', { type: 'checkbox', checked: isSel, id: 'cmp-' + p.id, dataset: { photo: p.id } });
          cb.addEventListener('change', () => toggleSelect(p, cb), { signal });
          return h('figure', { class: 'photo-card' + (isSel ? ' selected' : '') },
            photoImg(p),
            h('figcaption', null,
              h('span', { class: 'photo-date' }, D.formatDateTime(p.takenAt)),
              p.caption ? h('span', { class: 'photo-caption' }, p.caption) : null,
              h('span', { class: 'photo-owner muted' }, OWNER_LABEL[p.ownerType] || 'Tank')),
            h('div', { class: 'row-actions' },
              h('span', { class: 'checkbox' }, cb, h('label', { for: cb.id }, 'Compare')),
              button('Edit', () => editCaption(p), { attrs: { signal, 'aria-label': 'Edit details of photo from ' + D.formatDateTime(p.takenAt) } }),
              button('Delete', () => remove(p), { kind: 'danger', attrs: { signal, 'aria-label': 'Delete photo from ' + D.formatDateTime(p.takenAt) } })));
        })));
      });
      replace(gridHost, h('h2', null, 'Timeline (' + list.length + ')'), sections);
    }

    async function load() {
      try {
        photos = await req('photos:list', { tankId });
      } catch (e) { photos = []; }
      render();
    }

    await load();
    return {};
  }
};
