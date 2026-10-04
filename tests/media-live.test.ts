import {openSnapshotOutput} from './snapshot-controls';
import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
// Public original players/media, never replacement pages or intercepted responses.
const sites=[
  {name:'embedded-direct',url:'https://www.w3schools.com/html/html5_video.asp',stream:false},
  {name:'hls',url:'https://hlsjs.video-dev.org/demo/?src=https%3A%2F%2Ftest-streams.mux.dev%2Fx36xhzz%2Fx36xhzz.m3u8',stream:true},
  {name:'dash',url:'https://reference.dashif.org/dash.js/latest/samples/dash-if-reference-player/index.html?mpd=https%3A%2F%2Fdash.akamaized.net%2Fakamai%2Fbbb_30fps%2Fbbb_30fps.mpd',stream:true},
];
for(const site of sites)test(`real ${site.name} media capture and offline playback through end`,async({},info)=>{
  test.setTimeout(300000);
  const extension=path.resolve('.output/chrome-mv3');
  const profile=await mkdtemp(path.join(tmpdir(),'abx-media-'));
  const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--autoplay-policy=no-user-gesture-required']});
  const report:Record<string,unknown>={site,profile};
  try {
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const studio=await context.newPage();await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    await studio.getByRole('button',{name:/^\d+ plugins$/}).click();
    for(const row of await studio.locator('.plugin-option').all()) {
      const box=row.locator('label').first().getByRole('checkbox');if(!await box.isDisabled())await box.setChecked(['Embedded media','Rendered DOM'].includes(await row.locator('strong').innerText()));
    }
    const option=studio.locator('.plugin-option').filter({has:studio.locator('strong').filter({hasText:/^Embedded media$/})});
    await option.locator('.config-field').filter({hasText:'Fetch discovered direct media'}).getByRole('checkbox').check();
    await studio.getByRole('spinbutton',{name:'MEDIA_MAX_MB',exact:true}).fill('512');
    await studio.getByRole('spinbutton',{name:'MEDIA_MAX_URLS',exact:true}).fill('1500');
    await studio.getByRole('textbox',{name:'Open URL'}).fill(site.url);
    await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
    await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:220000});
    const capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);report.capture=capture;
    const download=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();
    const archive=info.outputPath(`${site.name}.wacz`);await(await download).saveAs(archive);
    expect(capture.state,JSON.stringify(capture)).toBe('complete');
    const hook=capture.hooks.find((hook:any)=>hook.plugin==='media');expect(hook.status,JSON.stringify(hook)).toBe('succeeded');
    expect(hook.records.length).toBeGreaterThan(site.stream?50:0);
    expect(hook.records.every((ref:any)=>/^https?:/.test(ref.url))).toBe(true);
    await studio.getByRole('button',{name:'Delete capture',exact:true}).click();
    for(const page of context.pages())if(page!==studio)await page.close();
    await context.setOffline(true);const live:string[]=[];
    context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url());});
    const chooser=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await chooser).setFiles(archive);
    await openSnapshotOutput(studio,'media');
    await expect(studio.locator('#main-frame-wrapper .plugin-view > h2')).toHaveText('Embedded media');
    await expect(studio.locator('#main-frame-wrapper .plugin-view > .muted')).toContainText('0 missing selected dependencies');
    const video=studio.locator('#main-frame-wrapper .plugin-view video').first();await expect(video).toBeVisible();
    await expect.poll(()=>video.evaluate((element:HTMLVideoElement)=>Number.isFinite(element.duration)?element.duration:0),{timeout:30000}).toBeGreaterThan(5);
    const duration=await video.evaluate((element:HTMLVideoElement)=>element.duration);report.duration=duration;
    await video.evaluate((element:HTMLVideoElement)=>{element.muted=true;return element.play();});
    await expect.poll(()=>video.evaluate((element:HTMLVideoElement)=>element.currentTime)).toBeGreaterThan(1);
    await video.evaluate((element:HTMLVideoElement)=>{element.currentTime=element.duration-2;return element.play();});
    await expect.poll(()=>video.evaluate((element:HTMLVideoElement)=>element.ended),{timeout:20000}).toBe(true);
    expect(await video.evaluate((element:HTMLVideoElement)=>element.videoWidth)).toBeGreaterThan(100);
    await expect(studio.locator('#main-frame-wrapper .plugin-view .error')).toHaveCount(0);
    expect(live).toEqual([]);report.liveRequests=live;
    await studio.screenshot({path:info.outputPath('offline-playback.png')});
  }finally{await writeFile(info.outputPath('media-report.json'),JSON.stringify(report,null,2));await context.close();}
});
