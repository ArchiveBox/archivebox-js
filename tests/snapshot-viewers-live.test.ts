import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openSnapshotOutput} from './snapshot-controls';
const file='/tmp/abx-all-plugins-commons-build14-20261004/all-plugins-live-all-plugi-ef16b-enshot-and-metadata-offline/commons-all-plugins.wacz';
test('all snapshot cards remain usable and canonical text/link/screenshot views replay offline',async({},info)=>{
 test.setTimeout(180000);
 const extension=path.resolve('.output/chrome-mv3');
 const context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-viewers-')),{channel:'chromium',headless:true,acceptDownloads:true,viewport:{width:1440,height:1000},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 const errors:string[]=[],external:string[]=[],opened:string[]=[],network:any[]=[];let phase='import';
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
  const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');cdp.on('Network.requestWillBeSent',event=>{if(/^https?:/.test(event.request.url))network.push({phase,...event})});
  page.on('pageerror',error=>errors.push(String(error)));await context.setOffline(true);context.on('request',request=>{if(/^https?:/.test(request.url()))external.push(request.url())});
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await chooser).setFiles(file);await expect(page.locator('.stack-shelf')).toBeVisible();
  await expect(page.locator('.thumb-card[data-plugin-name="media"]')).toHaveCount(0);
  const plugins=await readdir('abx-plugins/abx_plugins/plugins');
  for(const name of await page.locator('a[data-plugin-view]').evaluateAll(links=>links.map(link=>(link as HTMLElement).dataset.pluginView!)))expect(plugins).toContain(name);
  const names=await page.locator('.thumb-card[data-plugin-name]').evaluateAll(cards=>cards.map(card=>(card as HTMLElement).dataset.pluginName!));
  for(const plugin of ['browsertrix_behaviors','infiniscroll','robots','search_contents'])expect(names).toContain(plugin);
  expect(names).toContain('rss'); // This capture contains a redirected Atom feed.
  for(const plugin of ['modalcloser','istilldontcareaboutcookies','chrome_screencast','manifest','networktiming','ssl'])expect(names).not.toContain(plugin);
  for(const name of names){
   phase=name;
   const panel=await openSnapshotOutput(page,name);
   await expect(panel.locator(':scope > .loading')).toHaveCount(0,{timeout:20000});
   await expect(panel.locator('[role=alert]')).toHaveCount(0);await expect(page.locator('.stack-shelf')).toBeVisible();opened.push(name);
  }
  phase='chrome_screencast files';const files=await openSnapshotOutput(page,'chrome_screencast');
  await expect(files.locator('.plugin-files tbody tr')).not.toHaveCount(0);
  const savedFile=files.locator('.plugin-files tbody td:first-child a').first();
  await expect(savedFile).toHaveAttribute('title',/^urn:screencast-frame:/);
  await expect(files.getByRole('link',{name:'Open output',exact:true})).toHaveCount(0);
  await openSnapshotOutput(page,'screenshot');const screenshot=page.frameLocator('#main-frame-wrapper iframe[title="Screenshot"]');
  await expect(screenshot.locator('img.screenshot-fullscreen')).toHaveCount(1);await expect.poll(()=>screenshot.locator('img').evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth)).toBe(1440);
  await expect(page.locator('#main-frame-wrapper')).not.toContainText('Tile');
  await openSnapshotOutput(page,'title');const title=page.frameLocator('#main-frame-wrapper iframe[title="Title"]');await expect(title.locator('.page-title')).toContainText('Paintings by Claude Monet');
  const download=page.waitForEvent('download');await title.locator('#download').click();const saved=info.outputPath('title.txt');await(await download).saveAs(saved);expect(await readFile(saved,'utf8')).toBe(await title.locator('.page-title').innerText());
  await openSnapshotOutput(page,'htmltotext');const text=page.frameLocator('#main-frame-wrapper iframe[title="HTML to Text"]');await expect(text.locator('#article')).toContainText('Paintings by Claude Monet');
  await openSnapshotOutput(page,'parse_dom_outlinks');const links=page.frameLocator('#main-frame-wrapper iframe[title="Discovered URLs"]');await expect(links.getByRole('searchbox',{name:'Filter discovered URLs'})).toBeVisible();const total=await links.locator('.row').count();expect(total).toBeGreaterThan(20);await links.getByRole('searchbox').fill('Wildenstein');expect(await links.locator('.row').count()).toBeGreaterThan(0);expect(await links.locator('.row').count()).toBeLessThan(total);
  expect(errors).toEqual([]);expect(external).toEqual([]);await page.screenshot({path:info.outputPath('canonical-links.png'),fullPage:true});
 }finally{await writeFile(info.outputPath('viewers.json'),JSON.stringify({opened,errors,external,network},null,2));await context.close()}
});
