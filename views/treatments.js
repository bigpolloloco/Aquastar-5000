/*
 * Treatment log: medication or non-drug methods (dips, temperature,
 * hyposalinity), dose as written on the product label (nothing built in),
 * course dates, target (whole tank or one livestock item), daily
 * observations and outcome. The ticker warns when a course reaches its
 * planned end date.
 */
import { h, replace, button, options, field } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, tankById } from '../ui/state.js';
import { confirmDialog } from '../ui/modal.js';
import { formDialog } from '../ui/forms.js';
import { D, tankSelect, emptyState, table, statusBadge } from '../ui/widgets.js';

const METHODS = [{ value: 'medication', label: 'Medication' }, { value: 'dip', label: 'Dip / bath' }, { value: 'temperature', label: 'Temperature change' }, { value: 'hyposalinity', label: 'Hyposalinity' }, { value: 'other', label: 'Other method' }];
const OUTCOMES = [{ value: 'ongoing', label: 'Ongoing' }, { value: 'resolved', label: 'Resolved' }, { value: 'improved', label: 'Improved' }, { value: 'no_change', label: 'No change' }, { value: 'worse', label: 'Worse' }, { value: 'losses', label: 'Losses' }];
const label = (list, v) => (list.find((x) => x.value === v) || { label: v }).label;

