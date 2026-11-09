#!/usr/bin/env node
// Rebuild the pinned npm package patches in an isolated temporary directory.
// Usage: node scripts/rebuild-webrecorder.mjs [patch-directory]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const patchDir = path.resolve(process.argv[2] || path.join(import.meta.dirname, '../patches'));
const root = await mkdtemp(path.join(tmpdir(), 'archivebox-webrecorder-rebuild-'));
const specs = [
  { name: 'wombat', version: '3.11.0', head: 'ad69888a2c57f8fdc408f054eaefce9c25011926', repository: 'wombat',
    integrity: 'sha512-Yd1nWNyxASZ5WYMUE9MHYF+XBaQpZjp2l6UzUihssM+Ws3uPRiwShIEG+iL6pLDly8ZgUs2YCqK6PpKTOrEM4Q==',
    files: { 'rollup.config.prod.js': '6a78a1ef04045c3c2534cc8b370578cc4e0029169deb332dfb3871458411ecd0', 'yarn.lock': 'e8aa82778b6f0a74b5dd14c48379f29a4fe0e03baf8390830f5c114f413ca5e5' } },
  { name: 'wabac', version: '2.27.4', head: 'f62b924492339cf2ee069f51319ab6603f63500d', repository: 'wabac.js',
    integrity: 'sha512-UQwVQGq+SKeCG3FPY9p2qyeTwBSSG7K4uXySuYwOX1QElLSIPpezbm4QtM3j9mu1LrMbmcDSoDKKUs3bSjo9wA==',
    files: { 'webpack.config.cjs': 'd118f9761bdf8b2f700e298136bd37375208de5229442f23be8d21c29d20287b', 'tsconfig.json': '00d5780d73d35bbfc23ea0a581544e4ccfdc7437935071b3ff70c2fc4713ec5c', 'yarn.lock': '5b537bef073a9b52bd4d2bc75d7e6bcc83d3f521a335def08f1c338bf0384b01' } },
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed`);
}
async function download(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `Download failed: ${url} (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}
async function npmPackage(name, version, destination, integrity) {
  const metadata = JSON.parse(await download(`https://registry.npmjs.org/${name}/${version}`));
  assert.equal(metadata.name, name);
  assert.equal(metadata.version, version);
  if (integrity) assert.equal(metadata.dist.integrity, integrity);
  const bytes = await download(metadata.dist.tarball);
  const [algorithm, expected] = (integrity || metadata.dist.integrity).split('-', 2);
  assert.equal(createHash(algorithm).update(bytes).digest('base64'), expected);
  await mkdir(destination, { recursive: true });
  const archive = `${destination}.tgz`;
  await writeFile(archive, bytes);
  run('tar', ['-xzf', archive, '-C', destination, '--strip-components=1'], root);
  return metadata;
}
async function filesUnder(directory, prefix = '') {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + item.name;
    if (item.isDirectory()) result.push(...await filesUnder(path.join(directory, item.name), relative + '/'));
    else result.push(relative);
  }
  return result.sort();
}

console.log(`Build staging: ${root}`);
await npmPackage('yarn', '1.22.22', path.join(root, 'yarn-classic'));
await npmPackage('@yarnpkg/cli-dist', '4.17.1', path.join(root, 'yarn-modern'));
const hashes = {};
for (const spec of specs) {
  const directory = path.join(root, spec.name);
  const expected = path.join(root, spec.name + '-expected');
  const metadata = await npmPackage(`@webrecorder/${spec.name}`, spec.version, directory, spec.integrity);
  assert.equal(metadata.gitHead, spec.head);
  await mkdir(expected);
  run('tar', ['-xzf', `${directory}.tgz`, '-C', expected, '--strip-components=1'], root);
  const patch = path.join(patchDir, `@webrecorder__${spec.name}@${spec.version}.patch`);
  run('git', ['apply', '--include=src/**', patch], directory);
  run('git', ['apply', patch], expected);
  for (const [filename, hash] of Object.entries(spec.files)) {
    const bytes = await download(`https://raw.githubusercontent.com/webrecorder/${spec.repository}/${spec.head}/${filename}`);
    assert.equal(sha256(bytes), hash, `Changed upstream build input: ${filename}`);
    // Both upstream configurations include the current year in their banner.
    // Fix that metadata to the publication year, including after New Year.
    await writeFile(path.join(directory, filename), filename.includes('.config.') ? bytes.toString().replaceAll('new Date().getFullYear()', '2026') : bytes);
  }
  if (spec.name === 'wombat') {
    run(process.execPath, [path.join(root, 'yarn-classic/bin/yarn.js'), 'install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive'], directory);
    run(process.execPath, ['node_modules/rollup/dist/bin/rollup', '-c', 'rollup.config.prod.js'], directory);
  } else {
    // Supported in-range deduplication removes the CLI-only ansi-regex 5.0.0 advisory.
    run('git', ['apply', path.join(patchDir, 'wabac-build-lock.patch')], directory);
    assert.equal(sha256(await readFile(path.join(directory, 'yarn.lock'))), '6d6ddb0ecc40cc3f2e08ad5ed17928ff6d921d8401783c4b599bdd2d24724cac');
    run(process.execPath, [path.join(root, 'yarn-modern/bin/yarn.js'), 'install', '--immutable'], directory, { YARN_ENABLE_SCRIPTS: 'false', YARN_NODE_LINKER: 'node-modules' });
    await copyFile(path.join(root, 'wombat/src/wombat.js'), path.join(directory, 'node_modules/@webrecorder/wombat/src/wombat.js'));
    run(process.execPath, ['node_modules/webpack/bin/webpack.js', '--mode', 'production'], directory);
  }
  assert.deepEqual(await filesUnder(path.join(directory, 'dist')), await filesUnder(path.join(expected, 'dist')));
  for (const file of await filesUnder(path.join(expected, 'dist'))) {
    const actualBytes = await readFile(path.join(directory, 'dist', file));
    assert.deepEqual(actualBytes, await readFile(path.join(expected, 'dist', file)), `Non-reproducible output: ${spec.name}/dist/${file}`);
    hashes[`${spec.name}/dist/${file}`] = sha256(actualBytes);
  }
}
await writeFile(path.join(root, 'sha256.json'), JSON.stringify(hashes, null, 2) + '\n');
console.log(`Verified all ${Object.keys(hashes).length} distribution files against the committed patches. Evidence: ${root}/sha256.json`);
