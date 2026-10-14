/*
 * "Current Conditions": one slide per tank, rotating WeatherStar style, with
 * pause and manual previous/next. Rotation pauses while the pointer is over
 * the slide or keyboard focus is inside it.
 */
import { h, replace, button } from '../ui/dom.js';
import { req } from '../ui/api.js';
import { state, tankDefs } from '../ui/state.js';
import { computeAlerts } from '../ui/alerts.js';
import { U, D, S, statusBadge, fmtReading, fmtVolume, settings, typeLabel, styleLabel, emptyState, maintenanceLabel, waterChangePercent } from '../ui/widgets.js';

export default {
  id: 'dashboard',
  title: 'Current Conditions',
  async mount(root, ctx) {
    const { signal } = ctx;
    let index = 0;
    let paused = !settings().dashboard.autoRotate;
    let hoverPause = false;
    let focusPause = false;
    let timer = null;
    let data = null;

    const slideHost = h('div', { class: 'slide-host', 'aria-live': 'off' });
    const counter = h('span', { class: 'slide-counter' });
    const pauseBtn = button('', () => { paused = !paused; renderControls(); schedule(); }, { attrs: { signal, 'aria-pressed': 'false' } });
    const prevBtn = button('< Prev', () => go(-1), { attrs: { signal, title: 'Previous tank' } });
    const nextBtn = button('Next >', () => go(1), { attrs: { signal, title: 'Next tank' } });
    const dots = h('div', { class: 'slide-dots', role: 'group', 'aria-label': 'Choose tank' });
    const controls = h('div', { class: 'slide-controls' }, prevBtn, pauseBtn, nextBtn, counter, dots);
    replace(root, h('section', { class: 'dashboard' }, controls, slideHost));

    slideHost.addEventListener('mouseenter', () => { hoverPause = true; schedule(); }, { signal });
    slideHost.addEventListener('mouseleave', () => { hoverPause = false; schedule(); }, { signal });
    root.addEventListener('focusin', (e) => { if (slideHost.contains(e.target)) { focusPause = true; schedule(); } }, { signal });
    root.addEventListener('focusout', (e) => { if (!slideHost.contains(e.relatedTarget)) { focusPause = false; schedule(); } }, { signal });
    // Arrow keys switch tanks while focus is on the controls.
    controls.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    }, { signal });

    function go(step) {
      if (!state.tanks.length) return;
      index = (index + step + state.tanks.length) % state.tanks.length;
      render(true);
      schedule();
    }

    function schedule() {
      if (timer) { ctx.clearTimer(timer); timer = null; }
      if (paused || hoverPause || focusPause || state.tanks.length < 2) return;
      const seconds = Math.max(5, settings().dashboard.rotateSeconds || 12);
      timer = ctx.setTimer(() => { timer = null; go(1); }, seconds * 1000);
    }

    function renderControls() {
      pauseBtn.textContent = paused ? 'Play' : 'Pause';
      pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
      pauseBtn.title = paused ? 'Resume automatic rotation' : 'Pause automatic rotation';
      const many = state.tanks.length > 1;
      [prevBtn, nextBtn, pauseBtn].forEach((b) => { b.disabled = !many; });
      counter.textContent = state.tanks.length ? 'Tank ' + (index + 1) + ' of ' + state.tanks.length : '';
      replace(dots, state.tanks.map((t, i) => h('button', {
        type: 'button', class: 'slide-dot' + (i === index ? ' active' : ''), 'aria-label': t.name, 'aria-current': i === index ? 'true' : 'false',
        onclick: () => { index = i; render(true); schedule(); }, signal
      })));
    }

    function render(animate) {
      renderControls();
      if (!state.tanks.length) {
        replace(slideHost, emptyState('No tanks yet', 'Create your first tank profile to start logging tests.',
          button('Create a tank', () => ctx.navigate('tanks', 'new'), { kind: 'primary', attrs: { signal } })));
        return;
      }
      if (index >= state.tanks.length) index = 0;
      const tank = state.tanks[index];
      const slide = buildSlide(tank);
      if (animate) slide.classList.add('slide-enter');
      replace(slideHost, slide);
    }

    function buildSlide(tank) {
      const s = settings();
      const entries = data.alerts.entriesByTank.get(tank.id) || [];
      const latest = S.latestByParam(entries);
      const defs = tankDefs(tank);
      const now = new Date();
      const tiles = defs.map((def) => {
        const cfg = tank.params[def.id];
        const reading = latest[def.id];
        const st = S.stability(entries, def.id, def, cfg, now);
        const status = reading ? S.rangeStatus(def, cfg, reading).level : 'NONE';
        const change = st.change && st.change.delta !== null ? S.formatDelta(def, st.change.delta, s) : null;
        return h('div', { class: 'tile tile-' + status.toLowerCase() + (st.change && st.change.flagged ? ' tile-swing' : '') },
          h('div', { class: 'tile-name' }, def.name),
          h('div', { class: 'tile-value' }, reading ? fmtReading(def, reading) : '--'),
          h('div', { class: 'tile-status' }, reading ? statusBadge(status) : h('span', { class: 'muted' }, 'not tested')),
          h('div', { class: 'tile-meta' },
            reading ? D.formatDaysAgo(D.daysSince(reading.takenAt, now)) : '',
            change ? h('span', { class: 'tile-change' + (st.change.flagged ? ' swing' : '') }, ' ' + change + (st.change.flagged ? ' SWING' : '')) : null,
            st.overdue.overdue ? h('span', { class: 'tile-overdue' }, ' OVERDUE') : null));
      });

      const maint = data.maintenance.filter((m) => m.tankId === tank.id);
      const lastWc = maint.find((m) => m.type === 'water_change');
      const wcDays = lastWc ? D.daysSince(lastWc.performedAt, now) : null;
      const wcPct = lastWc ? waterChangePercent(lastWc.volumeL, tank) : null;
      const overdue = data.alerts.byTank.get(tank.id).filter((a) => a.kind === 'overdue');
      const problems = data.alerts.byTank.get(tank.id).filter((a) => a.kind !== 'overdue');
      const recentMaint = maint.slice(0, 3);
      const upcoming = data.upcoming.filter((u) => u.tankId === tank.id).slice(0, 5);
      const regimen = S.currentRegimen ? S.currentRegimen(data.dosing.filter((d) => d.tankId === tank.id)) : [];

      return h('article', { class: 'slide panel', 'aria-label': 'Current conditions for ' + tank.name },
        h('header', { class: 'slide-header' },
          h('h2', { class: 'slide-title' }, tank.name),
          h('p', { class: 'slide-sub' }, typeLabel(tank.type) + ' / ' + styleLabel(tank.type, tank.style) + '  -  ' + fmtVolume(tank.totalVolumeL) + ' system')),
        defs.length ? h('div', { class: 'tile-grid' }, tiles) : h('p', null, 'No parameters enabled for this tank. Edit the tank to choose parameters.'),
        h('div', { class: 'slide-columns' },
          h('section', { class: 'subpanel' },
            h('h3', null, 'Water Change'),
            h('p', { class: 'big-line' }, lastWc ? D.formatDaysAgo(wcDays) : 'none logged'),
            lastWc ? h('p', { class: 'muted' }, U.formatVolume(lastWc.volumeL, s) + (wcPct !== null ? ' (' + U.formatNumber(wcPct, 0) + '% of system)' : '')) : null,
            regimen.length ? h('h3', null, 'Daily Dosing') : null,
            regimen.length ? h('ul', { class: 'plain-list' }, regimen.map((r) => h('li', null, r.product + ': ' + U.formatNumber(r.amount, 2).replace(/\.?0+$/, '') + ' ' + r.unit + '/day'))) : null),
          h('section', { class: 'subpanel' },
            h('h3', null, 'Alerts'),
            problems.length ? h('ul', { class: 'alert-list' }, problems.map((a) => h('li', null, statusBadge(a.level), ' ', a.message.replace(tank.name + ': ', '')))) : h('p', null, statusBadge('OK'), ' No range or stability alerts.'),
            h('h3', null, 'Overdue Tests'),
            overdue.length ? h('ul', { class: 'plain-list' }, overdue.map((a) => h('li', null, a.message.replace(tank.name + ': ', '')))) : h('p', null, 'None.')),
          h('section', { class: 'subpanel' },
            h('h3', null, 'Upcoming Maintenance'),
            upcoming.length
              ? h('ul', { class: 'plain-list' }, upcoming.map((u) => h('li', { class: u.overdue ? 'overdue' : '' }, u.label + ' - ' + u.when)))
              : h('p', { class: 'muted' }, data.upcomingNote || 'Nothing scheduled.'),
            h('h3', null, 'Recent Maintenance'),
            recentMaint.length ? h('ul', { class: 'plain-list' }, recentMaint.map((m) => h('li', null, maintenanceLabel(m) + ' - ' + D.formatDaysAgo(D.daysSince(m.performedAt, now))))) : h('p', { class: 'muted' }, 'None logged.'))));
    }

    async function load() {
      const [alerts, maintenance, dosing, upcoming] = await Promise.all([
        computeAlerts(),
        req('maintenance:list', {}),
        req('dosing:list', {}),
        ctx.upcomingMaintenance ? ctx.upcomingMaintenance() : Promise.resolve({ items: [], note: null })
      ]);
      data = { alerts, maintenance, dosing, upcoming: upcoming.items, upcomingNote: upcoming.note };
      const sel = ctx.params && ctx.params.tankId ? state.tanks.findIndex((t) => t.id === ctx.params.tankId) : -1;
      if (sel >= 0) index = sel;
      render(false);
      schedule();
    }

    try {
      await load();
    } catch (err) {
      replace(slideHost, emptyState('Current conditions unavailable', err.message || 'Data could not be loaded.'));
    }
    return {
      unmount() { if (timer) ctx.clearTimer(timer); },
      async onDataChanged() { try { await load(); } catch (e) { /* ticker already shows the error */ } }
    };
  }
};
