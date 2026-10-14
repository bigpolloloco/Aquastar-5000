/*
 * Equipment: heaters, lights, pumps, skimmers, filters, ATO, controllers and
 * test kits with purchase/warranty info, per-equipment maintenance history,
 * test-kit reagent expiry dates (ticker warnings), calibration logs, and the
 * optional lighting schedule and PAR readings per tank.
 */
import { h, replace, button, options, field } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, tankById, refresh } from '../ui/state.js';
import { confirmDialog } from '../ui/modal.js';
import { formDialog } from '../ui/forms.js';
import { U, D, settings, tankSelect, emptyState, table, fmtMoney, statusBadge, maintenanceLabel } from '../ui/widgets.js';

const CATEGORIES = [
  { value: 'heater', label: 'Heater' }, { value: 'light', label: 'Light' }, { value: 'pump', label: 'Pump / powerhead' },
  { value: 'skimmer', label: 'Protein skimmer' }, { value: 'filter', label: 'Filter' }, { value: 'ato', label: 'ATO' },
  { value: 'controller', label: 'Controller' }, { value: 'test_kit', label: 'Test kit' }, { value: 'refractometer', label: 'Refractometer' },
  { value: 'ph_probe', label: 'pH probe' }, { value: 'salinity_probe', label: 'Salinity probe' }, { value: 'reactor', label: 'Reactor' },
  { value: 'chiller', label: 'Chiller' }, { value: 'other', label: 'Other' }
];
const CALIBRATABLE = ['refractometer', 'ph_probe', 'salinity_probe', 'controller'];
const catLabel = (v) => (CATEGORIES.find((c) => c.value === v) || { label: v }).label;
const nameOf = (e) => [e.brand, e.model].filter(Boolean).join(' ') || catLabel(e.category);

