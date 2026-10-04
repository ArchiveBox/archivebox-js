import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

// Independent interoperability acceptance: the unmodified npm player opens WACZs
// exported by real-site capture tests. No extension, routing, or substituted content.
const captureRoot = process.env.ABX_LIVE_CAPTURE_DIR || '/tmp/abx-wacz-live-final';
const sites = [
  { name: 'hacker-news', text: 'Hacker News' },
  { name: 'hacker-news-discussion', text: 'Hacker News' },
  { name: 'sweeting', text: 'Sweeting' },
  { name: 'sweeting-blog', text: 'Sweeting' },
];
for (const site of sites) test(`upstream ReplayWeb.page opens real ${site.name} WACZ offline`, async ({}, info) => {
  const require = createRequire(import.meta.url);
  const playerRoot = path.resolve(path.dirname(require.resolve('replaywebpage')), '..');
  const candidates = await readdir(captureRoot, { withFileTypes: true });
  let archivePath = '';
  for (const candidate of candidates.filter(item => item.isDirectory())) {
    const candidatePath = path.join(captureRoot, candidate.name, `${site.name}.wacz`);
    if (await stat(candidatePath).catch(() => undefined)) { archivePath = candidatePath; break; }
  }
  expect(archivePath, `Missing real capture ${site.name}.wacz in ${captureRoot}`).not.toBe('');
  const sourceReport = JSON.parse(await readFile(path.join(path.dirname(archivePath), 'live-site-report.json'), 'utf8'));
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
      const filename = path.resolve(playerRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!filename.startsWith(playerRoot + path.sep)) { response.writeHead(403); response.end(); return; }
      const bytes = await readFile(filename);
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm' };
      response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream' }); response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const consoleMessages: string[] = [];
  const errors: string[] = [], externalRequests: string[] = [], replayRequests: string[] = [];
  const report: Record<string, unknown> = { player: 'replaywebpage@2.5.3', archivePath, source: sourceReport.site, origin, browser: browser.version() };
  context.on('console', message => consoleMessages.push(message.text()));
  page.on('pageerror', error => errors.push(String(error)));
  context.on('request', request => {
    if (/^https?:/.test(request.url())) {
      if (!request.url().startsWith(origin + '/')) externalRequests.push(request.url());
      else if (request.url().includes('/w/')) replayRequests.push(request.url());
    }
  });
  try {
    await page.goto(origin);
    await expect(page.getByText('Load Web Archive', { exact: true })).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    // The native chooser uses showOpenFilePicker, which Playwright cannot drive.
    // Obtain a disk-backed File through a browser file input, then perform the
    // player's supported drag/drop UI flow. No player methods are called directly.
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'acceptance-file-transfer'; input.hidden = true; document.body.append(input); });
    await page.locator('#acceptance-file-transfer').setInputFiles(archivePath);
    const transfer = await page.evaluateHandle(() => {
      const input = document.querySelector<HTMLInputElement>('#acceptance-file-transfer')!;
      const transfer = new DataTransfer(); transfer.items.add(input.files![0]!); input.remove(); return transfer;
    });
    await page.locator('replay-app-main').dispatchEvent('dragenter', { dataTransfer: transfer });
    await page.locator('replay-app-main').dispatchEvent('drop', { dataTransfer: transfer });
    await transfer.dispose();
    await expect(page.locator('wr-page-entry')).toHaveCount(1, { timeout: 30000 });
    await context.setOffline(true);
    await page.locator('wr-page-entry .page-title').click();
    const replay = page.frameLocator('iframe[name="___wb_replay_top_frame"]');
    await expect(replay.locator('body')).toBeVisible({ timeout: 30000 });
    await expect(replay.locator('body')).toContainText(site.text, { timeout: 30000 });
    const frame = page.frames().find(frame => frame.name() === '___wb_replay_top_frame')!;
    await expect.poll(() => frame.evaluate(() => Array.from(document.images).filter(image => image.complete && image.naturalWidth > 0).length), { timeout: 15000 }).toBeGreaterThan(0);
    report.document = await frame.evaluate(() => ({ url: location.href, title: document.title, text: document.body.innerText.slice(0,1500), display: getComputedStyle(document.body).display,
      wombat: !!(window as any)._wb_wombat, images: Array.from(document.images).map(image => ({ src: image.currentSrc || image.src, loaded: image.complete && image.naturalWidth > 0, width: image.naturalWidth, height: image.naturalHeight })) }));
    expect((report.document as any).wombat).toBe(true);
    expect((report.document as any).title).toBe(sourceReport.capture.title);
    expect(errors, 'Archived document JavaScript errors').toEqual([]);
    expect(externalRequests, 'Replay must make no requests to the original sites').toEqual([]);
    expect(replayRequests.length).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath('upstream-player.png'), fullPage: true });
    await frame.locator('body').screenshot({ path: info.outputPath('replayed-document.png') });
  } finally {
    report.console = consoleMessages; report.errors = errors; report.externalRequests = externalRequests; report.replayRequests = replayRequests;
    report.finalURL = page.url();
    report.visibleUI = await page.locator('body').innerText().catch(() => 'Unavailable');
    await page.screenshot({ path: info.outputPath('final-player.png'), fullPage: true }).catch(() => {});
    await writeFile(info.outputPath('replaywebpage-report.json'), JSON.stringify(report, null, 2));
    await context.close(); await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
