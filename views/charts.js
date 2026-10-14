/*
 * Trend charts: one parameter (optionally overlaid with a second on its own
 * y-axis), selectable time range, shaded ideal range, event markers, and a
 * text summary plus data table for screen-reader and keyboard users.
 */
import { h, replace, options, field } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, tankById, tankDefs, defaultTankId, defById } from '../ui/state.js';
import { createTrendChart, chartAvailable, RANGES, MARKER_STYLES } from '../ui/charting.js';
import { U, D, S, settings, tankSelect, emptyState, table, fmtReading, statusBadge } from '../ui/widgets.js';

export default {
  id: 'charts',
  title: 'Trend Charts',
  async mount(root, ctx) {
    const { signal } = ctx;
    if (!state.allTanks.length) {
      replace(root, emptyState('No tanks yet', 'Charts appear once you have a tank with logged tests.'));
      return {};
    }
    let tankId = (ctx.params && ctx.params.tankId) || defaultTankId() || state.allTanks[0].id;
    let paramId = (ctx.params && ctx.params.parameterId) || null;
    let overlayId = '';
    let range = '30d';
    let entries = [];
    let events = [];
    let chart = null;

    const tankSel = tankSelect(tankId, (id) => { tankId = id; paramId = null; overlayId = ''; loadTank(); }, { signal, includeArchived: true });
    const paramSel = h('select', { 'aria-label': 'Parameter' });
    const overlaySel = h('select', { 'aria-label': 'Overlay a second parameter' });
    paramSel.addEventListener('change', () => { paramId = paramSel.value; if (overlayId === paramId) overlayId = ''; fillSelectors(); draw(); }, { signal });
    overlaySel.addEventListener('change', () => { overlayId = overlaySel.value; draw(); }, { signal });
    const rangeGroup = h('div', { class: 'toggle-group', role: 'group', 'aria-label': 'Time range' },
      RANGES.map((r) => h('button', {
        type: 'button', class: 'btn toggle', dataset: { range: r.value }, 'aria-pressed': r.value === range ? 'true' : 'false',
        onclick: () => { range = r.value; updateRangeButtons(); draw(); }, signal
      }, r.label)));
    const canvas = h('canvas', { role: 'img', 'aria-label': 'Trend chart' });
    const chartBox = h('div', { class: 'chart-box' }, canvas);
    const chartMsg = h('div', { class: 'chart-message', hidden: true });
    const summary = h('div', { class: 'chart-summary', 'aria-live': 'polite' });
    const legend = h('p', { class: 'marker-legend' },
      Object.keys(MARKER_STYLES).filter((k) => k !== 'dose_once').map((k) => h('span', { class: 'marker-key marker-' + k }, MARKER_STYLES[k].label + ' = ' + MARKER_STYLES[k].name)));
    const tableHost = h('details', { class: 'data-details' });
    replace(root,
      h('div', { class: 'panel controls-row' },
        field('Tank', tankSel).wrap, field('Parameter', paramSel).wrap, field('Overlay', overlaySel).wrap,
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Range'), rangeGroup)),
      h('section', { class: 'panel' }, chartBox, chartMsg, legend, summary, tableHost));

    function updateRangeButtons() {
      rangeGroup.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.range === range ? 'true' : 'false'));
    }

    function numericDefs() {
      const tank = tankById(tankId);
      const enabled = tankDefs(tank).filter((d) => d.kind !== 'choice');
      // Include parameters that have data even if they are disabled now.
      const withData = new Set();
      entries.forEach((e) => e.readings.forEach((r) => withData.add(r.parameterId)));
      const extra = Array.from(withData).filter((id) => !enabled.some((d) => d.id === id)).map(defById).filter((d) => d && d.kind !== 'choice');
      return enabled.concat(extra);
    }

    function fillSelectors() {
      const defs = numericDefs();
      if (!paramId || !defs.some((d) => d.id === paramId)) {
        const withData = defs.find((d) => entries.some((e) => e.readings.some((r) => r.parameterId === d.id)));
        paramId = withData ? withData.id : (defs[0] ? defs[0].id : null);
      }
      replace(paramSel, options(defs.map((d) => ({ value: d.id, label: d.name })), paramId));
      replace(overlaySel, h('option', { value: '' }, 'None'), options(defs.filter((d) => d.id !== paramId).map((d) => ({ value: d.id, label: d.name })), overlayId));
    }

    function destroyChart() {
      if (chart) { chart.destroy(); chart = null; }
    }

    function showMessage(text) {
      destroyChart();
      chartBox.hidden = true;
      chartMsg.hidden = false;
      chartMsg.textContent = text;
    }

    function draw() {
      const tank = tankById(tankId);
      const def = defById(paramId);
      replace(summary);
      replace(tableHost);
      if (!tank || !def) { showMessage('Choose a parameter to chart.'); return; }
      const now = Date.now();
      const r = RANGES.find((x) => x.value === range);
      const all = S.seriesFor(entries, def.id);
      let from = r.days ? now - r.days * D.MS_PER_DAY : (all.length ? all[0].t : now - 30 * D.MS_PER_DAY);
      let to = now;
      if (!r.days && all.length === 1) { from = all[0].t - D.MS_PER_DAY; to = Math.max(now, all[0].t + D.MS_PER_DAY); }
      if (!r.days && all.length > 1) { const pad = (now - from) * 0.02; from -= pad; }
      const series = all.filter((p) => p.t >= from && p.t <= to);
      const overlayDef = overlayId ? defById(overlayId) : null;
      const overlaySeries = overlayDef ? S.seriesFor(entries, overlayDef.id).filter((p) => p.t >= from && p.t <= to) : [];
      const cfg = tank.params[def.id] || null;
      const rangeEvents = events.filter((e) => { const t = Date.parse(e.t); return t >= from && t <= to; });

      renderSummary(def, cfg, all, series, overlayDef, overlaySeries);
      renderTable(def, series, overlayDef, overlaySeries, rangeEvents);

      if (!series.length && !overlaySeries.length) { showMessage('No ' + def.name + ' readings in this range.'); return; }
      if (!chartAvailable()) { showMessage('Chart unavailable. The data table below still lists every reading.'); return; }
      chartBox.hidden = false;
      chartMsg.hidden = true;
      try {
        destroyChart();
        chart = createTrendChart(canvas, {
          primary: { def, cfg, series },
          secondary: overlayDef ? { def: overlayDef, series: overlaySeries } : null,
          from, to, events: rangeEvents
        });
        canvas.setAttribute('aria-label', def.name + (overlayDef ? ' and ' + overlayDef.name : '') + ' trend chart. Summary and data table follow.');
      } catch (err) {
        ctx.ticker.error('Chart unavailable: the chart could not be drawn.');
        ctx.log('ERROR', 'Chart render failed: ' + (err && err.message));
        showMessage('Chart unavailable. The data table below still lists every reading.');
      }
    }

    function renderSummary(def, cfg, all, series, overlayDef, overlaySeries) {
      const s = settings();
      const latest = all[all.length - 1];
      const parts = [];
      if (latest) {
        const st = S.rangeStatus(def, cfg, latest);
        parts.push(h('p', null, 'Latest ', def.name, ': ', h('strong', null, fmtReading(def, latest)), ' (', D.formatDateTime(latest.t), ') ', statusBadge(st.level), ' Ideal: ', S.formatRange(def, cfg, s), '.'));
        const change = S.lastChange(all, cfg);
        if (change && change.delta !== null) {
          let text = 'Change since previous test: ' + S.formatDelta(def, change.delta, s) + ' over ' + D.formatDuration(change.ms);
          if (change.perDay !== null && change.hours >= 48) text += ' (' + S.formatDelta(def, change.perDay, s) + '/day)';
          if (change.perDayNote) text += '. ' + change.perDayNote;
          if (change.gapNote) text += ' ' + change.gapNote;
          parts.push(h('p', { class: change.flagged ? 'swing-text' : '' }, change.flagged ? 'STABILITY ALERT: ' : '', text));
        } else if (change && change.perDayNote) {
          parts.push(h('p', null, change.perDayNote));
        }
      } else {
        parts.push(h('p', null, 'No ' + def.name + ' readings yet.'));
      }
      if (series.length) {
        const nums = series.filter((p) => !p.bdl).map((p) => U.toDisplay(def, p.value, s));
        if (nums.length) {
          const d = U.displayDecimals(def, s);
          parts.push(h('p', null, series.length + ' readings in range. Low ' + U.formatNumber(Math.min.apply(null, nums), d) + ', high ' + U.formatNumber(Math.max.apply(null, nums), d) + ' ' + U.unitLabel(def, s) + '.' +
            (series.some((p) => p.bdl) ? ' Hollow down-triangles mark below-detection readings.' : '')));
        }
      }
      if (overlayDef) {
        const l2 = overlaySeries[overlaySeries.length - 1];
        parts.push(h('p', null, 'Overlay ' + overlayDef.name + ': ' + (l2 ? fmtReading(overlayDef, l2) + ' latest in range' : 'no readings in range') + '.'));
      }
      replace(summary, parts);
    }

    function renderTable(def, series, overlayDef, overlaySeries, rangeEvents) {
      const items = series.map((p) => ({ t: p.t, def, p }));
      if (overlayDef) overlaySeries.forEach((p) => items.push({ t: p.t, def: overlayDef, p }));
      items.sort((a, b) => b.t - a.t);
      const rows = items.slice(0, 400).map((it) => [D.formatDateTime(it.t), it.def.name, fmtReading(it.def, it.p)]);
      const evRows = rangeEvents.slice().reverse().map((e) => [D.formatDateTime(e.t), (MARKER_STYLES[e.kind] || MARKER_STYLES.maintenance).name, e.detail]);
      replace(tableHost,
        h('summary', null, 'Show data table (' + rows.length + ' readings, ' + evRows.length + ' events)'),
        rows.length ? table(['When', 'Parameter', 'Value'], rows, { caption: 'Readings in the selected range' }) : h('p', null, 'No readings in range.'),
        evRows.length ? table(['When', 'Event', 'Detail'], evRows, { caption: 'Events in the selected range', captionVisible: true }) : null);
    }

    async function loadTank() {
      try {
        [entries, events] = await Promise.all([req('entries:list', { tankId }), req('stats:events', { tankId })]);
      } catch (e) {
        entries = []; events = [];
      }
      fillSelectors();
      draw();
    }

    await loadTank();
    return {
      unmount() { destroyChart(); }
    };
  }
};
