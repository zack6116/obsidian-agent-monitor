const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const dashboard = fs.readFileSync(path.join(root, 'src/dashboard.js'), 'utf8');
const start = dashboard.indexOf('function () {') + 'function () {'.length;
const end = dashboard.lastIndexOf('\n});');
if (start < 15 || end < start) throw new Error('Unsupported dashboard wrapper');
const source = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const marker = "const { Dashboard, sessionAction } = require('./dashboard');";
if (!source.includes(marker)) throw new Error('Missing local module marker');
const monitor = fs.readFileSync(path.join(root, 'src/monitor.py'), 'utf8');
const bundled = source.replace(marker, 'const { Dashboard, sessionAction } = (() => {' + dashboard.slice(start, end) + '\n})();')
  .replace("const PYTHON_MONITOR = '';", 'const PYTHON_MONITOR = ' + JSON.stringify(monitor) + ';');
fs.writeFileSync(path.join(root, 'main.js'), bundled);
console.log('Built main.js with embedded dashboard and Python detector.');
