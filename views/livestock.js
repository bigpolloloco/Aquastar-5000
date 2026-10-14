/*
 * Livestock inventory: fish, corals, inverts and plants per tank, with moves
 * between tanks (full history kept), frags linked to mother colonies, status
 * changes (died / sold / traded / moved out) that can split a quantity, and
 * quarantine tracking.
 */
import { h, replace, button, options, field } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, tankById } from '../ui/state.js';
import { confirmDialog, openDialog } from '../ui/modal.js';
import { formDialog, control } from '../ui/forms.js';
import { U, D, settings, tankSelect, emptyState, table, fmtMoney, statusBadge } from '../ui/widgets.js';

const CATEGORIES = [{ value: 'fish', label: 'Fish' }, { value: 'coral', label: 'Coral' }, { value: 'invert', label: 'Invertebrate' }, { value: 'plant', label: 'Plant' }, { value: 'other', label: 'Other' }];
const SOURCES = [{ value: 'store', label: 'Local store' }, { value: 'online', label: 'Online' }, { value: 'trade', label: 'Trade' }, { value: 'frag_swap', label: 'Frag swap' }, { value: 'own_frag', label: 'Own frag' }, { value: 'other', label: 'Other' }];
const STATUS = [{ value: 'alive', label: 'Alive' }, { value: 'died', label: 'Died' }, { value: 'sold', label: 'Sold' }, { value: 'traded', label: 'Traded' }, { value: 'moved', label: 'Moved out (not tracked here)' }];
const label = (list, v) => (list.find((x) => x.value === v) || { label: v }).label;

