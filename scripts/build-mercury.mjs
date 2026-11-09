import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const directory = path.join(root, 'vendor/mercury');
const provenance = JSON.parse(readFileSync(path.join(directory, 'provenance.json')));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
for (const [file, expected] of Object.entries(provenance.files)) {
  if (hash(path.join(directory, file)) !== expected) throw Error(`Mercury upstream source changed: ${file}`);
}
// These are the original package's browser mappings, plus Node's URL polyfill.
// No dependency is disabled: all executable inputs remain in the build graph.
const result = await build({
  absWorkingDir: root, entryPoints: ['vendor/mercury/mercury.cjs'],
  outfile: 'vendor/mercury/mercury.browser.js', bundle: true, platform: 'browser',
  format: 'iife', globalName: 'Mercury', minify: true, metafile: true,
  alias: {
    url: require.resolve('url/'),
    cheerio: path.join(directory, 'shims/cheerio-query.js'),
    'iconv-lite': path.join(directory, 'shims/iconv-lite.js'),
    'postman-request': path.join(directory, 'browser-request/index.cjs'),
    'moment-timezone': require.resolve('moment-timezone/builds/moment-timezone-with-data-2012-2022.min.js'),
  },
});
const components = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (input.startsWith('(disabled):')) continue; // Browser field's non-executable built-in, retained in metafile.
  const file = path.resolve(root, input);
  let folder = path.dirname(file);
  while (!existsSync(path.join(folder, 'package.json')) && folder !== path.dirname(folder)) folder = path.dirname(folder);
  let pkg = JSON.parse(readFileSync(path.join(folder, 'package.json')));
  if (file.startsWith(directory + path.sep) && !file.includes('/browser-request/')) { pkg = provenance; folder = directory; }
  const key = `${pkg.name}@${pkg.version}`;
  const component = components.get(key) || {
    name: pkg.name, version: pkg.version, author: pkg.author || null,
    license: pkg.name === 'browser-request' ? 'Apache-2.0' : pkg.license || pkg.licenses || null,
    licenseFiles: readdirSync(folder).filter(name => /license|copying|notice/i.test(name) || (['difflib', 'string-direction'].includes(pkg.name) && /^readme\.md$/i.test(name))).map(name => path.relative(root, path.join(folder, name))),
    inputs: [],
  };
  component.inputs.push({ file: path.relative(root, file), sha256: hash(file) });
  components.set(key, component);
}
const sorted = [...components.values()].sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(path.join(directory, 'build-metafile.json'), JSON.stringify(result.metafile, null, 2) + '\n');
writeFileSync(path.join(directory, 'components.json'), JSON.stringify({ source: provenance, components: sorted }, null, 2) + '\n');
writeFileSync(path.join(directory, 'bom.cdx.json'), JSON.stringify({
  bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
  components: sorted.map(component => ({
    type: 'library', name: component.name, version: component.version,
    purl: `pkg:npm/${component.name.replace('@', '%40')}@${component.version}`,
    licenses: component.license ? [{ license: { name: typeof component.license === 'string' ? component.license : JSON.stringify(component.license) } }] : [],
    properties: component.inputs.map(input => ({ name: `source-sha256:${input.file}`, value: input.sha256 })),
  })),
}, null, 2) + '\n');
const notices = sorted.map(component => [
  component.name + '@' + component.version,
  'Declared license: ' + JSON.stringify(component.license),
  'Author: ' + JSON.stringify(component.author),
  ...component.licenseFiles.map(file => readFileSync(path.join(root, file), 'utf8')),
].join('\n\n')).join('\n\n' + '='.repeat(72) + '\n\n');
mkdirSync(path.join(root, 'public/mercury'), { recursive: true });
writeFileSync(path.join(root, 'public/mercury/THIRD_PARTY_NOTICES.txt'), notices + '\n');
console.log(`Mercury browser build: ${sorted.length} inventoried components; ${Object.keys(result.metafile.inputs).length} inputs`);
