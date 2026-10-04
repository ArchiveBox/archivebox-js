import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const cases=[
 {name:'noresults',file:'/tmp/abx-all-plugins-commons-build14-20261004/all-plugins-live-all-plugi-ef16b-enshot-and-metadata-offline/commons-all-plugins.wacz'},
 {name:'phpbb',file:'/tmp/abx-forum-canonical-build9-20261004/forum-upstream-live-comple-335c9-comparison-and-offline-WACZ/phpbb.wacz'},
];
for(const item of cases)test(`canonical forum ${item.name} from original WACZ`,async({},info)=>{
 const extension=path.resolve('.output/chrome-mv3'),profile=await mkdtemp(path.join(tmpdir(),'abx-forum-view-'));
 const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);await context.setOffline(true);
  const live:string[]=[];context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url())});
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await chooser).setFiles(item.file);await expect(page.locator('.stack-shelf')).toBeVisible();
  const started=Date.now();await page.goto(page.url().split('#')[0]+'#view=forumdl');const forum=page.locator('#main-frame-wrapper .plugin-view').frameLocator('iframe[title="Forum thread"]');
  if(item.name==='noresults'){await expect(forum.locator('#content')).toHaveText('No captured replies');expect(Date.now()-started).toBeLessThan(5000);}
  else{
   const native=JSON.parse(await readFile('/tmp/abx-forum-canonical-build9-20261004/forum-upstream-live-comple-335c9-comparison-and-offline-WACZ/native.json','utf8'));
   await expect(forum.locator('.thread-title')).toHaveText(native.threads[0].title,{timeout:60_000});
   const downloading=page.waitForEvent('download');await forum.getByRole('link',{name:'Download',exact:true}).click();const file=info.outputPath('forum.jsonl');await(await downloading).saveAs(file);
   const records=(await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(records.filter(record=>record.type==='post').map(record=>record.item)).toEqual(native.posts);
  }
  await page.screenshot({path:info.outputPath('forum.png'),fullPage:true});expect(live).toEqual([]);
 }finally{await context.close()}
});
