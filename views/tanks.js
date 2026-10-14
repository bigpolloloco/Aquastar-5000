/*
 * Tank profiles: create/edit (type, style preset, volumes, dimensions, start
 * date, notes, per-parameter ideal ranges, swing thresholds and test
 * intervals), archive/unarchive, and permanent deletion behind a typed
 * confirmation that also removes the tank's photos.
 */
import { h, replace, button, options, field, numberOrNull } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, refresh, tankById } from '../ui/state.js';
import { confirmDialog, typedConfirm } from '../ui/modal.js';
import { U, D, P, settings, typeLabel, styleLabel, fmtVolume, emptyState, table } from '../ui/widgets.js';

export default {
  id: 'tanks',
  title: 'Tank Profiles',
  async mount(root, ctx) {
    const { signal } = ctx;
    const listHost = h('section', { class: 'panel' });
    const editorHost = h('section', { class: 'panel', hidden: true });
    replace(root, editorHost, listHost);

    function renderList() {
      const active = state.allTanks.filter((t) => !t.archived);
      const archived = state.allTanks.filter((t) => t.archived);
      const row = (t) => [
        t.name,
        typeLabel(t.type) + ' / ' + styleLabel(t.type, t.style),
        fmtVolume(t.totalVolumeL) + (t.displayVolumeL ? ' (display ' + fmtVolume(t.displayVolumeL) + ')' : ''),
        t.startDate ? D.formatDate(t.startDate) + ' (' + D.formatDaysAgo(-D.daysUntilDate(t.startDate)).replace(' ago', '') + ')' : '--',
        h('div', { class: 'row-actions' },
          button('Edit', () => openEditor(t), { attrs: { signal, 'aria-label': 'Edit ' + t.name } }),
          button(t.archived ? 'Unarchive' : 'Archive', () => toggleArchive(t), { attrs: { signal, 'aria-label': (t.archived ? 'Unarchive ' : 'Archive ') + t.name } }),
          button('Delete...', () => remove(t), { kind: 'danger', attrs: { signal, 'aria-label': 'Delete ' + t.name + ' permanently' } }))
      ];
      replace(listHost,
        h('div', { class: 'list-header' }, h('h2', null, 'Tanks'), button('New tank', () => openEditor(null), { kind: 'primary', attrs: { signal } })),
        active.length ? table(['Name', 'Type / style', 'System volume', 'Running since', ''], active.map(row), { caption: 'Active tanks', rowHeaders: true }) : emptyState('No active tanks', 'Create a tank to start logging.'),
        archived.length ? h('h3', null, 'Archived tanks (history kept)') : null,
        archived.length ? table(['Name', 'Type / style', 'System volume', 'Started', ''], archived.map(row), { caption: 'Archived tanks', rowHeaders: true }) : null);
    }

    async function toggleArchive(t) {
      if (!t.archived) {
        const ok = await confirmDialog('Archive ' + t.name + '?', 'Archived tanks disappear from the dashboard and entry screens, but all history stays viewable in charts and logs. You can unarchive at any time.', { confirmLabel: 'Archive' });
        if (!ok) return;
      }
      try {
        await req('tanks:save', Object.assign({}, stripMeta(t), { archived: !t.archived }));
        ctx.ticker.info(t.name + (t.archived ? ' restored.' : ' archived.'));
        await refresh(['tanks']);
        renderList();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    async function remove(t) {
      const typed = await typedConfirm('Delete ' + t.name + ' permanently?',
        'This deletes the tank with ALL of its tests, maintenance, dosing records and photos. This cannot be undone. (Archiving keeps the history instead.)',
        t.name, 'Delete everything');
      if (typed === null) return;
      try {
        await req('tanks:delete', { id: t.id, confirmName: typed });
        ctx.ticker.info(t.name + ' and its history were deleted.');
        await refresh(['tanks', 'settings']);
        closeEditor();
        renderList();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    function stripMeta(t) {
      const out = Object.assign({}, t);
      ['createdAt', 'updatedAt', 'marine', 'archivedAt'].forEach((k) => delete out[k]);
      return out;
    }

    function closeEditor() {
      editorHost.hidden = true;
      replace(editorHost);
    }

    function openEditor(tank) {
      const s = settings();
      const isNew = !tank;
      let type = tank ? tank.type : 'freshwater';
      let style = tank ? tank.style : Object.keys(P.TANK_TYPES.freshwater.styles)[0];
      let params = tank ? JSON.parse(JSON.stringify(tank.params || {})) : P.buildTankParams(type, style);

      const name = h('input', { type: 'text', maxlength: 80, required: true, value: tank ? tank.name : '' });
      const typeSel = h('select', null, options(P.typeOptions(), type));
      const styleSel = h('select', null, options(P.styleOptions(type), style));
      const fmtVol = (l) => (typeof l === 'number' ? U.formatNumber(U.volumeToDisplay(l, s), 1) : '');
      const display = h('input', { type: 'text', inputmode: 'decimal', value: tank ? fmtVol(tank.displayVolumeL) : '' });
      const total = h('input', { type: 'text', inputmode: 'decimal', value: tank ? fmtVol(tank.totalVolumeL) : '' });
      const dims = tank && tank.dimensions ? tank.dimensions : null;
      const fmtLen = (cm) => (typeof cm === 'number' ? U.formatNumber(U.lengthToDisplay(cm, s), 1) : '');
      const len = h('input', { type: 'text', inputmode: 'decimal', value: dims ? fmtLen(dims.lengthCm) : '', 'aria-label': 'Length' });
      const wid = h('input', { type: 'text', inputmode: 'decimal', value: dims ? fmtLen(dims.widthCm) : '', 'aria-label': 'Width' });
      const hei = h('input', { type: 'text', inputmode: 'decimal', value: dims ? fmtLen(dims.heightCm) : '', 'aria-label': 'Height' });
      const start = h('input', { type: 'date', value: tank && tank.startDate ? tank.startDate : '' });
      const notes = h('textarea', { rows: 3, maxlength: 5000 }, tank ? tank.notes || '' : '');
      const paramHost = h('div', { class: 'param-table-host' });
      const vl = U.volumeLabel(s);
      const ll = U.lengthLabel(s);

      typeSel.addEventListener('change', () => {
        type = typeSel.value;
        replace(styleSel, options(P.styleOptions(type)));
        style = styleSel.value;
        params = mergeForType(params, type, style, isNew);
        renderParams();
      }, { signal });
      styleSel.addEventListener('change', () => {
        style = styleSel.value;
        if (isNew) { params = withCustoms(P.buildTankParams(type, style), params); renderParams(); }
      }, { signal });

      function withCustoms(base, old) {
        Object.keys(old).forEach((id) => { if (id.startsWith('custom-') && !base[id]) base[id] = old[id]; });
        return base;
      }

      function mergeForType(old, newType, newStyle, fresh) {
        const preset = P.buildTankParams(newType, newStyle);
        if (fresh) return withCustoms(preset, old);
        const out = {};
        Object.keys(preset).forEach((id) => { out[id] = old[id] ? old[id] : preset[id]; });
        // Keep existing configs (and their history) for parameters outside the new type, disabled.
        Object.keys(old).forEach((id) => { if (!out[id]) out[id] = Object.assign({}, old[id], { enabled: id.startsWith('custom-') ? old[id].enabled : false }); });
        return out;
      }

      const rowsState = [];
      function renderParams() {
        rowsState.length = 0;
        const typeParams = P.TANK_TYPES[type].params.concat((P.styleFor(type, style).extra || []));
        const ids = Array.from(new Set(typeParams.concat(Object.keys(params)).concat(state.defs.filter((d) => d.custom).map((d) => d.id))));
        const rows = ids.map((id) => {
          const def = state.defs.find((d) => d.id === id);
          if (!def) return null;
          const cfg = params[id] || { enabled: false, min: def.defaultMin ?? null, max: def.defaultMax ?? null, maxDelta: def.defaultMaxDelta ?? null, intervalDays: def.defaultIntervalDays ?? null };
          const en = h('input', { type: 'checkbox', checked: Boolean(cfg.enabled), id: 'pe-' + id, 'aria-label': 'Track ' + def.name });
          const isChoice = def.kind === 'choice';
          const disp = (v) => (typeof v === 'number' ? String(U.round(U.toDisplay(def, v, s), U.displayDecimals(def, s) + 1)) : '');
          const dispDelta = (v) => (typeof v === 'number' ? String(U.round(U.deltaToDisplay(def, v, s), U.displayDecimals(def, s) + 1)) : '');
          const mk = (val, label) => h('input', { type: 'text', inputmode: 'decimal', value: val, 'aria-label': def.name + ' ' + label, disabled: isChoice, class: 'num' });
          const mn = mk(disp(cfg.min), 'ideal minimum');
          const mx = mk(disp(cfg.max), 'ideal maximum');
          const md = mk(dispDelta(cfg.maxDelta), 'maximum change between tests');
          const iv = h('input', { type: 'text', inputmode: 'numeric', value: cfg.intervalDays ? String(cfg.intervalDays) : '', 'aria-label': def.name + ' test interval in days', class: 'num' });
          rowsState.push({ id, def, en, mn, mx, md, iv });
          return [
            h('span', { class: 'checkbox' }, en, h('label', { for: en.id }, def.name + (def.custom ? ' (custom)' : ''))),
            U.unitLabel(def, s) + (U.isApproximate(def, s) ? ' ~' : ''), mn, mx, md, iv
          ];
        }).filter(Boolean);
        replace(paramHost,
          h('div', { class: 'list-header' }, h('h3', null, 'Parameters, ideal ranges and alerts'),
            button('Reset to "' + P.styleFor(type, style).label + '" preset', () => { params = withCustoms(P.buildTankParams(type, style), params); renderParams(); ctx.ticker.info('Preset ranges applied; save to keep them.'); }, { attrs: { signal } })),
          h('p', { class: 'hint' }, 'Leave min or max empty for a one-sided range. "Max change" triggers a stability alert when two consecutive tests differ by more. "Test every" marks a test overdue.'),
          table(['Track', 'Unit', 'Ideal min', 'Ideal max', 'Max change', 'Test every (days)'], rows, { caption: 'Parameter settings', class: 'param-table' }));
      }

      function collectParams() {
        const out = {};
        for (const r of rowsState) {
          const num = (input, label, isDelta) => {
            const v = numberOrNull(input.value);
            if (v === null) return null;
            if (Number.isNaN(v) || v < 0) throw new Error(r.def.name + ': ' + label + ' must be a positive number.');
            return U.round(isDelta ? U.deltaFromDisplay(r.def, v, s) : U.fromDisplay(r.def, v, s), 6);
          };
          const iv = numberOrNull(r.iv.value);
          if (iv !== null && (Number.isNaN(iv) || !Number.isInteger(iv) || iv < 1 || iv > 365)) throw new Error(r.def.name + ': test interval must be 1-365 days.');
          const cfg = {
            enabled: r.en.checked,
            min: r.def.kind === 'choice' ? null : num(r.mn, 'ideal minimum'),
            max: r.def.kind === 'choice' ? null : num(r.mx, 'ideal maximum'),
            maxDelta: r.def.kind === 'choice' ? null : num(r.md, 'max change', true),
            intervalDays: iv
          };
          if (cfg.min !== null && cfg.max !== null && cfg.min > cfg.max) throw new Error(r.def.name + ': minimum is above maximum.');
          if (cfg.enabled || params[r.id]) out[r.id] = cfg;
        }
        return out;
      }

      const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, isNew ? 'Create tank' : 'Save tank');
      const form = h('form', { novalidate: true, 'aria-label': isNew ? 'New tank' : 'Edit tank' },
        h('h2', null, isNew ? 'New Tank' : 'Edit ' + tank.name),
        h('div', { class: 'form-row' }, field('Name', name).wrap, field('Type', typeSel).wrap, field('Style preset', styleSel).wrap),
        h('div', { class: 'form-row' },
          field('Display volume (' + vl + ')', display).wrap,
          field('Total system volume (' + vl + ')', total, 'Display + sump + plumbing. Used for water change % and dosing.').wrap,
          field('Start date', start).wrap),
        h('fieldset', { class: 'dims' }, h('legend', null, 'Dimensions (' + ll + ', optional): length x width x height'), h('div', { class: 'inline' }, len, ' x ', wid, ' x ', hei)),
        field('Notes', notes).wrap,
        paramHost,
        h('div', { class: 'actions' }, saveBtn, button('Cancel', () => closeEditor(), { attrs: { signal } })));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        let payload;
        try {
          const totalV = numberOrNull(total.value);
          const displayV = numberOrNull(display.value);
          if (!name.value.trim()) throw new Error('Enter a tank name.');
          if (totalV === null || Number.isNaN(totalV) || totalV <= 0) throw new Error('Enter the total system volume.');
          if (displayV !== null && (Number.isNaN(displayV) || displayV < 0)) throw new Error('Display volume must be a positive number.');
          if (displayV !== null && displayV > totalV) throw new Error('Total system volume must be at least the display volume.');
          const d = [len, wid, hei].map((i) => numberOrNull(i.value));
          let dimensions = null;
          if (d.some((x) => x !== null)) {
            if (d.some((x) => x === null || Number.isNaN(x) || x <= 0)) throw new Error('Enter all three dimensions, or none.');
            dimensions = { lengthCm: U.lengthFromDisplay(d[0], s), widthCm: U.lengthFromDisplay(d[1], s), heightCm: U.lengthFromDisplay(d[2], s) };
          }
          payload = {
            name: name.value, type, style,
            displayVolumeL: displayV === null ? null : U.volumeFromDisplay(displayV, s),
            totalVolumeL: U.volumeFromDisplay(totalV, s),
            dimensions,
            startDate: start.value || null,
            notes: notes.value,
            archived: tank ? Boolean(tank.archived) : false,
            params: collectParams()
          };
          if (tank) payload.id = tank.id;
        } catch (err) {
          ctx.ticker.warn(err.message);
          return;
        }
        saveBtn.disabled = true;
        try {
          const saved = await req('tanks:save', payload);
          ctx.ticker.info((isNew ? 'Created ' : 'Saved ') + saved.name + '.');
          await refresh(['tanks', 'settings']);
          if (isNew) await req('settings:save', { lastTankId: saved.id }).then((st) => { state.settings = st; }).catch(() => undefined);
          closeEditor();
          renderList();
          ctx.dataChanged();
        } catch (err2) { /* ticker */ } finally { saveBtn.disabled = false; }
      }, { signal });

      renderParams();
      replace(editorHost, form);
      editorHost.hidden = false;
      name.focus();
      editorHost.scrollIntoView({ block: 'start' });
    }

    renderList();
    if (ctx.params && ctx.params.action === 'new') openEditor(null);
    if (ctx.params && ctx.params.editTankId && tankById(ctx.params.editTankId)) openEditor(tankById(ctx.params.editTankId));
    return {};
  }
};
