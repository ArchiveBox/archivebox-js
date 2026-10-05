import {readWaczPackage} from './wacz-evidence';
import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';
import {imageSize} from 'image-size';
import {inspectWaczEvidence,verifyReplayPayloads} from './wacz-evidence';
import {openSnapshotOutput} from './snapshot-controls';
const fixtures=[
 {plugin:'gdrive',url:'https://drive.google.com/drive/folders/1KpLl_1tcK0eeehzN980zbG-3M2nhbVks',count:6},
 {plugin:'dropbox',url:'https://www.dropbox.com/scl/fo/kf9a29cwaebpkbtug6a7k/AFiq9xq2XcvTcmHl_z-tsIc/Lockups?rlkey=4mrp0lpvxmwrlwdy349nspygn&dl=0',count:8},
];
for(const fixture of fixtures)test(`all-plugin original ${fixture.plugin} folder download and offline explorer`,async({},info)=>{
 test.setTimeout(900000);
 const plugins=(await readdir(path.resolve('abx-plugins/abx_plugins/plugins'),{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();
 const extension=path.resolve('.output/chrome-mv3'),context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),`abx-${fixture.plugin}-`)),{channel:'chromium',headless:true,acceptDownloads:true,viewport:{width:1440,height:1100},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 let capture:any,archivePath=process.env.ABX_CLOUD_WACZ||'',timer:ReturnType<typeof setInterval>|undefined;
 const external:string[]=[],errors:string[]=[],providerDownloads:string[]=[];
 context.on('page',page=>page.on('download',download=>{if(page.url().startsWith('http'))providerDownloads.push(download.url())}));
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
  await page.getByRole('button',{name:`${plugins.length} plugins`,exact:true}).click();
  for(const row of await page.locator('.plugin-option').all())await expect(row.locator('label').first().getByRole('checkbox')).toBeChecked();
  await page.getByRole('button',{name:`${plugins.length} plugins`,exact:true}).click();
  if(!archivePath){
   await page.getByRole('textbox',{name:'Open URL',exact:true}).fill(fixture.url);await page.getByRole('button',{name:'Capture tab',exact:true}).click();
   let last='';timer=setInterval(()=>{void page.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])?.[0]).then(value=>{capture=value;const status=JSON.stringify(value?.hooks.map((hook:any)=>({plugin:hook.plugin,status:hook.status,summary:hook.summary,log:hook.logs?.at(-1)})));if(status!==last){last=status;console.log(fixture.plugin+' '+status)}}).catch(()=>{})},10000);
   await expect(page.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:780000});clearInterval(timer);timer=undefined;
   capture=await page.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
   const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download WACZ',exact:true}).click();archivePath=info.outputPath(`${fixture.plugin}-all-plugins.wacz`);await(await downloading).saveAs(archivePath);console.log('CLOUD_WACZ '+archivePath);
   await writeFile(info.outputPath('capture.json'),JSON.stringify(capture,null,2));
   await page.getByRole('button',{name:'Delete capture',exact:true}).click();await expect(page.locator('.stack-shelf')).toHaveCount(0);
  }
  for(const other of context.pages())if(other!==page)await other.close();await context.setOffline(true);context.on('request',request=>{if(/^https?:/.test(request.url()))external.push(request.url())});
  const choosing=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);await expect(page.locator('.stack-shelf')).toBeVisible({timeout:90000});
  capture=await page.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);expect(capture.plugins.slice().sort()).toEqual(plugins);
  const hook=capture.hooks.find((hook:any)=>hook.plugin===fixture.plugin);expect(hook?.status,JSON.stringify(hook)).toBe('succeeded');expect(hook.data.files).toHaveLength(fixture.count);
  const data=hook.data,zip=unzipSync(await readFile(archivePath));expect(Object.keys(zip).filter(name=>name.startsWith(fixture.plugin+'/')),'Provider bodies remain original HTTP WARC bytes').toEqual([]);
  const manifest=(await readWaczPackage(zip)),ocrFiles=manifest.metadata.files.filter((file:any)=>file.metadata.plugin==='liteparse'&&file.metadata.document);
  const providerBodies=new Map<string,Uint8Array>();
  for(const [name,body]of Object.entries(zip)){if(!name.startsWith('archive/'))continue;for await(const record of new WARCParser([body])){const payload=await record.readFully();if(record.warcType==='response'&&data.downloads.some((item:any)=>item.ref.url===record.warcTargetURI))providerBodies.set(record.warcTargetURI!,payload)}}
  for(const download of data.downloads){
   const body=providerBodies.get(download.ref.url);expect(body).toBeTruthy();
   const members=unzipSync(body!);
   for(const file of data.files.filter((file:any)=>file.ref.url===download.ref.url)){
    const original=members[file.ref.member[0]];expect(original).toBeTruthy();expect(createHash('sha256').update(original!).digest('hex')).toBe(file.sha256);
    if(/^image\/(png|jpeg|gif|webp|bmp)$/.test(file.mime)){const dimensions=imageSize(original!);if(dimensions.width>=128||dimensions.height>=128)expect(ocrFiles.some((saved:any)=>saved.metadata.document.source.url===download.ref.url&&JSON.stringify(saved.metadata.document.source.member)===JSON.stringify(file.ref.member)),file.filename+' must have capture-time OCR').toBe(true)}
   }
  }
  const evidence=await inspectWaczEvidence(archivePath);
  for(const download of data.downloads){expect(download.ref.url).toMatch(/^https?:/);expect(evidence.requests.filter(request=>request.url===download.ref.url&&request.method==='GET'),'Provider body is requested once').toHaveLength(1)}
  expect(providerDownloads,'Capture must not create a second native browser download').toEqual([]);
  await openSnapshotOutput(page,fixture.plugin);const frame=page.frameLocator(`#main-frame-wrapper iframe[title=${JSON.stringify(data.title)}]`);
  await expect(frame.locator('#title')).toHaveText(data.title);await expect(frame.locator('#entries .directory-link').first()).toBeVisible();
  const file=data.files.find((file:any)=>fixture.plugin==='gdrive'?file.filename.endsWith('fractal.jpg'):file.filename.endsWith('.png'));expect(file).toBeTruthy();
  for(const part of file.filename.split('/'))await frame.locator('#entries .directory-link').filter({hasText:new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/?$')}).click();
  await expect.poll(()=>frame.locator('#content img').evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBe(true);
  const downloading=page.waitForEvent('download');await frame.locator('#download').click();const bytes=await readFile((await(await downloading).path())!);expect(bytes.length).toBe(file.size);expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
  await page.screenshot({path:info.outputPath('cloud-explorer.png'),fullPage:true});
  while(await frame.getByRole('button',{name:'↩ Up One Level',exact:true}).isVisible())await frame.getByRole('button',{name:'↩ Up One Level',exact:true}).click();await frame.getByRole('searchbox',{name:'Filter files'}).fill('no-such-file-archivebox');await expect(frame.locator('#entries .empty-state')).toHaveText('No matching files.');
  await openSnapshotOutput(page,'search_contents');const search=page.frameLocator('#main-frame-wrapper iframe[title="Search"]');await search.getByRole('searchbox',{name:'Search archived text'}).fill(fixture.plugin==='gdrive'?'Lorem ipsum':'healing');
  await expect(search.locator('.row')).not.toHaveCount(0);await expect(search.locator('mark').first()).toBeVisible();
  await page.screenshot({path:info.outputPath('cloud-search.png'),fullPage:true});
  await writeFile(info.outputPath('verification.json'),JSON.stringify({archivePath,providerDownloads,external,errors,evidence,files:data.files},null,2));
  await verifyReplayPayloads(page,capture.id);expect(external).toEqual([]);expect(errors).toEqual([]);expect(capture.hooks.filter((hook:any)=>['failed','killed'].includes(hook.status)),JSON.stringify(capture.hooks)).toEqual([]);expect(capture.state).toBe('complete');
 }finally{if(timer)clearInterval(timer);await writeFile(info.outputPath('last-state.json'),JSON.stringify({capture,archivePath,providerDownloads,external,errors},null,2));await context.close()}
});
