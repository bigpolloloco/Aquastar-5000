/*
 * Cycling mode for new or recovering tanks: Ammonia, Nitrite and Nitrate on
 * one chart. The keeper decides when the cycle is complete; AquaStar only
 * offers a hint ("Ammonia and Nitrite at 0 for X consecutive tests").
 */
import { h, replace, button, field } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, tankById, defaultTankId, defById, refresh } from '../ui/state.js';
import { confirmDialog } from '../ui/modal.js';
import { createMultiChart, chartAvailable } from '../ui/charting.js';
import { D, S, tankSelect, emptyState, table, fmtReading, statusBadge } from '../ui/widgets.js';

/** Count the most recent consecutive tests where both ammonia and nitrite read zero / not detected. */
export function zeroStreak(entries) {
  const tests = entries
    .map((e) => ({ t: Date.parse(e.takenAt), a: e.readings.find((r) => r.parameterId === 'ammonia'), n: e.readings.find((r) => r.parameterId === 'nitrite') }))
    .filter((x) => x.a && x.n)
    .sort((x, y) => y.t - x.t);
  const isZero = (r) => r.value === 0 || (r.bdl && r.value <= 0.25);
  let count = 0;
  for (const x of tests) {
    if (isZero(x.a) && isZero(x.n)) count++;
    else break;
  }
  return count;
}

