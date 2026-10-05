import {readWaczPackage} from './wacz-evidence';
import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {openSnapshotOutput} from './snapshot-controls';
import {inspectWaczEvidence,verifyReplayPayloads} from './wacz-evidence';
import MiniSearch from 'minisearch';
import {searchOptions} from '../abx-plugins/abx_plugins/plugins/search_contents/browser/index';

const documents=[
 {kind:'document',id:'195j9eDD3ccgjQRttHhJPymLJUCOUjs-jmwTrekvdjFE',formats:['docx','pdf','odt','rtf','txt','md','zip','epub'],office:'docx',member:'word/document.xml'},
 {kind:'spreadsheets',id:'1o5t26He2DzTweYeleXOGiDjlU4Jkx896f95VUHVgS8U',formats:['xlsx','csv','pdf','ods','tsv','zip'],office:'xlsx',member:'xl/workbook.xml'},
 {kind:'presentation',id:'1EAYk18WDjIG-zp_0vLm3CsfQh_i8eXc67Jo2O9C6Vuc',formats:['pptx','pdf','odp','txt'],office:'pptx',member:'ppt/presentation.xml'},
 {kind:'drawings',id:'1mUK8f8Hhlp_o06GPL_QxpPUL5s_vxv942a5NOn3aqE0',formats:['svg','pdf','png','jpg']},
];
for(const document of documents)test(`Google ${document.kind}: full exports, original viewer and offline WACZ`,async({},info)=>{
 test.setTimeout(900000);
 const plugins=(await readdir('abx-plugins/abx_plugins/plugins',{withFileTypes:true})).filter(item=>item.isDirectory()).map(item=>item.name).sort();
 const extension=path.resolve('.output/chrome-mv3'),context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-google-')),{channel:'chromium',headless:true,acceptDownloads:true,viewport:{width:1440,height:1000},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--remote-debugging-port=0']});
 const errors:string[]=[],external:string[]=[];let capture:any,timer:ReturnType<typeof setInterval>|undefined;
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();
  page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
  await page.getByRole('button',{name:`${plugins.length} plugins`,exact:true}).click();
  for(const row of await page.locator('.plugin-option').all())await expect(row.locator('label').first().getByRole('checkbox')).toBeChecked();
  if(!process.env.ABX_GOOGLE_DEFAULTS)await page.getByRole('textbox',{name:'GOOGLEDOCS_FORMATS',exact:true}).fill(document.formats.join(','));
  await page.getByRole('button',{name:`${plugins.length} plugins`,exact:true}).click();
  let archivePath:string;
  const retained=process.env.ABX_GOOGLE_WACZ_DIR;
  if(retained){
    const file=(await readdir(retained,{recursive:true})).find(file=>file.endsWith('/'+document.kind+'-all-plugins.wacz'));
    if(!file)throw Error('Missing retained all-plugin capture for '+document.kind);
    archivePath=path.join(retained,file);
    const choosing=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);
    await expect(page.locator('.stack-shelf')).toBeVisible({timeout:90000});
    capture=await page.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
  }else{
  await page.getByRole('textbox',{name:'Open URL',exact:true}).fill(`https://docs.google.com/${document.kind}/d/${document.id}/edit${document.kind==='spreadsheets'?'#gid=211973040':''}`);
  await page.getByRole('button',{name:'Capture tab',exact:true}).click();
  timer=setInterval(()=>{void page.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])?.[0]).then(value=>{capture=value;console.log(document.kind,JSON.stringify({state:value?.state,hook:value?.hooks.at(-1)?.plugin,status:value?.hooks.at(-1)?.status,summary:value?.hooks.at(-1)?.summary}))}).catch(()=>{})},15000);
  await expect(page.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:780000});
  clearInterval(timer);timer=undefined;
  capture=await page.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
  const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download WACZ',exact:true}).click();
  archivePath=info.outputPath(`${document.kind}-all-plugins.wacz`);await(await downloading).saveAs(archivePath);console.log('GOOGLE_WACZ '+archivePath);
  }
  await writeFile(info.outputPath('capture.json'),JSON.stringify(capture,null,2));
  expect(capture.plugins.slice().sort()).toEqual(plugins);
  const hook=capture.hooks.find((hook:any)=>hook.plugin==='googledocs');expect(hook,JSON.stringify(capture.hooks)).toBeTruthy();expect(hook.status,JSON.stringify(hook)).toBe('succeeded');
  const data=hook.data;expect(data.errors).toEqual([]);
  const expected=process.env.ABX_GOOGLE_DEFAULTS?document.formats.filter(format=>['docx','xlsx','pptx','csv','pdf','svg'].includes(format)):document.formats;
  expect([...new Set(data.exports.map((item:any)=>item.format))].sort()).toEqual(expected.slice().sort());
  if(document.kind==='spreadsheets'){expect(data.sheets).toEqual([{id:'0',name:'Test Sheet'},{id:'211973040',name:'this/that'}]);expect(data.selected_sheet).toBe('211973040');for(const format of expected.filter(f=>['csv','tsv'].includes(f)))expect(data.exports.filter((item:any)=>item.format===format)).toHaveLength(2)}
  const evidence=await inspectWaczEvidence(archivePath);await writeFile(info.outputPath('integrity.json'),JSON.stringify(evidence,null,2));
  const zip=unzipSync(await readFile(archivePath));expect(Object.keys(zip).filter(name=>name.startsWith('googledocs/')),'Export bytes belong only in the shared WARC').toEqual([]);
  const manifest=(await readWaczPackage(zip));
  const indexFile=manifest.metadata.files.find((file:any)=>file.path==='search_contents/index.json');
  expect(indexFile,'Final-stage text index').toBeDefined();
  const indexData=JSON.parse(new TextDecoder().decode(zip[indexFile.path]));
  expect(indexData.documents.length).toBeGreaterThan(0);
  expect(indexData.documents.every((entry:any)=>!('text' in entry))).toBe(true);
  expect(indexData.index.storedFields).toEqual({});
  expect(manifest.metadata.files.some((file:any)=>/^(readability|forumdl)\//.test(file.path||''))).toBe(false);
  if(document.kind==='spreadsheets'){
   const index=MiniSearch.loadJS(indexData.index,searchOptions);
   const matches=index.search('Favorite number').map(result=>indexData.documents[result.id]);
   expect(matches.some((entry:any)=>entry.mime.includes('spreadsheetml')),'Original XLSX is indexed with OfficeParser').toBe(true);
   expect(matches.some((entry:any)=>entry.ocr),'Final capture PDF OCR is indexed').toBe(true);
   expect(matches.some((entry:any)=>entry.ref.member?.some((part:string)=>part.endsWith('.html'))),'HTML ZIP export member is indexed').toBe(true);
  }
  await page.getByRole('button',{name:'Delete capture',exact:true}).click();
  await expect(page.locator('.stack-shelf')).toHaveCount(0);
  for(const other of context.pages())if(other!==page)await other.close();
  await context.setOffline(true);context.on('request',request=>{if(/^https?:/.test(request.url()))external.push(request.url())});
  const choosing=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);
  await expect(page.locator('.stack-shelf')).toBeVisible({timeout:90000});
  const imported=await page.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
  expect(imported.hooks.find((hook:any)=>hook.plugin==='googledocs').data).toEqual(data);
  await verifyReplayPayloads(page,imported.id);
  await openSnapshotOutput(page,'googledocs');const frame=page.frameLocator('#main-frame-wrapper iframe[title="Google Docs"]');
  await expect(frame.locator('#formats button')).toHaveCount(expected.length);await expect(frame.locator('iframe[title="Archived document PDF"]')).toHaveAttribute('src',/^blob:/,{timeout:30000});
  for(const format of expected){
   await frame.getByRole('button',{name:format.toUpperCase(),exact:true}).click();
   await expect(frame.locator('#download')).toHaveText('⤓ Download '+format.toUpperCase());
   if(['csv','tsv'].includes(format)){await expect(frame.locator('#sheet option')).toHaveCount(2);await frame.getByRole('combobox',{name:'Sheet',exact:true}).selectOption('211973040');await expect(frame.locator('table')).toBeVisible();}
   if(['svg','png','jpg'].includes(format))await expect.poll(()=>frame.locator('img.image').evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth>0)).toBe(true);
   const download=page.waitForEvent('download');await frame.locator('#download').click();const bytes=await readFile((await(await download).path())!);
   expect(bytes.length).toBeGreaterThan(0);
   if(format==='pdf')expect(bytes.subarray(0,5).toString()).toBe('%PDF-');
   if(format===document.office)expect(Object.keys(unzipSync(bytes))).toContain(document.member);
   if(['csv','tsv'].includes(format))expect(bytes.toString()).toBe(format==='csv'?'A,B\r\nAA,BB':'A\tB\r\nAA\tBB');
  }
  await page.screenshot({path:info.outputPath('google-full.png'),fullPage:true});
  if(document.kind==='spreadsheets'){
   await openSnapshotOutput(page,'search_contents');const search=page.frameLocator('#main-frame-wrapper iframe[title="Search"]');
   await search.getByRole('searchbox',{name:'Search archived text'}).fill('Favorite number');
   await expect(search.locator('.rows .row mark').first()).toBeVisible();
   await expect(search.locator('.stats')).toContainText('matching documents');
   await page.screenshot({path:info.outputPath('google-search.png'),fullPage:true});
  }
  expect(external).toEqual([]);expect(errors).toEqual([]);
  expect(capture.hooks.filter((hook:any)=>['failed','killed'].includes(hook.status)),JSON.stringify(capture.hooks)).toEqual([]);
 }finally{if(timer)clearInterval(timer);await writeFile(info.outputPath('last-state.json'),JSON.stringify({capture,errors,external},null,2));await context.close()}
});
