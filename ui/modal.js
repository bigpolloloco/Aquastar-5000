/*
 * Accessible modal dialogs built on the native <dialog> element (focus is
 * trapped and Escape cancels natively).
 */
import { h } from './dom.js';

let openCount = 0;

/**
 * Generic dialog.
 * @param {object} o
 * @param {string} o.title
 * @param {Node|Node[]} o.body
 * @param {Array<{label, value, kind}>} o.actions  - first with kind 'primary' is the default
 * @param {function} [o.validate]  - called with the clicked value; return an error string to keep the dialog open
 * @param {string} [o.size] - 'wide'
 * @returns {Promise<any>} value of the clicked action, or null when cancelled
 */
export function openDialog(o) {
  return new Promise((resolve) => {
    const titleId = 'dlg-title-' + (++openCount);
    const errorEl = h('p', { class: 'dialog-error', role: 'alert' });
    const form = h('form', { method: 'dialog', class: 'dialog-form', novalidate: true });
    const body = h('div', { class: 'dialog-body' }, o.body);
    const actions = h('div', { class: 'dialog-actions' });
    const dlg = h('dialog', { class: ['dialog', o.size === 'wide' ? 'dialog-wide' : ''].join(' '), 'aria-labelledby': titleId },
      h('h2', { id: titleId, class: 'dialog-title' }, o.title), form);
    form.append(body, errorEl, actions);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(value);
    };
    (o.actions || [{ label: 'OK', value: true, kind: 'primary' }]).forEach((a) => {
      const btn = h('button', { type: a.kind === 'primary' ? 'submit' : 'button', class: 'btn' + (a.kind ? ' btn-' + a.kind : ''), value: String(a.value) }, a.label);
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (a.value !== null && a.value !== false && o.validate) {
          let err;
          try { err = await o.validate(a.value); } catch (e) { err = e && e.message ? e.message : 'Please check the form.'; }
          if (err) { errorEl.textContent = err; return; }
        }
        finish(a.value);
      });
      actions.appendChild(btn);
    });
    // Enter inside an input submits with the primary action.
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const primary = actions.querySelector('button[type="submit"]');
      if (primary) primary.click();
    });
    dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); finish(null); });
    document.body.appendChild(dlg);
    dlg.showModal();
    const focusTarget = body.querySelector('input:not([type=hidden]), select, textarea') || actions.querySelector('.btn-primary, button');
    if (focusTarget) focusTarget.focus();
  });
}

export async function confirmDialog(title, message, opts) {
  const o = opts || {};
  const res = await openDialog({
    title,
    body: h('p', { class: 'dialog-message' }, message),
    actions: [
      { label: o.cancelLabel || 'Cancel', value: false },
      { label: o.confirmLabel || 'OK', value: true, kind: o.danger ? 'danger' : 'primary' }
    ]
  });
  return res === true || res === 'true';
}

/** Requires the user to type `expected` exactly before confirming. */
export async function typedConfirm(title, message, expected, confirmLabel) {
  const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Type ' + expected + ' to confirm' });
  const res = await openDialog({
    title,
    body: [h('p', { class: 'dialog-message' }, message), h('p', null, 'Type ', h('strong', null, expected), ' to confirm:'), input],
    actions: [{ label: 'Cancel', value: false }, { label: confirmLabel || 'Delete permanently', value: true, kind: 'danger' }],
    validate: () => (input.value === expected ? null : 'The text does not match.')
  });
  return (res === true || res === 'true') ? input.value : null;
}

export function messageDialog(title, message) {
  return openDialog({ title, body: h('p', { class: 'dialog-message' }, message), actions: [{ label: 'OK', value: true, kind: 'primary' }] });
}
