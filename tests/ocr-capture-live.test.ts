import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';
import * as mupdf from 'mupdf';
import {openSnapshotOutput} from './snapshot-controls';
import {inspectWaczEvidence} from './wacz-evidence';

const cases=[
 {name:'image',url:'https://raw.githubusercontent.com/scribeocr/ocr-benchmark/main/img/filing_01.png',text:'UNITED STATES',filename:'filing.wacz'},
 {name:'scanned PDF',url:'https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/skew.pdf',text:'LinnSequencer',filename:'linnsequencer.wacz'},
 {name:'native PDF',url:'https://arxiv.org/pdf/1706.03762',text:'Attention Is All You Need',filename:'attention-is-all-you-need.wacz'},
];
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
for(const source of cases)test(`all plugins save ${source.name} OCR during capture and replay saved text`,async({},info)=>{
 test.setTimeout(360000);
 const pluginRoot=path.resolve('abx-plugins/abx_plugins/plugins'),expectedPlugins=(await readdir(pluginRoot,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();
 const extension=path.resolve('.output/chrome-mv3'),context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-capture-ocr-')),{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 const errors:string[]=[],external:string[]=[],ocrRequests:string[]=[],report:Record<string,unknown>={source};let page;
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');page=await context.newPage();page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
  await expect(page.getByRole('button',{name:new RegExp(`^${expectedPlugins.length} plugins$`)})).toBeVisible();
  await page.getByRole('textbox',{name:'Open URL',exact:true}).fill(source.url);await page.getByRole('button',{name:'Capture tab',exact:true}).click();
  await expect(page.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:300000});
  const capture=await page.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);report.capture=capture;
  const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download WACZ',exact:true}).click();const archivePath=info.outputPath(source.filename);await(await downloading).saveAs(archivePath);
  expect(capture.plugins.slice().sort()).toEqual(expectedPlugins);expect(capture.state,JSON.stringify(capture)).toBe('complete');
  expect(capture.hooks.filter((hook:any)=>['failed','killed','running'].includes(hook.status))).toEqual([]);
  expect(capture.hooks.find((hook:any)=>hook.plugin==='liteparse')?.status).toBe('succeeded');
  if(source.name==='scanned PDF'){
   expect(capture.hooks.find((hook:any)=>hook.hook==='on_Snapshot__30_navigate.ts').data.download.ref.url).toBe(source.url);expect(capture.finalUrl).toBe(source.url);
   expect(capture.hooks.find((hook:any)=>hook.plugin==='screenshot').status).toBe('noresults');
  }
  const bytes=await readFile(archivePath),zip=unzipSync(bytes),manifest=JSON.parse(new TextDecoder().decode(zip['datapackage.json']!));
  const saved=manifest.archivebox.files.filter((file:any)=>file.metadata.plugin==='liteparse');expect(saved.length).toBeGreaterThan(0);
  expect(saved.every((file:any)=>file.url.startsWith('urn:ocr:')&&file.mime==='application/json'&&file.path.startsWith('liteparse/')&&file.path.endsWith('.json'))).toBe(true);
  expect(new Set(saved.map((file:any)=>file.metadata.document.digest)).size).toBe(saved.length);
  expect(Object.keys(zip).filter(name=>name.startsWith('liteparse/')).sort()).toEqual([...new Set(saved.map((file:any)=>file.path))].sort());
  const originals=new Map<string,{body:Uint8Array;digest:string;mime:string}>();
  for(const [name,content]of Object.entries(zip))if(name.startsWith('archive/'))for await(const record of new WARCParser([content])){const body=await record.readFully();if(record.warcType==='response')originals.set(`${record.warcTargetURI} ${Date.parse(record.warcDate!)}`,{body,digest:hash(body),mime:record.httpHeaders?.headers.get('content-type')||''})}
  for(const file of saved){const document=file.metadata.document,original=originals.get(`${document.source.url} ${document.source.ts}`);expect(original,document.source.url).toBeDefined();expect(document.digest).toBe('sha256:'+original!.digest);expect(document.size).toBe(original!.body.length);expect(JSON.parse(new TextDecoder().decode(zip[file.path])).engine.pdf).toBe('LiteParse WASM 2.15.1')}
  const target=saved.find((file:any)=>file.metadata.document.source.url===source.url);expect(target).toBeDefined();
  const parsed=JSON.parse(new TextDecoder().decode(zip[target.path]));report.parsed=parsed;
  const indexFile=manifest.archivebox.files.find((file:any)=>file.metadata.plugin==='search_contents'&&file.url.startsWith('urn:index:'));expect(indexFile.path).toBe('search_contents/index.json');
  const index=JSON.parse(new TextDecoder().decode(zip[indexFile.path]));expect(index.engine).toBe('MiniSearch 7.2.0');
  expect(index.documents.some((document:any)=>document.ocr?.url===target.url&&document.ref.url===target.metadata.document.source.url)).toBe(true);
  expect(index.documents.every((document:any)=>!Object.hasOwn(document,'text'))).toBe(true);report.searchDocuments=index.documents;
  expect(parsed.text).toContain(source.text);expect(parsed.pageErrors).toEqual([]);expect(parsed.imageErrorCount).toBe(0);expect(parsed.images).toEqual([]);expect(parsed.screenshots).toEqual([]);
  expect(parsed.pages[0].textItems.length).toBeGreaterThan(20);expect(parsed.pages[0].textItems.every((item:any)=>[item.x,item.y,item.width,item.height].every(Number.isFinite))).toBe(true);
  if(source.name!=='native PDF')expect(parsed.engine.ocrPages).toBeGreaterThan(0);
  if(source.name!=='image'){
   const original=originals.get(`${target.metadata.document.source.url} ${target.metadata.document.source.ts}`)!,pdf=mupdf.Document.openDocument(original.body,'application/pdf');let nativeText='';
   for(let index=0;index<pdf.countPages();index++){const page=pdf.loadPage(index),text=page.toStructuredText('');nativeText+=text.asText();text.destroy();page.destroy()}pdf.destroy();
   if(source.name==='scanned PDF')expect(nativeText.trim()).toBe('');else expect(nativeText).toContain(source.text);
  }
  report.integrity=await inspectWaczEvidence(archivePath);
  await page.getByRole('button',{name:'Delete capture',exact:true}).click();for(const tab of context.pages())if(tab!==page)await tab.close();await context.setOffline(true);await page.reload();
  context.on('request',request=>{if(/^https?:/.test(request.url()))external.push(request.url());if(/ocr-sandbox|\/ocr\/|liteparse_wasm|paddleocr|ort-wasm/.test(request.url()))ocrRequests.push(request.url())});
  const choosing=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);
  await openSnapshotOutput(page,'liteparse');const viewer=page.locator('#main-frame-wrapper').frameLocator('iframe[title="LiteParse"]');
  await expect(viewer.locator('.text-preview').filter({hasText:source.text}).first()).toBeVisible();
  const tile=viewer.locator('.tile').filter({hasText:source.text}).first(),download=page.waitForEvent('download');await tile.getByRole('link',{name:'JSON',exact:true}).click();
  expect(JSON.parse(await readFile((await(await download).path())!,'utf8'))).toEqual(parsed);
  await expect(page.locator('[data-resource-preview="liteparse"]').filter({hasText:source.text}).first()).toBeVisible();
  await openSnapshotOutput(page,'search_contents');const search=page.locator('#main-frame-wrapper').frameLocator('iframe[title="Search"]');
  await search.getByRole('searchbox',{name:'Search archived text',exact:true}).fill(source.text);await expect(search.locator('.row').filter({hasText:source.text}).first()).toBeVisible();
  expect(page.frames().filter(frame=>frame.url().includes('ocr-sandbox'))).toHaveLength(0);expect(ocrRequests).toEqual([]);expect(external).toEqual([]);expect(errors).toEqual([]);
  const exported=page.waitForEvent('download');await page.getByRole('button',{name:'Download WACZ',exact:true}).click();expect(hash(await readFile((await(await exported).path())!))).toBe(hash(bytes));
  await page.locator('#main-frame-wrapper').screenshot({path:info.outputPath('saved-ocr-search.png')});
 }finally{report.errors=errors;report.external=external;report.ocrRequests=ocrRequests;await writeFile(info.outputPath('report.json'),JSON.stringify(report,null,2));await context.close()}
});
