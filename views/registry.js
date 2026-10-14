/*
 * View registry: the screens, their navigation entries and the hooks the
 * shell calls (upcoming maintenance for the dashboard, extra settings
 * sections, ticker items, startup checks).
 */
import dashboard from './dashboard.js';
import quickEntry from './quick-entry.js';
import charts from './charts.js';
import maintenance from './maintenance.js';
import dosing from './dosing.js';
import photos from './photos.js';
import tanks from './tanks.js';
import settings from './settings.js';
import livestock from './livestock.js';
import treatments from './treatments.js';
import schedules from './schedules.js';
import equipment from './equipment.js';
import calculators from './calculators.js';
import cycling from './cycling.js';
import journal from './journal.js';
import expenses from './expenses.js';
import reports from './reports.js';
import { desktopSection, backupSection } from './settings-keeper.js';
import { req } from '../ui/api.js';

export const VIEWS = [dashboard, quickEntry, charts, maintenance, dosing, photos, tanks, settings,
  livestock, treatments, schedules, equipment, calculators, cycling, journal, expenses, reports];

export const NAV = [
  { group: 'Daily' },
  { id: 'dashboard', label: 'Current Conditions', shortcut: 'Ctrl+1' },
  { id: 'quick-entry', label: 'Log a Test', shortcut: 'Ctrl+T' },
  { id: 'charts', label: 'Trend Charts', shortcut: 'Ctrl+3' },
  { id: 'schedules', label: 'Reminders', shortcut: 'Ctrl+Shift+R', compact: true },
  { group: 'Logs' },
  { id: 'maintenance', label: 'Maintenance', shortcut: 'Ctrl+4' },
  { id: 'dosing', label: 'Dosing', shortcut: 'Ctrl+5' },
  { id: 'treatments', label: 'Treatments' },
  { id: 'journal', label: 'Journal' },
  { id: 'photos', label: 'Photos', shortcut: 'Ctrl+6' },
  { group: 'Keeper' },
  { id: 'livestock', label: 'Livestock', shortcut: 'Ctrl+Shift+L', compact: true },
  { id: 'equipment', label: 'Equipment' },
  { id: 'cycling', label: 'Cycling Mode' },
  { id: 'expenses', label: 'Expenses' },
  { group: 'Tools' },
  { id: 'calculators', label: 'Calculators', shortcut: 'Ctrl+Shift+C', compact: true },
  { id: 'reports', label: 'Reports' },
  { id: 'tanks', label: 'Tanks', shortcut: 'Ctrl+7' },
  { id: 'settings', label: 'Settings & Data', shortcut: 'Ctrl+,' }
];

// Collections available beyond Phase 1 (used to show optional fields).
export const FEATURES = new Set(['livestock', 'treatments', 'schedules', 'equipment', 'journal', 'expenses']);

export const extensions = {
  /** Upcoming / due maintenance for the dashboard. */
  async upcomingMaintenance() {
    const list = await req('reminders:list', null, { quiet: true });
    const items = list.filter((r) => r.kind === 'schedule' && r.dueIn <= 7).map((r) => ({
      tankId: r.tankId, label: r.title, when: r.when, overdue: r.state === 'overdue'
    }));
    return { items, note: 'Nothing due in the next 7 days.' };
  },
  settingsSections: [desktopSection, backupSection],
  /** Items appended to the ticker's idle summary; `announce` ones are pushed on startup. */
  async tickerExtras() {
    const list = await req('reminders:list', null, { quiet: true });
    return list.filter((r) => r.state !== 'upcoming' || r.kind === 'reagent').slice(0, 6).map((r) => ({ text: r.message, level: 'WARN', announce: false }));
  },
  /** On launch, show anything that came due or overdue while the app was closed. */
  async onStartup({ ticker }) {
    const list = await req('reminders:list', null, { quiet: true });
    const due = list.filter((r) => r.state !== 'upcoming' || (r.kind === 'reagent' && r.level === 'ALERT'));
    if (!due.length) return;
    const names = due.slice(0, 3).map((r) => r.message);
    ticker.warn(due.length + ' reminder' + (due.length === 1 ? '' : 's') + ' due or overdue: ' + names.join(' / ') + (due.length > 3 ? ' (see Reminders)' : ''));
  }
};
