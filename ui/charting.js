/*
 * Chart.js helpers: linear time axis (no date adapter needed), ideal-range
 * shading and event markers as two small custom plugins, gap-aware datasets.
 */
import { U, D, S, settings } from './widgets.js';

export const MARKER_STYLES = {
  water_change: { color: '#4fd1ff', label: 'WC', name: 'Water change' },
  dose_change: { color: '#c9a3ff', label: 'DOSE', name: 'Dosing regimen change' },
  dose_once: { color: '#9f86d6', label: 'DOSE', name: 'One-time dose' },
  livestock_add: { color: '#7dff8a', label: 'ADD', name: 'Livestock added' },
  livestock_loss: { color: '#ff8a8a', label: 'LOSS', name: 'Livestock loss' },
  treatment: { color: '#ffd166', label: 'TX', name: 'Treatment' },
  maintenance: { color: '#a0b4ff', label: 'MNT', name: 'Maintenance' }
};

export function chartAvailable() {
  return typeof globalThis.Chart === 'function';
}

let configured = false;
function configure() {
  if (configured || !chartAvailable()) return;
  const C = globalThis.Chart;
  C.defaults.font.family = 'VT323, monospace';
  C.defaults.font.size = 17;
  C.defaults.color = '#e8eeff';
  C.defaults.borderColor = 'rgba(200, 215, 255, 0.18)';
  C.defaults.animation = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 300 };
  configured = true;
}

/** Shade the ideal range band behind the data. options.plugins.aquaRange = {min, max, axis}. */
const rangePlugin = {
  id: 'aquaRange',
  beforeDatasetsDraw(chart, _args, opts) {
    if (!opts || (opts.min === null && opts.max === null) || (opts.min === undefined && opts.max === undefined)) return;
    const scale = chart.scales[opts.axis || 'y'];
    if (!scale) return;
    const area = chart.chartArea;
    const top = typeof opts.max === 'number' ? scale.getPixelForValue(opts.max) : area.top;
    const bottom = typeof opts.min === 'number' ? scale.getPixelForValue(opts.min) : area.bottom;
    const y1 = Math.max(area.top, Math.min(top, bottom));
    const y2 = Math.min(area.bottom, Math.max(top, bottom));
    if (y2 <= y1) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = opts.color || 'rgba(60, 220, 120, 0.16)';
    ctx.fillRect(area.left, y1, area.right - area.left, y2 - y1);
    ctx.strokeStyle = 'rgba(60, 220, 120, 0.55)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (typeof opts.max === 'number' && top >= area.top && top <= area.bottom) { ctx.moveTo(area.left, top); ctx.lineTo(area.right, top); }
    if (typeof opts.min === 'number' && bottom >= area.top && bottom <= area.bottom) { ctx.moveTo(area.left, bottom); ctx.lineTo(area.right, bottom); }
    ctx.stroke();
    ctx.restore();
  }
};

/** Vertical dashed markers with short labels. options.plugins.aquaEvents = {events: [{t, kind}]}. */
const eventsPlugin = {
  id: 'aquaEvents',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.events || !opts.events.length) return;
    const x = chart.scales.x;
    const area = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = '15px VT323, monospace';
    ctx.textBaseline = 'top';
    let lastX = -Infinity;
    let row = 0;
    opts.events.forEach((ev) => {
      const px = x.getPixelForValue(ev.t);
      if (px < area.left || px > area.right) return;
      const style = MARKER_STYLES[ev.kind] || MARKER_STYLES.maintenance;
      ctx.strokeStyle = style.color;
      ctx.globalAlpha = 0.85;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, area.top);
      ctx.lineTo(px, area.bottom);
      ctx.stroke();
      row = px - lastX < 34 ? (row + 1) % 3 : 0;
      lastX = px;
      const label = style.label;
      const w = ctx.measureText(label).width + 6;
      const y = area.top + 2 + row * 16;
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      ctx.fillStyle = '#06123d';
      ctx.fillRect(px - w / 2, y, w, 15);
      ctx.fillStyle = style.color;
      ctx.fillText(label, px - w / 2 + 3, y);
    });
    ctx.restore();
  }
};

/** Points in display units with null breaks across unusually long gaps. */
export function buildPoints(series, def, gapMs) {
  const s = settings();
  const pts = [];
  for (let i = 0; i < series.length; i++) {
    const p = series[i];
    if (i > 0 && p.t - series[i - 1].t > gapMs) pts.push({ x: (p.t + series[i - 1].t) / 2, y: null });
    pts.push({ x: p.t, y: U.toDisplay(def, p.value, s), bdl: p.bdl, raw: p });
  }
  return pts;
}