export default {
  id: 'livestock',
  title: 'Livestock',
  async mount(root, ctx) {
    const { signal } = ctx;
    if (!state.allTanks.length) {
      replace(root, emptyState('No tanks yet', 'Create a tank before adding livestock.'));
      return {};
    }
    let tankFilter = (ctx.params && ctx.params.tankId) || '';
    let statusFilter = 'alive';
    let items = [];

    const tankSel = tankSelect(tankFilter, (v) => { tankFilter = v; render(); }, { signal, allowAll: true, includeArchived: true, label: 'Tank filter' });
    const statusSel = h('select', { 'aria-label': 'Status filter' }, options([{ value: 'alive', label: 'Alive only' }, { value: 'qt', label: 'In quarantine' }, { value: 'gone', label: 'Died / sold / traded / moved' }, { value: 'all', label: 'Everything' }], statusFilter));
    statusSel.addEventListener('change', () => { statusFilter = statusSel.value; render(); }, { signal });
    const listHost = h('section', { class: 'panel' });
    replace(root,
      h('div', { class: 'panel controls-row' }, field('Tank', tankSel).wrap, field('Show', statusSel).wrap,
        h('div', { class: 'field' }, h('span', { class: 'label' }, ' '), button('Add livestock', () => edit(null), { kind: 'primary', attrs: { signal } }))),
      listHost);

    const nameOf = (id) => { const x = items.find((i) => i.id === id); return x ? x.commonName : 'unknown'; };

    async function edit(item) {
      const s = settings();
      const tanks = state.tanks.map((t) => ({ value: t.id, label: t.name }));
      const mothers = items.filter((i) => i.category === 'coral' && (!item || i.id !== item.id)).map((i) => ({ value: i.id, label: i.commonName + ' (' + (tankById(i.tankId) || {}).name + ')' }));
      const values = await formDialog({
        title: item ? 'Edit ' + item.commonName : 'Add livestock',
        size: 'wide',
        fields: [
          { row: [
            { key: 'commonName', label: 'Common name', required: true, max: 80, value: item ? item.commonName : '' },
            { key: 'scientificName', label: 'Scientific name', max: 120, value: item ? item.scientificName : '' },
            { key: 'category', label: 'Category', type: 'select', options: CATEGORIES, value: item ? item.category : 'fish' }
          ] },
          { row: [
            { key: 'tankId', label: 'Tank', type: 'select', options: tanks, value: item ? item.tankId : (tankFilter || (state.tanks[0] || {}).id), hint: item ? 'Use Move to keep a move in the history.' : null },
            { key: 'quantity', label: 'Quantity', type: 'number', integer: true, min: 0, max: 100000, required: true, value: item ? item.quantity : 1 },
            { key: 'dateAdded', label: 'Date added', type: 'date', required: true, value: item ? item.dateAdded : D.localDateString() }
          ] },
          { row: [
            { key: 'source', label: 'Source', type: 'select', options: SOURCES, value: item ? item.source : 'store' },
            { key: 'cost', label: 'Cost (' + U.units(s).currency + ')', type: 'number', min: 0, value: item ? item.cost : null },
            { key: 'motherId', label: 'Mother colony (frags)', type: 'select', options: mothers, allowEmpty: true, value: item ? item.motherId : null }
          ] },
          { row: [
            { key: 'status', label: 'Status', type: 'select', options: STATUS, value: item ? item.status : 'alive' },
            { key: 'statusDate', label: 'Status date', type: 'date', value: item ? item.statusDate : null },
            { key: 'lossCause', label: 'Suspected cause (losses)', max: 200, value: item ? item.lossCause : '' }
          ] },
          { row: [
            { key: 'inQt', label: 'In quarantine', type: 'checkbox', value: item && item.qt ? item.qt.inQt : false },
            { key: 'qtStart', label: 'QT start', type: 'date', value: item && item.qt ? item.qt.startDate : null },
            { key: 'qtRelease', label: 'Planned release', type: 'date', value: item && item.qt ? item.qt.releaseDate : null }
          ] },
          { key: 'notes', label: 'Notes', type: 'textarea', value: item ? item.notes : '' }
        ],
        validate: (v) => {
          if (v.status !== 'alive' && !v.statusDate) return 'Enter the status date.';
          if (v.inQt && !v.qtStart) return 'Enter the quarantine start date.';
          return null;
        }
      });
      if (!values) return;
      const payload = {
        tankId: values.tankId, commonName: values.commonName, scientificName: values.scientificName, category: values.category,
        quantity: values.quantity, dateAdded: values.dateAdded, source: values.source, cost: values.cost,
        status: values.status, statusDate: values.statusDate, lossCause: values.lossCause, motherId: values.motherId,
        fragDate: item ? item.fragDate : null,
        qt: values.inQt || values.qtStart || values.qtRelease ? { inQt: values.inQt, startDate: values.qtStart, releaseDate: values.qtRelease } : null,
        notes: values.notes
      };
      if (item) payload.id = item.id;
      try {
        const saved = await req('livestock:save', payload);
        ctx.ticker.info((item ? 'Updated ' : 'Added ') + saved.commonName + '.');
        await load();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    async function move(item) {
      const others = state.tanks.filter((t) => t.id !== item.tankId).map((t) => ({ value: t.id, label: t.name }));
      if (!others.length) { ctx.ticker.warn('Create another tank first to move livestock.'); return; }
      const v = await formDialog({
        title: 'Move ' + item.commonName,
        intro: 'Moving keeps the full history. Move part of a group to split it.',
        fields: [{ row: [
          { key: 'toTankId', label: 'To tank', type: 'select', options: others },
          { key: 'quantity', label: 'How many (of ' + item.quantity + ')', type: 'number', integer: true, min: 1, max: item.quantity, required: true, value: item.quantity },
          { key: 'date', label: 'Date', type: 'date', required: true, value: D.localDateString() }
        ] }, { key: 'note', label: 'Note', max: 200 }]
      });
      if (!v) return;
      try {
        await req('livestock:move', { id: item.id, toTankId: v.toTankId, quantity: v.quantity, date: v.date, note: v.note });
        ctx.ticker.info('Moved ' + v.quantity + ' x ' + item.commonName + ' to ' + tankById(v.toTankId).name + '.');
        await load();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    async function frag(item) {
      const v = await formDialog({
        title: 'Frag ' + item.commonName,
        intro: 'Creates a new item linked to this mother colony.',
        fields: [{ row: [
          { key: 'count', label: 'Number of frags', type: 'number', integer: true, min: 1, max: 10000, required: true, value: 1 },
          { key: 'date', label: 'Frag date', type: 'date', required: true, value: D.localDateString() },
          { key: 'tankId', label: 'Tank', type: 'select', options: state.tanks.map((t) => ({ value: t.id, label: t.name })), value: item.tankId }
        ] }, { key: 'name', label: 'Name for the frags', max: 80, value: item.commonName + ' (frag)' }]
      });
      if (!v) return;
      try {
        await req('livestock:frag', { motherId: item.id, count: v.count, date: v.date, tankId: v.tankId, name: v.name });
        ctx.ticker.info('Recorded ' + v.count + ' frag(s) of ' + item.commonName + '.');
        await load();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    async function changeStatus(item) {
      const v = await formDialog({
        title: 'Record a loss, sale or trade: ' + item.commonName,
        fields: [{ row: [
          { key: 'status', label: 'What happened', type: 'select', options: STATUS.filter((x) => x.value !== 'alive'), value: 'died',
            onChange: (input, controls) => { control(controls, 'cause').wrap.hidden = input.value !== 'died'; } },
          { key: 'quantity', label: 'How many (of ' + item.quantity + ')', type: 'number', integer: true, min: 1, max: Math.max(1, item.quantity), required: true, value: item.quantity },
          { key: 'date', label: 'Date', type: 'date', required: true, value: D.localDateString() }
        ] }, { key: 'cause', label: 'Suspected cause', max: 200 }, { key: 'note', label: 'Note (buyer, trade partner...)', max: 200 }]
      });
      if (!v) return;
      try {
        await req('livestock:status', { id: item.id, status: v.status, quantity: v.quantity, date: v.date, cause: v.cause || '', note: v.note || '' });
        ctx.ticker.info('Recorded: ' + v.quantity + ' x ' + item.commonName + ' ' + label(STATUS, v.status).toLowerCase() + '.');
        await load();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    function showHistory(item) {
      const describe = (x) => {
        const tank = (id) => (tankById(id) || { name: 'deleted tank' }).name;
        switch (x.type) {
          case 'added': return 'Added ' + (x.quantity || '') + ' to ' + tank(x.tankId);
          case 'moved': return 'Moved ' + x.quantity + ' from ' + tank(x.fromTankId) + ' to ' + tank(x.toTankId) + (x.note ? ' (' + x.note + ')' : '');
          case 'moved_out': return 'Moved ' + x.quantity + ' out to ' + tank(x.toTankId);
          case 'status': return 'Status ' + x.from + ' -> ' + x.to + (x.quantity ? ' (' + x.quantity + ')' : '') + (x.cause ? ', cause: ' + x.cause : '') + (x.note ? ', ' + x.note : '');
          case 'status_split': return x.quantity + ' marked ' + x.to + ' (split off)';
          case 'quantity': return 'Quantity ' + x.from + ' -> ' + x.to;
          case 'qt_start': return 'Quarantine started';
          case 'qt_end': return 'Quarantine ended';
          case 'fragged': return 'Fragged into ' + x.count + ' piece(s)';
          case 'fragged_from': return 'Fragged from ' + nameOf(x.motherId) + ' (' + x.count + ')';
          default: return x.type;
        }
      };
      const when = (x) => (x.date ? D.localNoonIso(x.date) : x.at) || '';
      const rows = (item.history || []).map((x, i) => ({ x, i, t: when(x) }))
        .sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : b.i - a.i))
        .map(({ x }) => [x.date ? D.formatDate(x.date) : D.formatDateTime(x.at), describe(x)]);
      const children = items.filter((i) => i.motherId === item.id);
      openDialog({
        title: 'History: ' + item.commonName,
        size: 'wide',
        body: [
          rows.length ? table(['Date', 'Event'], rows, { caption: 'History' }) : h('p', null, 'No history recorded.'),
          item.motherId ? h('p', null, 'Mother colony: ' + nameOf(item.motherId)) : null,
          children.length ? h('div', null, h('h3', null, 'Frags from this colony'),
            table(['Name', 'Qty', 'Status', 'Tank'], children.map((c) => [c.commonName, String(c.quantity), label(STATUS, c.status), (tankById(c.tankId) || {}).name || '']), { caption: 'Frags' })) : null
        ],
        actions: [{ label: 'Close', value: true, kind: 'primary' }]
      });
    }

    async function remove(item) {
      const ok = await confirmDialog('Delete ' + item.commonName + '?', 'Delete this record and its history? To record a loss, sale or trade use "Loss/sale" instead, which keeps the history.', { confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await req('livestock:delete', { id: item.id });
        ctx.ticker.info(item.commonName + ' deleted.');
        await load();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    function render() {
      const list = items.filter((i) => (!tankFilter || i.tankId === tankFilter) && (
        statusFilter === 'all' ||
        (statusFilter === 'alive' && i.status === 'alive') ||
        (statusFilter === 'qt' && i.status === 'alive' && i.qt && i.qt.inQt) ||
        (statusFilter === 'gone' && i.status !== 'alive')));
      if (!list.length) { replace(listHost, h('h2', null, 'Inventory'), h('p', null, 'Nothing to show for this filter.')); return; }
      const totalQty = list.filter((i) => i.status === 'alive').reduce((a, b) => a + b.quantity, 0);
      const rows = list.map((i) => {
        const tags = [];
        if (i.qt && i.qt.inQt && i.status === 'alive') tags.push(h('span', { class: 'tag tag-qt' }, 'IN QT' + (i.qt.releaseDate ? ' until ' + D.formatDate(i.qt.releaseDate) : '')));
        if (i.motherId) tags.push(h('span', { class: 'tag' }, 'frag of ' + nameOf(i.motherId)));
        return [
          h('div', null, h('strong', null, i.commonName), i.scientificName ? h('div', { class: 'muted sci' }, i.scientificName) : null, tags),
          label(CATEGORIES, i.category),
          String(i.quantity),
          tankFilter ? null : (tankById(i.tankId) || {}).name || '?',
          D.formatDate(i.dateAdded) + ' - ' + label(SOURCES, i.source),
          i.cost !== null && i.cost !== undefined ? fmtMoney(i.cost) : '--',
          i.status === 'alive' ? statusBadge('OK', 'ALIVE') : h('span', null, label(STATUS, i.status) + (i.statusDate ? ' ' + D.formatDate(i.statusDate) : '') + (i.lossCause ? ' (' + i.lossCause + ')' : '')),
          h('div', { class: 'row-actions' },
            button('Edit', () => edit(i), { attrs: { signal, 'aria-label': 'Edit ' + i.commonName } }),
            i.status === 'alive' ? button('Move', () => move(i), { attrs: { signal, 'aria-label': 'Move ' + i.commonName } }) : null,
            i.status === 'alive' && i.category === 'coral' ? button('Frag', () => frag(i), { attrs: { signal, 'aria-label': 'Frag ' + i.commonName } }) : null,
            i.status === 'alive' ? button('Loss/sale', () => changeStatus(i), { attrs: { signal, 'aria-label': 'Record loss, sale or trade of ' + i.commonName } }) : null,
            button('History', () => showHistory(i), { attrs: { signal, 'aria-label': 'History of ' + i.commonName } }),
            button('Photo', () => ctx.addPhoto({ tankId: i.tankId, ownerType: 'livestock', ownerId: i.id }), { attrs: { signal, 'aria-label': 'Attach photo to ' + i.commonName } }),
            button('Delete', () => remove(i), { kind: 'danger', attrs: { signal, 'aria-label': 'Delete ' + i.commonName } }))
        ].filter((c) => c !== null);
      });
      const headers = ['Name', 'Category', 'Qty', tankFilter ? null : 'Tank', 'Added / source', 'Cost', 'Status', ''].filter((x) => x !== null);
      replace(listHost, h('h2', null, 'Inventory (' + totalQty + ' alive)'), table(headers, rows, { caption: 'Livestock inventory' }));
    }

    async function load() {
      try { items = await req('livestock:list', {}); } catch (e) { items = []; }
      render();
    }
    await load();
    return {};
  }
};
