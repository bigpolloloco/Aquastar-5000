/*
 * Quick Test Entry - built for speed:
 *  - focus lands on the first parameter field; Tab moves between fields;
 *    Enter anywhere saves; only filled fields are saved;
 *  - "<0.02" (or "ND") records a below-detection reading without extra controls;
 *  - last reading and days since are shown next to every field;
 *  - out-of-range values are flagged immediately (color + word), and alerts
 *    for the saved values go to the ticker after saving.
 */
import { h, replace, button, options, field } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, tankById, tankDefs, defaultTankId, rememberTank, defById } from '../ui/state.js';
import { confirmDialog } from '../ui/modal.js';
import { U, D, P, S, statusBadge, fmtReading, settings, tankSelect, emptyState, table } from '../ui/widgets.js';

export default {
  id: 'quick-entry',
  title: 'Log a Test',
  async mount(root, ctx) {
    const { signal } = ctx;
    if (!state.tanks.length) {
      replace(root, emptyState('No tanks yet', 'Create a tank first, then come back here to log tests.',
        button('Create a tank', () => ctx.navigate('tanks', 'new'), { kind: 'primary', attrs: { signal } })));
      return {};
    }
    let tankId = (ctx.params && ctx.params.tankId && tankById(ctx.params.tankId)) ? ctx.params.tankId : defaultTankId();
    let editing = null; // entry being edited
    let entries = [];
    let inputs = [];

    const tankSel = tankSelect(tankId, async (id) => { tankId = id; editing = null; await rememberTank(id); await reload(true); }, { signal, label: 'Tank' });
    const when = h('input', { type: 'datetime-local', value: D.toLocalInputValue(new Date()), required: true });
    const nowBtn = button('Now', () => { when.value = D.toLocalInputValue(new Date()); }, { attrs: { signal, title: 'Set time to now' } });
    const methodList = h('datalist', { id: 'method-list' }, options(P.TEST_METHODS));
    const method = h('input', { type: 'text', list: 'method-list', maxlength: 60, autocomplete: 'off', placeholder: 'optional' });
    const note = h('input', { type: 'text', maxlength: 2000, autocomplete: 'off', placeholder: 'optional' });
    const fieldsHost = h('div', { class: 'qe-fields' });
    const editBanner = h('div', { class: 'edit-banner', hidden: true });
    const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save (Enter)');
    const clearBtn = button('Clear', () => resetForm(), { attrs: { signal } });
    const form = h('form', { class: 'panel qe-form', novalidate: true, 'aria-label': 'Log a water test' },
      editBanner,
      h('div', { class: 'form-row' },
        field('Tank', tankSel).wrap,
        h('div', { class: 'field' }, h('label', { for: (when.id = 'qe-when') }, 'Date and time'), h('div', { class: 'inline' }, when, nowBtn))),
      h('p', { class: 'hint' }, 'Enter saves. Leave a field empty to skip it. Type <0.02 for "below detection" or ND for not detected.'),
      fieldsHost,
      h('div', { class: 'form-row' }, field('Test method', method).wrap, field('Note', note).wrap, methodList),
      h('div', { class: 'actions' }, saveBtn, clearBtn));
    const historyHost = h('section', { class: 'panel' });
    replace(root, form, historyHost);

    form.addEventListener('submit', (e) => { e.preventDefault(); save(); }, { signal });

    function lastReadings() {
      const latest = S.latestByParam(editing ? entries.filter((e) => e.id !== editing.id) : entries);
      return latest;
    }

    function buildFields() {
      const tank = tankById(tankId);
      let defs = tankDefs(tank);
      if (editing) {
        editing.readings.forEach((r) => { if (!defs.some((d) => d.id === r.parameterId)) { const d = defById(r.parameterId); if (d) defs = defs.concat([d]); } });
      }
      const latest = lastReadings();
      const now = new Date();
      inputs = defs.map((def) => {
        const cfg = tank.params[def.id] || null;
        const id = 'qe-' + def.id;
        const statusEl = h('span', { class: 'qe-status', id: id + '-status' });
        const errorEl = h('span', { class: 'qe-error', id: id + '-error' });
        const last = latest[def.id];
        const lastText = last ? 'Last: ' + fmtReading(def, last) + ' - ' + D.formatDaysAgo(D.daysSince(last.takenAt, now)) : 'Never tested';
        const lastEl = h('span', { class: 'qe-last', id: id + '-last' }, lastText);
        let input;
        if (def.kind === 'choice') {
          input = h('select', { id, 'aria-describedby': [id + '-last', id + '-status'].join(' ') }, h('option', { value: '' }, '(skip)'), options(def.options));
        } else {
          input = h('input', {
            id, type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false',
            'aria-describedby': [id + '-last', id + '-status', id + '-error'].join(' ')
          });
        }
        const existing = editing && editing.readings.find((r) => r.parameterId === def.id);
        if (existing) {
          if (def.kind === 'choice') input.value = existing.value;
          else input.value = U.formatReading(def, existing, settings(), { unit: false }).replace(/^~/, '').replace(/^ND$/, 'ND');
        }
        const row = h('div', { class: 'qe-row' },
          h('label', { for: id, class: 'qe-label' }, def.name, h('span', { class: 'qe-unit' }, ' ' + U.unitLabel(def, settings()) + (U.isApproximate(def, settings()) ? ' (approx.)' : ''))),
          input, statusEl, lastEl, errorEl);
        const item = { def, cfg, input, statusEl, errorEl, row };
        input.addEventListener('input', () => check(item), { signal });
        input.addEventListener('change', () => check(item), { signal });
        check(item);
        return item;
      });
      replace(fieldsHost, inputs.length ? inputs.map((i) => i.row) : h('p', null, 'This tank has no parameters enabled. Edit the tank to choose parameters.'));
    }

    /** Parse and live-check one field. Returns {skip} | {error} | {reading}. */
    function check(item) {
      const { def, cfg, input, statusEl, errorEl, row } = item;
      row.classList.remove('lvl-ok', 'lvl-watch', 'lvl-alert', 'has-error');
      input.removeAttribute('aria-invalid');
      replace(statusEl);
      errorEl.textContent = '';
      if (def.kind === 'choice') {
        if (!input.value) return { skip: true };
        const st = S.rangeStatus(def, cfg, { value: input.value });
        if (st.level !== 'NONE') { replace(statusEl, statusBadge(st.level)); row.classList.add('lvl-' + st.level.toLowerCase()); }
        return { reading: { parameterId: def.id, value: input.value, bdl: false } };
      }
      const parsed = U.parseReadingInput(input.value);
      if (parsed.empty) return { skip: true };
      if (parsed.error) return fieldError(item, parsed.error);
      const canonical = U.fromDisplay(def, parsed.value, settings());
      if (parsed.bdl && canonical === 0 && def.hardMin > 0) return fieldError(item, 'Below detection is not possible for ' + def.name);
      if (!(parsed.bdl && canonical === 0) && (canonical < (def.hardMin || 0) - 1e-9 || canonical > (def.hardMax || 1e6) + 1e-9)) {
        const lo = U.formatNumber(U.toDisplay(def, def.hardMin || 0, settings()), U.displayDecimals(def, settings()));
        const hi = U.formatNumber(U.toDisplay(def, def.hardMax || 1e6, settings()), U.displayDecimals(def, settings()));
        return fieldError(item, 'Must be between ' + lo + ' and ' + hi);
      }
      const reading = { parameterId: def.id, value: U.round(canonical, 6), bdl: parsed.bdl };
      const st = S.rangeStatus(def, cfg, reading);
      if (st.level !== 'NONE') {
        replace(statusEl, statusBadge(st.level, st.direction === 'low' ? 'LOW' : st.direction === 'high' ? 'HIGH' : ''));
        row.classList.add('lvl-' + st.level.toLowerCase());
      }
      return { reading };
    }

    function fieldError(item, msg) {
      item.row.classList.add('has-error');
      item.input.setAttribute('aria-invalid', 'true');
      item.errorEl.textContent = msg;
      return { error: msg };
    }

    async function save() {
      const takenAt = D.fromLocalInputValue(when.value);
      if (!takenAt) { ctx.ticker.warn('Please enter a valid date and time.'); when.focus(); return; }
      if (Date.parse(takenAt) > Date.now() + 5 * 60000) { ctx.ticker.warn('The test time is in the future. Check the date and time.'); when.focus(); return; }
      const results = inputs.map((i) => ({ item: i, res: check(i) }));
      const bad = results.find((r) => r.res.error);
      if (bad) { ctx.ticker.warn(bad.item.def.name + ': ' + bad.res.error); bad.item.input.focus(); return; }
      const readings = results.filter((r) => r.res.reading).map((r) => r.res.reading);
      if (!readings.length) {
        if (editing) {
          const del = await confirmDialog('Delete this test?', 'All fields are empty. Delete the whole test entry instead?', { confirmLabel: 'Delete test', danger: true });
          if (del) await removeEntry(editing);
          return;
        }
        ctx.ticker.warn('Nothing to save: fill in at least one parameter.');
        if (inputs[0]) inputs[0].input.focus();
        return;
      }
      saveBtn.disabled = true;
      try {
        const payload = { tankId, takenAt, method: method.value, note: note.value, readings };
        if (editing) payload.id = editing.id;
        await req('entries:save', payload);
        const tank = tankById(tankId);
        ctx.ticker.info((editing ? 'Updated ' : 'Saved ') + readings.length + ' reading' + (readings.length === 1 ? '' : 's') + ' for ' + tank.name + '.');
        const wasEditing = Boolean(editing);
        editing = null;
        await reload(false);
        announceAlerts(readings.map((r) => r.parameterId));
        resetForm(true);
        if (!wasEditing) await rememberTank(tankId);
        ctx.dataChanged();
      } catch (e) {
        // req already showed the error in the ticker
      } finally {
        saveBtn.disabled = false;
      }
    }

    function announceAlerts(paramIds) {
      const tank = tankById(tankId);
      const alerts = S.tankAlerts(tank, state.defs, entries, settings(), new Date())
        .filter((a) => paramIds.includes(a.paramId) && a.kind !== 'overdue');
      alerts.forEach((a) => ctx.ticker.warn(a.message));
    }

    function resetForm(keepFocus) {
      editing = null;
      editBanner.hidden = true;
      when.value = D.toLocalInputValue(new Date());
      method.value = method.value && keepFocus ? method.value : '';
      note.value = '';
      saveBtn.textContent = 'Save (Enter)';
      buildFields();
      if (inputs[0]) inputs[0].input.focus();
    }

    function startEdit(entry) {
      editing = entry;
      when.value = D.toLocalInputValue(entry.takenAt);
      method.value = entry.method || '';
      note.value = entry.note || '';
      replace(editBanner, 'Editing the test from ' + D.formatDateTime(entry.takenAt) + '. ',
        button('Cancel edit', () => resetForm(), { attrs: { signal } }));
      editBanner.hidden = false;
      saveBtn.textContent = 'Save changes (Enter)';
      buildFields();
      if (inputs[0]) inputs[0].input.focus();
      form.scrollIntoView({ block: 'start' });
    }

    async function removeEntry(entry) {
      const ok = await confirmDialog('Delete test?', 'Delete the test from ' + D.formatDateTime(entry.takenAt) + ' with ' + entry.readings.length + ' reading(s)? This cannot be undone.', { confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await req('entries:delete', { id: entry.id });
        ctx.ticker.info('Test deleted.');
        if (editing && editing.id === entry.id) editing = null;
        await reload(true);
        ctx.dataChanged();
      } catch (e) { /* shown in ticker */ }
    }

    function renderHistory() {
      const recent = entries.slice(0, 25);
      if (!recent.length) {
        replace(historyHost, h('h2', null, 'Recent Tests'), h('p', null, 'No tests logged for this tank yet.'));
        return;
      }
      const rows = recent.map((e) => {
        const summary = e.readings.map((r) => {
          const def = defById(r.parameterId);
          return def ? def.name + ' ' + fmtReading(def, r) : '';
        }).filter(Boolean).join(', ');
        return [
          D.formatDateTime(e.takenAt),
          summary,
          e.method || '',
          h('div', { class: 'row-actions' },
            button('Edit', () => startEdit(e), { attrs: { signal, 'aria-label': 'Edit test from ' + D.formatDateTime(e.takenAt) } }),
            button('Photo', () => ctx.addPhoto({ tankId: e.tankId, ownerType: 'entry', ownerId: e.id }), { attrs: { signal, 'aria-label': 'Attach photo to test from ' + D.formatDateTime(e.takenAt) } }),
            button('Delete', () => removeEntry(e), { kind: 'danger', attrs: { signal, 'aria-label': 'Delete test from ' + D.formatDateTime(e.takenAt) } }))
        ];
      });
      replace(historyHost, h('h2', null, 'Recent Tests'), table(['When', 'Readings', 'Method', ''], rows, { caption: 'Recent tests for this tank' }));
    }

    async function reload(rebuild) {
      entries = await req('entries:list', { tankId });
      if (rebuild) {
        resetForm();
      }
      renderHistory();
    }

    try {
      await reload(true);
      if (ctx.params && ctx.params.editEntryId) {
        const e = entries.find((x) => x.id === ctx.params.editEntryId);
        if (e) startEdit(e);
      }
    } catch (e) {
      replace(historyHost, h('p', null, 'Tests could not be loaded.'));
    }
    return {};
  }
};
