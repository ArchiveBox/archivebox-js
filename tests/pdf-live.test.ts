import {openSnapshotOutput} from './snapshot-controls';
import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { WARCParser } from 'warcio';

test('real arXiv paper captured by papersdl yields offline LiteParse text and positions', async ({}, info) => {
  test.setTimeout(180000);
  const url = 'https://arxiv.org/abs/1706.03762';
  const profile = await mkdtemp(path.join(tmpdir(), 'abx-native-pdf-live-'));
  const extension = path.resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const report: Record<string, unknown> = { url, profile, started: new Date().toISOString() };
  const errors: string[] = [], workers: string[] = [], liveRequests: string[] = [];
  let studio;
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    studio = await context.newPage();
    studio.on('pageerror', error => errors.push(String(error)));
    studio.on('worker', worker => workers.push(worker.url()));
    await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    await studio.getByRole('button', { name: /\d+ plugins$/ }).click();
    const enabled = new Set(['Chrome navigation', 'Rendered DOM', 'Accessibility tree', 'Academic papers', 'LiteParse']);
    for (const option of await studio.locator('.plugin-option').all()) {
      const checkbox = option.locator('input[type="checkbox"]').first();
      if (await checkbox.isEnabled()) await checkbox.setChecked(enabled.has(await option.locator('strong').innerText()));
    }
    await studio.getByRole('textbox', { name: 'PAPERSDL_PROVIDERS', exact: true }).fill('arxiv');
    await studio.getByRole('textbox', { name: 'Open URL' }).fill(url);
    await studio.getByRole('button', { name: 'Capture tab', exact: true }).click();
    await expect(studio.getByRole('button', { name: 'Download WACZ', exact: true })).toBeVisible({ timeout: 100000 });
    const capture = await studio.evaluate(async () => ((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
    report.capture = capture;
    expect(capture.state, JSON.stringify(capture)).toBe('complete');
    expect(capture.hooks.filter((hook: any) => ['failed', 'killed', 'running'].includes(hook.status))).toEqual([]);
    expect(capture.hooks.find((hook: any) => hook.plugin === 'papersdl')?.status).toBe('succeeded');
    const target = context.pages().find(page => page.url().startsWith(url));
    expect(target, 'The actual public arXiv abstract must be loaded').toBeDefined();
    await expect(target!.locator('h1.title')).toContainText('Attention Is All You Need');
    await target!.screenshot({ path: info.outputPath('live-arxiv-abstract.png'), fullPage: true });
    const downloading = studio.waitForEvent('download');
    await studio.getByRole('button', { name: 'Download WACZ', exact: true }).click();
    const archivePath = info.outputPath('attention-is-all-you-need.wacz');
    await (await downloading).saveAs(archivePath);
    const zip = unzipSync(await readFile(archivePath));
    const manifest = JSON.parse(strFromU8(zip['datapackage.json']!));
    for (const resource of manifest.resources) expect(`sha256:${createHash('sha256').update(zip[resource.path]!).digest('hex')}`, resource.path).toBe(resource.hash);
    const pdfBodies: {url: string; bytes: Buffer}[] = [];
    for (const [filename, bytes] of Object.entries(zip)) if (filename.startsWith('archive/')) {
      for await (const record of new WARCParser([bytes])) {
        const body = Buffer.from(await record.readFully());
        const target = record.warcTargetURI || '';
        expect(target.startsWith('urn:pdf:'), 'Browser print artifacts are disabled for this native-PDF capture').toBe(false);
        if (/^https:\/\/arxiv.org\/pdf\//.test(target) && body.subarray(0,5).toString() === '%PDF-') pdfBodies.push({url:target,bytes:body});
      }
    }
    expect(pdfBodies).toHaveLength(1);
    report.pdf = { url: pdfBodies[0]!.url, size: pdfBodies[0]!.bytes.length, sha256: createHash('sha256').update(pdfBodies[0]!.bytes).digest('hex') };
    await studio.getByRole('button', { name: 'Delete capture', exact: true }).click();
    await expect(studio.getByRole('textbox',{name:'Open URL',exact:true})).toBeVisible();
    for (const page of context.pages()) if (page !== studio) await page.close();
    await context.setOffline(true);
    context.on('request', request => { if (/^https?:/.test(request.url())) liveRequests.push(request.url()); });
    await studio.reload();
    const choosing = studio.waitForEvent('filechooser');
    await studio.getByRole('button', { name: 'Import WACZ', exact: true }).click();
    await (await choosing).setFiles(archivePath);
    await openSnapshotOutput(studio,'accessibility');
    const viewer = studio.locator('#main-frame-wrapper .plugin-view');
    const semantics=viewer.frameLocator('iframe[title="Accessibility"]');
    await expect(semantics.getByRole('heading',{name:'Accessibility tree',exact:true})).toBeVisible();
    await expect(semantics.getByRole('heading',{name:'Document outline',exact:true})).toBeVisible();
    await expect(semantics.locator('.outline')).toContainText('Attention Is All You Need');
    const semanticDownload=studio.waitForEvent('download');
    await semantics.getByRole('link',{name:'Download',exact:true}).click();
    const semanticJSON=JSON.parse(await readFile((await(await semanticDownload).path())!,'utf8'));
    const axNodes:any[]=[];const pending=[semanticJSON.tree];
    while(pending.length){const node=pending.pop();if(!node)continue;axNodes.push(node);pending.push(...node.children||[]);}
    expect(axNodes.some(node=>node.role==='heading'&&String(node.name).includes('Attention Is All You Need'))).toBe(true);
    expect(semanticJSON.headings.some((heading:string)=>/^#+ /.test(heading)&&heading.includes('Attention Is All You Need'))).toBe(true);
    report.accessibility=semanticJSON;
    await studio.screenshot({ path: info.outputPath('accessibility-outline.png'), fullPage: true });
    await openSnapshotOutput(studio,'liteparse');
    const output=viewer.frameLocator('iframe[title="LiteParse"]');
    const text=output.locator('.text-preview').first();
    await expect(text).toContainText('Attention Is All You Need',{timeout:60000});
    await expect(text).toContainText('self-attention');
    const jsonDownload=studio.waitForEvent('download');await output.getByRole('link',{name:'JSON',exact:true}).first().click();
    const parsed=JSON.parse(await readFile((await(await jsonDownload).path())!,'utf8'));
    expect(parsed.engine.pdf).toBe('LiteParse WASM 2.15.1');
    expect(parsed.totalPages).toBe(15);expect(parsed.pages).toHaveLength(15);
    const items=parsed.pages.flatMap((page:any)=>page.textItems);
    expect(items.length).toBeGreaterThan(100);
    expect(items.every((item:any)=>[item.x,item.y,item.width,item.height].every(Number.isFinite))).toBe(true);
    expect(parsed.images).toEqual([]);expect(parsed.screenshots).toEqual([]);
    report.extractedText=await text.innerText();report.spatialRows=items.length;report.parsed=parsed;
    // The canonical paper iframe serves the byte-identical archived PDF.
    await openSnapshotOutput(studio,'papersdl');
    const paper=viewer.locator('iframe[title="Archived scientific paper"]');
    await expect(paper).toBeVisible({timeout:90000});
    const paperURL=await paper.getAttribute('src');
    expect(paperURL).toMatch(/^blob:chrome-extension:\/\//);
    const originalDigest=await studio.evaluate(async url=>{
      const response=await fetch(url!);if(!response.ok)throw Error('Original PDF replay failed: '+response.status);
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await response.arrayBuffer())),byte=>byte.toString(16).padStart(2,'0')).join('');
    },paperURL);
    expect(originalDigest).toBe(createHash('sha256').update(pdfBodies[0]!.bytes).digest('hex'));
    await openSnapshotOutput(studio,'liteparse');
    await expect(output.locator('.text-preview').first()).toContainText('Attention Is All You Need',{timeout:60000});
    await expect(studio.locator('.stack-tray [data-resource-preview="liteparse"]')).toContainText('Attention Is All You Need',{timeout:60000});
    expect(errors).toEqual([]);expect(liveRequests).toEqual([]);
    await studio.screenshot({path:info.outputPath('pdf-text-layout.png'),fullPage:true});
  } finally {
    report.errors = errors; report.workers = workers; report.liveRequests = liveRequests;
    if (studio) await studio.screenshot({ path: info.outputPath('final-studio.png') }).catch(() => {});
    await writeFile(info.outputPath('native-pdf-report.json'), JSON.stringify(report,null,2));
    await context.close();
  }
});
