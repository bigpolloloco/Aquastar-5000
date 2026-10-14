'use strict';
/*
 * "Start at login" on Linux: app.setLoginItemSettings only works on Windows
 * and macOS, so on Linux we write an XDG autostart .desktop file to
 * $XDG_CONFIG_HOME/autostart (usually ~/.config/autostart).
 */
const fsp = require('fs').promises;
const path = require('path');
const { writeFileAtomic } = require('./storage.js');

const FILE_NAME = 'aquastar-5000.desktop';

/**
 * Quote one Exec argument per the Desktop Entry spec: reserved characters
 * force double quotes; inside quotes ", `, $ and \ are backslash-escaped, then
 * the general string escaping doubles every backslash. % becomes %%.
 */
function quoteExecArg(arg) {
  let s = String(arg).replace(/%/g, '%%');
  if (/[\s"'\\><~|&;$*?#()`]/.test(s)) s = '"' + s.replace(/(["`$\\])/g, '\\$1') + '"';
  return s.replace(/\\/g, '\\\\');
}

function desktopEntry(o) {
  const exec = [o.exec].concat(o.args || []).map(quoteExecArg).join(' ');
  const clean = (v) => String(v || '').replace(/[\r\n]+/g, ' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=' + clean(o.name),
    'Comment=' + clean(o.comment),
    'Exec=' + exec,
    o.icon ? 'Icon=' + clean(o.icon) : null,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].filter((l) => l !== null).join('\n');
}

async function setLinuxAutostart(enabled, o) {
  const dir = path.join(o.configDir, 'autostart');
  const file = path.join(dir, FILE_NAME);
  if (!enabled) {
    try { await fsp.unlink(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    return false;
  }
  await fsp.mkdir(dir, { recursive: true });
  await writeFileAtomic(file, desktopEntry(o));
  return true;
}

module.exports = { quoteExecArg, desktopEntry, setLinuxAutostart, FILE_NAME };
