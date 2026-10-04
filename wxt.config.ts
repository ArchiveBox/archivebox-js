import { defineConfig } from 'wxt';
import { version } from './package.json';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {browserAssets,pythonRuntimeRevision} from './scripts/browser-assets';
import {browsertrixSource} from './scripts/browsertrix';

// The studio needs filenames, not executable hooks. Only hook-worker imports
// hook modules, so Vite does not emit a second copy for the studio bundle.
const pluginRoot = fileURLToPath(new URL('./abx-plugins/abx_plugins/plugins/', import.meta.url));
const hookPaths = readdirSync(pluginRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(({ name }) => {
  const browser = path.join(pluginRoot, name, 'browser');
  return existsSync(browser) ? readdirSync(browser).filter(file => /^on_.*\.ts$/.test(file))
    .map(file => `../../abx-plugins/abx_plugins/plugins/${name}/browser/${file}`) : [];
});
export default defineConfig({
  modules: ['@wxt-dev/module-react'], manifestVersion: 3,
  manifest: {
    name: 'ArchiveBox JS', version,
    description: 'Capture with numbered plugin hooks. Keep one portable WACZ.',
    permissions: ['storage', 'unlimitedStorage', 'tabs', 'debugger', 'downloads', 'declarativeNetRequestWithHostAccess'],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Capture with ArchiveBox JS' },
    icons: { 16: '/icon/16.png', 48: '/icon/48.png', 128: '/icon/128.png' },
    sandbox: {pages:['ytdlp-sandbox/index.html','ocr-sandbox.html','python-sandbox.html']},
    web_accessible_resources:[{resources:['assets/*','chunks/*','ocr/*','pyodide/*','gallery-dl/*','forum-dl/*','papers-dl/*','ytdlp/*'],matches:['<all_urls>']}],
    content_security_policy: { sandbox: "sandbox allow-scripts; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; child-src 'self';", extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
  },
  vite: () => ({ plugins:[browsertrixSource()],resolve:{conditions:['onnxruntime-web-use-extern-wasm'],alias:{'node:buffer':'buffer','node:path':'path-browserify','node:events':'events','node:stream':'readable-stream','node:url':'url'}}, define: { __ABX_HOOK_PATHS__: JSON.stringify(hookPaths),__ABX_PYTHON_RUNTIME_REVISION__:JSON.stringify(pythonRuntimeRevision()) }, worker: { format: 'es' } }),
  hooks: {
    'build:publicAssets': (_wxt, assets) => {
      assets.push(...browserAssets());
    },
  },
});
