/*
 * Reports and sharing: a plain-text "help post" summary to paste into a forum
 * or show a fish store, and a printable parameter report saved as PDF
 * (webContents.printToPDF in the main process).
 */
import { h, replace, button, field } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, tankById, defaultTankId } from '../ui/state.js';
import { helpPost, printableReport } from '../ui/report.js';
import { createTrendChart, chartAvailable } from '../ui/charting.js';
import { D, tankSelect, emptyState } from '../ui/widgets.js';

async function loadTankData(tankId) {
  const [entries, maintenance, dosing, livestock, treatments, schedules, equipment] = await Promise.all([
    req('entries:list', { tankId }), req('maintenance:list', { tankId }), req('dosing:list', { tankId }),
    req('livestock:list', {}), req('treatments:list', { tankId }), req('schedules:list', { tankId }), req('equipment:list', { tankId })
  ]);
  return { tank: tankById(tankId), entries, maintenance, dosing, livestock, treatments, schedules, equipment };
}

export default {
  id: 'reports',
  title: 'Reports & Sharing',
  async mount(root, ctx) {
    const { signal } = ctx;
    if (!state.allTanks.length) {
      replace(root, emptyState('No tanks yet', 'Create a tank to generate reports.'));
      return {};
    }
    let tankId = defaultTankId() || state.allTanks[0].id;
    const tankSel = tankSelect(tankId, (v) => { tankId = v; generate(); }, { signal, includeArchived: true });
    const text = h('textarea', { rows: 22, readonly: true, class: 'help-post', 'aria-label': 'Help post summary', spellcheck: 'false' });
    const from = h('input', { type: 'date', value: D.addDaysToDateString(D.localDateString(), -90) });
    const to = h('input', { type: 'date', value: D.localDateString() });
    const pdfBtn = button('Save PDF report...', () => pdf(), { kind: 'primary', attrs: { signal } });
    replace(root,
      h('div', { class: 'panel controls-row' }, field('Tank', tankSel).wrap),
      h('section', { class: 'panel' },
        h('h2', null, '"Help post" summary'),
        h('p', { class: 'hint' }, 'Volume, livestock, latest parameters, recent trends and changes, and your maintenance routine as plain text. Copy it into a forum post or show it at your fish store.'),
        text,
        h('div', { class: 'actions' },
          button('Copy to clipboard', () => copy(), { kind: 'primary', attrs: { signal } }),
          button('Regenerate', () => generate(), { attrs: { signal } }))),
      h('section', { class: 'panel' },
        h('h2', null, 'Printable parameter report'),
        h('div', { class: 'form-row' }, field('From', from).wrap, field('To', to).wrap, h('div', { class: 'field' }, h('span', { class: 'label' }, ' '), pdfBtn)),
        h('p', { class: 'hint' }, 'Statistics, a chart and a table of readings for every parameter tested in the period, plus maintenance and dosing. Saved as a PDF file.')));

    async function generate() {
      try {
        const data = await loadTankData(tankId);
        text.value = helpPost(data);
      } catch (e) {
        text.value = '';
      }
    }

    async function copy() {
      if (!text.value) return;
      try {
        await req('reports:copy', { text: text.value });
        ctx.ticker.info('Summary copied to the clipboard.');
      } catch (e) { /* ticker */ }
    }

    function chartImage(def, cfg, series, f, t) {
      if (!chartAvailable()) return null;
      const box = h('div', { class: 'offscreen-chart' });
      const canvas = h('canvas');
      // A fixed-size, non-animated chart draws synchronously, so it can be captured at once.
      canvas.width = 760;
      canvas.height = 280;
      box.appendChild(canvas);
      document.body.appendChild(box);
      let chart = null;
      try {
        chart = createTrendChart(canvas, { static: true, primary: { def, cfg, series }, from: f, to: t, events: [] });
        chart.draw();
        return canvas.toDataURL('image/png');
      } catch (e) {
        ctx.log('WARN', 'Report chart failed: ' + e.message);
        return null;
      } finally {
        if (chart) chart.destroy();
        box.remove();
      }
    }

    async function pdf() {
      const f = D.dayNumberFromDateString(from.value);
      const t = D.dayNumberFromDateString(to.value);
      if (Number.isNaN(f) || Number.isNaN(t) || f > t) { ctx.ticker.warn('Choose a valid date range.'); return; }
      const fromMs = new Date(from.value + 'T00:00:00').getTime();
      const toMs = new Date(to.value + 'T23:59:59').getTime();
      pdfBtn.disabled = true;
      const printRoot = document.getElementById('print-root');
      try {
        const data = await loadTankData(tankId);
        replace(printRoot, printableReport(data, fromMs, toMs, chartImage));
        const res = await req('reports:pdf', { title: data.tank.name });
        if (!res.canceled) ctx.ticker.info(res.message);
      } catch (e) {
        /* ticker */
      } finally {
        replace(printRoot);
        pdfBtn.disabled = false;
      }
    }

    await generate();
    return {};
  }
};
