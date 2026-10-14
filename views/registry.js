/*
 * View registry: the screens, their navigation entries and optional hooks
 * the shell calls (upcoming maintenance for the dashboard, extra settings
 * sections, extra ticker items, startup checks).
 */
import dashboard from './dashboard.js';
import quickEntry from './quick-entry.js';
import charts from './charts.js';
import maintenance from './maintenance.js';
import dosing from './dosing.js';
import photos from './photos.js';
import tanks from './tanks.js';
import settings from './settings.js';

export const VIEWS = [dashboard, quickEntry, charts, maintenance, dosing, photos, tanks, settings];

export const NAV = [
  { id: 'dashboard', label: 'Current Conditions', shortcut: 'Ctrl+1' },
  { id: 'quick-entry', label: 'Log a Test', shortcut: 'Ctrl+T' },
  { id: 'charts', label: 'Trend Charts', shortcut: 'Ctrl+3' },
  { id: 'maintenance', label: 'Maintenance', shortcut: 'Ctrl+4' },
  { id: 'dosing', label: 'Dosing', shortcut: 'Ctrl+5' },
  { id: 'photos', label: 'Photos', shortcut: 'Ctrl+6' },
  { id: 'tanks', label: 'Tanks', shortcut: 'Ctrl+7' },
  { id: 'settings', label: 'Settings & Data', shortcut: 'Ctrl+,' }
];

// Collections available beyond Phase 1 (used to show optional fields).
export const FEATURES = new Set();

export const extensions = {
  upcomingMaintenance: null,
  settingsSections: [],
  tickerExtras: null,
  onStartup: null
};
