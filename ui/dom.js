/*
 * Tiny DOM helpers. User-supplied text is only ever assigned through
 * textContent / attributes, never innerHTML.
 */

/**
 * Create an element.
 *   h('button', { class: 'btn', onclick: fn, type: 'button' }, 'Save')
 * Attribute rules: `class`, `text`, `dataset`, `on<event>` (function), boolean
 * attributes (true/false), `style` is not supported (CSP forbids inline style
 * attributes; use classes or el.style in code).
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  const signal = attrs && attrs.signal;
  if (attrs) {
    Object.keys(attrs).forEach((key) => {
      const val = attrs[key];
      if (val === undefined || val === null || val === false || key === 'signal') return;
      if (key === 'class') el.className = Array.isArray(val) ? val.filter(Boolean).join(' ') : val;
      else if (key === 'text') el.textContent = String(val);
      else if (key === 'dataset') Object.keys(val).forEach((k) => { el.dataset[k] = val[k]; });
      else if (key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2), val, signal ? { signal } : undefined);
      else if (key === 'value') el.value = val;
      else if (key === 'checked' || key === 'selected' || key === 'disabled' || key === 'required' || key === 'hidden' || key === 'multiple') el[key] = Boolean(val);
      else if (val === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(val));
    });
  }
  append(el, children);
  return el;
}

function append(el, children) {
  children.forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  });
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

/** <option> list; items: [{value,label}] or strings. */
export function options(items, selected) {
  return items.map((it) => {
    const value = typeof it === 'object' ? it.value : it;
    const label = typeof it === 'object' ? it.label : it;
    return h('option', { value: value === null ? '' : String(value), selected: String(value) === String(selected) }, label);
  });
}

let idCounter = 0;
export function uid(prefix) {
  idCounter += 1;
  return (prefix || 'f') + '-' + idCounter;
}

/** Labelled form field: returns {wrap, input}. */
export function field(label, input, hint) {
  if (!input.id) input.id = uid('fld');
  const hintEl = hint ? h('span', { class: 'hint', id: input.id + '-hint' }, hint) : null;
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  const wrap = h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hintEl);
  return { wrap, input };
}

export function numberOrNull(text) {
  const s = String(text === undefined || text === null ? '' : text).trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export function button(label, onclick, opts) {
  const o = opts || {};
  return h('button', Object.assign({ type: 'button', class: ['btn', o.kind ? 'btn-' + o.kind : ''].join(' ').trim(), onclick }, o.attrs || {}), label);
}
