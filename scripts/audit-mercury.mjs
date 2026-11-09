import { readFile } from 'node:fs/promises';
const { components } = JSON.parse(await readFile(new URL('../vendor/mercury/components.json', import.meta.url), 'utf8'));
const versions = {};
for (const { name, version } of components) (versions[name] ||= []).push(version);
const response = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(versions),
});
if (!response.ok) throw Error(`Mercury component audit failed: HTTP ${response.status}`);
const advisories = await response.json();
if (Object.keys(advisories).length) {
  console.error(JSON.stringify(advisories, null, 2));
  process.exitCode = 1;
} else console.log(`No npm advisories returned for ${components.length} actual Mercury browser components.`);
