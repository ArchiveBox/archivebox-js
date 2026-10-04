import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openSnapshotOutput} from './snapshot-controls';
import {inspectWaczEvidence,verifyReplayPayloads} from './wacz-evidence';

const sites=[
 {name:'sweeting',url:'https://sweeting.me',plugin:'ytdlp'},
 {name:'hacker-news-49944227',url:'https://news.ycombinator.com/item?id=49944227',plugin:'forumdl'},
 {name:'zfsify',url:'https://github.com/pirate/zfsify',plugin:'git'},
];
for(const site of sites)test(`requested all-plugin capture ${site.name}`,async({},info)=>{
 test.setTimeout(900000);
 const root=path.resolve('abx-plugins/abx_plugins/plugins');
 const plugins=(await readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();
 const hookNames=(await Promise.all(plugins.map(async plugin=>{try{return (await readdir(path.join(root,plugin,'browser'))).filter(name=>/^on_.*\.ts$/.test(name)).map(name=>({plugin,name}))}catch{return []}}))).flat();
 expect(plugins).toContain('git');
 const extension=path.resolve('.output/chrome-mv3');
 const context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),`abx-requested-${site.name}-`)),{channel:'chromium',headless:true,acceptDownloads:true,viewport:{width:1440,height:1100},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 const errors:string[]=[],offlineHTTP:string[]=[];let capture:any,archivePath='',timer:ReturnType<typeof setInterval>|undefined;
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),studio=await context.newPage();
  studio.on('pageerror',error=>errors.push(String(error)));
  await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
  await studio.getByRole('button',{name:`${plugins.length} plugins`,exact:true}).click();
  const rows=studio.locator('.plugin-option');await expect(rows).toHaveCount(plugins.length);
  for(const row of await rows.all())await expect(row.locator('label').first().getByRole('checkbox')).toBeChecked();
  if(site.plugin==='forumdl')await studio.getByRole('spinbutton',{name:'FORUMDL_MAX_REQUESTS',exact:true}).fill('1000');
  await studio.getByRole('button',{name:`${plugins.length} plugins`,exact:true}).click();
  if(process.env.ABX_REQUESTED_CAPTURE){
   archivePath=process.env.ABX_REQUESTED_CAPTURE;
   const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);
   await expect(studio.locator('.stack-shelf')).toBeVisible({timeout:90000});
  }else{
   await studio.getByRole('textbox',{name:'Open URL',exact:true}).fill(site.url);
   await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
   let last='';timer=setInterval(()=>{void studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])?.[0]).then(value=>{if(!value)return;capture=value;const current=JSON.stringify({state:value.state,hooks:value.hooks.map((hook:any)=>({plugin:hook.plugin,status:hook.status,summary:hook.summary,log:hook.logs?.at(-1)}))});if(current!==last){last=current;console.log(site.name+' '+current)}}).catch(()=>{})},10000);
   await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:780000});
   clearInterval(timer);timer=undefined;
   const downloading=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();archivePath=info.outputPath(`${site.name}-all-plugins.wacz`);await(await downloading).saveAs(archivePath);
   console.log('REQUESTED_WACZ '+archivePath);
   const tab=context.pages().find(page=>page!==studio&&page.url().startsWith(site.url));
   expect(tab,'Original capture tab remains open').toBeDefined();
   const world=await tab!.evaluate(()=>({behaviors:typeof (self as any).__bx_behaviors,binding:typeof (self as any).__bx_log,jsonStringify:typeof JSON.stringify}));
   await writeFile(info.outputPath('page-world.json'),JSON.stringify(world,null,2));
   expect(world.behaviors,'Recorder behaviors must be isolated from page scripts').toBe('undefined');
   expect(world.binding,'Recorder bindings must not be exposed to page scripts').toBe('undefined');
   if(site.name==='sweeting')expect(world.jsonStringify,'Preserve the real page MooTools JSON global').toBe('undefined');
  }
  capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
  await writeFile(info.outputPath('capture.json'),JSON.stringify(capture,null,2));
  expect(capture.plugins.slice().sort()).toEqual(plugins);expect(capture.hooks).toHaveLength(hookNames.length);
  expect(capture.hooks.filter((hook:any)=>['running','pending'].includes(hook.status))).toEqual([]);
  const evidence=await inspectWaczEvidence(archivePath);await writeFile(info.outputPath('warc-evidence.json'),JSON.stringify(evidence,null,2));
  await studio.getByRole('button',{name:'Delete capture',exact:true}).click();await expect(studio.locator('.stack-shelf')).toHaveCount(0);
  for(const page of context.pages())if(page!==studio)await page.close();
  await context.setOffline(true);context.on('request',request=>{if(/^https?:/.test(request.url()))offlineHTTP.push(request.url())});
  const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);await expect(studio.locator('.stack-shelf')).toBeVisible({timeout:90000});
  const imported=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
  const records=await verifyReplayPayloads(studio,imported.id);
  await openSnapshotOutput(studio,'screenshot');const screenshot=studio.frameLocator('#main-frame-wrapper iframe[title="Screenshot"]');
  await expect(screenshot.locator('img.screenshot-fullscreen').first()).toBeVisible();await expect.poll(()=>screenshot.locator('img').evaluateAll(images=>images.every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0))).toBe(true);
  await studio.screenshot({path:info.outputPath('screenshot.png'),fullPage:true});
  for(const plugin of ['seo','sslcerts','accessibility','responses',site.plugin]){
   const panel=await openSnapshotOutput(studio,plugin);await expect(panel.locator(':scope > .loading')).toHaveCount(0,{timeout:90000});await expect(panel.locator('[role="alert"]')).toHaveCount(0);await expect(panel.locator('.error')).toHaveCount(0);
   if(plugin==='forumdl'){const forum=panel.frameLocator('iframe[title="Forum thread"]');await expect(forum.locator('.thread-title')).not.toBeEmpty({timeout:90000});await expect(forum.locator('.comment').first()).toBeVisible();expect(await forum.locator('.comment').count()).toBeGreaterThan(400);await panel.hover();await studio.mouse.wheel(0,100000);await expect.poll(()=>panel.evaluate(element=>element.scrollTop)).toBeGreaterThan(1000);await expect(forum.locator('.comment').last()).toBeInViewport();}
   if(plugin==='ytdlp'){const media=panel.frameLocator('iframe[title="Archived media"]');await expect(media.locator('.brand')).toContainText('YT-DLP');await writeFile(info.outputPath('media-view.txt'),await media.locator('body').innerText());}
   await studio.screenshot({path:info.outputPath(`${plugin}.png`),fullPage:true});
  }
  const failedHooks=capture.hooks.filter((hook:any)=>['failed','killed'].includes(hook.status));
  await writeFile(info.outputPath('verification.json'),JSON.stringify({archivePath,plugins:capture.plugins,records,failedHooks,errors,offlineHTTP},null,2));
  expect(offlineHTTP).toEqual([]);expect(errors).toEqual([]);expect(failedHooks,JSON.stringify(failedHooks)).toEqual([]);expect(capture.state).toBe('complete');
 }finally{if(timer)clearInterval(timer);await writeFile(info.outputPath('last-capture-state.json'),JSON.stringify({archivePath,capture,errors,offlineHTTP},null,2));await context.close()}
});
