/*
 * Optional expense log with totals per tank and per month. Livestock and
 * equipment purchase costs can be included in the totals.
 */
import { h, replace, button, field } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, tankById } from '../ui/state.js';
import { confirmDialog } from '../ui/modal.js';
import { formDialog } from '../ui/forms.js';
import { U, D, settings, tankSelect, table, fmtMoney } from '../ui/widgets.js';

const CATEGORIES = [
  { value: 'livestock', label: 'Livestock' }, { value: 'equipment', label: 'Equipment' }, { value: 'supplies', label: 'Supplies' },
  { value: 'food', label: 'Food' }, { value: 'salt', label: 'Salt' }, { value: 'testing', label: 'Testing' },
  { value: 'electricity', label: 'Electricity' }, { value: 'other', label: 'Other' }
];
const catLabel = (v) => (CATEGORIES.find((c) => c.value === v) || { label: v }).label;

export default {
  id: 'expenses',
  title: 'Expenses',
  async mount(root, ctx) {
    const { signal } = ctx;
    let tankFilter = '';
    let includePurchases = true;
    let items = [];
    let livestock = [];
    let equipment = [];
    const tankSel = tankSelect(tankFilter, (v) => { tankFilter = v; render(); }, { signal, allowAll: true, includeArchived: true, label: 'Tank filter' });
    const inc = h('input', { type: 'checkbox', id: 'exp-inc', checked: includePurchases });
    inc.addEventListener('change', () => { includePurchases = inc.checked; render(); }, { signal });
    const totalsHost = h('section', { class: 'panel' });
    const listHost = h('section', { class: 'panel' });
    replace(root,
      h('div', { class: 'panel controls-row' }, field('Tank', tankSel).wrap,
        h('div', { class: 'field' }, h('span', { class: 'checkbox' }, inc, h('label', { for: inc.id }, 'Include livestock and equipment costs in totals'))),
        h('div', { class: 'field' }, h('span', { class: 'label' }, ' '), button('Add expense', () => edit(null), { kind: 'primary', attrs: { signal } }))),
      totalsHost, listHost);

    async function edit(item) {
      const v = await formDialog({
        title: item ? 'Edit expense' : 'Add expense',
        fields: [
          { row: [
            { key: 'date', label: 'Date', type: 'date', required: true, value: item ? item.date : D.localDateString() },
            { key: 'category', label: 'Category', type: 'select', options: CATEGORIES, value: item ? item.category : 'supplies' },
            { key: 'amount', label: 'Amount (' + U.units(settings()).currency + ')', type: 'number', min: 0, required: true, value: item ? item.amount : null }
          ] },
          { row: [
            { key: 'description', label: 'Description', required: true, max: 120, value: item ? item.description : '' },
            { key: 'tankId', label: 'Tank', type: 'select', options: state.allTanks.map((t) => ({ value: t.id, label: t.name })), allowEmpty: true, emptyLabel: '(general / all tanks)', value: item ? item.tankId : (tankFilter || null) }
          ] },
          { key: 'notes', label: 'Notes', type: 'textarea', max: 1000, value: item ? item.notes : '' }
        ]
      });
      if (!v) return;
      if (item) v.id = item.id;
      try {
        await req('expenses:save', v);
        ctx.ticker.info('Expense saved.');
        await load();
      } catch (e) { /* ticker */ }
    }

    async function remove(item) {
      const ok = await confirmDialog('Delete expense?', 'Delete "' + item.description + '"?', { confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await req('expenses:delete', { id: item.id });
        ctx.ticker.info('Expense deleted.');
        await load();
      } catch (e) { /* ticker */ }
    }

    function allRows() {
      const rows = items.map((x) => ({ date: x.date, tankId: x.tankId, category: x.category, amount: x.amount, description: x.description, source: 'expense', ref: x }));
      if (includePurchases) {
        livestock.filter((l) => typeof l.cost === 'number' && !l.splitFromId).forEach((l) => rows.push({ date: l.dateAdded, tankId: l.tankId, category: 'livestock', amount: l.cost, description: l.commonName, source: 'livestock' }));
        equipment.filter((e) => typeof e.cost === 'number' && e.purchaseDate).forEach((e) => rows.push({ date: e.purchaseDate, tankId: e.tankId, category: 'equipment', amount: e.cost, description: [e.brand, e.model].filter(Boolean).join(' '), source: 'equipment' }));
      }
      return rows.filter((r) => !tankFilter || r.tankId === tankFilter).sort((a, b) => (a.date < b.date ? 1 : -1));
    }

    function render() {
      const rows = allRows();
      const total = rows.reduce((a, b) => a + b.amount, 0);
      const byMonth = new Map();
      const byTank = new Map();
      const byCat = new Map();
      rows.forEach((r) => {
        const m = r.date.slice(0, 7);
        byMonth.set(m, (byMonth.get(m) || 0) + r.amount);
        const t = r.tankId ? ((tankById(r.tankId) || {}).name || 'Deleted tank') : 'General';
        byTank.set(t, (byTank.get(t) || 0) + r.amount);
        byCat.set(catLabel(r.category), (byCat.get(catLabel(r.category)) || 0) + r.amount);
      });
      const monthLabel = (m) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
      replace(totalsHost,
        h('h2', null, 'Totals: ' + fmtMoney(total)),
        h('div', { class: 'slide-columns' },
          h('div', { class: 'subpanel' }, h('h3', null, 'Per month'), byMonth.size ? table(['Month', 'Total'], Array.from(byMonth.entries()).slice(0, 24).map(([m, v]) => [monthLabel(m), fmtMoney(v)]), { caption: 'Totals per month' }) : h('p', null, '--')),
          h('div', { class: 'subpanel' }, h('h3', null, 'Per tank'), byTank.size ? table(['Tank', 'Total'], Array.from(byTank.entries()).map(([t, v]) => [t, fmtMoney(v)]), { caption: 'Totals per tank' }) : h('p', null, '--')),
          h('div', { class: 'subpanel' }, h('h3', null, 'Per category'), byCat.size ? table(['Category', 'Total'], Array.from(byCat.entries()).map(([c, v]) => [c, fmtMoney(v)]), { caption: 'Totals per category' }) : h('p', null, '--'))));
      replace(listHost, h('h2', null, 'Expenses'), rows.length ? table(['Date', 'Description', 'Category', 'Tank', 'Amount', ''], rows.slice(0, 500).map((r) => [
        D.formatDate(r.date), r.description, catLabel(r.category), r.tankId ? ((tankById(r.tankId) || {}).name || '') : 'General', fmtMoney(r.amount),
        r.source === 'expense' ? h('div', { class: 'row-actions' },
          button('Edit', () => edit(r.ref), { attrs: { signal, 'aria-label': 'Edit ' + r.description } }),
          button('Delete', () => remove(r.ref), { kind: 'danger', attrs: { signal, 'aria-label': 'Delete ' + r.description } }))
          : h('span', { class: 'muted' }, 'from ' + r.source)
      ]), { caption: 'Expenses' }) : h('p', null, 'No expenses recorded.'));
    }

    async function load() {
      try {
        [items, livestock, equipment] = await Promise.all([req('expenses:list', {}), req('livestock:list', {}), req('equipment:list', {})]);
      } catch (e) { items = []; }
      render();
    }
    await load();
    return {};
  }
};
