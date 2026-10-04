import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openSnapshotOutput} from './snapshot-controls';

test('canonical DNS headers and redirects render original WACZ evidence offline',async({},info)=>{
  const archivePath=process.env.ABX_ALL_PLUGIN_WACZ;
  if(!archivePath)throw Error('ABX_ALL_PLUGIN_WACZ must name the real all-plugin capture');
  const extension=path.resolve('.output/chrome-mv3');
  const context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-canonical-network-')),{channel:'chromium',headless:true,acceptDownloads:true,viewport:{width:1440,height:1000},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const external:string[]=[];
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);await context.setOffline(true);context.on('request',request=>{if(/^https?:/.test(request.url()))external.push(request.url())});
    const choosing=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);await expect(page.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:60000});
    await openSnapshotOutput(page,'dns');const dns=page.frameLocator('#main-frame-wrapper iframe[title="DNS"]');await expect(dns.locator('.map').first()).toBeVisible();await expect(dns.locator('.node.answer').first()).toContainText('cdp');await expect(dns.locator('.node.resolver').first()).toContainText('Not recorded');await page.screenshot({path:info.outputPath('canonical-dns.png'),fullPage:true});
    await openSnapshotOutput(page,'headers');const headers=page.frameLocator('#main-frame-wrapper iframe[title="HTTP Headers"]');await expect(headers.locator('.message.request .header-row').first()).toBeVisible();await expect(headers.locator('.message.response .status')).toHaveText('200');await expect(headers.locator('.message.request .url')).toContainText('Category:Paintings');await page.screenshot({path:info.outputPath('canonical-headers.png'),fullPage:true});
    await openSnapshotOutput(page,'redirects');const redirects=page.frameLocator('#main-frame-wrapper iframe[title="Redirects"]');await expect(redirects.locator('.chain .node')).toHaveCount(1);await expect(redirects.locator('.overview')).toContainText('0 hops');await expect(redirects.locator('.node a')).toContainText('Category:Paintings');await page.screenshot({path:info.outputPath('canonical-redirects.png'),fullPage:true});
    await writeFile(info.outputPath('network-evidence.json'),JSON.stringify({archivePath,external},null,2));expect(external).toEqual([]);
  }finally{await context.close()}
});
