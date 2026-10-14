/*
 * Dosing log: one-time doses and the ongoing daily regimen per tank.
 * A "daily" record sets (or changes) a product's daily amount from that date;
 * a "stop" record ends it. The current regimen is the latest daily/stop record
 * per product; every change shows up as a chart marker.
 */
import { h, replace, button, options, field, numberOrNull } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, tankById, defaultTankId, rememberTank } from '../ui/state.js';
import { confirmDialog } from '../ui/modal.js';
import { U, D, P, S, tankSelect, emptyState, table } from '../ui/widgets.js';

const KIND_LABEL = { once: 'One-time dose', daily: 'Daily regimen set/changed', stop: 'Daily regimen stopped' };

export default {
  id: 'dosing',
  title: 'Dosing Log',
  async mount(root, ctx) {
    const { signal } = ctx;
    if (!state.tanks.length) {
      replace(root, emptyState('No tanks yet', 'Create a tank before logging doses.',
        button('Create a tank', () => ctx.navigate('tanks', 'new'), { kind: 'primary', attrs: { signal } })));
      return {};
    }
    let tankId = (ctx.params && ctx.params.tankId) || defaultTankId();
    let editing = null;
    let records = [];

    const tankSel = tankSelect(tankId, (id) => { tankId = id; renderAll(); }, { signal });
    const when = h('input', { type: 'datetime-local', value: D.toLocalInputValue(new Date()) });
    const productList = h('datalist', { id: 'product-list' });
    const product = h('input', { type: 'text', list: 'product-list', maxlength: 80, autocomplete: 'off', required: true });
    const category = h('select', null, options(P.DOSING_CATEGORIES, 'other'));
    const amount = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off' });
    const unit = h('select', null, options(P.DOSE_UNITS, 'ml'));
    const kindName = 'dose-kind';
    const kindRadios = ['once', 'daily', 'stop'].map((k) => h('input', { type: 'radio', name: kindName, value: k, id: 'dk-' + k, checked: k === 'once' }));
    const kindGroup = h('fieldset', { class: 'radio-group' }, h('legend', null, 'Kind'),
      kindRadios.map((r) => h('span', { class: 'radio' }, r, h('label', { for: r.id }, KIND_LABEL[r.value]))));
    const note = h('input', { type: 'text', maxlength: 2000, autocomplete: 'off' });
    const banner = h('div', { class: 'edit-banner', hidden: true });
    const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save');
    const amountField = h('div', { class: 'form-row' }, field('Amount', amount).wrap, field('Unit', unit).wrap);
    const form = h('form', { class: 'panel', novalidate: true, 'aria-label': 'Log a dose' },
      banner,
      h('div', { class: 'form-row' }, field('Tank', tankSel).wrap, field('Date and time', when).wrap),
      h('div', { class: 'form-row' }, field('Product', product).wrap, field('Category', category).wrap, productList),
      kindGroup, amountField, field('Note', note).wrap,
      h('div', { class: 'actions' }, saveBtn, button('Clear', () => resetForm(), { attrs: { signal } })));
    const regimenHost = h('section', { class: 'panel' });
    const historyHost = h('section', { class: 'panel' });
    replace(root, regimenHost, form, historyHost);

    form.addEventListener('submit', (e) => { e.preventDefault(); save(); }, { signal });
    kindRadios.forEach((r) => r.addEventListener('change', () => { amountField.hidden = kind() === 'stop'; }, { signal }));
    product.addEventListener('change', () => {
      const prev = records.find((d) => d.product.toLowerCase() === product.value.trim().toLowerCase());
      if (prev && !editing) { category.value = prev.category; unit.value = prev.unit; }
    }, { signal });

    const kind = () => (kindRadios.find((r) => r.checked) || kindRadios[0]).value;
    const setKind = (k) => { kindRadios.forEach((r) => { r.checked = r.value === k; }); amountField.hidden = k === 'stop'; };

    function resetForm() {
      editing = null;
      banner.hidden = true;
      when.value = D.toLocalInputValue(new Date());
      product.value = '';
      amount.value = '';
      note.value = '';
      setKind('once');
      saveBtn.textContent = 'Save';
    }

    function prefill(d, k) {
      product.value = d.product;
      category.value = d.category;
      unit.value = d.unit;
      amount.value = k === 'stop' ? '' : String(d.amount);
      setKind(k);
      when.value = D.toLocalInputValue(new Date());
      (k === 'stop' ? saveBtn : amount).focus();
    }

    function startEdit(d) {
      editing = d;
      tankId = d.tankId;
      tankSel.value = d.tankId;
      when.value = D.toLocalInputValue(d.dosedAt);
      product.value = d.product;
      category.value = d.category;
      amount.value = d.kind === 'stop' ? '' : String(d.amount);
      unit.value = d.unit;
      note.value = d.note || '';
      setKind(d.kind);
      replace(banner, 'Editing dose record from ' + D.formatDateTime(d.dosedAt) + '. ', button('Cancel edit', () => resetForm(), { attrs: { signal } }));
      banner.hidden = false;
      saveBtn.textContent = 'Save changes';
      product.focus();
      form.scrollIntoView({ block: 'start' });
    }

    async function save() {
      const dosedAt = D.fromLocalInputValue(when.value);
      if (!dosedAt) { ctx.ticker.warn('Please enter a valid date and time.'); when.focus(); return; }
      if (!product.value.trim()) { ctx.ticker.warn('Enter the product name.'); product.focus(); return; }
      const k = kind();
      let amt = 0;
      if (k !== 'stop') {
        amt = numberOrNull(amount.value);
        if (amt === null || Number.isNaN(amt) || amt <= 0) { ctx.ticker.warn('Enter an amount greater than zero.'); amount.focus(); return; }
      }
      const payload = { tankId, dosedAt, product: product.value, category: category.value, amount: amt, unit: unit.value, kind: k, note: note.value };
      if (editing) payload.id = editing.id;
      saveBtn.disabled = true;
      try {
        await req('dosing:save', payload);
        const msg = k === 'daily' ? 'Daily regimen: ' + payload.product.trim() + ' ' + amt + ' ' + payload.unit + '/day.'
          : k === 'stop' ? 'Stopped daily dosing of ' + payload.product.trim() + '.'
            : 'Logged ' + amt + ' ' + payload.unit + ' of ' + payload.product.trim() + '.';
        ctx.ticker.info(msg);
        await rememberTank(tankId);
        resetForm();
        await reload();
        ctx.dataChanged();
      } catch (e) { /* ticker */ } finally { saveBtn.disabled = false; }
    }

    async function remove(d) {
      const ok = await confirmDialog('Delete dose record?', 'Delete ' + KIND_LABEL[d.kind].toLowerCase() + ' for ' + d.product + ' from ' + D.formatDateTime(d.dosedAt) + '?', { confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await req('dosing:delete', { id: d.id });
        ctx.ticker.info('Dose record deleted.');
        if (editing && editing.id === d.id) resetForm();
        await reload();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    function renderAll() {
      const mine = records.filter((d) => d.tankId === tankId);
      const regimen = S.currentRegimen(mine);
      const tank = tankById(tankId);
      replace(regimenHost,
        h('h2', null, 'Current Daily Regimen - ' + (tank ? tank.name : '')),
        regimen.length ? table(['Product', 'Per day', 'Since', ''], regimen.map((r) => {
          const src = mine.find((d) => d.id === r.id);
          return [r.product, U.formatNumber(r.amount, 2).replace(/\.?0+$/, '') + ' ' + r.unit, D.formatDate(r.since),
            h('div', { class: 'row-actions' },
              button('Change', () => prefill(src, 'daily'), { attrs: { signal, 'aria-label': 'Change daily dose of ' + r.product } }),
              button('Stop', () => prefill(src, 'stop'), { attrs: { signal, 'aria-label': 'Stop daily dose of ' + r.product } }))];
        }), { caption: 'Current daily regimen' }) : h('p', null, 'No ongoing daily doses. Choose "Daily regimen" below to start one.'));
      const products = Array.from(new Set(records.map((d) => d.product))).sort();
      replace(productList, options(products));
      const hist = mine.slice(0, 300);
      replace(historyHost, h('h2', null, 'Dose History'),
        hist.length ? table(['When', 'Product', 'Kind', 'Amount', 'Note', ''], hist.map((d) => [
          D.formatDateTime(d.dosedAt), d.product, KIND_LABEL[d.kind], d.kind === 'stop' ? '--' : d.amount + ' ' + d.unit + (d.kind === 'daily' ? '/day' : ''), d.note || '',
          h('div', { class: 'row-actions' },
            button('Edit', () => startEdit(d), { attrs: { signal, 'aria-label': 'Edit dose record for ' + d.product } }),
            button('Delete', () => remove(d), { kind: 'danger', attrs: { signal, 'aria-label': 'Delete dose record for ' + d.product } }))
        ]), { caption: 'Dose history' }) : h('p', null, 'No doses logged for this tank.'));
    }

    async function reload() {
      records = await req('dosing:list', {});
      renderAll();
    }

    resetForm();
    try { await reload(); } catch (e) { replace(historyHost, h('p', null, 'Dosing could not be loaded.')); }
    return {};
  }
};
