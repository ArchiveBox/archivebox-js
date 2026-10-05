import {readWaczPackage} from './wacz-evidence';
import {openSnapshotOutput} from './snapshot-controls';
import {test, expect, chromium} from '@playwright/test';
import {mkdtemp, readdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {imageSize} from 'image-size';
import {inspectWaczEvidence} from './wacz-evidence';
import {WARCParser} from 'warcio';
import MiniSearch from 'minisearch';
import {searchOptions} from '../abx-plugins/abx_plugins/plugins/search_contents/browser/index';

test('all-plugin HN preserves a capped JPEG and full-resolution PNG pages, with offline derived views', async ({}, testInfo) => {
  test.setTimeout(900_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'abx-screenshot-live-'));
  const extension = path.resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(profile, {
    channel:'chromium', headless:true, acceptDownloads:true,
    viewport:{width:1440,height:1000},
    args:[`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const studio = await context.newPage();
    await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    const retained=process.env.ABX_SCREENSHOT_RETAINED;
    let capture:any,metrics:any,archivePath:string;
    if(retained){
      ({capture,metrics}=JSON.parse(await readFile(path.join(retained,'screenshot-capture.json'),'utf8')));
      archivePath=path.join(retained,'long-blog.wacz');
      const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);
      await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible();
    }else{
      const plugins=(await readdir('abx-plugins/abx_plugins/plugins',{withFileTypes:true})).filter(item=>item.isDirectory()).map(item=>item.name).sort();
      await expect(studio.getByRole('button',{name:`${plugins.length} plugins`,exact:true})).toBeVisible();
      await studio.getByRole('button',{name:`${plugins.length} plugins`,exact:true}).click();
      const rows=studio.locator('.plugin-option');await expect(rows).toHaveCount(plugins.length);
      for(const row of await rows.all()){
        const checkbox=row.locator('label').first().getByRole('checkbox');
        if(!await checkbox.isDisabled())await checkbox.setChecked(true);
        await expect(checkbox).toBeChecked();
      }
      if(process.env.ABX_SCREENSHOT_PAGES)await studio.getByRole('spinbutton',{name:'INFINISCROLL_SCROLL_LIMIT',exact:true}).fill(process.env.ABX_SCREENSHOT_PAGES);
      // This real thread has over 500 API items; acquire the whole thread while
      // keeping every plugin enabled and retaining the completion assertions.
      await studio.getByRole('spinbutton',{name:'FORUMDL_MAX_REQUESTS',exact:true}).fill('1000');
      await studio.getByRole('button',{name:`${plugins.length} plugins`,exact:true}).click();
      await studio.getByRole('textbox',{name:'Open URL'}).fill('https://news.ycombinator.com/item?id=49944227');
      await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
      await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:720_000});
      capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
      expect(capture.plugins.slice().sort()).toEqual(plugins);
      const target=context.pages().find(page=>page.url()===capture.finalUrl)!;
      const session=await context.newCDPSession(target);metrics=await session.send('Page.getLayoutMetrics');await session.detach();
      await writeFile(testInfo.outputPath('screenshot-capture.json'),JSON.stringify({capture,metrics},null,2));
      const downloading=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();
      archivePath=testInfo.outputPath('long-blog.wacz');await(await downloading).saveAs(archivePath);
    }
    const before=await readFile(archivePath),zip=unzipSync(before);
    await inspectWaczEvidence(archivePath);
    const manifest=(await readWaczPackage(zip));
    const indexed=JSON.parse(new TextDecoder().decode(zip['search_contents/index.json']));
    expect(indexed.documents.filter((entry:any)=>entry.url.includes('hacker-news.firebaseio.com/v0/item/')).length).toBeGreaterThan(500);
    expect(manifest.metadata.files.some((file:any)=>/^(readability|forumdl)\//.test(file.path||''))).toBe(false);
    const searchIndex=MiniSearch.loadJS(indexed.index,searchOptions);let commentWord='';
    for(const [name,body]of Object.entries(zip))if(name.startsWith('archive/'))for await(const record of new WARCParser([body])){
      if(record.warcType!=='response'||!record.warcTargetURI?.includes('hacker-news.firebaseio.com/v0/item/'))continue;
      const original=JSON.parse(new TextDecoder().decode(await record.readFully()));
      const word=original.type==='comment'&&original.text?.replace(/<[^>]+>/g,' ').match(/\b[a-z]{8,}\b/i)?.[0];
      if(word){expect(searchIndex.search(word).some(result=>indexed.documents[result.id].url===record.warcTargetURI)).toBe(true);commentWord=word;break}
    }
    expect(commentWord).not.toBe('');
    const pageLimit=Math.max(1,capture.pluginConfig.infiniscroll.INFINISCROLL_SCROLL_LIMIT);
    expect(manifest.metadata.files.filter((file:any)=>file.url.startsWith('urn:fullPage:')).length,'PNG count respects the configured scroll page limit').toBeLessThanOrEqual(pageLimit);
    expect(Object.keys(zip).filter(name=>/^(dom|accessibility|chrome_screencast)\//.test(name))).toEqual([]);
    expect(manifest.metadata.files.filter((file:any)=>/^urn:(dom|accessibility|screencast):/.test(file.url))).toEqual([]);
    expect(capture.hooks.filter((hook:any)=>['dom','accessibility','chrome_screencast'].includes(hook.plugin))).toEqual([]);
    const preview=manifest.metadata.files.find((file:any)=>file.url.startsWith('urn:screenshot:'));
    expect(preview.path).toBe('screenshot/screenshot.jpg');expect(preview.mime).toBe('image/jpeg');
    const jpeg=imageSize(zip[preview.path]!);expect(jpeg.type).toBe('jpg');
    expect(jpeg.height).toBe(Math.round(Math.min(preview.metadata.screenshot.capturedArea.height,12000)*preview.metadata.screenshot.devicePixelRatio));
    expect(jpeg.width).toBe(Math.round(preview.metadata.screenshot.capturedArea.width*preview.metadata.screenshot.devicePixelRatio));
    const images:{url:string;width:number;height:number;metadata:any}[]=[];
    for(const file of manifest.metadata.files.filter((file:any)=>file.url.startsWith('urn:fullPage:'))) {
      const tile=file.metadata.screenshot.tile;
      expect(file.path).toBe('screenshot/screenshot-'+String(tile.index+1).padStart(2,'0')+'.png');
      const png=imageSize(zip[file.path]!);expect(png.type).toBe('png');
      images.push({url:file.url,width:png.width,height:png.height,metadata:file.metadata});
      expect(tile.height).toBeLessThanOrEqual(1000);
    }
    await writeFile(testInfo.outputPath('screenshot-images.json'),JSON.stringify(images,null,2));
    expect(capture.hooks.find((hook:any)=>hook.plugin==='screenshot')?.status,JSON.stringify(capture,null,2)).toBe('succeeded');
    expect(images.length).toBeGreaterThan(1);
    const tiles=images.map(image=>image.metadata.screenshot.tile).sort((a,b)=>a.index-b.index);
    const bounds=images[0]!.metadata.screenshot.capturedArea;
    expect(images[0]!.metadata.screenshot.fullPage.width).toBe(metrics.cssContentSize.width);
    expect(images[0]!.metadata.screenshot.fullPage.height).toBe(metrics.cssContentSize.height);
    expect(bounds.height).toBe(Math.min(metrics.cssContentSize.height,pageLimit*1000));
    expect(bounds.height).toBeLessThan(metrics.cssContentSize.height);
    expect(bounds.width).toBe(Math.min(metrics.cssContentSize.width,1440));
    expect(tiles.map(tile=>tile.index)).toEqual(Array.from({length:tiles.length},(_,i)=>i));
    expect(new Set(images.map(image=>image.url)).size).toBe(images.length);
    for(const image of images) {
      const {tile,devicePixelRatio}=image.metadata.screenshot;
      expect(tile.count).toBe(images.length);
      expect(image.width).toBe(Math.round(tile.width*devicePixelRatio));
      expect(image.height).toBe(Math.round(tile.height*devicePixelRatio));
      expect(image.width).toBe(tile.pixelWidth);expect(image.height).toBe(tile.pixelHeight);
      expect(tile.x).toBeGreaterThanOrEqual(bounds.x);expect(tile.y).toBeGreaterThanOrEqual(bounds.y);
      expect(tile.x+tile.width).toBeLessThanOrEqual(bounds.x+bounds.width);
      expect(tile.y+tile.height).toBeLessThanOrEqual(bounds.y+bounds.height);
    }
    for(let i=0;i<tiles.length;i++)for(let j=i+1;j<tiles.length;j++) {
      const a=tiles[i],b=tiles[j];
      expect(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y,'Tiles must not overlap').toBe(true);
    }
    expect(tiles.reduce((area,tile)=>area+tile.width*tile.height,0)).toBe(bounds.width*bounds.height);

    // Re-import only the WACZ with the origin offline, then render original tile
    // resources through the product's upstream-backed resource viewer.
    await studio.getByRole('button',{name:'Delete capture',exact:true}).click();
    for(const page of context.pages())if(page!==studio)await page.close();
    await context.setOffline(true);
    const live:string[]=[];context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url())});
    const choosing=studio.waitForEvent('filechooser');
    await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();
    await(await choosing).setFiles(archivePath);
    await openSnapshotOutput(studio,'search_contents');const search=studio.frameLocator('#main-frame-wrapper iframe[title="Search"]');
    await search.getByRole('searchbox',{name:'Search archived text'}).fill(commentWord);
    await expect(search.locator('.rows mark').first()).toBeVisible();
    await openSnapshotOutput(studio,'screenshot');
    const imported=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
    const frame=studio.frameLocator('#main-frame-wrapper iframe[title="Screenshot"]');
    await expect(frame.locator('img')).toHaveCount(images.length);
    await expect.poll(()=>frame.locator('img').evaluateAll(elements=>elements.map(element=>({width:(element as HTMLImageElement).naturalWidth,height:(element as HTMLImageElement).naturalHeight})))).toEqual(images.sort((a,b)=>a.metadata.screenshot.tile.index-b.metadata.screenshot.tile.index).map(image=>({width:image.width,height:image.height})));
    const replayOrigin=await studio.evaluate(()=>location.origin);
    const sources=await frame.locator('img').evaluateAll(elements=>elements.map(element=>(element as HTMLImageElement).src));
    for(const [index,source]of sources.entries()){
      expect(source.startsWith(replayOrigin+'/')).toBe(true);
      expect(source).toContain('/'+imported.id+'/');
      expect(decodeURIComponent(source).endsWith(images[index]!.url)).toBe(true);
    }
    const actualLayout=await frame.locator('img').evaluateAll(elements=>elements.map(element=>{const image=element as HTMLImageElement;return {left:image.style.left,top:image.style.top,width:image.style.width,height:image.style.height}}));
    // CSSOM serializes percentages to six significant digits. Original PNG
    // dimensions and full, nonoverlapping pixel coverage are checked above.
    for(const [index,tile] of tiles.entries()){const expected={left:100*(tile.x-bounds.x)/bounds.width,top:100*(tile.y-bounds.y)/bounds.height,width:100*tile.width/bounds.width,height:100*tile.height/bounds.height};for(const key of ['left','top','width','height'] as const)expect(parseFloat(actualLayout[index]![key])).toBeCloseTo(expected[key],3);}
    const thumbnail=studio.locator('.stack-tray .thumb-card[data-plugin-name="screenshot"] img.screenshot-thumbnail');
    expect(decodeURIComponent((await thumbnail.getAttribute('src'))!)).toContain(preview.url);
    await expect.poll(()=>thumbnail.evaluate((image:HTMLImageElement)=>({width:image.naturalWidth,height:image.naturalHeight}))).toEqual({width:jpeg.width,height:jpeg.height});
    await studio.screenshot({path:testInfo.outputPath('offline-screenshot-view.png')});
    expect(await studio.evaluate(()=>performance.getEntriesByName('archivebox:singlefile:start').length)).toBe(0);
    const dom=await openSnapshotOutput(studio,'dom');
    await expect(dom.frameLocator('iframe[title="Offline document"]').locator('body')).toContainText('I quit OpenAI');
    const singlefilePanel=await openSnapshotOutput(studio,'singlefile');
    const singlefile=singlefilePanel.frameLocator('iframe[title="Offline document"]');
    await expect(singlefile.locator('body')).toContainText('I quit OpenAI');
    await expect(singlefile.locator('img[src^="data:image/"]').first()).toBeVisible();
    expect(await studio.evaluate(()=>performance.getEntriesByName('archivebox:singlefile:start').length)).toBe(1);
    expect(await readFile(archivePath)).toEqual(before);
    expect(capture.hooks.filter((hook:any)=>['failed','killed'].includes(hook.status)),JSON.stringify(capture.hooks)).toEqual([]);
    expect(live).toEqual([]);
  } finally {await context.close();}
});
