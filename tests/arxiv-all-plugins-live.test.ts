import {test,expect,chromium} from '@playwright/test';
import {mkdir,mkdtemp,readdir,readFile,writeFile,symlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';
import * as mupdf from 'mupdf';
import {openSnapshotOutput} from './snapshot-controls';
import {inspectWaczEvidence,verifyReplayPayloads} from './wacz-evidence';

const url='https://arxiv.org/abs/2610.02208',title='Sphere Encoder 2';
const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
test('all plugins capture Sphere Encoder 2 and render its original paper and OCR offline',async({},info)=>{
  test.setTimeout(900000);
  const pluginRoot=path.resolve('abx-plugins/abx_plugins/plugins');
  const expectedPlugins=(await readdir(pluginRoot,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();
  const expectedHooks=(await readdir(pluginRoot,{recursive:true})).filter(filename=>/\/browser\/on_Snapshot__[^/]+\.ts$/.test(filename)).map(filename=>path.basename(filename)).sort();
  const profile=await mkdtemp(path.join(tmpdir(),'abx-all-arxiv-')),extension=path.resolve('.output/chrome-mv3');
  const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,viewport:{width:1440,height:1100},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const errors:string[]=[],offlineHTTP:string[]=[],report:Record<string,unknown>={url,title,profile,expectedPlugins,expectedHooks,started:new Date().toISOString()};
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),studio=await context.newPage();studio.on('pageerror',error=>errors.push(String(error)));
  studio.on('console',message=>{if(message.text().startsWith('ALL_ARXIV_PROGRESS '))console.log(message.text())});
  try{
    await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    await studio.evaluate(()=>{let last='';chrome.storage.onChanged.addListener((changes,area)=>{const capture=(changes['wacz-captures']?.newValue as any[]|undefined)?.[0];if(area!=='local'||!capture)return;const next=JSON.stringify({state:capture.state,hooks:capture.hooks.map((hook:any)=>({plugin:hook.plugin,status:hook.status,summary:hook.summary}))});if(next!==last){last=next;console.log('ALL_ARXIV_PROGRESS '+next)}})});
    const retained=process.env.ABX_ARXIV_ALL_CAPTURE;
    let archivePath:string,capture:any;
    if(retained){
      archivePath=path.join(retained,'arxiv-2610.02208-all-plugins.wacz');capture=JSON.parse(await readFile(path.join(retained,'capture.json'),'utf8'));
      const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:90000});
    }else{
      await studio.getByRole('button',{name:/\d+ plugins$/}).click();
      const rows=studio.locator('.plugin-option');await expect(rows).toHaveCount(expectedPlugins.length);
      for(const row of await rows.all()){const checkbox=row.locator('label').first().getByRole('checkbox');if(await checkbox.isEnabled())await checkbox.check();await expect(checkbox).toBeChecked();}
      await expect(studio.getByRole('textbox',{name:'PAPERSDL_PROVIDERS',exact:true})).toHaveValue('all');
      await expect(studio.getByRole('checkbox',{name:/^Run bundled PaddleOCR/})).toBeChecked();
      await studio.getByRole('button',{name:new RegExp(`^${expectedPlugins.length} plugins$`)}).click();
      await studio.getByRole('textbox',{name:'Open URL',exact:true}).fill(url);await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
      await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:720000});
      capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
      await writeFile(info.outputPath('capture.json'),JSON.stringify(capture,null,2));
      const downloading=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();archivePath=info.outputPath('arxiv-2610.02208-all-plugins.wacz');await(await downloading).saveAs(archivePath);
      console.log('EXPORTED_ALL_ARXIV_WACZ '+archivePath);
      const target=context.pages().find(page=>page.url().startsWith(url));expect(target,'Actual requested public paper').toBeDefined();await expect(target!.locator('h1.title')).toContainText(title);await target!.screenshot({path:info.outputPath('live-arxiv.png'),fullPage:true});
    }
    report.archivePath=archivePath;report.capture=capture;
    expect(capture.plugins.slice().sort()).toEqual(expectedPlugins);expect(capture.hooks.map((hook:any)=>hook.hook).sort()).toEqual(expectedHooks);
    expect(capture.hooks.filter((hook:any)=>['pending','running'].includes(hook.status))).toEqual([]);
    report.warc=await inspectWaczEvidence(archivePath);
    const zip=unzipSync(await readFile(archivePath)),manifest=JSON.parse(new TextDecoder().decode(zip['datapackage.json']));
    expect(manifest.archivebox.plugins.map((plugin:any)=>plugin.id).sort()).toEqual(expectedPlugins);
    expect(Array.isArray(manifest.archivebox.files)).toBe(true);
    for(const plugin of ['screenshot','consolelog','accessibility','dom','sslcerts'])expect(manifest.archivebox.files.some((file:any)=>file.metadata.plugin===plugin),`${plugin} original generated evidence`).toBe(true);
    const screenshots=manifest.archivebox.files.filter((file:any)=>file.metadata.plugin==='screenshot');if(screenshots.length===1)expect(screenshots[0].path).toBe('screenshot/screenshot.png');
    expect(zip['consolelog/consolelog.json']).toBeDefined();expect(zip['accessibility/accessibility.json']).toBeDefined();
    for(const ref of capture.hooks.flatMap((hook:any)=>hook.records||[]).filter((ref:any)=>ref.url.startsWith('urn:')))expect(manifest.archivebox.files.some((file:any)=>file.url===ref.url&&file.ts===ref.ts),`Preserved original evidence reference ${ref.url}`).toBe(true);
    for(const resource of manifest.resources)expect(`sha256:${sha256(zip[resource.path]!)}`,resource.path).toBe(resource.hash);
    const originals:{url:string;body:Uint8Array}[]=[],exchanges:string[]=[];
    for(const [name,bytes]of Object.entries(zip))if(name.startsWith('archive/'))for await(const record of new WARCParser([bytes])){
      const body=await record.readFully(),target=record.warcTargetURI||'';
      if(/^https:\/\/arxiv.org\/pdf\/(?:arXiv:)?2610\.02208(?:v\d+)?(?:\.pdf)?$/.test(target)){
        if(['response','revisit'].includes(record.warcType||'')&&(record.httpHeaders?.headers.get('content-type')||'').includes('application/pdf'))exchanges.push(target);
        if(new TextDecoder().decode(body.subarray(0,5))==='%PDF-')originals.push({url:target,body});
      }
    }
    expect(originals,'One stored original paper PDF').toHaveLength(1);expect(exchanges,'Reuse the one original PDF exchange').toHaveLength(1);
    const original=originals[0]!,paperHook=capture.hooks.find((hook:any)=>hook.plugin==='papersdl');expect(paperHook.records.some((ref:any)=>ref.url===original.url)).toBe(true);
    if(process.env.ABX_ARXIV_NATIVE_PDF){const nativeBytes=await readFile(process.env.ABX_ARXIV_NATIVE_PDF);expect(sha256(original.body),'Captured PDF equals actual native papers-dl download').toBe(sha256(nativeBytes));report.nativePDF=process.env.ABX_ARXIV_NATIVE_PDF;}
    const native=mupdf.Document.openDocument(original.body,'application/pdf');const pages=native.countPages();native.destroy();
    report.pdf={url:original.url,bytes:original.body.length,sha256:sha256(original.body),pages};expect(pages).toBeGreaterThan(1);
    await studio.getByRole('button',{name:'Delete capture',exact:true}).click();await expect(studio.locator('.stack-shelf')).toHaveCount(0);
    await expect.poll(()=>studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[]).length)).toBe(0);
    for(const page of context.pages())if(page!==studio)await page.close();await context.setOffline(true);context.on('request',request=>{if(/^https?:/.test(request.url()))offlineHTTP.push(request.url())});
    const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);await expect(studio.locator('.stack-shelf')).toBeVisible({timeout:90000});
    const imported=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);report.replayedRecords=await verifyReplayPayloads(studio,imported.id);
    await openSnapshotOutput(studio,'papersdl');const paper=studio.locator('#main-frame-wrapper iframe[title="Archived scientific paper"]');await expect(paper).toBeVisible({timeout:90000});expect(await paper.getAttribute('src')).toMatch(/^blob:chrome-extension:/);
    await expect.poll(()=>studio.frames().some(frame=>frame.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'))).toBe(true);
    const nativeFrame=studio.frames().find(frame=>frame.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'))!;
    await nativeFrame.waitForFunction(()=>{const viewer=document.querySelector('pdf-viewer') as any;return viewer?.initialLoadComplete_&&viewer.loadState_==='success'});
    const nativeDownload=studio.waitForEvent('download');await nativeFrame.getByRole('button',{name:'Download',exact:true}).click();expect(sha256(await readFile((await(await nativeDownload).path())!))).toBe(sha256(original.body));await studio.screenshot({path:info.outputPath('offline-original-paper.png'),fullPage:true});
    await openSnapshotOutput(studio,'liteparse');const output=studio.frameLocator('#main-frame-wrapper iframe[title="LiteParse"]');
    await output.getByRole('searchbox',{name:'Search filenames or original URLs'}).fill('2610.02208');const tile=output.locator('.tile').filter({has:output.getByRole('button',{name:'Copy URL: '+original.url,exact:true})});await expect(tile).toHaveCount(1);await tile.scrollIntoViewIfNeeded();
    await expect(tile.locator('.text-preview')).toContainText(title,{timeout:180000});
    const download=studio.waitForEvent('download');await tile.getByRole('link',{name:'JSON',exact:true}).click();const parsed=JSON.parse(await readFile((await(await download).path())!,'utf8'));
    expect(parsed.engine.pdf).toBe('LiteParse WASM 2.15.1');expect(parsed.engine.ocrPages).toBeGreaterThan(0);expect(parsed.totalPages).toBe(pages);expect(parsed.pages).toHaveLength(pages);expect(parsed.text).toContain(title);
    const textItems=parsed.pages.flatMap((page:any)=>page.textItems);expect(textItems.length).toBeGreaterThan(100);expect(textItems.every((item:any)=>[item.x,item.y,item.width,item.height].every(Number.isFinite))).toBe(true);expect(parsed.images).toEqual([]);expect(parsed.screenshots).toEqual([]);
    report.parsed=parsed;await studio.screenshot({path:info.outputPath('offline-liteparse-ocr.png'),fullPage:true});await writeFile(info.outputPath('parsed-document.json'),JSON.stringify(parsed,null,2));
    await expect(studio.getByRole('alert')).toHaveCount(0);expect(offlineHTTP).toEqual([]);expect(errors).toEqual([]);
    expect(paperHook.status,JSON.stringify(paperHook)).toBe('succeeded');expect(capture.state,JSON.stringify(capture.hooks)).toBe('complete');expect(capture.hooks.filter((hook:any)=>['failed','killed'].includes(hook.status))).toEqual([]);
    await mkdir('/tmp/abx-wacz-demo',{recursive:true});const requested='/tmp/abx-wacz-demo/arxiv-all-plugins-20261004.wacz';const served=await stat(requested).catch(()=>null)?requested.replace('.wacz','-'+Date.now()+'.wacz'):requested;await symlink(archivePath,served);report.servedWacz=served;console.log('VERIFIED_ALL_ARXIV_WACZ '+served);
  }finally{
    report.errors=errors;report.offlineHTTP=offlineHTTP;
    report.finalCapture=await studio.evaluate(async()=>await chrome.storage.local.get('wacz-captures')).catch(()=>null);
    await writeFile(info.outputPath('report.json'),JSON.stringify(report,null,2));await studio.screenshot({path:info.outputPath('final-studio.png'),fullPage:true}).catch(()=>{});await context.close();
  }
});
