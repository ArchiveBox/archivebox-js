import {readWaczPackage} from './wacz-evidence';
import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';
import {openSnapshotOutput} from './snapshot-controls';
import {inspectWaczEvidence,verifyReplayPayloads} from './wacz-evidence';

test('all plugins capture Commons and replay gallery, screenshot and metadata offline',async({},info)=>{
  test.setTimeout(900000);
  const url='https://commons.wikimedia.org/wiki/Category:Paintings_by_Claude_Monet_in_Tel_Aviv_Museum_of_Art';
  const retained=process.env.ABX_ALL_PLUGINS_CAPTURE;
  const native=retained?await readFile(path.join(retained,'native-gallery.json'),'utf8'):execFileSync('uv',['run','--no-project','--with','gallery-dl==1.32.15','gallery-dl','--ignore-config','--resolve-json',url],{encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024});
  await writeFile(info.outputPath('native-gallery.json'),native);
  const originals=JSON.parse(native).filter((message:any[])=>message[0]===3);
  expect(originals.length).toBeGreaterThan(5);
  const originalBytes=originals.reduce((total:number,message:any[])=>total+Number(message[2].size),0);
  expect(originalBytes).toBeGreaterThan(128*1024*1024);
  // Allow all native originals plus API responses within a whole 64 MiB block.
  const galleryBudget=Math.ceil((originalBytes+16*1024*1024)/(64*1024*1024))*64*1024*1024;
  const pluginRoot=path.resolve('abx-plugins/abx_plugins/plugins');
  const expectedPlugins=(await readdir(pluginRoot,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();
  expect(expectedPlugins).toHaveLength(46);
  const extension=path.resolve('.output/chrome-mv3');
  const context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-all-plugins-')),{channel:'chromium',headless:true,acceptDownloads:true,viewport:{width:1440,height:1100},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const browserErrors:string[]=[],offlineHTTP:string[]=[];
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),studio=await context.newPage();
    studio.on('pageerror',error=>browserErrors.push(String(error)));
    await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    await studio.getByRole('button',{name:'46 plugins',exact:true}).click();
    const rows=studio.locator('.plugin-option');await expect(rows).toHaveCount(46);
    const selections=[];for(const row of await rows.all()){const checkbox=row.locator('label').first().getByRole('checkbox');await expect(checkbox).toBeChecked();selections.push(await row.locator('strong').innerText());}
    await expect(studio.locator('.plugin-settings .section-heading')).toContainText('25 numbered hooks');
    await expect(studio.getByRole('textbox',{name:'GALLERYDL_CONFIG',exact:true})).toHaveValue('{}');
    await studio.getByRole('spinbutton',{name:'GALLERYDL_MAX_BYTES',exact:true}).fill(String(galleryBudget));
    await writeFile(info.outputPath('selected-plugins.json'),JSON.stringify(selections,null,2));
    await studio.getByRole('button',{name:'46 plugins',exact:true}).click();
    let capture:any,archivePath:string;
    if(retained){
      capture=JSON.parse(await readFile(path.join(retained,'capture.json'),'utf8'));archivePath=path.join(retained,'commons-all-plugins.wacz');
      const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);
      await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:90000});
    }else{
    await studio.getByRole('textbox',{name:'Open URL',exact:true}).fill(url);
    await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
    try{await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:720000});}
    catch(error){await writeFile(info.outputPath('unfinished-capture.json'),JSON.stringify(await studio.evaluate(async()=>await chrome.storage.local.get('wacz-captures')),null,2));await studio.screenshot({path:info.outputPath('unfinished-capture.png'),fullPage:true});throw error;}
    capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
    await writeFile(info.outputPath('capture.json'),JSON.stringify(capture,null,2));
    const downloading=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();
    archivePath=info.outputPath('commons-all-plugins.wacz');await(await downloading).saveAs(archivePath);
    console.log('EXPORTED_ALL_PLUGINS_WACZ '+archivePath);
    }
    const failedHooks=capture.hooks.filter((hook:any)=>['failed','killed'].includes(hook.status));
    await writeFile(info.outputPath('hook-results.json'),JSON.stringify({state:capture.state,hooks:capture.hooks,failedHooks},null,2));
    console.log('ALL_PLUGIN_HOOK_RESULTS '+JSON.stringify(capture.hooks.map((hook:any)=>({plugin:hook.plugin,hook:hook.hook,status:hook.status,summary:hook.summary}))));
    expect(capture.plugins.slice().sort()).toEqual(expectedPlugins);expect(capture.hooks).toHaveLength(25);
    expect(capture.hooks.filter((hook:any)=>['pending','running'].includes(hook.status))).toEqual([]);
    for(const plugin of ['gallerydl','screenshot','sslcerts','accessibility','dom'])expect(capture.hooks.find((hook:any)=>hook.plugin===plugin)?.status,plugin).toBe('succeeded');
    const evidence=await inspectWaczEvidence(archivePath);await writeFile(info.outputPath('warc-evidence.json'),JSON.stringify(evidence,null,2));
    const zip=unzipSync(await readFile(archivePath));
    const savedPackage=(await readWaczPackage(zip));
    expect(savedPackage.metadata.plugins.map((plugin:any)=>plugin.id).sort()).toEqual(expectedPlugins);
    let screenshotCount=0,sslConnections=0,axNodes=0;const screenshotURLs:string[]=[],fullPageURLs:string[]=[];
    for(const [name,bytes]of Object.entries(zip)){if(!name.startsWith('archive/'))continue;for await(const record of new WARCParser([bytes])){const body=await record.readFully(),target=record.warcTargetURI||'';
      if(/^urn:(fullPage|fullPageFinal|view|thumbnail):/.test(target)){screenshotCount++;screenshotURLs.push(target);if(/^urn:(fullPage|fullPageFinal):/.test(target))fullPageURLs.push(target);if(record.warcType!=='revisit')expect(Buffer.from(body).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))).toBe(true);}
      if(target.startsWith('urn:sslcerts:'))sslConnections+=JSON.parse(new TextDecoder().decode(body)).connections.length;
      if(target.startsWith('urn:accessibility:'))axNodes+=JSON.parse(new TextDecoder().decode(body)).nodes.length;
    }}
    expect(screenshotCount).toBeGreaterThan(0);expect(sslConnections).toBeGreaterThan(0);expect(axNodes).toBeGreaterThan(10);
    await studio.getByRole('button',{name:'Delete capture',exact:true}).click();await expect(studio.locator('.stack-shelf')).toHaveCount(0);await expect.poll(()=>studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[]).length)).toBe(0);for(const page of context.pages())if(page!==studio)await page.close();
    await context.setOffline(true);context.on('request',request=>{if(/^https?:/.test(request.url()))offlineHTTP.push(request.url())});
    const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);
    await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:90000});
    await expect(studio.locator('.stack-shelf')).toBeVisible({timeout:90000});
    const imported=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
    const records=await verifyReplayPayloads(studio,imported.id);
    const references=capture.hooks.flatMap((hook:any)=>hook.records||[]);
    const headerFailures=await studio.evaluate(async({id,references})=>{const failures=[];for(const ref of references){const response=await chrome.runtime.sendMessage({type:'wacz-record',id,url:ref.url,ts:ref.ts});if(!response?.ok||!Object.keys(response.headers||{}).length)failures.push({ref,response});}return failures;},{id:imported.id,references});
    expect(headerFailures,'Every preserved hook response retains replay headers').toEqual([]);
    await openSnapshotOutput(studio,'gallerydl');const gallery=studio.frameLocator('#main-frame-wrapper iframe[title="Image gallery"]');
    await expect(gallery.locator('#count')).toHaveText(`${originals.length} images`,{timeout:90000});const images=gallery.locator('#gallery .tile img');await expect(images).toHaveCount(originals.length);
    for(let i=0;i<originals.length;i++)expect((await images.nth(i).getAttribute('src'))?.endsWith(originals[i][1])).toBe(true);
    await expect.poll(()=>images.evaluateAll(images=>images.every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0)),{timeout:60000}).toBe(true);
    await studio.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await studio.screenshot({path:info.outputPath('all-plugins-gallery.png'),fullPage:true});
    await openSnapshotOutput(studio,'screenshot');const screenshotImages=studio.frameLocator('#main-frame-wrapper iframe[title="Screenshot"]').locator('img.screenshot-fullscreen');const displayedScreenshots=fullPageURLs.length?fullPageURLs:screenshotURLs;await expect(screenshotImages).toHaveCount(displayedScreenshots.length);for(const target of displayedScreenshots)expect(await screenshotImages.evaluateAll(images=>images.map(image=>(image as HTMLImageElement).src))).toContainEqual(expect.stringContaining(target));
    await expect.poll(()=>screenshotImages.evaluateAll(images=>images.every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0))).toBe(true);await studio.screenshot({path:info.outputPath('all-plugins-screenshot.png'),fullPage:true});
    await openSnapshotOutput(studio,'seo');const seo=studio.frameLocator('#main-frame-wrapper iframe[title="SEO"]');await expect(seo.locator('.link-copy h2')).toContainText('Claude Monet');await studio.screenshot({path:info.outputPath('all-plugins-seo.png'),fullPage:true});
    await openSnapshotOutput(studio,'sslcerts');const ssl=studio.frameLocator('#main-frame-wrapper iframe[title="SSL Certificates"]');await expect(ssl.locator('.cert.leaf').first()).toBeVisible();await expect(ssl.locator('.session').first()).toContainText('TLS');await studio.screenshot({path:info.outputPath('all-plugins-ssl.png'),fullPage:true});
    await openSnapshotOutput(studio,'accessibility');const accessibility=studio.frameLocator('#main-frame-wrapper iframe[title="Accessibility"]');await expect(accessibility.getByRole('heading',{name:'Page semantics',exact:true})).toBeVisible();await expect(accessibility.locator('.outline-row').first()).toBeVisible();await studio.screenshot({path:info.outputPath('all-plugins-accessibility.png'),fullPage:true});
    await writeFile(info.outputPath('verification.json'),JSON.stringify({archivePath,plugins:capture.plugins,hooks:capture.hooks.length,records,screenshotCount,sslConnections,axNodes,failedHooks,browserErrors,offlineHTTP},null,2));
    expect(offlineHTTP).toEqual([]);expect(browserErrors).toEqual([]);expect(failedHooks).toEqual([]);
  }finally{await context.close();}
});
