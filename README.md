# AquaStar 5000

An offline, all-in-one aquarium keeping companion for freshwater, planted and reef tanks, styled after early-90s broadcast weather graphics: blue gradient panels, high-contrast pixel text and an amber scrolling ticker.

Log water tests in seconds, watch trends and stability, keep maintenance, dosing and photo history — all stored locally on your computer. Runs identically on **Windows** and **Linux**.

> Everything stays on your machine. AquaStar 5000 makes no network connections, has no accounts and no auto-update.

---

## Contents

- [Quick start](#quick-start)
- [Scripts](#scripts)
- [Building installers](#building-installers)
- [Where your data lives](#where-your-data-lives)
- [Using the app](#using-the-app)
- [Developer settings (.env)](#developer-settings-env)
- [Architecture](#architecture)
- [IPC contract](#ipc-contract)
- [Units and conversions](#units-and-conversions)
- [Troubleshooting](#troubleshooting)
- [Design decisions and assumptions](#design-decisions-and-assumptions)
- [Licenses](#licenses)

---

## Quick start

Requirements: [Node.js](https://nodejs.org/) 20 or newer (22 LTS recommended) and npm. No global packages are needed.

Run these as **separate commands** (Windows PowerShell 5.1 does not support `&&`):

```
npm ci
npm start
```

`npm ci` installs the exact versions from `package-lock.json` (Electron downloads its binary during install).

## Scripts

| Script | What it does |
|--------|--------------|
| `npm start` | Run the app. |
| `npm run dev` | Run with DevTools open and the Reload menu enabled (development only). |
| `npm test` | Run the unit tests with Node's built-in test runner (`node --test`). |
| `npm run lint` | Syntax-check every file and enforce project rules: exact-case imports, no absolute paths, no `innerHTML`, no `globalShortcut`, no shell-string process spawning, exact dependency pins. |
| `npm run build:win` | Build the Windows NSIS installer and portable `.exe` into `dist/`. |
| `npm run build:linux` | Build the Linux AppImage and `.deb` into `dist/`. |

## Building installers

Packages are built with `electron-builder` (pinned in `devDependencies`).

- Build each OS's packages **on that OS** (or in CI runners for each OS). Building Windows packages on Linux requires Wine, and `.deb` packages cannot be built on Windows.
- Windows: `npm run build:win` → `dist/AquaStar 5000 Setup 1.0.0.exe` (installer) and `dist/AquaStar 5000-1.0.0-portable.exe`.
- Linux: `npm run build:linux` → `dist/AquaStar 5000-1.0.0.AppImage` and `dist/aquastar-5000_1.0.0_amd64.deb`.
- Fonts, Chart.js, icons and all assets are bundled into the package and referenced by relative paths; nothing is fetched at runtime.
- The `.deb` maintainer comes from the `author` email in `package.json` — change it to your own before publishing.

## Where your data lives

All data is stored under Electron's `userData` folder, which is derived from the app name (`AquaStar 5000`). The name is fixed in `package.json` and must never change, or the data folder would silently move.

| OS | Data folder | Logs |
|----|-------------|------|
| Windows | `%APPDATA%\AquaStar 5000\` | `%APPDATA%\AquaStar 5000\logs\` |
| Linux | `~/.config/AquaStar 5000/` (or `$XDG_CONFIG_HOME/AquaStar 5000/`) | `~/.config/AquaStar 5000/logs/` |

Inside the data folder:

```text
data/            one JSON file per collection (tanks.json, entries.json, ...)
photos/<tankId>/ copied photos, named <uuid>.<ext>
backups/         automatic backups and the safety copy made before every import
logs/            main.log (+ rotated main.1.log, main.2.log ...)
```

Help ▸ **Open Data Folder** and Help ▸ **Open Log Folder** open these locations.

## Using the app

### Logging a test in under 30 seconds

1. Press **Ctrl+T** (File ▸ Log a Test). The last-used tank is preselected, the time is "now", and the cursor is already in the first parameter field.
2. Type a value, **Tab** to the next field, and so on. Empty fields are skipped.
3. Press **Enter** to save.

Next to each field you see the last reading and how long ago it was taken. Out-of-range values are flagged immediately (color **and** the words OK / WATCH / ALERT), and any range or stability alerts appear in the ticker after saving.

**Below detection:** type `<0.02` (the kit's detection limit) or `ND` (not detected). These readings are stored with a below-detection flag so a hobby kit's "0" is never treated as a true zero; charts draw them as hollow down-triangles.

### Main screens

| Screen | Shortcut | Purpose |
|--------|----------|---------|
| Current Conditions | Ctrl+1 | One slide per tank, rotating; pause / previous / next; latest values with status, days since water change, alerts, overdue tests, maintenance. |
| Log a Test | Ctrl+T / Ctrl+2 | Quick entry plus recent tests (edit, attach photo, delete). |
| Trend Charts | Ctrl+3 | Per-parameter charts (7D/30D/90D/1Y/ALL), shaded ideal range, event markers, overlay of a second parameter on its own axis, text summary and data table. |
| Maintenance | Ctrl+4 | Water changes (auto % of total system volume), filter media, skimmer, glass, gravel vac, pruning, top-off, salt mixing, equipment changes, custom types. |
| Dosing | Ctrl+5 | One-time doses and the current daily regimen with change history. |
| Photos | Ctrl+6 | Timeline per tank and side-by-side comparison of any two photos. |
| Tanks | Ctrl+7 | Tank profiles, style presets, per-parameter ranges, swing thresholds, test intervals; archive or permanently delete. |
| Settings & Data | Ctrl+, | Units, dashboard rotation, custom parameters, export/import, CSV. |

### Stability alerts

For every enabled parameter AquaStar checks:

- **Change between consecutive tests** against the tank's "max change" threshold (e.g. SPS alkalinity 0.3 dKH). The change and the time between tests are always shown. A per-day rate is only shown for tests at least 24 h apart, so a normal day/night pH swing measured hours apart is never scaled up. If the gap between tests is long (more than twice the test interval, or 7 days), the alert notes that swings in between would not show up.
- **Out of range**: OK inside the ideal range, WATCH slightly outside, ALERT further outside.
- **Overdue test** based on the per-parameter test interval.

### Export, import and CSV

- **Export all data** writes a folder (`AquaStar-5000-export-YYYYMMDD-HHMMSS/`) with `data.json` and every photo — no zip needed. Copy the folder to another machine and use **Import data**: you get a preview of what will be restored before anything is replaced, and your current data is backed up first.
- **CSV export** (tests, maintenance or dosing) produces UTF-8 with BOM, `\r\n` line endings and proper quoting, so it opens correctly in Excel and LibreOffice. Text cells beginning with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with `'` to prevent formula injection; numeric cells are untouched.
- **CSV import** reads files with `\n`, `\r\n` or `\r` line endings, comma/semicolon/tab separators, UTF-8 or Windows-1252, then lets you map columns to parameters (with units for temperature, salinity and alkalinity) and choose the date format.

## Developer settings (.env)

Copy `.env.example` to `.env`. It only holds developer settings; user preferences live in the app's Settings.

| Variable | Default | Meaning |
|----------|---------|---------|
| `LOG_LEVEL` | `INFO` | Minimum level written to the log: `INFO`, `WARN` or `ERROR`. |
| `OPEN_DEVTOOLS` | `false` | Open DevTools on start. Ignored in packaged builds (DevTools are disabled there). |

The `.env` path is resolved explicitly: the project root in development, the `userData` folder in a packaged build. A missing `.env` is fine.

## Architecture

```text
main.js              App lifecycle, single window, app:// protocol, security policy, menu, IPC wiring
preload.js           Sandboxed contextBridge API: call(channel, payload) / on(event, cb), whitelisted
renderer.js          UI shell: navigation, view lifecycle, ticker, global error handlers
index.html           Markup + Content-Security-Policy
styles.css           Theme (original artwork only)
lib/                 Node-side logic (unit-tested). Files marked * are also loaded by the renderer.
  units.js*          Unit conversion
  dates.js*          ISO UTC storage, local-calendar-day math (DST-safe)
  presets.js*        Built-in parameters, tank types, style presets
  stats.js*          Stability, range, overdue, regimen
  logger.js          Leveled logger with size rotation and path sanitizing
  storage.js         Atomic JSON writes, per-file write queue, corruption handling
  migrations.js      Schema versions and migration steps
  validate.js        Validation of every IPC payload
  service.js         Data operations behind the IPC handlers
  csv.js             CSV parse/write
  photos.js          Image signature checks, safe copying, path containment
  transfer.js        Folder export/import
  channels.js        The IPC channel list
ui/                  Renderer helpers (DOM, ticker, modal dialogs, charts, state)
views/               One module per screen
assets/fonts/        VT323 pixel font + OFL license
assets/icons/        App and tray icons (generated by scripts/make-icon.js)
test/                node --test suites and fixtures
scripts/             lint.js, make-icon.js
```

### Security model

- Every window uses `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The renderer has no Node APIs; `window.aqua` exposes exactly two functions.
- The UI is served from a privileged `app://aquastar/` scheme via `protocol.handle`. Only an allow-list of UI files, Chart.js and validated photo paths is served; every path is resolved and checked for containment (no `..` traversal).
- Strict CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; object-src 'none'` (sent as a header too).
- All `http(s)`, `ws(s)`, `ftp` and `file` requests are cancelled; navigation and new windows are blocked; all permission requests are denied.
- Every IPC handler checks that the sender is the app's own top-level `app://aquastar` frame, validates the payload (type, length, range; unknown fields dropped), and returns `{ok, data}` or `{ok:false, error}` — no exception crosses the boundary.
- The renderer never sends file paths. File pickers are opened by the main process (`dialog.showOpenDialog` / `showSaveDialog`), and imports use short-lived tokens.
- Photos are accepted by magic bytes (PNG, JPEG, WebP, GIF; 25 MB max), copied to `photos/<tankId>/<uuid>.<ext>`; user file names are never used in paths.
- User text is rendered with `textContent` only (enforced by `npm run lint`).
- Logs never contain the home folder, the data folder path, the OS user name, photo data or environment values.

### Data layer

- JSON files under `userData/data/`, one per collection: `tanks`, `parameters` (custom definitions; built-ins live in code), `entries`, `maintenance`, `dosing`, `photos`, `settings`.
- Every record has `id` (`crypto.randomUUID()`), `createdAt` and `updatedAt`. Every file has a `schemaVersion`; `lib/migrations.js` upgrades older data in steps.
- Writes are atomic (temp file in the same folder → fsync → rename) and the rename is retried on `EPERM`/`EBUSY`/`EACCES`, which Windows antivirus and indexers cause.
- Writes are serialized per file; a mutation only becomes visible once it is on disk.
- A file that cannot be parsed is left untouched, the ticker reports it, and the app offers to start fresh for that file (the damaged file is kept as `<name>.corrupt-<timestamp>.json`).
- Timestamps are stored as ISO 8601 UTC and displayed in local time. "Days since" and due dates count local calendar days, so daylight saving changes cannot shift them.

## IPC contract

All channels are `renderer → main` invokes returning `{ok, data?, error?}` unless noted. The same table is in `lib/channels.js`.

| Channel | Payload | Returns (`data`) |
|---------|---------|------------------|
| `app:info` | none | version, schema version, damaged stores, data folder |
| `app:resetStore` | `{name}` | `true` (damaged file moved aside) |
| `settings:get` | none | `Settings` |
| `settings:save` | partial `Settings` | `Settings` |
| `parameters:list` | none | `ParameterDef[]` (built-in + custom) |
| `parameters:save` | custom parameter | `ParameterDef` |
| `parameters:delete` | `{id}` | `{ok}` |
| `tanks:list` | `{includeArchived?}` | `Tank[]` |
| `tanks:get` | `{id}` | `Tank` |
| `tanks:save` | `Tank` | `Tank` |
| `tanks:delete` | `{id, confirmName}` | `{ok}` |
| `entries:list` | `{tankId?, from?, to?}` | `Entry[]` (newest first) |
| `entries:get` | `{id}` | `Entry` |
| `entries:save` | `Entry` | `Entry` |
| `entries:delete` | `{id}` | `{ok}` |
| `maintenance:list` / `:get` / `:save` / `:delete` | as entries | `Maintenance` |
| `dosing:list` / `:get` / `:save` / `:delete` | as entries | `Dose` |
| `photos:list` | `{tankId?, ownerType?, ownerId?}` | `Photo[]` with `app://` URL |
| `photos:get` | `{id}` | `Photo` + `{url, exists}` |
| `photos:add` | `{tankId, ownerType, ownerId?}` — main opens the picker | `{added: Photo[], errors: string[]}` |
| `photos:save` | `{id, caption, takenAt?}` | `Photo` |
| `photos:delete` | `{id}` | `{ok}` |
| `stats:stability` | `{tankId, parameterId}` | stability report (change, per-day rate, gap note, range, overdue) |
| `stats:events` | `{tankId, from?, to?}` | chart markers |
| `data:export` | none — main opens a folder picker | `{message}` |
| `data:import` | none — main opens a folder picker | preview + `token` |
| `data:importConfirm` | `{token}` | `{message}` |
| `data:importCancel` | `{token}` | `true` |
| `csv:export` | `{kind, tankId?}` — main opens a save dialog | `{message}` |
| `csv:import` | none — main opens a file picker | headers, sample rows, `token` |
| `csv:importCommit` | `{token, tankId, dateColumn, timeColumn, dateFormat, methodColumn, noteColumn, columns[]}` | `{imported, skipped, problems}` |
| `log:write` | `{level, message}` | `true` |

Events (main → renderer): `menu:navigate {view, action?}`, `app:ticker {level, text}`.

## Units and conversions

Values are stored in one canonical unit and converted for display, so switching units never changes stored data.

| Quantity | Stored as | Display options |
|----------|-----------|-----------------|
| Temperature | °C | °F, °C |
| Volume | litres | US gallons, litres (length follows: inches or cm) |
| Salinity | specific gravity (25/25) | SG, ppt (approximate) |
| Alkalinity / KH | dKH | dKH, meq/L, ppm CaCO₃ |
| Currency | number as entered | symbol/format from the chosen currency (no exchange rates) |

Formulas: °F = °C × 9/5 + 32 · 1 US gal = 3.785411784 L · 1 meq/L = 2.8 dKH · 1 dKH = 17.848 ppm CaCO₃.

**Salinity:** SG ↔ ppt depends on temperature. AquaStar uses a reference table at 25 °C generated from the UNESCO EOS-80 equation of state (`lib/units.js`), interpolated linearly, and marks converted values with `~` / "approx.". Examples: 35 ppt ≈ 1.0264 SG; 1.025 SG ≈ 33.2 ppt; 1.026 SG ≈ 34.5 ppt.

## Troubleshooting

**AppImage does not start on newer Ubuntu.** AppImages need FUSE 2. Install it: Ubuntu 22.04: `sudo apt install libfuse2`; Ubuntu 24.04 and newer: `sudo apt install libfuse2t64` (the package name varies by release). Alternatively install the `.deb`.

**"The SUID sandbox helper binary was found, but is not configured correctly" / sandbox errors on Linux.** Ubuntu 24.04+ restricts unprivileged user namespaces through AppArmor, which Chromium's sandbox uses. Do **not** run with `--no-sandbox` as a habit. Fixes, in order of preference:
- Install the `.deb` package: the installed `chrome-sandbox` helper gets the right owner and permissions.
- For an AppImage or an unpacked build, add an AppArmor profile that allows user namespaces for the binary, e.g. `/etc/apparmor.d/aquastar-5000`:
  ```
  abi <abi/4.0>,
  include <tunables/global>
  profile aquastar-5000 /path/to/AquaStar*.AppImage flags=(unconfined) {
    userns,
  }
  ```
  then `sudo apparmor_parser -r /etc/apparmor.d/aquastar-5000`.
- For an unpacked build directory you can instead make the helper SUID: `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`.

**Windows SmartScreen warns about an unrecognized app.** Builds are not code-signed. Click **More info ▸ Run anyway**, or sign the installer with your own code-signing certificate (configure `win.certificateFile` / `CSC_LINK` for electron-builder).

**The tray icon is missing on GNOME.** Stock GNOME Shell does not show tray icons. Install the "AppIndicator and KStatusNotifierItem Support" extension (preinstalled on Ubuntu).

**A data file is damaged.** The app still starts, reports the damaged file in the ticker and offers "Start fresh" for it; the damaged file is kept next to the others as `.corrupt-<timestamp>.json`. You can also restore an export or backup via Settings ▸ Import data.

**Text looks blurry at 125 % / 150 % scaling.** The pixel font (VT323) is drawn as outlines, so it stays sharp at fractional scaling. Use View ▸ Zoom In/Out (Ctrl + / Ctrl −) to adjust the size.

## Design decisions and assumptions

- **Name:** the product is **AquaStar 5000** (`name: aquastar-5000`, `productName: AquaStar 5000`). It must not change later because `userData` is derived from it.
- **Platform risks considered before writing code:** hardcoded paths and path separators; case-insensitive file systems hiding import typos; `\r\n` vs `\n` in CSV; Windows file locks during atomic rename; two instances corrupting the JSON files; daylight saving changes breaking "days since"; fonts differing per OS; GTK file dialog filters being case-sensitive (`.JPG`); Windows-1252 CSV exports from Excel; windows reopening on a disconnected monitor; AppArmor/FUSE on newer Ubuntu.
- **Storage:** JSON files in the main process (the recommended option) — one place for I/O, simple backups, easy to inspect.
- **No date adapter:** charts use a linear x-axis with millisecond timestamps and custom tick labels.
- **Custom parameter ranges** are stored per tank; the definition carries defaults used when enabling it on a tank.
- **Built-in parameters** live in code (`lib/presets.js`), custom ones in `parameters.json`.
- **CO₂** is offered both as a ppm value and as a drop-checker color (blue / green / lime / yellow) with a status per color.
- **Currency** is display-only; amounts are stored as entered with no conversion.
- **Photos of deleted records** (tests, maintenance) stay as tank photos instead of being deleted; deleting a tank removes its photos.
- **Exports** are not encrypted; treat them like any other personal file.

## Licenses

- AquaStar 5000 source: MIT.
- VT323 font © The VT323 Project Authors, SIL Open Font License 1.1 — `assets/fonts/VT323-OFL.txt`.
- Chart.js © Chart.js contributors, MIT — bundled from `node_modules/chart.js`.
- All artwork (logo, icons, placeholder) is original. AquaStar 5000 is not affiliated with The Weather Channel; no logos, artwork or fonts from WeatherStar products are used.