function tickFormatter(spanMs) {
  return (value) => {
    const d = new Date(value);
    if (spanMs > 400 * D.MS_PER_DAY) return d.toLocaleDateString(undefined, { year: '2-digit', month: 'short' });
    if (spanMs < 3 * D.MS_PER_DAY) return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
}

/**
 * Create a line chart for one or two parameters.
 * @param {HTMLCanvasElement} canvas
 * @param {object} o {primary: {def, cfg, series}, secondary?: {def, series}, from, to, events}
 */
export function createTrendChart(canvas, o) {
  configure();
  const C = globalThis.Chart;
  const existing = C.getChart(canvas);
  if (existing) existing.destroy();
  const s = settings();
  const gap = (series) => S.gapThreshold(series);
  const swingTargets = new Set(S.swingsInSeries(o.primary.series, o.primary.cfg && o.primary.cfg.maxDelta).map((w) => w.toT));
  const primaryPts = buildPoints(o.primary.series, o.primary.def, gap(o.primary.series));
  const datasets = [{
    label: o.primary.def.name + ' (' + U.unitLabel(o.primary.def, s) + ')',
    data: primaryPts,
    yAxisID: 'y',
    borderColor: '#ffe14d',
    backgroundColor: '#ffe14d',
    borderWidth: 2,
    spanGaps: false,
    tension: 0,
    pointRadius: (ctx) => (ctx.raw && ctx.raw.raw && swingTargets.has(ctx.raw.raw.t) ? 6 : 4),
    pointStyle: (ctx) => (ctx.raw && ctx.raw.bdl ? 'triangle' : 'circle'),
    pointRotation: (ctx) => (ctx.raw && ctx.raw.bdl ? 180 : 0),
    pointBackgroundColor: (ctx) => (ctx.raw && ctx.raw.bdl ? 'transparent' : '#ffe14d'),
    pointBorderColor: (ctx) => (ctx.raw && ctx.raw.raw && swingTargets.has(ctx.raw.raw.t) ? '#ff5470' : '#ffe14d'),
    pointBorderWidth: (ctx) => (ctx.raw && ctx.raw.raw && swingTargets.has(ctx.raw.raw.t) ? 3 : 1.5)
  }];
  const scales = {
    x: {
      type: 'linear',
      min: o.from,
      max: o.to,
      ticks: { callback: tickFormatter(o.to - o.from), maxRotation: 0, autoSkipPadding: 18 },
      grid: { color: 'rgba(200,215,255,0.10)' }
    },
    y: {
      type: 'linear',
      position: 'left',
      title: { display: true, text: datasets[0].label, color: '#ffe14d' },
      ticks: { color: '#ffe14d' },
      grace: '10%'
    }
  };
  if (o.secondary) {
    const pts2 = buildPoints(o.secondary.series, o.secondary.def, gap(o.secondary.series));
    const label2 = o.secondary.def.name + ' (' + U.unitLabel(o.secondary.def, s) + ')';
    datasets.push({
      label: label2,
      data: pts2,
      yAxisID: 'y2',
      borderColor: '#5fe0ff',
      backgroundColor: '#5fe0ff',
      borderWidth: 2,
      borderDash: [6, 3],
      spanGaps: false,
      tension: 0,
      pointRadius: 4,
      pointStyle: (ctx) => (ctx.raw && ctx.raw.bdl ? 'triangle' : 'rectRot'),
      pointRotation: (ctx) => (ctx.raw && ctx.raw.bdl ? 180 : 0),
      pointBackgroundColor: (ctx) => (ctx.raw && ctx.raw.bdl ? 'transparent' : '#5fe0ff')
    });
    scales.y2 = {
      type: 'linear',
      position: 'right',
      title: { display: true, text: label2, color: '#5fe0ff' },
      ticks: { color: '#5fe0ff' },
      grid: { drawOnChartArea: false },
      grace: '10%'
    };
  }
  // Make sure the shaded ideal range is visible even when all data sits inside it.
  const cfg = o.primary.cfg;
  if (cfg) {
    if (typeof cfg.min === 'number') scales.y.suggestedMin = U.toDisplay(o.primary.def, cfg.min, s);
    if (typeof cfg.max === 'number') scales.y.suggestedMax = U.toDisplay(o.primary.def, cfg.max, s);
  }
  const defsByAxis = { y: o.primary.def, y2: o.secondary ? o.secondary.def : null };
  return new C(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      normalized: true,
      interaction: { mode: 'nearest', intersect: false },
      scales,
      plugins: {
        legend: { labels: { usePointStyle: true } },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? D.formatDateTime(items[0].parsed.x) : ''),
            label: (item) => {
              const raw = item.raw && item.raw.raw;
              const def = defsByAxis[item.dataset.yAxisID];
              if (!raw || !def) return '';
              return def.name + ': ' + U.formatReading(def, raw, s);
            }
          }
        },
        aquaRange: {
          min: cfg && typeof cfg.min === 'number' ? U.toDisplay(o.primary.def, cfg.min, s) : null,
          max: cfg && typeof cfg.max === 'number' ? U.toDisplay(o.primary.def, cfg.max, s) : null,
          axis: 'y'
        },
        aquaEvents: { events: (o.events || []).map((e) => ({ t: Date.parse(e.t), kind: e.kind })) }
      }
    },
    plugins: [rangePlugin, eventsPlugin]
  });
}

export const RANGES = [
  { value: '7d', label: '7D', days: 7 },
  { value: '30d', label: '30D', days: 30 },
  { value: '90d', label: '90D', days: 90 },
  { value: '1y', label: '1Y', days: 365 },
  { value: 'all', label: 'ALL', days: null }
];
