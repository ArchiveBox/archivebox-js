import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {openSnapshotOutput} from './snapshot-controls';

for(const stop of [false,true])test(`all-plugin Browsertrix ${stop?'cooperative stop':'Telegram site behavior'}`,async({},info)=>{
 test.setTimeout(600000);
 const extension=path.resolve('.output/chrome-mv3'),context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-behavior-')),{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 const plugins=(await readdir('abx-plugins/abx_plugins/plugins',{withFileTypes:true})).filter(item=>item.isDirectory()).map(item=>item.name).sort();
 let capture:any;
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),studio=await context.newPage();await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
  await expect(studio.getByRole('button',{name:`${plugins.length} plugins`,exact:true})).toBeVisible();
  await studio.getByRole('textbox',{name:'Open URL',exact:true}).fill(stop?'https://news.ycombinator.com/item?id=49944227':'https://t.me/s/telegram/100');
  await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
  if(stop){
   await expect(studio.locator('.hook-row').filter({hasText:'on_Snapshot__47_browsertrix_behaviors.ts'}).locator('.hook-status')).toHaveText('running',{timeout:90000});
   await studio.getByRole('button',{name:'Stop capture',exact:true}).click();
  }
  await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:480000});
  capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
  const downloading=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();const file=info.outputPath('all-plugins.wacz');await(await downloading).saveAs(file);
  expect(capture.plugins.slice().sort()).toEqual(plugins);
  const hook=capture.hooks.find((hook:any)=>hook.plugin==='browsertrix_behaviors');expect(hook.status,JSON.stringify(hook)).toBe(stop?'killed':'succeeded');
  expect(hook.records.length).toBeGreaterThan(0);
  expect(hook.summary).toContain('Webrecorder Autofetcher, Autoplay, Autoclick');
  const zip=unzipSync(await readFile(file)),manifest=JSON.parse(new TextDecoder().decode(zip['datapackage.json']));
  const evidence=manifest.archivebox.files.find((file:any)=>file.metadata.plugin==='browsertrix_behaviors');expect(evidence).toBeTruthy();
  const activity=JSON.parse(new TextDecoder().decode(zip[evidence.path]));
  expect(activity.behaviors).toEqual(['Autofetcher','Autoplay','Autoclick',stop?'Autoscroll':'Telegram']);
  expect(activity.errors).toEqual([]);
  if(stop){expect(activity.cancelled).toBe(true);expect(capture.state).toBe('partial');}
  else{
   expect(activity.steps).toBeGreaterThan(0);expect(activity.logs.some((log:any)=>log.siteSpecific&&log.msg?.startsWith('Loading Message:'))).toBe(true);
   await openSnapshotOutput(studio,'browsertrix_behaviors');await expect(studio.frameLocator('#main-frame-wrapper iframe[title="Browser Behaviors"]').locator('.row').first()).toBeVisible();
   await studio.screenshot({path:info.outputPath('browsertrix-full.png')});
  }
 }finally{await writeFile(info.outputPath('capture.json'),JSON.stringify(capture,null,2));await context.close()}
});
