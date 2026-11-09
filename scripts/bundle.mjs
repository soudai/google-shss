// Builds the Apps Script files in memory. Used by the build, the local dev
// server and the UI tests, so all three run exactly what gets deployed.
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const path = file => fileURLToPath(new URL(`../${file}`, import.meta.url));
const read = file => readFile(path(file), 'utf8');
const bundle = (entry, options = {}) => build({entryPoints: [path(entry)], bundle: true, write: false, format: 'iife', target: 'es2019', legalComments: 'inline', ...options})
  .then(result => result.outputFiles[0].text);
// Inline text must not close the surrounding <script>.
const literal = text => JSON.stringify(text).replace(/</g, '\\u003c');

// Returns the HTML page with `/* BOOT */` where the boot JSON goes; the
// deployed page fills it with the template tag <?!= boot ?>.
export async function buildPage() {
  const [shell, css, bridge, app] = await Promise.all([read('web/index.html'), read('web/style.css'), read('web/bridge.js'), bundle('web/app.js')]);
  if (/<\/script/i.test(app) || /<\/style/i.test(css)) throw new Error('Invalid inline asset');
  return shell.replace('/* STYLE */', () => css).replace('/* BRIDGE */', () => literal(bridge)).replace('/* APP */', () => app);
}

// Returns {'Code.gs', 'Index.html', 'appsscript.json'} as strings.
export async function buildGas() {
  const [core, entryPoints, manifest, page] = await Promise.all([
    bundle('server/core.mjs', {globalName: 'SHSSCore'}), read('gas/Code.gs'), read('gas/appsscript.json'), buildPage()
  ]);
  // Keep the bundle and the GAS entry points in one file; no cross-file initialization order.
  return {'Code.gs': core + '\n' + entryPoints, 'Index.html': page.replace('/* BOOT */', '<?!= boot ?>'), 'appsscript.json': manifest};
}
