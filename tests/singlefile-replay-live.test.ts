import {test,expect,chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {openSnapshotOutput} from './snapshot-controls';
const root='http://127.0.0.1:8736/';

test('cards summarize HN without starting full extractors or building hidden reports',async({},info)=>{
 const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage();
 const requests:string[]=[];page.on('request',request=>requests.push(request.url()));
 try{
  await page.goto(root+'?source='+encodeURIComponent('http://127.0.0.1:8737/hacker-news-49944227-all-plugins-scroll-20261004.wacz')+'#view=screenshot');
  const accessibilityCard=page.locator('.output-stack-metadata iframe[data-plugin-preview="accessibility"]').contentFrame().frameLocator('iframe');
  await expect(accessibilityCard.locator('body')).toContainText('28316');
  expect(await accessibilityCard.locator('*').count()).toBeLessThan(80);
  const forumCard=page.locator('.output-stack-embedded_media iframe[data-plugin-preview="forumdl"]').contentFrame().frameLocator('iframe');
  await expect(forumCard.locator('body')).toContainText('I quit OpenAI');
  await expect(forumCard.locator('.comment')).toHaveCount(3);
  await page.locator('.output-stack-html').click();
  const singlefileCard=page.locator('.stack-tray iframe[data-plugin-preview="singlefile"]').contentFrame();
  await expect(singlefileCard.locator('body')).toContainText('I quit OpenAI');
  expect(await page.evaluate(()=>performance.getEntriesByType('mark').filter(entry=>entry.name==='archivebox:singlefile:start').length)).toBe(0);
  expect(requests.filter(url=>/urn%3Aaccessibility|hacker-news-api|firebaseio|pyodide|python-sandbox/.test(url))).toEqual([]);
  await page.screenshot({path:info.outputPath('cheap-cards.png')});
  const panel=await openSnapshotOutput(page,'accessibility'),full=panel.frameLocator('iframe[title="Accessibility"]');
  await expect(full.locator('.badges').first()).toContainText('28316 AX nodes');
  const branch=full.locator('.ax details:not([open]) > summary').filter({visible:true}).first();
  const summary=await branch.elementHandle();expect(await summary!.evaluate(element=>element.parentElement!.querySelectorAll(':scope > ul').length)).toBe(0);await summary!.click();await expect.poll(()=>summary!.evaluate(element=>element.parentElement!.querySelectorAll(':scope > ul > li').length)).toBe(1);
  await writeFile(info.outputPath('requests.json'),JSON.stringify(requests));
 }finally{await browser.close()}
});

test('SingleFile opens the complete HN thread promptly on cold and repeated loads',async({},info)=>{
 const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage();
 const timings:unknown[]=[];
 try{
  const cdp=process.env.ABX_PROFILE_SINGLEFILE?await page.context().newCDPSession(page):undefined;
  if(cdp){await cdp.send('Profiler.enable');await cdp.send('Profiler.start')}
  for(const load of ['cold','reload']){
   const started=Date.now();
   if(load==='cold')await page.goto(root+'?source='+encodeURIComponent('http://127.0.0.1:8737/hacker-news-49944227-all-plugins-scroll-20261004.wacz')+'#view=singlefile',{waitUntil:'domcontentloaded'});
   else await page.reload({waitUntil:'domcontentloaded'});
   const frame=page.locator('#main-frame-wrapper .plugin-view[data-plugin="singlefile"] iframe[title="Offline document"]').contentFrame();
   await expect(frame.locator('body')).toContainText('I quit OpenAI');
   await expect(frame.locator('img[src^="data:image/"]').first()).toBeVisible();
   const duration=Date.now()-started;
   timings.push({load,duration,marks:await page.evaluate(()=>performance.getEntriesByType('measure').filter(entry=>entry.name.startsWith('archivebox:')).map(entry=>({name:entry.name,start:entry.startTime,duration:entry.duration})))});
  }
  if(cdp)await writeFile(info.outputPath('singlefile.cpuprofile'),JSON.stringify((await cdp.send('Profiler.stop')).profile));
  await writeFile(info.outputPath('timings.json'),JSON.stringify(timings,null,2));
  for(const timing of timings as {load:string;duration:number}[])expect(timing.duration,`${timing.load} SingleFile display time`).toBeLessThan(5000);
 }finally{await browser.close()}
});

test('ArchiveWebpage card and stack cover show the archived HTML',async({},info)=>{
 const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage();
 try{
  await page.goto(root+'?source='+encodeURIComponent('http://127.0.0.1:8737/hacker-news-49944227-all-plugins-scroll-20261004.wacz')+'#view=dom');
  await openSnapshotOutput(page,'dom');
  const card=page.locator('.stack-tray .thumb-card[data-plugin-name="archivewebpage"] iframe[data-plugin-preview]');
  await expect(card).toBeVisible();
  const replay=card.contentFrame();
  await expect(replay.locator('body')).toContainText('I quit OpenAI');
  const cover=page.locator('.output-stack-html iframe[data-plugin-preview="archivewebpage"]');
  await expect(cover.contentFrame().locator('body')).toContainText('I quit OpenAI');
  await page.screenshot({path:info.outputPath('html-previews.png')});
 }finally{await browser.close()}
});

test('SingleFile engine inlines real WACZ assets into a standalone downloadable HTML',async({},info)=>{
 const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage({acceptDownloads:true});
 const external:string[]=[];page.context().on('request',request=>{if(/^https?:/.test(request.url())&&!['http://127.0.0.1:8736','http://127.0.0.1:8737'].includes(new URL(request.url()).origin))external.push(request.url())});
 try{
  await page.goto(root+'?source='+encodeURIComponent('http://127.0.0.1:8737/sweeting-all-plugins-20261004.wacz')+'#view=singlefile',{waitUntil:'domcontentloaded'});
  const panel=await openSnapshotOutput(page,'singlefile'),frame=panel.frameLocator('iframe[title="Offline document"]');
  await expect(frame.locator('img[src^="data:image/"]').first()).toBeVisible({timeout:30000});
  await expect(frame.locator('body')).toContainText('Nick Sweeting');
  await page.locator('.stack-tray .thumb-card[data-plugin-name="singlefile"] [title="Open output folder"]').click();
  const download=page.waitForEvent('download');await page.getByRole('link',{name:'Download singlefile.html',exact:true}).click();const saved=await download,path=info.outputPath('singlefile.html');await saved.saveAs(path);
  const html=await readFile(path,'utf8');expect(html).toContain('SingleFile');expect(html).toContain('data:image/');expect(html).not.toContain('http://127.0.0.1:8736/w/');
  const offline=await browser.newContext();await offline.setOffline(true);const standalone=await offline.newPage();await standalone.goto('file://'+path);
  await expect(standalone.locator('body')).toContainText('Nick Sweeting');
  await expect(standalone.locator('a[href="https://github.com/pirate"]').first()).toHaveCount(1);
  await expect.poll(()=>standalone.locator('img[src^="data:image/"]').evaluateAll(nodes=>nodes.filter(node=>(node as HTMLImageElement).naturalWidth>1).length)).toBeGreaterThan(0);
  expect(external).toEqual([]);await standalone.screenshot({path:info.outputPath('standalone.png')});await writeFile(info.outputPath('requests.json'),JSON.stringify({external}));
 }finally{await browser.close()}
});

test('extension runs SingleFile offline over the all-plugin HN capture',async({},info)=>{
 const {mkdtemp}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),path=await import('node:path');
 const extension=path.resolve('.output/chrome-mv3'),source='/tmp/abx-wacz-demo/hacker-news-49944227-all-plugins-scroll-20261004.wacz';
 const context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-singlefile-')),{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 const external:string[]=[];
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);await context.setOffline(true);context.on('request',request=>{if(/^https?:/.test(request.url()))external.push(request.url())});
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await chooser).setFiles(source);
  await expect(page.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:60000});
  const panel=await openSnapshotOutput(page,'singlefile'),frame=panel.frameLocator('iframe[title="Offline document"]');
  await expect(frame.locator('body')).toContainText('I quit OpenAI');
  await writeFile(info.outputPath('singlefile.html'),await panel.locator('iframe[title="Offline document"]').getAttribute('srcdoc')||'');
  await expect(frame.locator('img[src^="data:image/"]').first()).toBeVisible();
  await expect.poll(()=>frame.locator('img[src^="data:image/"]').first().evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({path:info.outputPath('singlefile-extension.png')});
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download WACZ',exact:true}).click();expect(await readFile((await(await download).path())!)).toEqual(await readFile(source));expect(external).toEqual([]);
 }finally{await context.close()}
});
