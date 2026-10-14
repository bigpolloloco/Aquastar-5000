/*
 * Declarative form dialogs for record editing.
 *
 *   const values = await formDialog({
 *     title: 'Add livestock',
 *     fields: [
 *       { key: 'commonName', label: 'Common name', type: 'text', required: true, max: 80 },
 *       { key: 'quantity', label: 'Quantity', type: 'number', integer: true, min: 0, value: 1 },
 *       { row: [ ...fields side by side... ] }
 *     ],
 *     validate: (v) => (v.a > v.b ? 'A must be below B' : null)
 *   });
 *
 * Returns the parsed values or null if cancelled. Numbers are parsed with
 * "." or ","; empty optional numbers become null.
 */
import { h, options as optionEls, field, numberOrNull, uid } from './dom.js';
import { openDialog } from './modal.js';

function buildInput(f) {
  const id = uid('ff');
  let input;
  switch (f.type) {
    case 'select':
      input = h('select', { id }, f.allowEmpty ? h('option', { value: '' }, f.emptyLabel || '(none)') : null, optionEls(f.options || [], f.value === null || f.value === undefined ? '' : f.value));
      break;
    case 'textarea':
      input = h('textarea', { id, rows: f.rows || 3, maxlength: f.max || 5000 }, f.value || '');
      break;
    case 'checkbox':
      input = h('input', { id, type: 'checkbox', checked: Boolean(f.value) });
      break;
    case 'date':
      input = h('input', { id, type: 'date', value: f.value || '' });
      break;
    case 'datetime':
      input = h('input', { id, type: 'datetime-local', value: f.value || '' });
      break;
    case 'time':
      input = h('input', { id, type: 'time', value: f.value || '' });
      break;
    case 'number':
      input = h('input', { id, type: 'text', inputmode: 'decimal', autocomplete: 'off', value: f.value === null || f.value === undefined ? '' : String(f.value) });
      break;
    default:
      input = h('input', { id, type: 'text', autocomplete: 'off', maxlength: f.max || 200, value: f.value || '', list: f.list || null });
  }
  if (f.type === 'checkbox') {
    const wrap = h('div', { class: 'field' }, h('span', { class: 'checkbox' }, input, h('label', { for: id }, f.label)), f.hint ? h('span', { class: 'hint' }, f.hint) : null);
    return { wrap, input };
  }
  return field(f.label + (f.required ? ' *' : ''), input, f.hint);
}

function readValue(f, input) {
  if (f.type === 'checkbox') return input.checked;
  const raw = input.value;
  if (f.type === 'number') {
    const n = numberOrNull(raw);
    if (n === null) {
      if (f.required) throw new Error(f.label + ' is required.');
      return null;
    }
    if (Number.isNaN(n)) throw new Error(f.label + ' must be a number.');
    if (f.integer && !Number.isInteger(n)) throw new Error(f.label + ' must be a whole number.');
    if (f.min !== undefined && n < f.min) throw new Error(f.label + ' must be at least ' + f.min + '.');
    if (f.max !== undefined && n > f.max) throw new Error(f.label + ' must be at most ' + f.max + '.');
    return n;
  }
  const s = String(raw).trim();
  if (f.required && !s) throw new Error(f.label + ' is required.');
  if (f.type === 'select' && s === '') return null;
  if ((f.type === 'date' || f.type === 'datetime' || f.type === 'time') && s === '') return null;
  return s;
}

export async function formDialog(o) {
  const controls = [];
  const build = (list) => list.map((f) => {
    if (f.row) return h('div', { class: 'form-row' }, build(f.row));
    if (f.node) return f.node;
    const { wrap, input } = buildInput(f);
    controls.push({ f, input, wrap });
    if (f.onInput) input.addEventListener('input', () => f.onInput(input, controls));
    if (f.onChange) input.addEventListener('change', () => f.onChange(input, controls));
    return wrap;
  });
  const body = build(o.fields);
  if (o.intro) body.unshift(h('p', { class: 'hint' }, o.intro));
  // Apply show/hide rules for the initial values.
  controls.forEach((c) => { if (c.f.onChange) c.f.onChange(c.input, controls); });
  let values = null;
  const res = await openDialog({
    title: o.title,
    size: o.size,
    body,
    actions: [{ label: 'Cancel', value: false }, { label: o.submitLabel || 'Save', value: true, kind: 'primary' }],
    validate: () => {
      const v = {};
      for (const c of controls) {
        if (c.wrap.hidden) { v[c.f.key] = null; continue; }
        v[c.f.key] = readValue(c.f, c.input);
      }
      const err = o.validate ? o.validate(v) : null;
      if (err) return err;
      values = v;
      return null;
    }
  });
  return res === true || res === 'true' ? values : null;
}

/** Find a control created by formDialog (for show/hide logic in onChange). */
export function control(controls, key) {
  return controls.find((c) => c.f.key === key) || null;
}
