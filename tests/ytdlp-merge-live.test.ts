import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {unzipSync} from 'fflate';
import {openSnapshotOutput} from './snapshot-controls';

// Public DASH-IF player and Big Buck Bunny originals, not test-generated media.
test('all-plugin DASH capture merges selected tracks offline with upstream FFmpeg',async({},info)=>{
 test.setTimeout(900000);
 const url='https://reference.dashif.org/dash.js/latest/samples/getting-started/auto-load-single-video.html';
 const extension=path.resolve('.output/chrome-mv3');
 const plugins=(await readdir('abx-plugins/abx_plugins/plugins',{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();
 const context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-ytdlp-merge-')),{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--autoplay-policy=no-user-gesture-required']});
 context.setDefaultTimeout(30000);
 let capture:any,timer:ReturnType<typeof setInterval>|undefined;const errors:string[]=[],requests:string[]=[];
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),studio=await context.newPage();
  studio.on('pageerror',error=>errors.push(String(error)));
  await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
  await studio.getByRole('button',{name:`${plugins.length} plugins`,exact:true}).click();
  for(const row of await studio.locator('.plugin-option').all())await expect(row.locator('label').first().getByRole('checkbox')).toBeChecked();
  // Exercise the real configurable upstream format selector without downloading
  // the demo's default 4K movie. Every plugin remains enabled.
  await studio.getByRole('textbox',{name:'YTDLP_FORMAT',exact:true}).fill('bv*[height<=240]+ba/b');
  await studio.getByRole('button',{name:`${plugins.length} plugins`,exact:true}).click();
  let archivePath=process.env.ABX_YTDLP_MERGE_CAPTURE;
  if(!archivePath){
   await studio.getByRole('textbox',{name:'Open URL',exact:true}).fill(url);
   await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
   let phase='';timer=setInterval(()=>{void studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])?.[0]).then(value=>{if(!value)return;capture=value;const next=JSON.stringify({state:value.state,running:value.hooks.filter((hook:any)=>hook.status==='running').map((hook:any)=>hook.plugin),failed:value.hooks.filter((hook:any)=>hook.status==='failed').map((hook:any)=>({plugin:hook.plugin,summary:hook.summary}))});if(next!==phase){phase=next;console.log(next)}}).catch(()=>{})},15000);
   await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:780000});
   clearInterval(timer);timer=undefined;
   capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
   await writeFile(info.outputPath('capture.json'),JSON.stringify(capture,null,2));
   expect(capture.plugins.slice().sort()).toEqual(plugins);
   const hook=capture.hooks.find((hook:any)=>hook.plugin==='ytdlp');expect(hook.status,JSON.stringify(hook)).toBe('succeeded');
   const downloading=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();
   archivePath=info.outputPath('dash-if-all-plugins.wacz');await(await downloading).saveAs(archivePath);
   await studio.getByRole('button',{name:'Delete capture',exact:true}).click();
  }
  const zip=unzipSync(await readFile(archivePath));
  expect(Object.keys(zip).filter(name=>/^ytdlp\/.*\.(webm|mp4|mkv)$/.test(name)),'No merged media duplicate is stored in the WACZ').toEqual([]);
  for(const page of context.pages())if(page!==studio)await page.close();
  await context.setOffline(true);context.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url())});
  const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);
  await expect(studio.locator('.stack-shelf')).toBeVisible({timeout:90000});
  await openSnapshotOutput(studio,'ytdlp');
  const media=studio.frameLocator('#main-frame-wrapper iframe[title="Archived media"]');
  await expect(media.locator('#count')).toContainText('1 item · 1 playable',{timeout:90000});
  const video=media.locator('video');
  await expect.poll(()=>video.evaluate((element:HTMLVideoElement)=>Number.isFinite(element.duration)?element.duration:0),{timeout:90000}).toBeGreaterThan(30);
  await video.evaluate((element:HTMLVideoElement)=>{element.muted=true;return element.play()});
  await expect.poll(()=>video.evaluate((element:HTMLVideoElement)=>element.currentTime)).toBeGreaterThan(1);
  expect(await video.evaluate((element:HTMLVideoElement)=>element.videoWidth)).toBeGreaterThan(300);
  const downloading=studio.waitForEvent('download');await media.locator('#download').click();const download=await downloading;
  expect(download.suggestedFilename()).toBe('auto-load-single-video-1.mp4');await download.saveAs(info.outputPath('merged.mp4'));
  expect((await readFile(info.outputPath('merged.mp4'))).length).toBeGreaterThan(1000000);
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',info.outputPath('merged.mp4')],{encoding:'utf8'}));
  await writeFile(info.outputPath('ffprobe.json'),JSON.stringify(probe,null,2));
  expect(probe.streams.map((stream:any)=>[stream.codec_type,stream.codec_name])).toEqual([['video','h264'],['audio','aac']]);
  expect(Number(probe.format.duration)).toBeGreaterThan(30);
  await studio.screenshot({path:info.outputPath('offline-media.png')});
  expect(requests).toEqual([]);expect(errors).toEqual([]);
 }finally{if(timer)clearInterval(timer);await writeFile(info.outputPath('verification.json'),JSON.stringify({capture,errors,requests},null,2));await context.close()}
});