export default {
  id: 'treatments',
  title: 'Treatment Log',
  async mount(root, ctx) {
    const { signal } = ctx;
    if (!state.allTanks.length) {
      replace(root, emptyState('No tanks yet', 'Create a tank before logging treatments.'));
      return {};
    }
    let tankFilter = (ctx.params && ctx.params.tankId) || '';
    let items = [];
    let livestock = [];
    const tankSel = tankSelect(tankFilter, (v) => { tankFilter = v; render(); }, { signal, allowAll: true, includeArchived: true, label: 'Tank filter' });
    const activeHost = h('section', { class: 'panel' });
    const pastHost = h('section', { class: 'panel' });
    replace(root,
      h('div', { class: 'panel controls-row' }, field('Tank', tankSel).wrap,
        h('div', { class: 'field' }, h('span', { class: 'label' }, ' '), button('Start a treatment', () => edit(null), { kind: 'primary', attrs: { signal } }))),
      h('p', { class: 'hint panel' }, 'AquaStar does not include medication doses. Always dose from the product label and record what you used here.'),
      activeHost, pastHost);

    async function edit(item) {
      const tankId = item ? item.tankId : (tankFilter || (state.tanks[0] || {}).id);
      const targets = livestock.filter((l) => l.status === 'alive').map((l) => ({ value: l.id, label: l.commonName + ' (' + ((tankById(l.tankId) || {}).name || '') + ')' }));
      const v = await formDialog({
        title: item ? 'Edit treatment' : 'Start a treatment',
        size: 'wide',
        fields: [
          { row: [
            { key: 'tankId', label: 'Tank', type: 'select', options: state.tanks.map((t) => ({ value: t.id, label: t.name })), value: tankId },
            { key: 'medication', label: 'Medication or method', required: true, max: 80, value: item ? item.medication : '' },
            { key: 'method', label: 'Type', type: 'select', options: METHODS, value: item ? item.method : 'medication' }
          ] },
          { row: [
            { key: 'dose', label: 'Dose (from the label)', max: 120, value: item ? item.dose : '' },
            { key: 'targetLivestockId', label: 'Target', type: 'select', options: targets, allowEmpty: true, emptyLabel: 'Whole tank', value: item ? item.targetLivestockId : null }
          ] },
          { row: [
            { key: 'startDate', label: 'Start date', type: 'date', required: true, value: item ? item.startDate : D.localDateString() },
            { key: 'plannedEndDate', label: 'Planned end', type: 'date', value: item ? item.plannedEndDate : null },
            { key: 'endDate', label: 'Actual end', type: 'date', value: item ? item.endDate : null },
            { key: 'outcome', label: 'Outcome', type: 'select', options: OUTCOMES, value: item ? item.outcome : 'ongoing' }
          ] },
          { key: 'notes', label: 'Notes', type: 'textarea', value: item ? item.notes : '' }
        ],
        validate: (x) => (x.plannedEndDate && x.plannedEndDate < x.startDate ? 'Planned end is before the start.' : x.endDate && x.endDate < x.startDate ? 'End is before the start.' : null)
      });
      if (!v) return;
      const payload = Object.assign({}, v, { observations: item ? item.observations : [] });
      if (item) payload.id = item.id;
      try {
        await req('treatments:save', payload);
        ctx.ticker.info((item ? 'Treatment updated: ' : 'Treatment started: ') + v.medication + '.');
        await load();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    async function observe(item) {
      const v = await formDialog({
        title: 'Observation: ' + item.medication,
        fields: [{ key: 'date', label: 'Date', type: 'date', required: true, value: D.localDateString() }, { key: 'note', label: 'What you observed', type: 'textarea', required: true, max: 500 }]
      });
      if (!v) return;
      try {
        await req('treatments:save', Object.assign({}, strip(item), { observations: (item.observations || []).concat([{ date: v.date, note: v.note }]).sort((a, b) => (a.date < b.date ? -1 : 1)) }));
        ctx.ticker.info('Observation added.');
        await load();
      } catch (e) { /* ticker */ }
    }

    async function finish(item) {
      const v = await formDialog({
        title: 'End treatment: ' + item.medication,
        fields: [{ row: [
          { key: 'endDate', label: 'End date', type: 'date', required: true, value: D.localDateString() },
          { key: 'outcome', label: 'Outcome', type: 'select', options: OUTCOMES.filter((o) => o.value !== 'ongoing'), value: 'resolved' }
        ] }]
      });
      if (!v) return;
      try {
        await req('treatments:save', Object.assign({}, strip(item), v));
        ctx.ticker.info('Treatment ended: ' + label(OUTCOMES, v.outcome) + '.');
        await load();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    function strip(item) {
      const out = Object.assign({}, item);
      delete out.createdAt; delete out.updatedAt;
      return out;
    }

    async function remove(item) {
      const ok = await confirmDialog('Delete treatment?', 'Delete the treatment record "' + item.medication + '" and its observations?', { confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await req('treatments:delete', { id: item.id });
        ctx.ticker.info('Treatment deleted.');
        await load();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    function card(item) {
      const target = item.targetLivestockId ? (livestock.find((l) => l.id === item.targetLivestockId) || { commonName: 'livestock item' }).commonName : 'Whole tank';
      const day = D.daysSince(D.localNoonIso(item.startDate)) + 1;
      const left = item.plannedEndDate ? D.daysUntilDate(item.plannedEndDate) : null;
      const status = item.endDate ? statusBadge('OK', label(OUTCOMES, item.outcome).toUpperCase())
        : left !== null && left <= 0 ? statusBadge('WATCH', left === 0 ? 'ENDS TODAY' : 'PAST END')
          : statusBadge('NONE', 'DAY ' + day);
      return h('article', { class: 'subpanel treatment-card' },
        h('div', { class: 'list-header' },
          h('h3', null, item.medication + ' - ' + ((tankById(item.tankId) || {}).name || '')), status),
        h('p', null, label(METHODS, item.method) + (item.dose ? ' - Dose: ' + item.dose : '') + ' - Target: ' + target),
        h('p', { class: 'muted' }, 'Started ' + D.formatDate(item.startDate) +
          (item.plannedEndDate ? ' - planned end ' + D.formatDate(item.plannedEndDate) + (left !== null && !item.endDate ? (left > 0 ? ' (' + left + ' days left)' : '') : '') : '') +
          (item.endDate ? ' - ended ' + D.formatDate(item.endDate) : '')),
        item.observations && item.observations.length
          ? table(['Date', 'Observation'], item.observations.slice().reverse().map((o) => [D.formatDate(o.date), o.note]), { caption: 'Observations' })
          : h('p', { class: 'muted' }, 'No observations yet.'),
        item.notes ? h('p', null, item.notes) : null,
        h('div', { class: 'row-actions' },
          button('Add observation', () => observe(item), { attrs: { signal } }),
          item.endDate ? null : button('End treatment', () => finish(item), { kind: 'primary', attrs: { signal } }),
          button('Edit', () => edit(item), { attrs: { signal } }),
          button('Photo', () => ctx.addPhoto({ tankId: item.tankId, ownerType: 'treatment', ownerId: item.id }), { attrs: { signal } }),
          button('Delete', () => remove(item), { kind: 'danger', attrs: { signal } })));
    }

    function render() {
      const list = items.filter((i) => !tankFilter || i.tankId === tankFilter);
      const active = list.filter((i) => !i.endDate);
      const past = list.filter((i) => i.endDate);
      replace(activeHost, h('h2', null, 'Active treatments (' + active.length + ')'), active.length ? active.map(card) : h('p', null, 'No active treatments.'));
      replace(pastHost, h('h2', null, 'Past treatments'), past.length ? past.map(card) : h('p', null, 'None yet.'));
    }

    async function load() {
      try {
        [items, livestock] = await Promise.all([req('treatments:list', {}), req('livestock:list', {})]);
      } catch (e) { items = []; }
      render();
    }
    await load();
    return {};
  }
};
