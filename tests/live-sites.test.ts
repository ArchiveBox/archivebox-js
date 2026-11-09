import {verifyOfflineOutputs} from './offline-output-contract';
import {inspectWaczEvidence} from './wacz-evidence';
import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { WARCParser } from 'warcio';

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
    const archiveBytes = await readFile(archivePath);
    const zip = unzipSync(archiveBytes);
    const manifest = JSON.parse(strFromU8(zip['datapackage.json']!));
    for (const resource of manifest.resources) expect(`sha256:${createHash('sha256').update(zip[resource.path]!).digest('hex')}`, resource.path).toBe(resource.hash);
    const packageEvidence = await inspectWaczEvidence(archivePath);
    report.packageEvidence = packageEvidence;
    const entries = strFromU8(zip['indexes/index.cdx']!).split('\n').filter(Boolean).map(line => JSON.parse(line.slice(line.indexOf(' {') + 1)));
    const main = entries.filter(entry => entry.url === capture.finalUrl?.split('#')[0] || entry.url === site.url.split('#')[0]);
    report.documentEntries = main;
    report.recordCount = entries.length;
    let finalDOM = zip['dom/dom.html'] ? strFromU8(zip['dom/dom.html']) : '';
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
    const {viewerIds} = await verifyOfflineOutputs({studio,testInfo,archiveBytes,zip,manifest,entries,packageEvidence,observedConnections,site,documentURLs:main.map(entry=>entry.url),sampledText,report});
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
