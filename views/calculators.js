/*
 * Calculators. All use the selected tank's total system volume and the
 * user's unit settings; product strengths are entered from the label.
 * Formulas: lib/calc.js (worked examples in README.md).
 */
import { h, replace, button, options, field, numberOrNull } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, tankById, defaultTankId, defById } from '../ui/state.js';
import { U, D, S, settings, tankSelect } from '../ui/widgets.js';

const Calc = globalThis.AquaCalc;
const TABS = [
  { id: 'volume', label: 'Tank volume' },
  { id: 'water', label: 'Water change' },
  { id: 'salt', label: 'Salt mix' },
  { id: 'dose', label: 'Dose' },
  { id: 'consumption', label: 'Consumption' },
  { id: 'convert', label: 'Unit converter' }
];

export default {
  id: 'calculators',
  title: 'Calculators',
  async mount(root, ctx) {
    const { signal } = ctx;
    let tab = (ctx.params && ctx.params.tab) || 'volume';
    let tankId = defaultTankId();
    const s = () => settings();
    const vl = () => U.volumeLabel(s());
    const tankSel = state.tanks.length ? tankSelect(tankId, (v) => { tankId = v; renderTab(); }, { signal, label: 'Tank' }) : null;
    const tabBar = h('div', { class: 'toggle-group tabs', role: 'tablist', 'aria-label': 'Calculator' });
    const panel = h('section', { class: 'panel', role: 'tabpanel', id: 'calc-panel' });
    replace(root, h('div', { class: 'panel controls-row' }, tankSel ? field('Tank (for system volume)', tankSel).wrap : h('p', null, 'Tip: create a tank to prefill its system volume.'), tabBar), panel);

    function renderTabs() {
      replace(tabBar, TABS.map((t) => h('button', {
        type: 'button', class: 'btn toggle', role: 'tab', id: 'tab-' + t.id, 'aria-selected': t.id === tab ? 'true' : 'false', 'aria-pressed': t.id === tab ? 'true' : 'false', 'aria-controls': 'calc-panel',
        onclick: () => { tab = t.id; renderTabs(); renderTab(); }, signal
      }, t.label)));
    }

    function systemDisplay() {
      const t = tankById(tankId);
      return t ? U.round(U.volumeToDisplay(t.totalVolumeL, s()), 1) : null;
    }

    function num(label, value, hint) {
      const input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', value: value === null || value === undefined ? '' : String(value) });
      return { input, wrap: field(label, input, hint).wrap, get: () => numberOrNull(input.value) };
    }

    function result(out) {
      return h('div', { class: 'calc-result', role: 'status', 'aria-live': 'polite' }, out);
    }

    /** Wire inputs so results update as the user types. */
    function live(inputs, compute, outEl) {
      const run = () => {
        try { replace(outEl, compute()); } catch (err) { replace(outEl, h('p', { class: 'muted' }, err.message)); }
      };
      inputs.forEach((i) => { i.input.addEventListener('input', run, { signal }); i.input.addEventListener('change', run, { signal }); });
      run();
    }

    const fmt = (v, d) => U.formatNumber(v, d === undefined ? 1 : d);
    const bad = (...vals) => vals.some((v) => v === null || Number.isNaN(v));

    function volumeTab() {
      const ll = U.lengthLabel(s());
      const t = tankById(tankId);
      const dims = t && t.dimensions ? t.dimensions : null;
      const len = num('Length (' + ll + ')', dims ? U.round(U.lengthToDisplay(dims.lengthCm, s()), 1) : null);
      const wid = num('Width (' + ll + ')', dims ? U.round(U.lengthToDisplay(dims.widthCm, s()), 1) : null);
      const hei = num('Height (' + ll + ')', dims ? U.round(U.lengthToDisplay(dims.heightCm, s()), 1) : null);
      const water = num('Water depth (' + ll + ')', null, 'Leave empty if filled to the top.');
      const sand = num('Substrate depth (' + ll + ')', null);
      const rock = num('Rock (' + (U.units(s()).volume === 'gal' ? 'lb' : 'kg') + ')', null);
      const out = result();
      const toCm = (v) => (v === null ? null : U.lengthFromDisplay(v, s()));
      const toKg = (v) => (v === null ? null : (U.units(s()).volume === 'gal' ? v * 0.45359237 : v));
      replace(panel, h('h2', null, 'Tank volume from dimensions'),
        h('div', { class: 'form-row' }, len.wrap, wid.wrap, hei.wrap),
        h('div', { class: 'form-row' }, water.wrap, sand.wrap, rock.wrap), out,
        h('p', { class: 'hint' }, 'Displacement estimate: a sand or gravel bed is about 40% water, so 60% of its volume displaces water; rock displaces its weight / 2.5 kg per litre.'));
      live([len, wid, hei, water, sand, rock], () => {
        if (bad(len.get(), wid.get(), hei.get())) return h('p', { class: 'muted' }, 'Enter length, width and height.');
        const r = Calc.tankVolume({ lengthCm: toCm(len.get()), widthCm: toCm(wid.get()), heightCm: toCm(hei.get()), waterDepthCm: toCm(water.get()), substrateDepthCm: toCm(sand.get()), rockKg: toKg(rock.get()) });
        const v = (l) => fmt(U.volumeToDisplay(l, s()), 1) + ' ' + vl();
        return [
          h('p', null, 'Glass volume: ', h('strong', null, v(r.grossL))),
          h('p', null, 'Water at that depth: ' + v(r.waterL)),
          h('p', null, 'Substrate displaces about ' + v(r.substrateL) + '; rock about ' + v(r.rockL) + '.'),
          h('p', { class: 'big-line' }, 'Estimated water volume: ' + v(r.netL)),
          h('p', { class: 'hint' }, 'Add the sump\'s running volume to get the total system volume for this tank.')
        ];
      }, out);
    }

    function waterTab() {
      const sys = num('Total system volume (' + vl() + ')', systemDisplay());
      const pct = num('Water change %', 20);
      const cur = num('Current nitrate (ppm)', null);
      const neu = num('Nitrate in new water (ppm)', 0);
      const count = num('Number of changes', 1);
      const target = num('Target nitrate (ppm)', null, 'Optional: % needed for a single change.');
      const out = result();
      replace(panel, h('h2', null, 'Water change'), h('div', { class: 'form-row' }, sys.wrap, pct.wrap, count.wrap), h('div', { class: 'form-row' }, cur.wrap, neu.wrap, target.wrap), out,
        h('p', { class: 'hint' }, 'Assumes complete mixing: after = new + (current - new) x (1 - %)^changes. Works the same for phosphate.'));
      live([sys, pct, cur, neu, count, target], () => {
        if (bad(sys.get(), pct.get())) return h('p', { class: 'muted' }, 'Enter system volume and percentage.');
        const sysL = U.volumeFromDisplay(sys.get(), s());
        const r = Calc.waterChange({ systemL: sysL, percent: pct.get(), current: cur.get() === null ? undefined : cur.get(), newWater: neu.get() || 0, changes: count.get() || 1 });
        const lines = [h('p', { class: 'big-line' }, 'Change ' + fmt(U.volumeToDisplay(r.volumeL, s()), 1) + ' ' + vl() + ' per water change')];
        if (r.after !== undefined) lines.push(h('p', null, 'Expected nitrate after ' + r.changes + ' change(s): ' + fmt(r.after, 1) + ' ppm'));
        if (cur.get() !== null && target.get() !== null) {
          try { lines.push(h('p', null, 'To reach ' + target.get() + ' ppm in one change: ' + fmt(Calc.percentForTarget({ current: cur.get(), target: target.get(), newWater: neu.get() || 0 }), 0) + '%')); } catch (e) { lines.push(h('p', { class: 'muted' }, e.message)); }
        }
        return lines;
      }, out);
    }

    function saltTab() {
      const vol = num('New water to mix (' + vl() + ')', null);
      const amt = num('Label: amount of salt', null, 'e.g. 0.5 (cups) or 38 (g)');
      const unit = h('input', { type: 'text', maxlength: 12, value: U.units(s()).volume === 'gal' ? 'cups' : 'g' });
      const per = num('...per volume of water (' + vl() + ')', 1);
      const out = result();
      replace(panel, h('h2', null, 'Salt mix'), h('div', { class: 'form-row' }, vol.wrap, amt.wrap, field('Salt unit', unit).wrap, per.wrap), out,
        h('p', { class: 'hint' }, 'Salt brands differ: always use the rate printed on your salt, then confirm with a refractometer or probe.'));
      live([vol, amt, per, { input: unit }], () => {
        if (bad(vol.get(), amt.get(), per.get())) return h('p', { class: 'muted' }, 'Enter the volume and the label rate.');
        const r = Calc.saltMix({ volume: vol.get(), rateAmount: amt.get(), ratePerVolume: per.get() });
        return h('p', { class: 'big-line' }, 'Add ' + fmt(r.amount, 2) + ' ' + (unit.value || '') + ' of salt to ' + fmt(vol.get(), 1) + ' ' + vl());
      }, out);
    }

    function paramChoices() {
      return state.defs.filter((d) => d.kind !== 'choice' && (['alk', 'calcium', 'magnesium', 'kh', 'gh', 'potassium', 'iron', 'nitrate', 'phosphate'].includes(d.id) || d.custom));
    }

    function doseTab() {
      const defs = paramChoices();
      const sel = h('select', null, options(defs.map((d) => ({ value: d.id, label: d.name })), 'alk'));
      const sys = num('Total system volume (' + vl() + ')', systemDisplay());
      const cur = num('Current value', null);
      const tgt = num('Target value', null);
      const pAmt = num('Label: product amount (ml)', null);
      const pRaise = num('...raises by (units)', null);
      const pVol = num('...in volume (' + vl() + ')', null);
      const maxDay = num('Max raise per day (optional)', null, 'e.g. 1 dKH/day for alkalinity');
      const out = result();
      const unitText = () => { const d = defById(sel.value); return d ? U.unitLabel(d, s()) : ''; };
      replace(panel, h('h2', null, 'Dose calculator'),
        h('div', { class: 'form-row' }, field('Parameter', sel).wrap, sys.wrap, cur.wrap, tgt.wrap),
        h('div', { class: 'form-row' }, pAmt.wrap, pRaise.wrap, pVol.wrap, maxDay.wrap), out,
        h('p', { class: 'hint' }, 'Enter the strength exactly as printed on the product ("X ml raises Y in Z volume"). AquaStar does not store product strengths.'));
      const run = [sys, cur, tgt, pAmt, pRaise, pVol, maxDay, { input: sel }];
      live(run, () => {
        if (bad(sys.get(), cur.get(), tgt.get(), pAmt.get(), pRaise.get(), pVol.get())) return h('p', { class: 'muted' }, 'Fill in system volume, current and target values and the label strength.');
        const r = Calc.dose({ current: cur.get(), target: tgt.get(), systemL: U.volumeFromDisplay(sys.get(), s()), productAmount: pAmt.get(), productRaise: pRaise.get(), productPerL: U.volumeFromDisplay(pVol.get(), s()), maxDailyRaise: maxDay.get() || undefined });
        if (r.note) return h('p', null, r.note);
        const lines = [h('p', { class: 'big-line' }, 'Total dose: ' + fmt(r.amount, 1) + ' ml to raise ' + fmt(r.diff, 2) + ' ' + unitText())];
        if (r.days > 1) lines.push(h('p', null, 'Spread over ' + r.days + ' days: ' + fmt(r.perDay, 1) + ' ml per day.'));
        return lines;
      }, out);
    }

    function consumptionTab() {
      const opts = state.defs.filter((d) => ['alk', 'calcium', 'magnesium'].includes(d.id));
      const sel = h('select', null, options(opts.map((d) => ({ value: d.id, label: d.name })), 'alk'));
      const days = num('Use tests from the last (days)', 14);
      const sys = num('Total system volume (' + vl() + ')', systemDisplay());
      const daily = num('Current daily dose (ml/day)', null, 'Prefilled from the dosing regimen when a matching product exists.');
      const pAmt = num('Label: product amount (ml)', null);
      const pRaise = num('...raises by (units)', null);
      const pVol = num('...in volume (' + vl() + ')', null);
      const out = result();
      replace(panel, h('h2', null, 'Consumption rate'),
        h('div', { class: 'form-row' }, field('Parameter', sel).wrap, days.wrap, sys.wrap),
        h('div', { class: 'form-row' }, daily.wrap, pAmt.wrap, pRaise.wrap, pVol.wrap), out,
        h('p', { class: 'hint' }, 'Consumption/day = rise from daily dosing - trend of your tests. The trend is a straight-line fit through the tests in the period.'));
      let entries = [];
      let doses = [];
      const prefill = () => {
        const cat = { alk: 'alk', calcium: 'calcium', magnesium: 'magnesium' }[sel.value];
        const reg = S.currentRegimen(doses).find((r) => r.category === cat);
        daily.input.value = reg && reg.unit === 'ml' ? String(reg.amount) : '';
      };
      const compute = () => {
        if (!tankId) return h('p', { class: 'muted' }, 'Choose a tank.');
        const def = defById(sel.value);
        const since = Date.now() - (days.get() || 14) * D.MS_PER_DAY;
        const series = S.seriesFor(entries, sel.value).filter((p) => !p.bdl && p.t >= since).map((p) => ({ t: p.t, value: U.toDisplay(def, p.value, s()) }));
        if (bad(sys.get())) return h('p', { class: 'muted' }, 'Enter the system volume.');
        const r = Calc.consumption({ series, systemL: U.volumeFromDisplay(sys.get(), s()), dailyDose: daily.get() || 0, productAmount: pAmt.get(), productRaise: pRaise.get(), productPerL: pVol.get() === null ? null : U.volumeFromDisplay(pVol.get(), s()) });
        const unit = U.unitLabel(def, s());
        const lines = [h('p', null, series.length + ' tests used. Trend: ' + (r.trendPerDay >= 0 ? '+' : '') + fmt(r.trendPerDay, 3) + ' ' + unit + '/day.')];
        if (r.note) lines.push(h('p', { class: 'muted' }, r.note));
        if (r.consumptionPerDay !== null && r.consumptionPerDay !== undefined) {
          lines.push(h('p', { class: 'big-line' }, 'Estimated consumption: ' + fmt(r.consumptionPerDay, 3) + ' ' + unit + '/day'));
          if (r.holdSteadyDose !== null) lines.push(h('p', null, 'Daily dose to hold steady: about ' + fmt(r.holdSteadyDose, 1) + ' ml/day of this product.'));
        }
        return lines;
      };
      const reload = async () => {
        if (!tankId) return;
        [entries, doses] = await Promise.all([req('entries:list', { tankId }), req('dosing:list', { tankId })]);
        prefill();
      };
      sel.addEventListener('change', prefill, { signal });
      reload().then(() => live([sel, days, sys, daily, pAmt, pRaise, pVol].map((x) => (x.input ? x : { input: x })), compute, out)).catch(() => replace(out, h('p', null, 'Test history could not be loaded.')));
    }

    function convertTab() {
      const rows = [
        { label: 'Temperature', units: [['°F', (v) => v, (v) => v], ['°C', U.fToC, U.cToF]], base: 'F' },
        { label: 'Volume', units: [['US gal', (v) => v, (v) => v], ['L', U.gallonsToLitres, U.litresToGallons]] },
        { label: 'Salinity (25 °C reference, approximate)', units: [['SG', (v) => v, (v) => v], ['ppt', U.sgToPpt, U.pptToSg]] },
        { label: 'Alkalinity', units: [['dKH', (v) => v, (v) => v], ['meq/L', U.dkhToMeq, U.meqToDkh], ['ppm CaCO3', U.dkhToPpm, U.ppmToDkh]] },
        { label: 'Length', units: [['in', (v) => v, (v) => v], ['cm', U.inchesToCm, U.cmToInches]] }
      ];
      const sections = rows.map((row) => {
        const inputs = row.units.map(([name]) => h('input', { type: 'text', inputmode: 'decimal', 'aria-label': row.label + ' in ' + name, class: 'num' }));
        inputs.forEach((input, i) => input.addEventListener('input', () => {
          const v = numberOrNull(input.value);
          if (v === null || Number.isNaN(v)) return;
          const base = row.units[i][2](v); // to first unit
          inputs.forEach((other, j) => { if (j !== i) other.value = U.formatNumber(row.units[j][1](base), row.label.startsWith('Salinity') && j === 0 ? 4 : 2); });
        }, { signal }));
        return h('div', { class: 'convert-row' }, h('h3', null, row.label), h('div', { class: 'inline' }, inputs.map((input, i) => h('span', { class: 'inline' }, input, ' ' + row.units[i][0] + (i < inputs.length - 1 ? ' = ' : '')))));
      });
      replace(panel, h('h2', null, 'Unit converter'), h('p', { class: 'hint' }, 'Type in any box.'), sections);
    }

    function renderTab() {
      ({ volume: volumeTab, water: waterTab, salt: saltTab, dose: doseTab, consumption: consumptionTab, convert: convertTab })[tab]();
    }

    renderTabs();
    renderTab();
    return {};
  }
};
