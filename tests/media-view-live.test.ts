import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';
const fixtures=[
 {name:'captions',file:'/tmp/abx-parent-build8-20261004/ytdlp-live-upstream-yt-dlp-WASM-captions/captions.wacz',empty:false},
 {name:'commons',file:'/tmp/abx-all-plugins-commons-build14-20261004/all-plugins-live-all-plugi-ef16b-enshot-and-metadata-offline/commons-all-plugins.wacz',empty:true},
];
for(const fixture of fixtures)test(`canonical YT-DLP ${fixture.name} offline player`,async({},info)=>{
 const extension=path.resolve('.output/chrome-mv3'),profile=await mkdtemp(path.join(tmpdir(),'abx-media-view-'));
 const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);await context.setOffline(true);
  const live:string[]=[];const leaks:Promise<unknown>[]=[];context.on('request',request=>{if(/^https?:/.test(request.url())){live.push(request.url());try{leaks.push(request.frame().evaluate(()=>({url:location.href,base:document.baseURI,html:document.documentElement.outerHTML})).then(frame=>({request:request.url(),frame})).catch(error=>String(error)))}catch{}}});
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await chooser).setFiles(fixture.file);await expect(page.locator('.stack-shelf')).toBeVisible();
  const started=Date.now();const python:string[]=[];page.on('request',request=>{if(/\/pyodide\/.*(?:wasm|pyodide\.mjs)/.test(request.url()))python.push(request.url())});
  await page.goto(page.url().split('#')[0]+'#view=ytdlp');
  const player=page.locator('#main-frame-wrapper .plugin-view').frameLocator('iframe[title="Archived media"]');
  await expect(player.locator('.brand')).toContainText('YT-DLP',{timeout:20_000});
  if(fixture.empty){await expect(player.locator('#stage')).toHaveText('No archived video or audio files found.');await expect(player.locator('#queue .item')).toHaveCount(0);expect(Date.now()-started).toBeLessThan(5000);expect(python).toEqual([]);}
  else{
   const native=JSON.parse(await readFile('/tmp/abx-parent-build8-20261004/ytdlp-live-upstream-yt-dlp-WASM-captions/native-info.json','utf8'));
   await expect(player.locator('#title')).toHaveText(native.title);
   await expect(player.locator('#language option')).toHaveCount(3);await expect(player.locator('#transcript .cue')).not.toHaveCount(0);
   const video=player.locator('video');await expect.poll(()=>video.evaluate(element=>(element as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
   const bounds=await video.boundingBox();expect(bounds).toBeTruthy();await video.click({position:{x:25,y:bounds!.height-48}});
   await page.screenshot({path:info.outputPath('playback.png'),fullPage:true});
   await expect.poll(()=>video.evaluate(element=>(element as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
   await player.locator('#language').selectOption({label:'manual.de.vtt'});await expect(player.locator('#transcript .cue')).not.toHaveCount(0);
   const download=page.waitForEvent('download');await player.locator('#subtitle-download').click();const saved=info.outputPath('subtitle.vtt');await(await download).saveAs(saved);
   const zip=unzipSync(await readFile(fixture.file));let subtitle:Uint8Array|undefined,media:Uint8Array|undefined;
   for(const [name,data]of Object.entries(zip))if(name.startsWith('archive/'))for await(const record of new WARCParser([data])){const body=await record.readFully();if(record.warcType==='response'&&record.warcTargetURI?.endsWith('sintel-de.vtt'))subtitle=body;if(record.warcType==='response'&&record.warcTargetURI?.endsWith('sintel-short.mp4'))media=body;}
   expect(subtitle).toBeTruthy();expect(await readFile(saved)).toEqual(Buffer.from(subtitle!));
   const cue=player.locator('#transcript .cue').nth(2),stamp=await cue.locator('time').innerText(),seconds=stamp.split(':').reduce((total,part)=>total*60+Number(part),0);await cue.click();await expect.poll(()=>video.evaluate(element=>(element as HTMLVideoElement).currentTime)).toBeGreaterThanOrEqual(seconds);
   const mediaDownload=page.waitForEvent('download');await player.locator('#download').click();const savedMedia=info.outputPath('video.mp4');await(await mediaDownload).saveAs(savedMedia);expect(media).toBeTruthy();expect(await readFile(savedMedia)).toEqual(Buffer.from(media!));
   await writeFile(info.outputPath('media-evidence.json'),JSON.stringify({title:await player.locator('#title').innerText(),subtitleBytes:subtitle!.length,live},null,2));
  }
  await page.screenshot({path:info.outputPath('media.png'),fullPage:true});await writeFile(info.outputPath('http-leaks.json'),JSON.stringify(await Promise.all(leaks),null,2));expect(live).toEqual([]);
 }finally{await context.close()}
});
