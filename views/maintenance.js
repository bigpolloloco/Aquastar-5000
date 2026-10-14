/*
 * Maintenance log: water changes (with % of total system volume), filter
 * media, skimmer, glass, gravel vac, pruning, top-off, salt mixing, equipment
 * changes and custom types. Add, edit, delete, attach photos.
 */
import { h, replace, button, options, field, numberOrNull } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, tankById, defaultTankId, rememberTank } from '../ui/state.js';
import { confirmDialog } from '../ui/modal.js';
import { U, D, P, settings, tankSelect, emptyState, table, maintenanceLabel, waterChangePercent } from '../ui/widgets.js';

export default {
  id: 'maintenance',
  title: 'Maintenance Log',
  async mount(root, ctx) {
    const { signal } = ctx;
    if (!state.tanks.length) {
      replace(root, emptyState('No tanks yet', 'Create a tank before logging maintenance.',
        button('Create a tank', () => ctx.navigate('tanks', 'new'), { kind: 'primary', attrs: { signal } })));
      return {};
    }
    let tankId = (ctx.params && ctx.params.tankId) || defaultTankId();
    let filterTank = tankId;
    let editing = null;
    let records = [];
    let equipment = [];

    const tankSel = tankSelect(tankId, (id) => { tankId = id; updatePercent(); }, { signal });
    const when = h('input', { type: 'datetime-local', value: D.toLocalInputValue(new Date()), required: true });
    const typeSel = h('select', null, options(P.MAINTENANCE_TYPES));
    const volume = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off' });
    const pct = h('span', { class: 'hint', 'aria-live': 'polite' });
    const media = h('select', null, options(P.MEDIA_TYPES));
    const mediaAction = h('select', null, options(P.MEDIA_ACTIONS));
    const customType = h('input', { type: 'text', maxlength: 60 });
    const equipSel = h('select');
    const note = h('textarea', { rows: 2, maxlength: 2000 });
    const volField = field('Water changed (' + U.volumeLabel(settings()) + ')', volume);
    volField.wrap.appendChild(pct);
    const mediaField = h('div', { class: 'form-row' }, field('Media', media).wrap, field('Action', mediaAction).wrap);
    const customField = field('Custom type name', customType);
    const equipField = field('Equipment (optional)', equipSel);
    const banner = h('div', { class: 'edit-banner', hidden: true });
    const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save');
    const form = h('form', { class: 'panel', novalidate: true, 'aria-label': 'Log maintenance' },
      banner,
      h('div', { class: 'form-row' }, field('Tank', tankSel).wrap, field('Date and time', when).wrap, field('Type', typeSel).wrap),
      volField.wrap, mediaField, customField.wrap, equipField.wrap,
      field('Note', note).wrap,
      h('div', { class: 'actions' }, saveBtn, button('Clear', () => resetForm(), { attrs: { signal } })));
    const filterSel = tankSelect(filterTank, (id) => { filterTank = id; renderList(); }, { signal, allowAll: true, includeArchived: true, label: 'Show maintenance for' });
    const listHost = h('div');
    replace(root, form, h('section', { class: 'panel' }, h('div', { class: 'list-header' }, h('h2', null, 'History'), field('Show', filterSel).wrap), listHost));

    typeSel.addEventListener('change', () => updateVisibility(), { signal });
    volume.addEventListener('input', () => updatePercent(), { signal });
    form.addEventListener('submit', (e) => { e.preventDefault(); save(); }, { signal });

    function updateVisibility() {
      const t = typeSel.value;
      volField.wrap.hidden = t !== 'water_change';
      mediaField.hidden = t !== 'media';
      customField.wrap.hidden = t !== 'custom';
      equipField.wrap.hidden = !equipment.length || !['equipment', 'media', 'skimmer', 'custom'].includes(t);
      updatePercent();
    }

    function updatePercent() {
      const v = numberOrNull(volume.value);
      const tank = tankById(tankId);
      if (typeSel.value !== 'water_change' || v === null || Number.isNaN(v) || v <= 0 || !tank) { pct.textContent = tank ? 'Total system volume: ' + U.formatVolume(tank.totalVolumeL, settings()) : ''; return; }
      const p = waterChangePercent(U.volumeFromDisplay(v, settings()), tank);
      pct.textContent = U.formatNumber(p, 1) + '% of total system volume (' + U.formatVolume(tank.totalVolumeL, settings()) + ')' + (p > 100 ? ' - more than the whole system?' : '');
    }

    function fillEquipment(selected) {
      const list = equipment.filter((e) => e.tankId === tankId || !e.tankId);
      replace(equipSel, h('option', { value: '' }, '(none)'), options(list.map((e) => ({ value: e.id, label: [e.brand, e.model].filter(Boolean).join(' ') || e.category })), selected || ''));
    }

    function resetForm() {
      editing = null;
      banner.hidden = true;
      when.value = D.toLocalInputValue(new Date());
      volume.value = '';
      customType.value = '';
      note.value = '';
      saveBtn.textContent = 'Save';
      fillEquipment('');
      updateVisibility();
    }

    function startEdit(m) {
      editing = m;
      tankId = m.tankId;
      tankSel.value = m.tankId;
      when.value = D.toLocalInputValue(m.performedAt);
      typeSel.value = m.type;
      volume.value = m.volumeL ? U.formatNumber(U.volumeToDisplay(m.volumeL, settings()), 2) : '';
      if (m.media) media.value = m.media;
      if (m.mediaAction) mediaAction.value = m.mediaAction;
      customType.value = m.customType || '';
      note.value = m.note || '';
      fillEquipment(m.equipmentId);
      replace(banner, 'Editing ' + maintenanceLabel(m) + ' from ' + D.formatDateTime(m.performedAt) + '. ', button('Cancel edit', () => resetForm(), { attrs: { signal } }));
      banner.hidden = false;
      saveBtn.textContent = 'Save changes';
      updateVisibility();
      typeSel.focus();
      form.scrollIntoView({ block: 'start' });
    }

    async function save() {
      const performedAt = D.fromLocalInputValue(when.value);
      if (!performedAt) { ctx.ticker.warn('Please enter a valid date and time.'); when.focus(); return; }
      const payload = { tankId, performedAt, type: typeSel.value, note: note.value, customType: customType.value, media: null, mediaAction: null, volumeL: null, equipmentId: equipSel.value || null };
      if (payload.type === 'water_change') {
        const v = numberOrNull(volume.value);
        if (v === null || Number.isNaN(v) || v <= 0) { ctx.ticker.warn('Enter how much water was changed.'); volume.focus(); return; }
        payload.volumeL = U.volumeFromDisplay(v, settings());
      }
      if (payload.type === 'media') { payload.media = media.value; payload.mediaAction = mediaAction.value; }
      if (editing) payload.id = editing.id;
      saveBtn.disabled = true;
      try {
        const saved = await req('maintenance:save', payload);
        ctx.ticker.info((editing ? 'Updated: ' : 'Logged: ') + maintenanceLabel(saved) + ' for ' + tankById(saved.tankId).name + '.');
        await rememberTank(tankId);
        resetForm();
        await reload();
        ctx.dataChanged();
      } catch (e) { /* ticker */ } finally { saveBtn.disabled = false; }
    }

    async function remove(m) {
      const ok = await confirmDialog('Delete maintenance entry?', 'Delete "' + maintenanceLabel(m) + '" from ' + D.formatDateTime(m.performedAt) + '? This cannot be undone.', { confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await req('maintenance:delete', { id: m.id });
        ctx.ticker.info('Maintenance entry deleted.');
        if (editing && editing.id === m.id) resetForm();
        await reload();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    function renderList() {
      const list = records.filter((m) => !filterTank || m.tankId === filterTank).slice(0, 300);
      if (!list.length) { replace(listHost, h('p', null, 'No maintenance logged yet.')); return; }
      const rows = list.map((m) => {
        const tank = tankById(m.tankId);
        const p = m.type === 'water_change' ? waterChangePercent(m.volumeL, tank) : null;
        const detail = m.type === 'water_change' ? U.formatVolume(m.volumeL, settings()) + (p !== null ? ' (' + U.formatNumber(p, 0) + '%)' : '') : '';
        const eq = m.equipmentId ? equipment.find((e) => e.id === m.equipmentId) : null;
        return [
          D.formatDateTime(m.performedAt),
          filterTank ? null : (tank ? tank.name : '?'),
          maintenanceLabel(m),
          [detail, eq ? 'Equipment: ' + [eq.brand, eq.model].filter(Boolean).join(' ') : '', m.note].filter(Boolean).join(' - '),
          h('div', { class: 'row-actions' },
            button('Edit', () => startEdit(m), { attrs: { signal, 'aria-label': 'Edit ' + maintenanceLabel(m) } }),
            button('Photo', () => ctx.addPhoto({ tankId: m.tankId, ownerType: 'maintenance', ownerId: m.id }), { attrs: { signal, 'aria-label': 'Attach photo to ' + maintenanceLabel(m) } }),
            button('Delete', () => remove(m), { kind: 'danger', attrs: { signal, 'aria-label': 'Delete ' + maintenanceLabel(m) } }))
        ].filter((c) => c !== null);
      });
      const headers = filterTank ? ['When', 'Type', 'Details', ''] : ['When', 'Tank', 'Type', 'Details', ''];
      replace(listHost, table(headers, rows, { caption: 'Maintenance history' }));
    }

    async function reload() {
      records = await req('maintenance:list', {});
      renderList();
    }

    try {
      equipment = ctx.hasCollection('equipment') ? await req('equipment:list', {}, { quiet: true }) : [];
    } catch (e) { equipment = []; }
    resetForm();
    if (ctx.params && ctx.params.prefill) {
      const pf = ctx.params.prefill;
      if (pf.type) typeSel.value = pf.type;
      if (pf.tankId) { tankId = pf.tankId; tankSel.value = pf.tankId; }
      if (pf.volumeL) volume.value = U.formatNumber(U.volumeToDisplay(pf.volumeL, settings()), 1);
      if (pf.note) note.value = pf.note;
      fillEquipment(pf.equipmentId || '');
      updateVisibility();
    }
    try { await reload(); } catch (e) { replace(listHost, h('p', null, 'Maintenance could not be loaded.')); }
    return {};
  }
};