export default {
  id: 'cycling',
  title: 'Cycling Mode',
  async mount(root, ctx) {
    const { signal } = ctx;
    if (!state.tanks.length) {
      replace(root, emptyState('No tanks yet', 'Create a tank to track its nitrogen cycle.'));
      return {};
    }
    let tankId = (ctx.params && ctx.params.tankId) || (state.tanks.find((t) => t.cycling && t.cycling.active) || {}).id || defaultTankId();
    let chart = null;
    const tankSel = tankSelect(tankId, (v) => { tankId = v; load(); }, { signal });
    const statusHost = h('section', { class: 'panel' });
    const canvas = h('canvas', { role: 'img', 'aria-label': 'Ammonia, nitrite and nitrate chart' });
    const chartBox = h('div', { class: 'chart-box' }, canvas);
    const chartMsg = h('div', { class: 'chart-message', hidden: true });
    const tableHost = h('div');
    replace(root, h('div', { class: 'panel controls-row' }, field('Tank', tankSel).wrap), statusHost, h('section', { class: 'panel' }, chartBox, chartMsg, tableHost));

    async function setCycling(cycling, message) {
      const tank = tankById(tankId);
      const payload = Object.assign({}, tank, { cycling });
      ['createdAt', 'updatedAt', 'marine', 'archivedAt'].forEach((k) => delete payload[k]);
      try {
        await req('tanks:save', payload);
        await refresh(['tanks']);
        ctx.ticker.info(message);
        await load();
        ctx.dataChanged();
      } catch (e) { /* ticker */ }
    }

    function destroy() { if (chart) { chart.destroy(); chart = null; } }

    async function load() {
      const tank = tankById(tankId);
      let entries = [];
      try { entries = await req('entries:list', { tankId }); } catch (e) { entries = []; }
      const c = tank.cycling || null;
      const streak = zeroStreak(entries);
      const day = c && c.startedAt ? D.daysSince(D.localNoonIso(c.startedAt)) + 1 : null;
      replace(statusHost,
        h('h2', null, tank.name + ': ' + (c && c.active ? 'cycling (day ' + day + ')' : c && c.completedAt ? 'cycle completed ' + D.formatDate(c.completedAt) : 'not in cycling mode')),
        c && c.active ? h('p', null, streak > 0
          ? [statusBadge(streak >= 3 ? 'OK' : 'WATCH'), ' Ammonia and Nitrite at 0 for ' + streak + ' consecutive test' + (streak === 1 ? '' : 's') + '.']
          : 'Ammonia and/or Nitrite are still detectable in the latest test.') : null,
        c && c.active ? h('p', { class: 'hint' }, 'You decide when the cycle is done. A common rule of thumb is a tank that processes its ammonia source to zero ammonia and nitrite within 24 hours, several times in a row.') : null,
        h('div', { class: 'actions' },
          !(c && c.active) ? button('Start cycling mode', () => setCycling({ active: true, startedAt: D.localDateString(), completedAt: null }, 'Cycling mode started for ' + tank.name + '.'), { kind: 'primary', attrs: { signal } }) : null,
          c && c.active ? button('Mark cycle complete', async () => {
            const ok = await confirmDialog('Mark cycle complete?', 'Mark the nitrogen cycle of ' + tank.name + ' as complete? You can restart cycling mode later if needed.', { confirmLabel: 'Mark complete' });
            if (ok) setCycling({ active: false, startedAt: c.startedAt, completedAt: D.localDateString() }, 'Cycle marked complete. Congratulations!');
          }, { kind: 'primary', attrs: { signal } }) : null,
          c && c.active ? button('Leave cycling mode', () => setCycling(null, 'Cycling mode turned off for ' + tank.name + '.'), { attrs: { signal } }) : null,
          button('Log a test', () => ctx.navigate('quick-entry', { tankId }), { attrs: { signal } })));

      const defs = ['ammonia', 'nitrite', 'nitrate'].map(defById).filter(Boolean);
      const since = c && c.startedAt ? D.dayNumberFromDateString(c.startedAt) * D.MS_PER_DAY - D.MS_PER_DAY : Date.now() - 60 * D.MS_PER_DAY;
      const series = defs.map((d) => S.seriesFor(entries, d.id).filter((p) => p.t >= since));
      const allPts = series.flat();
      if (!allPts.length) {
        destroy();
        chartBox.hidden = true;
        chartMsg.hidden = false;
        chartMsg.textContent = 'No ammonia, nitrite or nitrate readings yet' + (c && c.startedAt ? ' since cycling started.' : '.');
      } else if (!chartAvailable()) {
        destroy();
        chartBox.hidden = true;
        chartMsg.hidden = false;
        chartMsg.textContent = 'Chart unavailable. The table below lists every reading.';
      } else {
        chartBox.hidden = false;
        chartMsg.hidden = true;
        const from = Math.min(since, Math.min.apply(null, allPts.map((p) => p.t))) ;
        const to = Math.max(Date.now(), Math.max.apply(null, allPts.map((p) => p.t)));
        try {
          destroy();
          chart = createMultiChart(canvas, {
            from: from - (to - from) * 0.02, to,
            leftTitle: 'Ammonia / Nitrite (ppm)', rightTitle: 'Nitrate (ppm)',
            series: [
              { def: defs[0], series: series[0], axis: 'y', color: '#ffe14d' },
              { def: defs[1], series: series[1], axis: 'y', color: '#ff8a8a', dash: [6, 3], pointStyle: 'rectRot' },
              { def: defs[2], series: series[2], axis: 'y2', color: '#5fe0ff', dash: [2, 3], pointStyle: 'rect' }
            ]
          });
        } catch (err) {
          ctx.log('ERROR', 'Cycling chart failed: ' + err.message);
          chartBox.hidden = true;
          chartMsg.hidden = false;
          chartMsg.textContent = 'Chart unavailable. The table below lists every reading.';
        }
      }
      const rows = entries.filter((e) => Date.parse(e.takenAt) >= since && e.readings.some((r) => ['ammonia', 'nitrite', 'nitrate'].includes(r.parameterId)))
        .map((e) => [D.formatDateTime(e.takenAt)].concat(defs.map((d) => { const r = e.readings.find((x) => x.parameterId === d.id); return r ? fmtReading(d, r) : '--'; })));
      replace(tableHost, rows.length ? table(['When'].concat(defs.map((d) => d.name)), rows.slice(0, 100), { caption: 'Cycling readings' }) : null);
    }

    await load();
    return { unmount() { destroy(); } };
  }
};
