/*
 * Maintenance schedules and reminders: recurring tasks per tank with due /
 * overdue status. "Mark complete" creates the matching log entry. Test
 * reminders are completed by logging the test. Desktop notifications are sent
 * by the main process while the app (or its tray icon) is running.
 */
import { h, replace, button, options, field } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, tankById, defById } from '../ui/state.js';
import { confirmDialog } from '../ui/modal.js';
import { formDialog, control } from '../ui/forms.js';
import { U, D, P, settings, tankSelect, emptyState, table, statusBadge } from '../ui/widgets.js';

const KINDS = P.MAINTENANCE_TYPES.map((t) => ({ value: t.value, label: t.label })).concat([{ value: 'test', label: 'Water test' }]);
const kindLabel = (k) => (KINDS.find((x) => x.value === k) || { label: k }).label;

export default {
  id: 'schedules',
  title: 'Reminders & Schedules',
  async mount(root, ctx) {
    const { signal } = ctx;
    if (!state.tanks.length) {
      replace(root, emptyState('No tanks yet', 'Create a tank before adding maintenance schedules.'));
      return {};
    }
    let tankFilter = (ctx.params && ctx.params.tankId) || '';
    let schedules = [];
    let reminders = [];
    const tankSel = tankSelect(tankFilter, (v) => { tankFilter = v; render(); }, { signal, allowAll: true, label: 'Tank filter' });
    const dueHost = h('section', { class: 'panel' });
    const listHost = h('section', { class: 'panel' });
    replace(root,
      h('div', { class: 'panel controls-row' }, field('Tank', tankSel).wrap,
        h('div', { class: 'field' }, h('span', { class: 'label' }, ' '), button('New schedule', () => edit(null), { kind: 'primary', attrs: { signal } }))),
      dueHost, listHost);

    async function edit(item) {
      const numeric = state.defs.filter((d) => d.kind !== 'choice').map((d) => ({ value: d.id, label: d.name }));
      const v = await formDialog({
        title: item ? 'Edit schedule' : 'New schedule',
        size: 'wide',
        intro: 'Examples: "20% water change every 7 days", "Clean skimmer cup every 3 days", "Test Alk every day".',
        fields: [
          { row: [
            { key: 'tankId', label: 'Tank', type: 'select', options: state.tanks.map((t) => ({ value: t.id, label: t.name })), value: item ? item.tankId : (tankFilter || (state.tanks[0] || {}).id) },
            { key: 'title', label: 'Title', required: true, max: 80, value: item ? item.title : '' },
            { key: 'kind', label: 'Task type', type: 'select', options: KINDS, value: item ? item.kind : 'water_change',
              onChange: (input, controls) => {
                control(controls, 'parameterId').wrap.hidden = input.value !== 'test';
                control(controls, 'volumePercent').wrap.hidden = input.value !== 'water_change';
              } }
          ] },
          { row: [
            { key: 'intervalDays', label: 'Every (days)', type: 'number', integer: true, min: 1, max: 365, required: true, value: item ? item.intervalDays : 7 },
            { key: 'startDate', label: 'First due date', type: 'date', required: true, value: item ? item.startDate : D.localDateString() },
            { key: 'volumePercent', label: 'Water change %', type: 'number', min: 0, max: 100, value: item ? item.volumePercent : 20 },
            { key: 'parameterId', label: 'Parameter to test', type: 'select', options: numeric, value: item ? item.parameterId : 'alk' }
          ] },
          { row: [
            { key: 'notify', label: 'Desktop notification when due', type: 'checkbox', value: item ? item.notify !== false : true },
            { key: 'active', label: 'Active', type: 'checkbox', value: item ? item.active !== false : true }
          ] },
          { key: 'note', label: 'Note', type: 'textarea', max: 500, value: item ? item.note : '' }
        ]
      });
      if (!v) return;
      if (v.kind !== 'test') v.parameterId = null;
      if (v.kind !== 'water_change') v.volumePercent = null;
      if (item) v.id = item.id;
      try {
        await req('schedules:save', v);
        ctx.ticker.info('Schedule saved: ' + v.title + '.');
        await load();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    async function complete(s) {
      if (s.kind === 'test') {
        ctx.ticker.info('Log the ' + ((defById(s.parameterId) || {}).name || '') + ' test to complete this reminder.');
        ctx.navigate('quick-entry', { tankId: s.tankId });
        return;
      }
      let payload = { id: s.id };
      if (s.kind === 'water_change') {
        const tank = tankById(s.tankId);
        const suggested = s.volumePercent && tank ? U.volumeToDisplay(tank.totalVolumeL * s.volumePercent / 100, settings()) : null;
        const v = await formDialog({
          title: 'Complete: ' + s.title,
          intro: 'This logs the water change in the maintenance log.',
          fields: [{ row: [
            { key: 'volume', label: 'Water changed (' + U.volumeLabel(settings()) + ')', type: 'number', min: 0.01, required: true, value: suggested !== null ? U.round(suggested, 1) : null },
            { key: 'when', label: 'When', type: 'datetime', required: true, value: D.toLocalInputValue(new Date()) }
          ] }]
        });
        if (!v) return;
        payload = { id: s.id, volumeL: U.volumeFromDisplay(v.volume, settings()), performedAt: D.fromLocalInputValue(v.when) };
      }
      try {
        await req('schedules:complete', payload);
        ctx.ticker.info('Done: ' + s.title + ' (logged in Maintenance).');
        await load();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    async function remove(s) {
      const ok = await confirmDialog('Delete schedule?', 'Delete the schedule "' + s.title + '"? Logged maintenance is kept.', { confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await req('schedules:delete', { id: s.id });
        ctx.ticker.info('Schedule deleted.');
        await load();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    function render() {
      const due = reminders.filter((r) => (!tankFilter || r.tankId === tankFilter) && r.state !== 'upcoming');
      replace(dueHost, h('h2', null, 'Needs attention (' + due.length + ')'),
        due.length ? h('ul', { class: 'alert-list' }, due.map((r) => {
          const sched = r.kind === 'schedule' ? schedules.find((s) => s.id === r.ref) : null;
          return h('li', null, statusBadge(r.level), ' ', r.message, ' ',
            sched ? button(sched.kind === 'test' ? 'Log test' : 'Mark complete', () => complete(sched), { kind: 'primary', attrs: { signal } }) : null,
            r.kind === 'treatment' ? button('Open treatment', () => ctx.navigate('treatments', { tankId: r.tankId }), { attrs: { signal } }) : null,
            r.kind === 'reagent' ? button('Open equipment', () => ctx.navigate('equipment'), { attrs: { signal } }) : null,
            r.kind === 'qt' ? button('Open livestock', () => ctx.navigate('livestock', { tankId: r.tankId }), { attrs: { signal } }) : null);
        })) : h('p', null, statusBadge('OK'), ' Nothing due or overdue.'));
      const list = schedules.filter((s) => !tankFilter || s.tankId === tankFilter)
        .slice().sort((a, b) => (a.status.dueIn - b.status.dueIn));
      replace(listHost, h('h2', null, 'Schedules'),
        list.length ? table(['Task', 'Tank', 'Every', 'Last done', 'Next due', ''], list.map((s) => [
          h('div', null, h('strong', null, s.title), h('div', { class: 'muted' }, kindLabel(s.kind) + (s.kind === 'test' ? ': ' + ((defById(s.parameterId) || {}).name || '') : '') + (s.active === false ? ' (paused)' : ''))),
          (tankById(s.tankId) || {}).name || '?',
          s.intervalDays + ' day' + (s.intervalDays === 1 ? '' : 's'),
          s.status.lastDone ? D.formatDate(s.status.lastDone) : 'never',
          h('span', null, D.formatDate(s.status.dueDate) + ' ', statusBadge(s.status.state === 'overdue' ? 'ALERT' : s.status.state === 'due' ? 'WATCH' : 'OK', s.status.state === 'overdue' ? 'OVERDUE' : s.status.state === 'due' ? 'TODAY' : 'in ' + s.status.dueIn + 'd')),
          h('div', { class: 'row-actions' },
            button(s.kind === 'test' ? 'Log test' : 'Complete', () => complete(s), { attrs: { signal, 'aria-label': 'Complete ' + s.title } }),
            button('Edit', () => edit(s), { attrs: { signal, 'aria-label': 'Edit ' + s.title } }),
            button('Delete', () => remove(s), { kind: 'danger', attrs: { signal, 'aria-label': 'Delete ' + s.title } }))
        ]), { caption: 'Schedules' }) : h('p', null, 'No schedules yet.'));
    }

    async function load() {
      try {
        [schedules, reminders] = await Promise.all([req('schedules:list', { includeInactive: true }), req('reminders:list')]);
      } catch (e) { schedules = []; reminders = []; }
      render();
    }
    await load();
    return {};
  }
};
