import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// An unchanged retained real capture, never a generated or intercepted response.
test('Mercury renders and exports the retained real article offline', async ({}, testInfo) => {
  let archive = process.env.ABX_MERCURY_CAPTURE;
  if (!archive) {
    const root = process.env.ABX_LIVE_CAPTURE_DIR || '/tmp/abx-wacz-live-final';
    const files = await readdir(root, { recursive: true });
    const relative = files.find(file => path.basename(file) === 'sweeting-blog.wacz');
    if (!relative) throw Error('Capture the real Sweeting blog with tests/live-sites.test.ts first');
    archive = path.join(root, relative);
  }
  const extension = path.resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(), 'abx-mercury-compare-')), {
    channel: 'chromium', headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const live: string[] = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await context.setOffline(true);
    context.on('request', request => { if (/^https?:/.test(request.url())) live.push(request.url()); });
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    const choosing = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import WACZ', exact: true }).click();
    await (await choosing).setFiles(archive);
    await expect(page.getByRole('button', { name: 'Download WACZ', exact: true })).toBeVisible({ timeout: 60_000 });
    await page.goto(page.url().split('#')[0] + '#view=mercury');
    const shell = page.frameLocator('iframe[title="Mercury full view"]');
    const reader = shell.frameLocator('iframe[title="Mercury reader view"]');
    await expect(reader.locator('body')).toContainText('Sweeting', { timeout: 45_000 });
    const text = await reader.locator('body').innerText();
    expect(text.length).toBeGreaterThan(500);
    await expect.poll(() => reader.locator('img').evaluateAll(images => images.filter(image => (image as HTMLImageElement).naturalWidth > 0).length)).toBeGreaterThan(0);
    await expect.poll(() => reader.locator("img").evaluateAll(images => images.every(image => (image as HTMLImageElement).complete))).toBe(true);
    const images = await reader.locator('img').evaluateAll(images => images.map(node => {
      const image = node as HTMLImageElement;
      return { src: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight };
    }));
    expect(images.filter(image => image.width > 0).every(image => image.src.includes('/w/'))).toBe(true);
    const downloading = page.waitForEvent('download');
    await shell.getByRole('link', { name: 'Download', exact: true }).click();
    const html = await readFile((await (await downloading).path())!, 'utf8');
    expect(html).toContain('Sweeting'); expect(html).toMatch(/<img[\s>]/i); expect(html).toContain('/w/');
    expect(live).toEqual([]); expect(errors).toEqual([]);
    const output = { text, images, html };
    if (process.env.ABX_MERCURY_BASELINE) {
      const baseline = JSON.parse(await readFile(process.env.ABX_MERCURY_BASELINE, 'utf8'));
      // Only per-browser extension and per-import capture identifiers vary.
      const normalize = (value: unknown) => JSON.stringify(value)
        .replace(/chrome-extension:\/\/[a-z]+/g, 'chrome-extension://EXT')
        .replace(/\/w\/[^/]+\//g, '/w/CAPTURE/');
      expect(normalize(output)).toBe(normalize(baseline));
    }
    const result = JSON.stringify(output, null, 2);
    await writeFile(testInfo.outputPath('mercury-output.json'), result);
    if (process.env.ABX_MERCURY_RESULT) await writeFile(process.env.ABX_MERCURY_RESULT, result);
  } finally { await context.close(); }
});
