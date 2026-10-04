import {openSnapshotOutput} from './snapshot-controls';
import { test, expect, chromium, type Page } from '@playwright/test';
import { access, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { WARCParser } from 'warcio';

async function capturedArchive(name: string) {
  const root = process.env.ABX_LIVE_CAPTURE_DIR || '/tmp/abx-wacz-live-final';
  const files = await readdir(root, { recursive: true });
  const relative = files.find(file => path.basename(file) === name);
  if (!relative) throw Error(`Capture the real site with tests/live-sites.test.ts first; no ${name} in ${root}`);
  const file = path.join(root, relative); await access(file); return file;
}

async function canonicalURLs(studio:Page,id:string) {
  await studio.goto(studio.url().split('#')[0]+'#view='+id);
  const frame=studio.frameLocator('#main-frame-wrapper iframe[title="Discovered URLs"]');
  await expect(frame.locator('header h1')).toContainText('Discovered URLs');
  const download=studio.waitForEvent('download',{timeout:15000});await frame.getByRole('link',{name:'Download',exact:true}).click();
  const text=await readFile((await(await download).path())!,'utf8');
  const rows=text.trim()?text.trim().split('\n').map(line=>JSON.parse(line)):[];
  await expect(frame.locator('.rows .row')).toHaveCount(rows.length);
  expect(await frame.locator('.rows .row a.url').allTextContents()).toEqual(rows.map(row=>row.url));
  return {frame,rows};
}
async function originalResponses(file:string) {
  const responses=new Map<string,string>();
  const zip=unzipSync(await readFile(file),{filter:entry=>entry.name.startsWith('archive/')});
  for(const bytes of Object.values(zip))for await(const record of new WARCParser([bytes])){
    const body=await record.readFully();if(record.warcType==='response')responses.set(record.warcTargetURI!,new TextDecoder().decode(body));
  }
  return responses;
}

test('real saved Sweeting blog derives Mercury, plaintext and URL format views offline', async ({}, testInfo) => {
  const archivePath = await capturedArchive('sweeting-blog.wacz');
  const extension = path.resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(), 'abx-derived-live-')), {
    channel: 'chromium', headless: true, acceptDownloads:true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const studio = await context.newPage(); const errors: string[] = []; const liveRequests: string[] = [];
    studio.on('pageerror', error => errors.push(String(error)));
    context.on('request', request => { if (/^https?:/.test(request.url())) liveRequests.push(request.url()); });
    await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    await context.setOffline(true);
    const choosing = studio.waitForEvent('filechooser');
    await studio.getByRole('button', { name: 'Import WACZ', exact: true }).click();
    await (await choosing).setFiles(archivePath);
    const viewer = studio.locator('#main-frame-wrapper .plugin-view');
    await studio.goto(studio.url().split('#')[0]+'#view=mercury');
    const shell=viewer.frameLocator('iframe[title="Mercury full view"]');
    await expect(shell.locator('header h1')).toHaveText('Mercury');
    const article=shell.frameLocator('iframe[title="Mercury reader view"]');
    await expect(article.locator('body')).toContainText('Sweeting');
    expect((await article.locator('body').innerText()).length).toBeGreaterThan(500);
    await expect.poll(() => article.locator('img').evaluateAll(images => images.some(image => (image as HTMLImageElement).naturalWidth > 0 && (image as HTMLImageElement).currentSrc.includes('/w/')))).toBe(true);
    const downloaded=studio.waitForEvent('download',{timeout:15000});
    await shell.getByRole('link',{name:'Download',exact:true}).click();
    const exportedHTML=await readFile((await(await downloaded).path())!,'utf8');
    expect(exportedHTML).toContain('Sweeting');
    expect(exportedHTML).toMatch(/<img[\s>]/i);
    expect(exportedHTML).toContain('/w/');
    await studio.screenshot({ path: testInfo.outputPath('mercury-offline.png') });
    for (const image of await article.locator('img').all()) if (await image.evaluate(element => (element as HTMLImageElement).naturalWidth > 0)) {
      await image.scrollIntoViewIfNeeded(); await studio.screenshot({ path: testInfo.outputPath('mercury-image-offline.png') }); break;
    }

    await studio.goto(studio.url().split('#')[0]+'#view=htmltotext');
    const plain=viewer.frameLocator('iframe[title="HTML to Text"]');
    await expect(plain.locator('#article')).toContainText('Sweeting');
    expect((await plain.locator('#article').innerText()).length).toBeGreaterThan(500);
    const textDownload=studio.waitForEvent('download',{timeout:15000});await plain.getByRole('link',{name:'Download',exact:true}).click();
    expect(await readFile((await(await textDownload).path())!,'utf8')).toBe(await plain.locator('#article').textContent());

    const originals=await originalResponses(archivePath);
    const textURLs=await canonicalURLs(studio,'parse_txt_urls');
    expect(textURLs.rows.length).toBeGreaterThan(10);
    expect(textURLs.rows.map(row=>row.url)).toContain('https://docs.monadical.com/icons/apple-touch-icon.png');
    const decodedURI=(value:string)=>value.replace(/(?:%[0-9a-f]{2})+/gi,sequence=>{try{return decodeURIComponent(sequence)}catch{return sequence}});
    for(const row of textURLs.rows){
      const target=new URL(row.url),literal=target.pathname==='/'&&!target.search&&!target.hash?target.origin:row.url;
      const line=originals.get(row.source_url)?.split(/\r?\n/)[row.line-1];expect(line).toBeDefined();
      const decodedSource=await studio.evaluate(value=>{const text=document.createElement('textarea');text.innerHTML=value!;text.innerHTML=text.value;return text.value},line);
      expect(decodedURI(decodedSource)).toContain(decodedURI(literal));
    }
    await textURLs.frame.getByRole('searchbox',{name:'Filter discovered URLs'}).fill('https://docs.sweeting.me/s/blog');
    expect(await textURLs.frame.locator('.row').count()).toBe(textURLs.rows.filter(row=>JSON.stringify(row).toLowerCase().includes('https://docs.sweeting.me/s/blog')).length);
    for(const id of ['parse_jsonl_urls','parse_netscape_urls']){
      const parsed=await canonicalURLs(studio,id);expect(parsed.rows).toEqual([]);
      await expect(parsed.frame.locator('.stats')).toHaveText('🔗 0 URLs');
      await expect(parsed.frame.locator('.empty')).toHaveText('No matching URLs');
    }
    const feedURLs=await canonicalURLs(studio,'parse_rss_urls');
    for(const row of feedURLs.rows){expect(originals.has(row.source_url)).toBe(true);expect(originals.get(row.source_url)).toContain(row.url.replaceAll('&','&amp;'));}
    if(!feedURLs.rows.length)await expect(feedURLs.frame.locator('.empty')).toHaveText('No matching URLs');
    expect(liveRequests, 'Derived viewers must only read the imported WACZ').toEqual([]);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('real saved Hacker News feed yields its original article URLs offline', async ({}, testInfo) => {
  const archivePath = await capturedArchive('hacker-news.wacz');
  const zip = unzipSync(await readFile(archivePath), { filter: file => file.name.startsWith('archive/') });
  let source = '';
  for (const bytes of Object.values(zip)) for await (const record of new WARCParser([bytes])) {
    const body = await record.readFully();
    if (record.warcType === 'response' && record.warcTargetURI === 'https://news.ycombinator.com/rss') source = new TextDecoder().decode(body);
  }
  expect(source).toContain('<title>Hacker News</title>');
  const extension = path.resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(), 'abx-feed-live-')), {
    channel: 'chromium', headless: true, acceptDownloads:true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); const studio = await context.newPage();
    const live:string[]=[];context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url())});
    await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`); await context.setOffline(true);
    const expected = await studio.evaluate(xml => [...new DOMParser().parseFromString(xml, 'application/xml').querySelectorAll('item > link')].map(link => link.textContent!), source);
    expect(expected.length).toBeGreaterThan(0);
    const choosing = studio.waitForEvent('filechooser'); await studio.getByRole('button', { name: 'Import WACZ', exact: true }).click(); await (await choosing).setFiles(archivePath);
    const {frame,rows}=await canonicalURLs(studio,'parse_rss_urls');
    expect(rows.map(row=>row.url)).toEqual([...new Set(expected)]);
    expect(rows.map(row=>row.source_url)).toEqual(expected.map(()=> 'https://news.ycombinator.com/rss'));
    await expect(frame.locator('.stats')).toHaveText(`🔗 ${new Set(expected).size} URLs`);
    await frame.getByRole('searchbox',{name:'Filter discovered URLs'}).fill(rows[0].url);
    await expect(frame.locator('.row')).toHaveCount(rows.filter(row=>JSON.stringify(row).toLowerCase().includes(rows[0].url.toLowerCase())).length);
    await frame.getByRole('searchbox',{name:'Filter discovered URLs'}).fill('no-such-archived-feed-item-9876');
    await expect(frame.locator('.empty')).toHaveText('No matching URLs');
    await frame.getByRole('searchbox',{name:'Filter discovered URLs'}).fill('');
    await openSnapshotOutput(studio,'rss');
    const original=studio.locator('.plugin-files a[title="https://news.ycombinator.com/rss"]');
    await expect(original).toHaveAttribute('href',/^#view=responses&request=/);await original.click();
    const response=studio.getByRole('region',{name:'Selected request'});await expect(response.locator('.response-selected code')).toHaveText('https://news.ycombinator.com/rss');
    const download=studio.waitForEvent('download',{timeout:15000});await response.getByRole('button',{name:'Download',exact:true}).click();
    expect(await readFile((await(await download).path())!,'utf8')).toBe(source);
    await studio.screenshot({ path: testInfo.outputPath('feed-urls-offline.png') });expect(live).toEqual([]);
  } finally { await context.close(); }
});
