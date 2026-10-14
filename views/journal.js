/*
 * Free-form journal per tank (observations, behavior, spawning, algae
 * outbreaks) with photos.
 */
import { h, replace, button, field } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, tankById, defaultTankId } from '../ui/state.js';
import { confirmDialog } from '../ui/modal.js';
import { formDialog } from '../ui/forms.js';
import { photoImg } from './photos.js';
import { D, tankSelect, emptyState } from '../ui/widgets.js';

export default {
  id: 'journal',
  title: 'Journal',
  async mount(root, ctx) {
    const { signal } = ctx;
    if (!state.allTanks.length) {
      replace(root, emptyState('No tanks yet', 'Create a tank to start a journal.'));
      return {};
    }
    let tankId = (ctx.params && ctx.params.tankId) || defaultTankId() || state.allTanks[0].id;
    let items = [];
    let photos = [];
    const tankSel = tankSelect(tankId, (v) => { tankId = v; load(); }, { signal, includeArchived: true });
    const listHost = h('section', { class: 'panel' });
    replace(root, h('div', { class: 'panel controls-row' }, field('Tank', tankSel).wrap,
      h('div', { class: 'field' }, h('span', { class: 'label' }, ' '), button('New entry', () => edit(null), { kind: 'primary', attrs: { signal } }))), listHost);

    async function edit(item) {
      const v = await formDialog({
        title: item ? 'Edit journal entry' : 'New journal entry',
        size: 'wide',
        fields: [
          { row: [
            { key: 'when', label: 'Date and time', type: 'datetime', required: true, value: D.toLocalInputValue(item ? item.date : new Date()) },
            { key: 'title', label: 'Title', max: 120, value: item ? item.title : '' }
          ] },
          { key: 'text', label: 'Entry', type: 'textarea', rows: 8, max: 10000, value: item ? item.text : '' }
        ],
        validate: (x) => (!x.title && !x.text ? 'Write a title or some text.' : null)
      });
      if (!v) return;
      const payload = { tankId, date: D.fromLocalInputValue(v.when), title: v.title || '', text: v.text || '' };
      if (item) { payload.id = item.id; payload.tankId = item.tankId; }
      try {
        await req('journal:save', payload);
        ctx.ticker.info('Journal entry saved.');
        await load();
      } catch (e) { /* ticker */ }
    }

    async function remove(item) {
      const ok = await confirmDialog('Delete journal entry?', 'Delete "' + (item.title || D.formatDateTime(item.date)) + '"? Attached photos stay in the photo timeline.', { confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await req('journal:delete', { id: item.id });
        ctx.ticker.info('Journal entry deleted.');
        await load();
      } catch (e) { /* ticker */ }
    }

    function render() {
      if (!items.length) { replace(listHost, h('h2', null, 'Journal - ' + (tankById(tankId) || {}).name), h('p', null, 'No entries yet.')); return; }
      replace(listHost, h('h2', null, 'Journal - ' + (tankById(tankId) || {}).name), items.map((j) => {
        const pics = photos.filter((p) => p.ownerType === 'journal' && p.ownerId === j.id);
        return h('article', { class: 'subpanel journal-entry' },
          h('div', { class: 'list-header' }, h('h3', null, j.title || 'Entry'), h('span', { class: 'muted' }, D.formatDateTime(j.date))),
          j.text ? h('p', { class: 'journal-text' }, j.text) : null,
          pics.length ? h('div', { class: 'photo-grid small' }, pics.map((p) => h('figure', { class: 'photo-card' }, photoImg(p), p.caption ? h('figcaption', null, p.caption) : null))) : null,
          h('div', { class: 'row-actions' },
            button('Edit', () => edit(j), { attrs: { signal } }),
            button('Add photo', async () => { if (await ctx.addPhoto({ tankId: j.tankId, ownerType: 'journal', ownerId: j.id })) load(); }, { attrs: { signal } }),
            button('Delete', () => remove(j), { kind: 'danger', attrs: { signal } })));
      }));
    }

    async function load() {
      try {
        [items, photos] = await Promise.all([req('journal:list', { tankId }), req('photos:list', { tankId, ownerType: 'journal' })]);
      } catch (e) { items = []; photos = []; }
      render();
    }
    await load();
    return {};
  }
};
