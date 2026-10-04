import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';
import {openSnapshotOutput} from './snapshot-controls';

test('activity robots feeds and search use recorded originals offline',async({},info)=>{
  const archivePath=process.env.ABX_ALL_PLUGIN_WACZ;if(!archivePath)throw Error('ABX_ALL_PLUGIN_WACZ must name the retained all-plugin Commons WACZ');
  const originals=new Map<string,string>(),responseURLs=new Set<string>();let dom='';
  for(const [name,bytes]of Object.entries(unzipSync(await readFile(archivePath))))if(name.startsWith('archive/'))for await(const record of new WARCParser([bytes])){
    const body=await record.readFully(),url=record.warcTargetURI||'';
    if(['response','revisit'].includes(record.warcType||''))responseURLs.add(url);
    if(url.startsWith('urn:dom:'))dom=new TextDecoder().decode(body);
    if((/urn:(?:infiniscroll|browsertrix_behaviors):/.test(url)||url.endsWith('/robots.txt'))&&body.length)originals.set(url,new TextDecoder().decode(body));
  }
  const extension=path.resolve('.output/chrome-mv3'),context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-activity-')),{channel:'chromium',headless:true,acceptDownloads:true,viewport:{width:1440,height:1000},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const external:string[]=[],errors:string[]=[];
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);await context.setOffline(true);context.on('request',request=>{if(/^https?:/.test(request.url()))external.push(request.url())});page.on('pageerror',error=>errors.push(String(error)));
    const choosing=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);await expect(page.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:60000});
    for(const [plugin,title]of [['infiniscroll','Infinite Scroll'],['browsertrix_behaviors','Browser Behaviors']]){
      const expected=JSON.parse([...originals].find(([url])=>url.startsWith(`urn:${plugin}:`))![1]);
      await openSnapshotOutput(page,plugin!);const viewer=page.frameLocator(`#main-frame-wrapper iframe[title="${title}"]`);
      if(plugin==='infiniscroll')await expect(viewer.locator('.metric').filter({hasText:'Scroll steps'})).toContainText(String(expected.steps));
      else await expect(viewer.locator('.stats')).toContainText(`${expected.steps} scroll steps`);
      const downloading=page.waitForEvent('download');await viewer.getByRole('link',{name:'Download',exact:true}).click();expect(JSON.parse(await readFile((await(await downloading).path())!,'utf8'))).toEqual(expected);
      if(plugin==='infiniscroll'){await expect(viewer.locator('[data-initial-height]')).toHaveAttribute('data-initial-height',String(expected.initialHeight));await expect(viewer.locator('[data-document-height]')).toHaveAttribute('data-document-height',String(expected.finalHeight))}
      await page.screenshot({path:info.outputPath(`${plugin}.png`)});
    }
    await openSnapshotOutput(page,'robots');const robots=page.frameLocator('#main-frame-wrapper iframe[title="Robots.txt"]');const expectedRobots=[...originals].find(([url])=>url.endsWith('/robots.txt'))![1];await expect(robots.locator('#article')).toHaveText(expectedRobots);
    const downloading=page.waitForEvent('download');await robots.getByRole('link',{name:'Download',exact:true}).click();expect(await readFile((await(await downloading).path())!,'utf8')).toBe(expectedRobots);await page.screenshot({path:info.outputPath('robots.png')});
    const feedURL='https://commons.wikimedia.org/w/index.php?title=Special:RecentChanges&feed=atom';expect(dom).toContain('feed=atom');expect(responseURLs.has(feedURL)).toBe(false);
    await openSnapshotOutput(page,'rss');const feeds=page.frameLocator('#main-frame-wrapper iframe[title="Feeds"]');await expect(feeds.locator('.stats')).toContainText('1 feeds');await expect(feeds.locator('.rows .row')).toHaveCount(49);await expect(feeds.locator('#content')).not.toContainText('Feed not archived');
    await openSnapshotOutput(page,'search_contents');const search=page.frameLocator('#main-frame-wrapper iframe[title="Search"]');await search.getByRole('searchbox',{name:'Search archived text'}).fill('Monet');await expect(search.locator('mark').first()).toContainText(/monet/i);await expect(search.locator('.rows')).toContainText('Paintings');await page.screenshot({path:info.outputPath('search.png')});
    expect(external).toEqual([]);expect(errors).toEqual([]);await writeFile(info.outputPath('report.json'),JSON.stringify({archivePath,external,errors},null,2));
  }finally{await context.close()}
});
