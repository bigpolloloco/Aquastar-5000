'use strict';
/*
 * Project lint with no third-party tools:
 *  - syntax check of every JS file (CommonJS and ES modules);
 *  - relative import/require paths must exist with EXACT casing (Linux rules);
 *  - no hardcoded absolute paths, no innerHTML-style sinks, no globalShortcut,
 *    no shell-string process spawning, no TODO/FIXME placeholders;
 *  - the sandboxed preload may only require('electron');
 *  - every dependency in package.json is pinned to an exact version.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const ESM_DIRS = ['views', 'ui'];
const ESM_FILES = new Set(['renderer.js']);
const problems = [];

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function isEsm(file) {
  const r = rel(file);
  return ESM_FILES.has(r) || ESM_DIRS.some((d) => r.startsWith(d + '/'));
}

/** True when every segment of `target` exists with exactly this casing. */
function existsExactCase(target) {
  const relPath = path.relative(ROOT, target);
  if (relPath.startsWith('..')) return fs.existsSync(target);
  let cur = ROOT;
  for (const seg of relPath.split(path.sep)) {
    if (!fs.existsSync(cur) || !fs.readdirSync(cur).includes(seg)) return false;
    cur = path.join(cur, seg);
  }
  return true;
}

const files = walk(ROOT, []);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquastar-lint-'));

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const r = rel(file);
  const lines = text.split(/\r?\n/);

  // 1. Syntax
  try {
    if (isEsm(file)) {
      const tmp = path.join(tmpDir, r.replace(/[\\/]/g, '__') + '.mjs');
      fs.writeFileSync(tmp, text);
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } else {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    }
  } catch (err) {
    problems.push(r + ': syntax error\n' + String(err.stderr || err.message).split('\n').slice(0, 6).join('\n'));
  }

  // 2. Relative import/require casing
  const specRe = /(?:require\(\s*|import\s+(?:[^'"]*?\s+from\s+)?|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  let m;
  while ((m = specRe.exec(text))) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (!existsExactCase(target)) problems.push(r + ': import "' + m[1] + '" does not exist with that exact casing');
  }

  // 3. Forbidden patterns (this file describes them, so it is exempt)
  if (r !== 'scripts/lint.js') lines.forEach((line, i) => {
    const where = r + ':' + (i + 1);
    const code = line.replace(/\/\/.*$/, '');
    if (/['"`](?:[A-Za-z]:\\\\|\/home\/|\/Users\/|\/root\/|\/tmp\/)/.test(code) && !r.startsWith('test/') && !r.startsWith('scripts/')) problems.push(where + ': hardcoded absolute path');
    if (/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(/.test(code)) problems.push(where + ': HTML injection sink (use textContent)');
    if (/globalShortcut/.test(code)) problems.push(where + ': globalShortcut is not allowed');
    if (/shell\s*:\s*true/.test(code) || /child_process['"]\)\.exec\(|\bexecSync\(/.test(code)) problems.push(where + ': shell-string process execution is not allowed');
    if (/\b(TODO|FIXME|XXX)\b/.test(line)) problems.push(where + ': placeholder comment');
  });

  // 4. Preload must stay self-contained
  if (r === 'preload.js') {
    const reqs = text.match(/require\(\s*['"][^'"]+['"]\s*\)/g) || [];
    reqs.forEach((x) => { if (!/require\(\s*['"]electron['"]\s*\)/.test(x)) problems.push(r + ': sandboxed preload may only require("electron"), found ' + x); });
  }
}

// 5. index.html and stylesheet references
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
(html.match(/(?:src|href)="([^"#:]+)"/g) || []).forEach((attr) => {
  const ref = attr.replace(/^(?:src|href)="/, '').replace(/"$/, '');
  if (ref.startsWith('vendor/')) return; // served from node_modules/chart.js by the app:// handler
  if (!existsExactCase(path.join(ROOT, ref))) problems.push('index.html: reference "' + ref + '" does not exist with that exact casing');
});
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
(css.match(/url\('([^']+)'\)/g) || []).forEach((u) => {
  const ref = u.slice(5, -2);
  if (!existsExactCase(path.join(ROOT, ref))) problems.push('styles.css: url "' + ref + '" does not exist with that exact casing');
});
if (/style\s*=\s*"/.test(html)) problems.push('index.html: inline style attribute (blocked by CSP)');

// 6. Exact dependency pins
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
['dependencies', 'devDependencies'].forEach((section) => {
  Object.entries(pkg[section] || {}).forEach(([name, version]) => {
    if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push('package.json: ' + section + '.' + name + ' must be pinned to an exact version (found "' + version + '")');
  });
});
if (pkg.dependencies && pkg.dependencies.electron) problems.push('package.json: electron must be a devDependency');

fs.rmSync(tmpDir, { recursive: true, force: true });

if (problems.length) {
  console.error(problems.join('\n'));
  console.error('\nlint: ' + problems.length + ' problem(s)');
  process.exit(1);
}
console.log('lint: ' + files.length + ' files OK');
