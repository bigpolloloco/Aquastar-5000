/*
 * Settings & Data: units, dashboard rotation, custom parameters, data health
 * (damaged files), export/import (folder), CSV export and CSV import with a
 * column-mapping step.
 */
import { h, replace, button, options, field, numberOrNull } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, refresh } from '../ui/state.js';
import { confirmDialog, openDialog, messageDialog } from '../ui/modal.js';
import { U, D, settings, tankSelect, table } from '../ui/widgets.js';

const STORE_LABELS = { tanks: 'Tanks', parameters: 'Custom parameters', entries: 'Test entries', maintenance: 'Maintenance', dosing: 'Dosing', photos: 'Photo records', settings: 'Settings' };

export default {
  id: 'settings',
  title: 'Settings & Data',
  async mount(root, ctx) {
    const { signal } = ctx;
    const healthHost = h('section', { class: 'panel', hidden: true });
    const unitsHost = h('section', { class: 'panel' });
    const paramsHost = h('section', { class: 'panel' });
    const dataHost = h('section', { class: 'panel' });
    const extraHosts = (ctx.settingsSections || []).map(() => h('section', { class: 'panel' }));
    replace(root, healthHost, unitsHost, extraHosts, paramsHost, dataHost);

    // ------------------------------------------------------------ health
    async function renderHealth() {
      let info;
      try { info = await req('app:info', null, { quiet: true }); } catch (e) { return; }
      state.info = info;
      if (!info.corrupt.length) { healthHost.hidden = true; return; }
      healthHost.hidden = false;
      replace(healthHost,
        h('h2', null, 'Data Health'),
        h('p', null, 'These data files could not be read. They were left untouched on disk. You can restore a backup, or start fresh for each file (the damaged file is kept next to the data as a .corrupt copy).'),
        h('ul', { class: 'plain-list' }, info.corrupt.map((name) => h('li', null, (STORE_LABELS[name] || name) + ' ',
          button('Start fresh', () => resetStore(name), { kind: 'danger', attrs: { signal } })))));
    }

    async function resetStore(name) {
      const ok = await confirmDialog('Start fresh?', 'Start the "' + (STORE_LABELS[name] || name) + '" data with an empty file? The damaged file is kept as a .corrupt copy in the data folder.', { confirmLabel: 'Start fresh', danger: true });
      if (!ok) return;
      try {
        await req('app:resetStore', { name });
        ctx.ticker.info((STORE_LABELS[name] || name) + ' reset. You can keep using the app.');
        await refresh();
        await renderHealth();
        ctx.dataChanged(true);
      } catch (e) { /* ticker */ }
    }

    // ------------------------------------------------------------- units
    function renderUnits() {
      const s = settings();
      const u = s.units;
      const mk = (key, label, opts) => {
        const sel = h('select', null, options(opts, u[key]));
        sel.addEventListener('change', () => saveSettings({ units: { [key]: sel.value } }, label + ' set to ' + sel.options[sel.selectedIndex].text + '.'), { signal });
        return field(label, sel).wrap;
      };
      const rotate = h('input', { type: 'number', min: 5, max: 120, step: 1, value: String(s.dashboard.rotateSeconds) });
      const auto = h('input', { type: 'checkbox', id: 'set-autorotate', checked: s.dashboard.autoRotate });
      rotate.addEventListener('change', () => {
        const v = Math.round(Number(rotate.value));
        if (!Number.isFinite(v) || v < 5 || v > 120) { ctx.ticker.warn('Rotation must be 5-120 seconds.'); rotate.value = String(s.dashboard.rotateSeconds); return; }
        saveSettings({ dashboard: { rotateSeconds: v } }, 'Dashboard rotates every ' + v + ' seconds.');
      }, { signal });
      auto.addEventListener('change', () => saveSettings({ dashboard: { autoRotate: auto.checked } }, auto.checked ? 'Dashboard auto-rotation on.' : 'Dashboard auto-rotation off.'), { signal });
      replace(unitsHost,
        h('h2', null, 'Units'),
        h('p', { class: 'hint' }, 'Values are stored in one canonical unit and converted for display, so switching units never changes your data. Salinity in ppt is converted from specific gravity with a 25 °C reference table and is marked approximate (~).'),
        h('div', { class: 'form-row' },
          mk('temperature', 'Temperature', U.UNIT_OPTIONS.temperature),
          mk('volume', 'Volume (and length)', U.UNIT_OPTIONS.volume),
          mk('salinity', 'Salinity', U.UNIT_OPTIONS.salinity),
          mk('alkalinity', 'Alkalinity / KH', U.UNIT_OPTIONS.alkalinity),
          mk('currency', 'Currency', U.CURRENCIES)),
        h('h2', null, 'Dashboard'),
        h('div', { class: 'form-row' },
          h('div', { class: 'field' }, h('span', { class: 'checkbox' }, auto, h('label', { for: auto.id }, 'Rotate between tanks automatically'))),
          field('Seconds per tank', rotate).wrap));
    }

    async function saveSettings(patch, message) {
      try {
        state.settings = await req('settings:save', patch);
        ctx.ticker.info(message);
        await refresh(['settings']);
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    // ------------------------------------------------- custom parameters
    function renderParams() {
      const customs = state.defs.filter((d) => d.custom);
      replace(paramsHost,
        h('div', { class: 'list-header' }, h('h2', null, 'Custom Parameters'), button('Add custom parameter', () => editParam(null), { kind: 'primary', attrs: { signal } })),
        h('p', { class: 'hint' }, 'Add anything your kits or ICP tests measure (iodine, strontium, ORP, PAR...). Enable it per tank in Tanks > Edit.'),
        customs.length ? table(['Name', 'Unit', 'Decimals', 'Default ideal range', ''], customs.map((d) => [
          d.name, d.unit || '--', String(d.decimals),
          (typeof d.defaultMin === 'number' ? d.defaultMin : '') + ' - ' + (typeof d.defaultMax === 'number' ? d.defaultMax : ''),
          h('div', { class: 'row-actions' },
            button('Edit', () => editParam(d), { attrs: { signal, 'aria-label': 'Edit ' + d.name } }),
            button('Delete', () => deleteParam(d), { kind: 'danger', attrs: { signal, 'aria-label': 'Delete ' + d.name } }))
        ]), { caption: 'Custom parameters' }) : h('p', null, 'No custom parameters yet.'));
    }

    async function editParam(def) {
      const name = h('input', { type: 'text', maxlength: 40, value: def ? def.name : '' });
      const unit = h('input', { type: 'text', maxlength: 15, value: def ? def.unit : '' });
      const decimals = h('select', null, options(['0', '1', '2', '3', '4'], def ? String(def.decimals) : '2'));
      const min = h('input', { type: 'text', inputmode: 'decimal', value: def && typeof def.defaultMin === 'number' ? String(def.defaultMin) : '' });
      const max = h('input', { type: 'text', inputmode: 'decimal', value: def && typeof def.defaultMax === 'number' ? String(def.defaultMax) : '' });
      const delta = h('input', { type: 'text', inputmode: 'decimal', value: def && typeof def.defaultMaxDelta === 'number' ? String(def.defaultMaxDelta) : '' });
      const interval = h('input', { type: 'text', inputmode: 'numeric', value: def && def.defaultIntervalDays ? String(def.defaultIntervalDays) : '' });
      const hardMax = h('input', { type: 'text', inputmode: 'decimal', value: def ? String(def.hardMax) : '' });
      let payload = null;
      const res = await openDialog({
        title: def ? 'Edit ' + def.name : 'New custom parameter',
        body: [
          h('div', { class: 'form-row' }, field('Name', name).wrap, field('Unit', unit, 'e.g. ppm, ppb, mV').wrap, field('Decimal places', decimals).wrap),
          h('div', { class: 'form-row' }, field('Ideal min', min).wrap, field('Ideal max', max).wrap),
          h('div', { class: 'form-row' }, field('Max change between tests', delta).wrap, field('Test every (days)', interval).wrap, field('Highest possible value', hardMax, 'Readings above this are rejected as typos.').wrap)
        ],
        actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, kind: 'primary' }],
        validate: () => {
          const n = (el) => numberOrNull(el.value);
          const vals = [n(min), n(max), n(delta), n(interval), n(hardMax)];
          if (!name.value.trim()) return 'Enter a name.';
          if (vals.some((v) => v !== null && (Number.isNaN(v) || v < 0))) return 'Numbers must be positive.';
          if (vals[3] !== null && (!Number.isInteger(vals[3]) || vals[3] < 1 || vals[3] > 365)) return 'Test interval must be 1-365 days.';
          if (vals[0] !== null && vals[1] !== null && vals[0] > vals[1]) return 'Ideal min is above ideal max.';
          payload = { name: name.value, unit: unit.value, decimals: Number(decimals.value), defaultMin: vals[0], defaultMax: vals[1], defaultMaxDelta: vals[2], defaultIntervalDays: vals[3], hardMax: vals[4] || 1000000 };
          if (def) payload.id = def.id;
          return null;
        }
      });
      if (!res || !payload) return;
      try {
        await req('parameters:save', payload);
        ctx.ticker.info('Custom parameter "' + payload.name.trim() + '" saved. Enable it on a tank under Tanks > Edit.');
        await refresh(['defs']);
        renderParams();
      } catch (e) { /* ticker */ }
    }

    async function deleteParam(def) {
      const ok = await confirmDialog('Delete ' + def.name + '?', 'Delete this custom parameter? This only works when no logged test uses it.', { confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await req('parameters:delete', { id: def.id });
        ctx.ticker.info(def.name + ' deleted.');
        await refresh(['defs', 'tanks']);
        renderParams();
      } catch (e) { /* ticker */ }
    }

    // --------------------------------------------------------------- data
    function renderData() {
      const kind = h('select', { 'aria-label': 'What to export' }, options([{ value: 'entries', label: 'Test results' }, { value: 'maintenance', label: 'Maintenance' }, { value: 'dosing', label: 'Dosing' }]));
      const csvTank = tankSelect('', null, { allowAll: true, includeArchived: true, label: 'Tank for CSV export' });
      replace(dataHost,
        h('h2', null, 'Your Data'),
        h('p', null, 'Everything is stored only on this computer' + (state.info && state.info.dataFolder ? ' in: ' : '.'), state.info && state.info.dataFolder ? h('code', { class: 'path' }, state.info.dataFolder) : null),
        h('h3', null, 'Export and import everything'),
        h('p', { class: 'hint' }, 'Export creates a folder with all data and photos. Import replaces all current data after showing a preview; your current data is backed up first.'),
        h('div', { class: 'actions' },
          button('Export all data...', () => exportAll(), { kind: 'primary', attrs: { signal } }),
          button('Import data...', () => importAll(), { attrs: { signal } })),
        h('h3', null, 'CSV (spreadsheets)'),
        h('div', { class: 'form-row' }, field('Export', kind).wrap, field('Tank', csvTank).wrap,
          h('div', { class: 'field' }, h('span', { class: 'label' }, ' '), button('Export CSV...', () => exportCsv(kind.value, csvTank.value), { attrs: { signal } }))),
        h('p', { class: 'hint' }, 'Bring in years of spreadsheet records: choose a CSV, then match its columns to parameters.'),
        button('Import test history from CSV...', () => importCsv(), { attrs: { signal } }));
    }

    async function exportAll() {
      try {
        const res = await req('data:export');
        if (!res.canceled) ctx.ticker.info(res.message);
      } catch (e) { /* ticker */ }
    }

    async function importAll() {
      let preview;
      try {
        preview = await req('data:import');
      } catch (e) { return; }
      if (preview.canceled) return;
      const rows = Object.keys(preview.counts).map((k) => [STORE_LABELS[k] || k, String(preview.counts[k]), String(preview.skipped[k] || 0)]);
      rows.push(['Photo files', String(preview.photos), String(preview.badPhotos || 0)]);
      const ok = await openDialog({
        title: 'Import preview',
        size: 'wide',
        body: [
          h('p', null, 'Export from ' + (preview.exportedAt ? D.formatDateTime(preview.exportedAt) : 'an unknown date') + (preview.fromVersion < (state.info ? state.info.schemaVersion : 0) ? ' (older format; it will be upgraded).' : '.')),
          table(['Data', 'Will import', 'Skipped (invalid)'], rows, { caption: 'Import preview', rowHeaders: true }),
          h('p', { class: 'warning-text' }, 'Importing REPLACES all current data and photos. A backup of your current data is saved first.')
        ],
        actions: [{ label: 'Cancel', value: false }, { label: 'Replace my data', value: true, kind: 'danger' }]
      });
      if (!(ok === true || ok === 'true')) {
        req('data:importCancel', { token: preview.token }, { quiet: true }).catch(() => undefined);
        ctx.ticker.info('Import cancelled. Nothing was changed.');
        return;
      }
      try {
        const res = await req('data:importConfirm', { token: preview.token });
        ctx.ticker.info(res.message);
        await refresh();
        ctx.dataChanged(true);
      } catch (e) { /* ticker */ }
    }

    async function exportCsv(kind, tankId) {
      try {
        const res = await req('csv:export', tankId ? { kind, tankId } : { kind });
        if (!res.canceled) ctx.ticker.info(res.message);
      } catch (e) { /* ticker */ }
    }

    async function importCsv() {
      if (!state.tanks.length) { ctx.ticker.warn('Create a tank first, then import its history.'); return; }
      let res;
      try { res = await req('csv:import'); } catch (e) { return; }
      if (res.canceled) return;
      const mapping = await csvMappingDialog(res);
      if (!mapping) {
        req('data:importCancel', { token: res.token }, { quiet: true }).catch(() => undefined);
        ctx.ticker.info('CSV import cancelled.');
        return;
      }
      try {
        const out = await req('csv:importCommit', Object.assign({ token: res.token }, mapping));
        ctx.ticker.info('CSV import: ' + out.imported + ' tests imported, ' + out.skipped + ' rows skipped.');
        if (out.problems.length) await messageDialog('Some rows were skipped', out.problems.join('\n'));
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    renderUnits();
    renderParams();
    await renderHealth();
    renderData();
    (ctx.settingsSections || []).forEach((fn, i) => fn(extraHosts[i], ctx));
    if (ctx.params && ctx.params.action === 'export') exportAll();
    if (ctx.params && ctx.params.action === 'import') importAll();
    if (ctx.params && ctx.params.action === 'csv-import') importCsv();
    return {};
  }
};

// ---------------------------------------------------------------------------
// CSV column mapping
// ---------------------------------------------------------------------------
const HEADER_GUESSES = [
  ['alk', /alk|dkh|\bkh\b.*reef/i], ['calcium', /calc|\bca\b/i], ['magnesium', /magn|\bmg\b/i],
  ['nitrate', /nitrate|no3/i], ['nitrite', /nitrite|no2/i], ['phosphate', /phosph|po4/i],
  ['ammonia', /ammon|nh3|nh4/i], ['salinity', /salin|\bsg\b|spec.*grav|ppt/i], ['temp', /temp/i],
  ['ph', /^\s*ph\b|\bph\s*$/i], ['kh', /\bkh\b/i], ['gh', /\bgh\b/i], ['tds', /tds/i],
  ['co2', /co2/i], ['iron', /iron|\bfe\b/i], ['potassium', /potass|\bk\b/i]
];

function guessDateFormat(samples) {
  const vals = samples.filter(Boolean).map((v) => String(v).trim());
  if (vals.some((v) => /^\d{4}-\d{2}-\d{2}T/.test(v))) return 'iso';
  if (vals.every((v) => /^\d{4}[-/.]/.test(v))) return 'ymd';
  if (vals.some((v) => { const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]/.exec(v); return m && Number(m[1]) > 12; })) return 'dmy';
  return 'mdy';
}

function unitChoicesFor(def) {
  if (!def) return null;
  if (def.unitKind === 'temperature') return [{ value: 'F', label: '°F' }, { value: 'C', label: '°C' }];
  if (def.unitKind === 'salinity') return [{ value: 'sg', label: 'SG' }, { value: 'ppt', label: 'ppt' }];
  if (def.unitKind === 'alkalinity') return [{ value: 'dkh', label: 'dKH' }, { value: 'meq', label: 'meq/L' }, { value: 'ppm', label: 'ppm CaCO3' }];
  return null;
}

function csvMappingDialog(res) {
  const headers = res.headers;
  const colOptions = headers.map((name, i) => ({ value: String(i), label: (i + 1) + ': ' + name }));
  const dateIdx = Math.max(0, headers.findIndex((x) => /date|time|when|day/i.test(x)));
  const tankSel = tankSelect(state.settings && state.settings.lastTankId, null, { label: 'Import into tank' });
  const dateCol = h('select', null, options(colOptions, String(dateIdx)));
  const timeIdx = headers.findIndex((x, i) => i !== dateIdx && /^time$/i.test(x.trim()));
  const timeCol = h('select', null, h('option', { value: '' }, '(time is in the date column / none)'), options(colOptions, timeIdx >= 0 ? String(timeIdx) : ''));
  const dateFmt = h('select', null, options([
    { value: 'iso', label: 'ISO (2024-05-31T18:00Z or 2024-05-31 18:00)' },
    { value: 'ymd', label: 'Year-Month-Day (2024-05-31)' },
    { value: 'mdy', label: 'Month/Day/Year (05/31/2024)' },
    { value: 'dmy', label: 'Day/Month/Year (31/05/2024)' }
  ], guessDateFormat(res.sample.map((r) => r[dateIdx]))));
  const methodCol = h('select', null, h('option', { value: '' }, '(none)'), options(colOptions, String(headers.findIndex((x) => /method|kit/i.test(x)))));
  const noteCol = h('select', null, h('option', { value: '' }, '(none)'), options(colOptions, String(headers.findIndex((x) => /note|comment/i.test(x)))));
  const numericDefs = state.defs.filter((d) => d.kind !== 'choice');
  const colRows = headers.map((name, i) => {
    const guess = HEADER_GUESSES.find(([, re]) => re.test(name));
    const sel = h('select', { 'aria-label': 'Parameter for column ' + name }, h('option', { value: '' }, '(ignore)'), options(numericDefs.map((d) => ({ value: d.id, label: d.name })), guess && i !== dateIdx ? guess[0] : ''));
    const unitSel = h('select', { 'aria-label': 'Unit for column ' + name });
    const updateUnits = () => {
      const def = numericDefs.find((d) => d.id === sel.value);
      const choices = unitChoicesFor(def);
      unitSel.hidden = !choices;
      if (choices) {
        let guessUnit = choices[0].value;
        const sampleVals = res.sample.map((r) => Number(String(r[i] || '').replace(',', '.'))).filter((v) => Number.isFinite(v));
        if (def.unitKind === 'temperature') guessUnit = /°?\s*c\b|celsius/i.test(name) || sampleVals.some((v) => v > 0 && v < 40) && !sampleVals.some((v) => v > 50) ? 'C' : 'F';
        if (def.unitKind === 'salinity') guessUnit = sampleVals.some((v) => v > 2) ? 'ppt' : 'sg';
        if (def.unitKind === 'alkalinity') guessUnit = /meq/i.test(name) ? 'meq' : sampleVals.some((v) => v > 40) ? 'ppm' : 'dkh';
        replace(unitSel, options(choices, guessUnit));
      }
    };
    sel.addEventListener('change', updateUnits);
    updateUnits();
    return { i, name, sel, unitSel, sample: res.sample.slice(0, 3).map((r) => r[i] || '').join(' | ') };
  });
  const preview = table(headers.slice(0, 12), res.sample.slice(0, 5).map((r) => headers.slice(0, 12).map((_, i) => String(r[i] || ''))), { caption: 'First rows of ' + res.fileName, captionVisible: true, class: 'csv-preview' });
  let mapping = null;
  return openDialog({
    title: 'Map CSV columns (' + res.rowCount + ' rows)',
    size: 'wide',
    body: [
      h('div', { class: 'csv-preview-wrap' }, preview),
      h('div', { class: 'form-row' }, field('Tank', tankSel).wrap, field('Date column', dateCol).wrap, field('Date format', dateFmt).wrap),
      h('div', { class: 'form-row' }, field('Time column', timeCol).wrap, field('Method column', methodCol).wrap, field('Note column', noteCol).wrap),
      h('p', { class: 'hint' }, 'Match each value column to a parameter. Values like "<0.02" or "ND" import as below detection. Dates without a time are placed at noon local time.'),
      table(['Column', 'Sample values', 'Parameter', 'Unit'], colRows.map((c) => [c.name, c.sample, c.sel, c.unitSel]), { caption: 'Column mapping', class: 'mapping-table' })
    ],
    actions: [{ label: 'Cancel', value: false }, { label: 'Import', value: true, kind: 'primary' }],
    validate: () => {
      const used = new Set([dateCol.value, timeCol.value, methodCol.value, noteCol.value].filter((x) => x !== ''));
      const columns = colRows.filter((c) => c.sel.value && !used.has(String(c.i))).map((c) => ({ index: c.i, parameterId: c.sel.value, unit: c.unitSel.hidden ? 'canonical' : c.unitSel.value }));
      if (!tankSel.value) return 'Choose a tank.';
      if (!columns.length) return 'Map at least one column to a parameter.';
      const ids = columns.map((c) => c.parameterId);
      if (new Set(ids).size !== ids.length) return 'Each parameter can only be mapped once.';
      mapping = {
        tankId: tankSel.value,
        dateColumn: Number(dateCol.value),
        timeColumn: timeCol.value === '' ? null : Number(timeCol.value),
        dateFormat: dateFmt.value,
        methodColumn: methodCol.value === '' ? null : Number(methodCol.value),
        noteColumn: noteCol.value === '' ? null : Number(noteCol.value),
        columns
      };
      return null;
    }
  }).then((ok) => ((ok === true || ok === 'true') ? mapping : null));
}
