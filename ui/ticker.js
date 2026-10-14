/*
 * Amber ticker bar: one scrolling line at the bottom of the window for status,
 * warnings and errors.
 *  - Messages are queued by severity (ERROR > WARN > INFO), FIFO within a level.
 *  - INFO auto-dismisses, WARN stays longer, ERROR stays until acknowledged or
 *    replaced by a newer ERROR.
 *  - Screen readers: messages are announced through aria-live regions
 *    (polite for INFO/WARN, assertive for ERROR); the moving copy is hidden
 *    from assistive tech to avoid double announcements.
 *  - prefers-reduced-motion: static, wrapped text instead of scrolling.
 */
import { h, replace } from './dom.js';

const ORDER = { ERROR: 3, WARN: 2, INFO: 1 };
const SPEED_PX_PER_S = 110;
const MIN_SHOW_MS = { INFO: 7000, WARN: 15000 };
const MAX_HISTORY = 60;
const MIN_VISIBLE_MS = { INFO: 3000, WARN: 5000 };
const STALE_INFO_MS = 20000;

export class Ticker {
  constructor(root) {
    this.root = root;
    this.queue = [];
    this.current = null;
    this.idleText = '';
    this.history = [];
    this.timer = null;
    this.listeners = [];

    this.badge = h('span', { class: 'ticker-badge', 'aria-hidden': 'true' });
    this.track = h('span', { class: 'ticker-text', 'aria-hidden': 'true' });
    this.viewport = h('div', { class: 'ticker-viewport' }, this.track);
    this.count = h('span', { class: 'ticker-count', 'aria-hidden': 'true' });
    this.dismissBtn = h('button', { type: 'button', class: 'ticker-btn', hidden: true, title: 'Acknowledge this message' }, 'OK');
    this.historyBtn = h('button', { type: 'button', class: 'ticker-btn', title: 'Show recent messages' }, 'Messages');
    this.livePolite = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    this.liveAssertive = h('div', { class: 'sr-only', role: 'alert', 'aria-live': 'assertive', 'aria-atomic': 'true' });
    replace(root, this.badge, this.viewport, this.count, this.dismissBtn, this.historyBtn, this.livePolite, this.liveAssertive);

    this.onDismiss = () => this.ack();
    this.dismissBtn.addEventListener('click', this.onDismiss);
    this.onHistory = () => { if (this.historyHandler) this.historyHandler(this.history.slice().reverse()); };
    this.historyBtn.addEventListener('click', this.onHistory);

    this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.onMotion = () => this.render();
    this.motionQuery.addEventListener('change', this.onMotion);
    this.onResize = () => this.layout();
    window.addEventListener('resize', this.onResize);
    this.render();
  }

  setHistoryHandler(fn) { this.historyHandler = fn; }

  info(text) { this.push('INFO', text); }
  warn(text) { this.push('WARN', text); }
  error(text) { this.push('ERROR', text); }

  push(level, text) {
    const lvl = ORDER[level] ? level : 'INFO';
    const msg = { level: lvl, text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600), at: new Date() };
    if (!msg.text) return;
    if (this.current && this.current.text === msg.text && this.current.level === msg.level) return;
    if (this.queue.some((m) => m.text === msg.text && m.level === msg.level)) return;
    this.history.push(msg);
    if (this.history.length > MAX_HISTORY) this.history.shift();

    if (!this.current || msg.level === 'ERROR') {
      // Errors show at once and replace whatever is showing (an older error included).
      this.show(msg);
      return;
    }
    if (this.current.level === 'INFO' && msg.level === 'INFO') {
      // A newer status line replaces an older one (it stays in the history).
      this.show(msg);
      return;
    }
    this.queue.push(msg);
    this.queue.sort((a, b) => ORDER[b.level] - ORDER[a.level] || a.at - b.at);
    this.renderCount();
    this.reschedule();
  }

  /**
   * While something is waiting, the current INFO/WARN only keeps the ticker
   * for a short guaranteed time, so newer messages are never held back long.
   * Errors stay until acknowledged or replaced.
   */
  reschedule() {
    if (!this.current || this.current.level === 'ERROR') return;
    const full = Math.max(MIN_SHOW_MS[this.current.level], this.scrollMs * (this.current.level === 'WARN' ? 2 : 1));
    const duration = this.queue.length ? Math.min(full, MIN_VISIBLE_MS[this.current.level]) : full;
    const left = Math.max(0, duration - (Date.now() - this.shownAt));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.next(), left);
  }

  /** Text shown when no message is queued (e.g. a summary of active alerts). */
  setIdle(text) {
    this.idleText = String(text || '');
    if (!this.current) this.render();
  }

  ack() {
    this.next();
  }

  next() {
    clearTimeout(this.timer);
    this.timer = null;
    // Status lines that waited too long are stale; they remain in the history.
    const now = Date.now();
    this.queue = this.queue.filter((m) => m.level !== 'INFO' || now - m.at.getTime() < STALE_INFO_MS);
    const msg = this.queue.shift() || null;
    if (msg) this.show(msg);
    else { this.current = null; this.render(); }
  }

  show(msg) {
    clearTimeout(this.timer);
    this.timer = null;
    this.current = msg;
    const prefix = msg.level === 'ERROR' ? 'Error: ' : msg.level === 'WARN' ? 'Warning: ' : '';
    const region = msg.level === 'ERROR' ? this.liveAssertive : this.livePolite;
    // Clear then set so repeated identical text is announced again.
    region.textContent = '';
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => { region.textContent = prefix + msg.text; }, 50);
    this.render();
    this.shownAt = Date.now();
    this.reschedule();
  }

  render() {
    const msg = this.current;
    const level = msg ? msg.level : 'IDLE';
    this.root.dataset.level = level;
    this.badge.textContent = msg ? (msg.level === 'ERROR' ? 'ERROR' : msg.level === 'WARN' ? 'WARNING' : 'INFO') : 'STATUS';
    this.track.textContent = msg ? msg.text : (this.idleText || 'AquaStar 5000 - all systems normal');
    this.dismissBtn.hidden = !msg;
    this.dismissBtn.textContent = msg && msg.level === 'ERROR' ? 'Acknowledge' : 'Dismiss';
    this.renderCount();
    this.layout();
  }

  renderCount() {
    this.count.textContent = this.queue.length ? '+' + this.queue.length + ' more' : '';
  }

  layout() {
    const reduced = this.motionQuery.matches;
    const vw = this.viewport.clientWidth || 600;
    this.track.classList.remove('scrolling');
    this.root.classList.toggle('static', reduced);
    const tw = this.track.scrollWidth;
    this.scrollMs = ((vw + tw) / SPEED_PX_PER_S) * 1000;
    if (reduced || tw <= vw) return;
    this.track.style.setProperty('--ticker-from', vw + 'px');
    this.track.style.setProperty('--ticker-to', -tw + 'px');
    this.track.style.setProperty('--ticker-duration', (this.scrollMs / 1000).toFixed(2) + 's');
    // Force a reflow so the animation restarts for the new text.
    void this.track.offsetWidth;
    this.track.classList.add('scrolling');
  }

  destroy() {
    clearTimeout(this.timer);
    clearTimeout(this.announceTimer);
    this.dismissBtn.removeEventListener('click', this.onDismiss);
    this.historyBtn.removeEventListener('click', this.onHistory);
    this.motionQuery.removeEventListener('change', this.onMotion);
    window.removeEventListener('resize', this.onResize);
  }
}
