import {openSnapshotOutput} from './snapshot-controls';
import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { WARCParser } from 'warcio';
const soft = expect.configure({ soft: true });

// These tests navigate the public sites themselves. No request interception,
// local replacement pages, or synthetic responses are involved. Access blocks
// remain failures, with the actual page and WACZ retained for inspection.
const sites = [
  { name: 'hacker-news', url: 'https://news.ycombinator.com/', content: 'Hacker News' },
  { name: 'sweeting', url: 'https://sweeting.me/', content: 'Sweeting' },
  { name: 'hacker-news-discussion', url: 'https://news.ycombinator.com/item?id=49948254', content: 'Hacker News' },
  { name: 'sweeting-blog', url: 'https://docs.sweeting.me/s/blog#Personal-Projects', content: 'Sweeting' },
  { name: 'reddit', url: 'https://www.reddit.com/r/DataHoarder/', content: 'DataHoarder' },
];

for (const site of sites) test(`live ${site.name}: capture, export, delete, offline import and plugin replay`, async ({}, testInfo) => {
  test.setTimeout(180_000);
  const profile = await mkdtemp(path.join(tmpdir(), `abx-live-${site.name}-`));
  const extension = path.resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const report: Record<string, unknown> = { site, profile, started: new Date().toISOString() };
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const studio = await context.newPage();
    const errors: string[] = [];
    studio.on('pageerror', error => errors.push(String(error)));
    await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    await studio.getByRole('textbox', { name: 'Open URL' }).fill(site.url);
    await studio.getByRole('button', { name: 'Capture tab', exact: true }).click();
    await expect(studio.getByRole('button', { name: 'Download WACZ', exact: true })).toBeVisible({ timeout: 100_000 });
    const capture = await studio.evaluate(async () => ((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
    report.capture = capture;
    console.log(`${site.name}: ${capture.state}, ${capture.resourceCount} records, ${capture.size} bytes, ${capture.title}`);
    const target = context.pages().find(page => page.url() === capture.finalUrl);
    let sampledText: string[] = [];
    if (target) {
      report.liveText = (await target.locator('body').innerText()).slice(0, 12_000);
      sampledText = await target.locator('h1,h2,.titleline,.commtext').evaluateAll(elements => elements.map(element => (element.textContent || '').trim().replace(/\s+/g, ' ')).filter(text => text.length >= 20).slice(0, 3));
      report.sampledText = sampledText;
      await target.screenshot({ path: testInfo.outputPath('live-page.png') });
    }
    await studio.screenshot({ path: testInfo.outputPath('capture-overview.png') });
    const downloading = studio.waitForEvent('download');
    await studio.getByRole('button', { name: 'Download WACZ', exact: true }).click();
    const archivePath = testInfo.outputPath(`${site.name}.wacz`);
    await (await downloading).saveAs(archivePath);
    const zip = unzipSync(await readFile(archivePath));
    const manifest = JSON.parse(strFromU8(zip['datapackage.json']!));
    for (const resource of manifest.resources) expect(`sha256:${createHash('sha256').update(zip[resource.path]!).digest('hex')}`, resource.path).toBe(resource.hash);
    const entries = strFromU8(zip['indexes/index.cdx']!).split('\n').filter(Boolean).map(line => JSON.parse(line.slice(line.indexOf(' {') + 1)));
    const main = entries.filter(entry => entry.url === capture.finalUrl?.split('#')[0] || entry.url === site.url.split('#')[0]);
    report.documentEntries = main;
    report.recordCount = entries.length;
    let finalDOM = '';
    const observedConnections: {url:string;network:Record<string,unknown>}[] = [];
    const types: Record<string, number> = {};
    for await (const record of new WARCParser([zip['archive/data.warc.gz']!])) {
      const body = await record.readFully();
      types[record.warcType!] = (types[record.warcType!] || 0) + 1;
      if (record.warcTargetURI?.startsWith('urn:dom:')) finalDOM = strFromU8(body);
      const extra = JSON.parse(record.warcHeaders.headers.get('WARC-JSON-Metadata') || '{}');
      if (extra.network?.remoteIPAddress) observedConnections.push({url:record.warcTargetURI!,network:extra.network});
    }
    report.warcTypes = types;
    report.observedConnections = observedConnections;
    expect.soft(observedConnections.length, 'Original responses retain observed IP addresses').toBeGreaterThan(0);
    expect.soft(capture.state, JSON.stringify({ error: capture.error, failed: capture.hooks.filter((hook: any) => ['failed', 'killed'].includes(hook.status)) })).toBe('complete');
    expect.soft(main.some(entry => entry.status === 200), JSON.stringify(main)).toBe(true);
    expect.soft(finalDOM.includes(site.content), `Saved DOM must contain ${site.content}`).toBe(true);
    expect.soft(String(report.liveText)).not.toMatch(/you(?:'|’)?ve been blocked|blocked by network security|verify you are human|prove your humanity/i);
    expect.soft(entries.some(entry => /^https?:/.test(entry.url) && /image\//.test(entry.mime))).toBe(true);

    // Delete via the product so reopening cannot use the acquisition database.
    await studio.getByRole('button', { name: 'Delete capture', exact: true }).click();
    await expect(studio.getByRole('textbox',{name:'Open URL',exact:true})).toBeVisible();
    for (const page of context.pages()) if (page !== studio) await page.close();
    await context.setOffline(true);
    const liveRequests: string[] = [], replayResponses: string[] = [], missingReplay: string[] = [];
    context.on('request', request => { if (/^https?:/.test(request.url())) liveRequests.push(request.url()); });
    studio.on('response', response => {
      if (response.url().includes('/w/') && response.fromServiceWorker()) {
        replayResponses.push(response.url());
        if (response.status() >= 400) missingReplay.push(`${response.status()} ${response.url()}`);
      }
    });
    await studio.reload();
    const choosing = studio.waitForEvent('filechooser');
    await studio.getByRole('button', { name: 'Import WACZ', exact: true }).click();
    await (await choosing).setFiles(archivePath);
    await expect(studio.locator('.stack-shelf')).toBeVisible();
    const viewerIds=await studio.locator('.thumb-card[data-plugin-name],.thumb-card[data-other-files] a[data-plugin-view]').evaluateAll(items=>items.map(item=>(item as HTMLElement).dataset.pluginName||(item as HTMLElement).dataset.pluginView!));
    expect(new Set(viewerIds).size).toBe(viewerIds.length);
    report.viewers = viewerIds;
    for (const plugin of viewerIds) {
      await openSnapshotOutput(studio,plugin);
      const viewer=studio.locator('#main-frame-wrapper .plugin-view');
      await expect(viewer.locator(':scope > h2, :scope > iframe, wr-coll-replay').first(),plugin).toBeVisible({timeout:30_000});
      if(['readability','defuddle','mercury'].includes(plugin)&&await viewer.locator(':scope > iframe').count()){
        const name=plugin[0]!.toUpperCase()+plugin.slice(1);
        await expect(viewer.frameLocator(`iframe[title="${name} full view"]`).locator('header h1')).toContainText(name);
      }
      await expect.soft(studio.getByRole('alert'), plugin).toHaveCount(0);
      await expect.soft(studio.locator('#main-frame-wrapper .plugin-view .error'), plugin).toHaveCount(0);
      if (['seo', 'sslcerts', 'readability', 'screenshot'].includes(plugin)) await studio.screenshot({ path: testInfo.outputPath(`viewer-${plugin}.png`) });
      if (plugin === 'hashes') {
        const summary = await studio.locator('#main-frame-wrapper .plugin-view > .muted').innerText();
        report.integrity = summary;
        expect.soft(summary).toContain('0 mismatches');
        expect.soft(summary).toContain('0 unreadable');
      }
      if (plugin === 'dns') {
        const connection = observedConnections.find(item=>/^https?:/.test(item.url));
        expect(connection).toBeDefined();
        await expect.soft(studio.locator('#main-frame-wrapper .plugin-view')).toContainText(String(connection!.network.remoteIPAddress));
        await expect.soft(studio.locator('#main-frame-wrapper .plugin-view')).toContainText(new URL(connection!.url).hostname);
      }
      if (plugin === 'networktiming') await expect.soft(studio.locator('#main-frame-wrapper .plugin-view table tbody tr').first()).toBeVisible();
      if (plugin === 'search_contents') {
        await viewer.getByRole('searchbox', {name:'Search archived text'}).fill(site.content);
        await expect.soft(studio.locator('#main-frame-wrapper .plugin-view article').first()).toBeVisible();
      }
    }
    await openSnapshotOutput(studio,'dom');
    const dom = studio.locator('#main-frame-wrapper .plugin-view').frameLocator('iframe[title="Offline document"]');
    await expect.soft(dom.locator('body'), 'Final DOM preview must be visible').toBeVisible();
    await expect.soft(dom.locator('body')).toContainText(site.content);
    for (const text of sampledText) await expect.soft(dom.locator('body')).toContainText(text);
    await soft.poll(() => dom.locator('img').evaluateAll(images => images.some(image => (image as HTMLImageElement).currentSrc.includes('/w/') && (image as HTMLImageElement).naturalWidth > 0)), { message: 'DOM images must load from archived responses' }).toBe(true);
    report.offlineDOMImages = await dom.locator('img').evaluateAll(images => images.map(image => ({ src: (image as HTMLImageElement).currentSrc.slice(0, 500), width: (image as HTMLImageElement).naturalWidth })));
    await studio.screenshot({ path: testInfo.outputPath('offline-dom.png') });
    await openSnapshotOutput(studio,'archivewebpage');
    const replay = studio.locator('#main-frame-wrapper').frameLocator('iframe[name="___wb_replay_top_frame"]');
    await expect.soft(replay.locator('body'), 'Original document replay must be visible').toBeVisible();
    await expect.soft(replay.locator('body')).toContainText(site.content);
    for (const text of sampledText) await expect.soft(replay.locator('body')).toContainText(text);
    await soft.poll(() => replay.locator('img').evaluateAll(images => images.some(image => (image as HTMLImageElement).currentSrc.includes('/w/') && (image as HTMLImageElement).naturalWidth > 0)), { message: 'Document images must load from archived responses' }).toBe(true);
    report.offlineDocumentText = (await replay.locator('body').innerText()).slice(0, 12_000);
    report.offlineDocumentImages = await replay.locator('img').evaluateAll(images => images.map(image => ({ src: (image as HTMLImageElement).currentSrc.slice(0, 500), width: (image as HTMLImageElement).naturalWidth })));
    await studio.screenshot({ path: testInfo.outputPath('offline-document.png') });
    report.liveRequests = liveRequests; report.replayResponses = replayResponses; report.missingReplay = missingReplay; report.errors = errors;
    expect.soft(liveRequests, 'Offline viewers must use WACZ responses exclusively').toEqual([]);
    expect.soft(replayResponses.length).toBeGreaterThan(0);
    expect.soft(errors).toEqual([]);
    console.log(`${site.name}: ${viewerIds.length} offline viewers, ${replayResponses.length} service-worker responses, ${liveRequests.length} live requests`);
  } finally {
    await writeFile(testInfo.outputPath('live-site-report.json'), JSON.stringify(report, null, 2));
    await context.close();
  }
});