export default {
  id: 'equipment',
  title: 'Equipment',
  async mount(root, ctx) {
    const { signal } = ctx;
    let tankFilter = (ctx.params && ctx.params.tankId) || '';
    let items = [];
    let maintenance = [];
    const tankSel = tankSelect(tankFilter, (v) => { tankFilter = v; render(); }, { signal, allowAll: true, includeArchived: true, label: 'Tank filter' });
    const listHost = h('section', { class: 'panel' });
    const lightHost = h('section', { class: 'panel' });
    replace(root,
      h('div', { class: 'panel controls-row' }, field('Tank', tankSel).wrap,
        h('div', { class: 'field' }, h('span', { class: 'label' }, ' '), button('Add equipment', () => edit(null), { kind: 'primary', attrs: { signal } }))),
      listHost, lightHost);

    async function edit(item) {
      const v = await formDialog({
        title: item ? 'Edit ' + nameOf(item) : 'Add equipment',
        size: 'wide',
        fields: [
          { row: [
            { key: 'category', label: 'Type', type: 'select', options: CATEGORIES, value: item ? item.category : 'heater' },
            { key: 'brand', label: 'Brand', max: 60, value: item ? item.brand : '' },
            { key: 'model', label: 'Model', max: 60, value: item ? item.model : '' },
            { key: 'tankId', label: 'Tank', type: 'select', options: state.allTanks.map((t) => ({ value: t.id, label: t.name })), allowEmpty: true, emptyLabel: '(not in a tank / spare)', value: item ? item.tankId : (tankFilter || null) }
          ] },
          { row: [
            { key: 'purchaseDate', label: 'Purchase date', type: 'date', value: item ? item.purchaseDate : null },
            { key: 'cost', label: 'Cost (' + U.units(settings()).currency + ')', type: 'number', min: 0, value: item ? item.cost : null },
            { key: 'warrantyEnd', label: 'Warranty ends', type: 'date', value: item ? item.warrantyEnd : null }
          ] },
          { key: 'notes', label: 'Notes', type: 'textarea', value: item ? item.notes : '' }
        ],
        validate: (x) => (!x.brand && !x.model ? 'Enter a brand or model.' : null)
      });
      if (!v) return;
      const payload = Object.assign({ reagents: item ? item.reagents : [], calibrations: item ? item.calibrations : [] }, v);
      if (item) payload.id = item.id;
      await save(payload, (item ? 'Updated ' : 'Added ') + nameOf(v) + '.');
    }

    async function save(payload, message) {
      try {
        await req('equipment:save', payload);
        ctx.ticker.info(message);
        await load();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    const strip = (item) => { const o = Object.assign({}, item); delete o.createdAt; delete o.updatedAt; return o; };

    async function addReagent(item) {
      const v = await formDialog({
        title: 'Reagent for ' + nameOf(item),
        intro: 'Expired reagents give wrong readings; AquaStar warns ' + settings().reagentWarnDays + ' days before expiry.',
        fields: [{ row: [
          { key: 'name', label: 'Reagent', required: true, max: 60, value: '' },
          { key: 'lot', label: 'Lot', max: 40 },
          { key: 'expires', label: 'Expires', type: 'date', required: true }
        ] }]
      });
      if (!v) return;
      await save(Object.assign(strip(item), { reagents: (item.reagents || []).concat([v]) }), 'Reagent added.');
    }

    async function removeReagent(item, r) {
      await save(Object.assign(strip(item), { reagents: item.reagents.filter((x) => x.id !== r.id) }), 'Reagent removed.');
    }

    async function addCalibration(item) {
      const v = await formDialog({
        title: 'Calibration: ' + nameOf(item),
        fields: [{ row: [
          { key: 'when', label: 'When', type: 'datetime', required: true, value: D.toLocalInputValue(new Date()) },
          { key: 'standard', label: 'Standard / solution', max: 60, value: item.category === 'ph_probe' ? 'pH 7.0 / 10.0' : '35 ppt' },
          { key: 'reading', label: 'Reading before adjusting', max: 40 }
        ] }, { key: 'note', label: 'Note', max: 200 }]
      });
      if (!v) return;
      const cal = { date: D.fromLocalInputValue(v.when), standard: v.standard || '', reading: v.reading || '', note: v.note || '' };
      await save(Object.assign(strip(item), { calibrations: (item.calibrations || []).concat([cal]) }), 'Calibration logged.');
    }

    async function remove(item) {
      const ok = await confirmDialog('Delete ' + nameOf(item) + '?', 'Delete this equipment record with its reagents and calibration log? Maintenance entries stay in the log.', { confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await req('equipment:delete', { id: item.id });
        ctx.ticker.info('Equipment deleted.');
        await load();
      } catch (e) { /* ticker */ }
    }

    function card(item) {
      const tank = item.tankId ? tankById(item.tankId) : null;
      const warrantyLeft = item.warrantyEnd ? D.daysUntilDate(item.warrantyEnd) : null;
      const history = maintenance.filter((m) => m.equipmentId === item.id);
      return h('article', { class: 'subpanel equipment-card' },
        h('div', { class: 'list-header' }, h('h3', null, nameOf(item)), h('span', { class: 'muted' }, catLabel(item.category) + (tank ? ' - ' + tank.name : ' - spare'))),
        h('p', { class: 'muted' }, [
          item.purchaseDate ? 'Bought ' + D.formatDate(item.purchaseDate) : null,
          item.cost !== null && item.cost !== undefined ? fmtMoney(item.cost) : null,
          item.warrantyEnd ? 'Warranty ' + (warrantyLeft < 0 ? 'ended ' : 'until ') + D.formatDate(item.warrantyEnd) : null
        ].filter(Boolean).join(' - ')),
        item.notes ? h('p', null, item.notes) : null,
        item.category === 'test_kit' ? h('div', null, h('h3', null, 'Reagents'),
          item.reagents && item.reagents.length ? table(['Reagent', 'Lot', 'Expires', ''], item.reagents.map((r) => {
            const left = D.daysUntilDate(r.expires);
            const lvl = left < 0 ? 'ALERT' : left <= settings().reagentWarnDays ? 'WATCH' : 'OK';
            return [r.name, r.lot || '--', h('span', null, D.formatDate(r.expires) + ' ', statusBadge(lvl, left < 0 ? 'EXPIRED' : left + 'd')),
              button('Remove', () => removeReagent(item, r), { kind: 'danger', attrs: { signal, 'aria-label': 'Remove reagent ' + r.name } })];
          }), { caption: 'Reagents' }) : h('p', { class: 'muted' }, 'No reagents recorded.'),
          button('Add reagent', () => addReagent(item), { attrs: { signal } })) : null,
        CALIBRATABLE.includes(item.category) ? h('div', null, h('h3', null, 'Calibration log'),
          item.calibrations && item.calibrations.length ? table(['When', 'Standard', 'Reading', 'Note'], item.calibrations.slice(0, 10).map((c) => [D.formatDateTime(c.date), c.standard, c.reading, c.note]), { caption: 'Calibrations' }) : h('p', { class: 'muted' }, 'Never calibrated.'),
          button('Log calibration', () => addCalibration(item), { attrs: { signal } })) : null,
        h('h3', null, 'Maintenance history'),
        history.length ? h('ul', { class: 'plain-list' }, history.slice(0, 8).map((m) => h('li', null, D.formatDate(m.performedAt) + ' - ' + maintenanceLabel(m) + (m.note ? ': ' + m.note : '')))) : h('p', { class: 'muted' }, 'None logged.'),
        h('div', { class: 'row-actions' },
          item.tankId ? button('Log maintenance', () => ctx.navigate('maintenance', { prefill: { tankId: item.tankId, type: 'equipment', equipmentId: item.id, note: nameOf(item) + ': ' } }), { attrs: { signal } }) : null,
          button('Edit', () => edit(item), { attrs: { signal } }),
          button('Photo', () => (item.tankId ? ctx.addPhoto({ tankId: item.tankId, ownerType: 'equipment', ownerId: item.id }) : ctx.ticker.warn('Assign the equipment to a tank to attach photos.')), { attrs: { signal } }),
          button('Delete', () => remove(item), { kind: 'danger', attrs: { signal } })));
    }

    // ---------------------------------------------------------- lighting
    function renderLighting() {
      const tank = tankFilter ? tankById(tankFilter) : null;
      if (!tank) {
        replace(lightHost, h('h2', null, 'Lighting schedule and PAR'), h('p', { class: 'muted' }, 'Choose a tank above to record its lighting schedule and PAR readings (optional).'));
        return;
      }
      const lighting = tank.lighting || { photoperiod: [], par: [] };
      const hours = lighting.photoperiod.reduce((sum, p) => {
        const [sh, sm] = p.start.split(':').map(Number);
        const [eh, em] = p.end.split(':').map(Number);
        let mins = (eh * 60 + em) - (sh * 60 + sm);
        if (mins < 0) mins += 1440;
        return sum + mins;
      }, 0) / 60;
      replace(lightHost,
        h('h2', null, 'Lighting - ' + tank.name),
        lighting.photoperiod.length ? table(['Period', 'Start', 'End', 'Intensity', ''], lighting.photoperiod.map((p, i) => [p.label || 'Period ' + (i + 1), p.start, p.end, p.intensity !== null && p.intensity !== undefined ? p.intensity + '%' : '--',
          button('Remove', () => saveLighting(tank, Object.assign({}, lighting, { photoperiod: lighting.photoperiod.filter((_, j) => j !== i) })), { kind: 'danger', attrs: { signal } })]), { caption: 'Photoperiod' }) : h('p', { class: 'muted' }, 'No lighting schedule recorded.'),
        lighting.photoperiod.length ? h('p', null, 'Total photoperiod: ' + U.formatNumber(hours, 1) + ' h/day') : null,
        button('Add light period', () => addPeriod(tank, lighting), { attrs: { signal } }),
        h('h3', null, 'PAR readings'),
        lighting.par.length ? table(['Date', 'Spot', 'PAR', ''], lighting.par.slice().reverse().map((p) => [D.formatDate(p.date), p.spot || '--', String(p.value),
          button('Remove', () => saveLighting(tank, Object.assign({}, lighting, { par: lighting.par.filter((x) => x !== p) })), { kind: 'danger', attrs: { signal } })]), { caption: 'PAR readings' }) : h('p', { class: 'muted' }, 'No PAR readings.'),
        button('Add PAR reading', () => addPar(tank, lighting), { attrs: { signal } }));
    }

    async function addPeriod(tank, lighting) {
      const v = await formDialog({
        title: 'Light period',
        fields: [{ row: [
          { key: 'label', label: 'Label', max: 40, value: 'Main' },
          { key: 'start', label: 'Start', type: 'time', required: true, value: '10:00' },
          { key: 'end', label: 'End', type: 'time', required: true, value: '19:00' },
          { key: 'intensity', label: 'Intensity %', type: 'number', integer: true, min: 0, max: 100 }
        ] }]
      });
      if (!v) return;
      await saveLighting(tank, Object.assign({}, lighting, { photoperiod: lighting.photoperiod.concat([{ label: v.label || '', start: v.start, end: v.end, intensity: v.intensity }]) }));
    }

    async function addPar(tank, lighting) {
      const v = await formDialog({
        title: 'PAR reading',
        fields: [{ row: [
          { key: 'date', label: 'Date', type: 'date', required: true, value: D.localDateString() },
          { key: 'spot', label: 'Spot (e.g. top left, sand bed)', max: 60 },
          { key: 'value', label: 'PAR', type: 'number', min: 0, max: 3000, required: true }
        ] }]
      });
      if (!v) return;
      await saveLighting(tank, Object.assign({}, lighting, { par: lighting.par.concat([{ date: v.date, spot: v.spot || '', value: v.value }]) }));
    }

    async function saveLighting(tank, lighting) {
      const payload = Object.assign({}, tank, { lighting });
      ['createdAt', 'updatedAt', 'marine', 'archivedAt'].forEach((k) => delete payload[k]);
      try {
        await req('tanks:save', payload);
        await refresh(['tanks']);
        ctx.ticker.info('Lighting saved for ' + tank.name + '.');
        renderLighting();
      } catch (e) { /* ticker */ }
    }

    function render() {
      const list = items.filter((e) => !tankFilter || e.tankId === tankFilter || !e.tankId);
      replace(listHost, h('h2', null, 'Equipment (' + list.length + ')'), list.length ? h('div', { class: 'card-grid' }, list.map(card)) : h('p', null, 'No equipment recorded yet.'));
      renderLighting();
    }

    async function load() {
      try {
        [items, maintenance] = await Promise.all([req('equipment:list', {}), req('maintenance:list', {})]);
      } catch (e) { items = []; }
      render();
    }
    await load();
    return {};
  }
};
