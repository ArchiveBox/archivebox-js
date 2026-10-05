import {readWaczPackage} from './wacz-evidence';
import {inspectWaczEvidence,verifyReplayPayloads} from './wacz-evidence';
import {openSnapshotOutput} from './snapshot-controls';
import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';

for(const source of [
  {name:'arxiv-url',url:'https://arxiv.org/abs/1706.03762',query:'',providers:'arxiv'},
  {name:'doi-url',url:'https://doi.org/10.48550/arXiv.1706.03762',query:'',providers:'arxiv'},
  {name:'pdf-url',url:'https://arxiv.org/pdf/1706.03762.pdf',query:'https://arxiv.org/pdf/1706.03762.pdf',providers:'scihub'},
])test(`actual papers-dl Python: real ${source.name}, original PDF and offline replay`,async({},info)=>{
  test.setTimeout(360000);
  const profile=await mkdtemp(path.join(tmpdir(),'abx-papers-source-'));
  const extension=path.resolve('.output/chrome-mv3');
  const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const report:Record<string,unknown>={source,profile,started:new Date().toISOString()},errors:string[]=[],offlineRequests:string[]=[];
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const studio=await context.newPage();studio.on('pageerror',error=>errors.push(String(error)));
  try {
    await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    if(source.name==='pdf-url'){
      const navigation:unknown[]=[];report.navigation=navigation;
      studio.on('console',message=>{if(message.text().startsWith('PDF CDP '))navigation.push(JSON.parse(message.text().slice(8)));});
      await studio.evaluate(()=>chrome.debugger.onEvent.addListener((source,method,params:any)=>{
        if(['Page.loadEventFired','Page.frameNavigated','Page.frameStoppedLoading','Target.attachedToTarget','Target.detachedFromTarget','Fetch.requestPaused','Network.loadingFinished','Network.loadingFailed'].includes(method))console.log('PDF CDP',JSON.stringify({source,method,params}));
      }));
      await studio.evaluate(()=>chrome.tabs.onUpdated.addListener((tabId,info,tab)=>{if(info.status==='complete'&&tab.url?.startsWith('https://arxiv.org/pdf/'))console.log('PDF CDP',JSON.stringify({method:'tabs.onUpdated',tabId,info,url:tab.url}));}));
    }
    await studio.getByRole('button',{name:/\d+ plugins$/}).click();
    const enabled=new Set(['Chrome navigation','Rendered DOM','Academic papers']);
    if(source.name==='pdf-url')enabled.add('LiteParse');
    for(const option of await studio.locator('.plugin-option').all()) {
      const checkbox=option.locator('input[type="checkbox"]').first();
      if(await checkbox.isEnabled())await checkbox.setChecked(enabled.has(await option.locator('strong').innerText()));
    }
    await studio.getByRole('textbox',{name:'PAPERSDL_PROVIDERS',exact:true}).fill(source.providers);
    if(source.name==='pdf-url')await studio.getByRole('checkbox',{name:/^Run bundled PaddleOCR/}).uncheck();
    await studio.getByRole('textbox',{name:'PAPERSDL_QUERY',exact:true}).fill(source.query);
    await studio.getByRole('textbox',{name:'Open URL'}).fill(source.url);
    await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
    await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:300000});
    const capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
    report.capture=capture;
    expect(capture.state,JSON.stringify(capture)).toBe('complete');
    expect(capture.hooks.filter((hook:any)=>['failed','killed','running'].includes(hook.status))).toEqual([]);
    const paperHook=capture.hooks.find((hook:any)=>hook.plugin==='papersdl');
    expect(paperHook?.status,JSON.stringify(paperHook)).toBe('succeeded');
    expect(paperHook.logs.join('\n')).toContain('papers-dl 0.0.25 Python');
    expect(paperHook.records.length).toBeGreaterThan(0);
    const target=context.pages().find(page=>page.url().startsWith('https://arxiv.org/'));
    expect(target,'Actual public paper input').toBeDefined();
    if(source.name==='pdf-url'){
      expect(target!.url()).toContain('/pdf/1706.03762');
      expect(await target!.evaluate(()=>document.readyState)).toBe('complete');
      expect((report.navigation as any[]).some(event=>event.method==='tabs.onUpdated'&&event.info.status==='complete'),'Chrome must report the actual PDF tab completed loading').toBe(true);
      expect(capture.hooks.find((hook:any)=>hook.plugin==='dom')?.status).toBe('skipped');
      await expect(studio.locator('#main-frame-wrapper .plugin-view')).toHaveAttribute('data-plugin','papersdl');
      await expect(studio.locator('.thumb-card[data-plugin-name="dom"],a[data-plugin-view="dom"]')).toHaveCount(0);
    }
    else await expect(target!.locator('h1.title')).toContainText('Attention Is All You Need');
    await target!.screenshot({path:info.outputPath('live-paper.png'),fullPage:true});
    const downloading=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();
    const archivePath=info.outputPath(`${source.name}.wacz`);await(await downloading).saveAs(archivePath);
    report.waczEvidence=await inspectWaczEvidence(archivePath);
    const zip=unzipSync(await readFile(archivePath)),manifest=(await readWaczPackage(zip));
    expect(manifest.metadata).not.toHaveProperty('responseReuses');
    expect(capture).not.toHaveProperty('responseReuses');
    for(const resource of manifest.resources)expect(`sha256:${createHash('sha256').update(zip[resource.path]!).digest('hex')}`,resource.path).toBe(resource.hash);
    const originals:{url:string;body:Buffer}[]=[],pdfExchanges:string[]=[],redirects:string[]=[];
    for(const [filename,bytes]of Object.entries(zip))if(filename.startsWith('archive/'))for await(const record of new WARCParser([bytes])){
      const body=Buffer.from(await record.readFully()),url=record.warcTargetURI||'';
      if(record.warcType==='response'&&url===source.url&&record.httpHeaders?.statusCode===301)redirects.push(record.httpHeaders.headers.get('location')||'');
      if(['response','revisit'].includes(record.warcType||'')&&(record.httpHeaders?.headers.get('content-type')||'').includes('application/pdf'))pdfExchanges.push(url);
      if(/^https:\/\/arxiv.org\/pdf\//.test(url)&&body.subarray(0,5).toString()==='%PDF-')originals.push({url,body});
    }
    expect(pdfExchanges,'Reuse the recorded PDF response, without an extra HTTP exchange').toHaveLength(1);
    if(source.name==='pdf-url')expect(redirects,'Retain the actual initial HTTP redirect before the first page commits').toEqual(['/pdf/1706.03762']);
    expect(originals).toHaveLength(1);expect(paperHook.records.some((ref:any)=>ref.url===originals[0]!.url)).toBe(true);
    report.pdf={url:originals[0]!.url,size:originals[0]!.body.length,sha256:createHash('sha256').update(originals[0]!.body).digest('hex')};
    const nativeDir=await mkdtemp(path.join(tmpdir(),'abx-native-papers-'));
    const native=await promisify(execFile)('uv',['run','--no-project','--with','papers-dl==0.0.25','papers-dl','-v','fetch',source.query||'arXiv:1706.03762','--providers',source.providers,'--output',nativeDir],{cwd:'/tmp',timeout:180000,maxBuffer:4_000_000});
    report.native={directory:nativeDir,...native};
    expect(native.stdout).toContain('Successfully downloaded paper');
    expect(native.stdout).toContain('Attention Is All You Need.pdf');
    const originalPath=path.join(nativeDir,'original.pdf');await writeFile(originalPath,originals[0]!.body);
    const inferred=await promisify(execFile)('uv',['run','--no-project','--with','papers-dl==0.0.25','python','-c',"import pdf2doi,json,sys; pdf2doi.config.set('verbose',False); pdf2doi.config.set('save_identifier_metadata',False); r=pdf2doi.pdf2doi(sys.argv[1]); print(json.dumps(r,default=str))",originalPath],{cwd:'/tmp',timeout:180000,maxBuffer:4_000_000});
    const nativeInference=JSON.parse(inferred.stdout.trim().split('\n').at(-1)!);report.nativeInference=nativeInference;

    await studio.getByRole('button',{name:'Delete capture',exact:true}).click();
    await expect(studio.getByRole('textbox',{name:'Open URL',exact:true})).toBeVisible();
    for(const page of context.pages())if(page!==studio)await page.close();
    await context.setOffline(true);context.on('request',request=>{if(/^https?:/.test(request.url()))offlineRequests.push(request.url());});
    await studio.reload();
    // Observe the real UI worker's result without replacing any transport or runtime.
    await studio.evaluate(()=>{(window as any).__paperResults=[];window.addEventListener('message',({data})=>{if(data?.type==='python-sandbox-message'&&data.message?.type==='result'&&data.message.result?.inference)(window as any).__paperResults.push(data.message.result);});});
    const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);
    const viewer=studio.locator('#main-frame-wrapper .plugin-view');
    if(source.name==='pdf-url'){
      await expect(viewer).toHaveAttribute('data-plugin','papersdl');
      await expect(studio.locator('.thumb-card[data-plugin-name="dom"],a[data-plugin-view="dom"]')).toHaveCount(0);
    }
    await openSnapshotOutput(studio,'papersdl');
    const importedId=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0].id);
    expect(await studio.evaluate(async()=>Object.hasOwn(((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0],'responseReuses'))).toBe(false);
    report.verifiedPayloads=await verifyReplayPayloads(studio,importedId);
    expect(report.verifiedPayloads).toBeGreaterThan(0);
    const paper=viewer.locator('iframe[title="Archived scientific paper"]');
    await expect(paper).toBeVisible({timeout:90000});
    expect(await paper.getAttribute('src')).toMatch(/^blob:chrome-extension:\/\//);
    expect((await paper.getAttribute('src'))?.endsWith('#toolbar=1&navpanes=1&view=FitH')).toBe(true);
    await expect.poll(()=>studio.frames().some(frame=>frame.url()==='chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html')).toBe(true);
    const nativeViewer=studio.frame({url:'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html'})!;
    await nativeViewer.waitForFunction(()=>{const viewer=document.querySelector('pdf-viewer') as any;return viewer?.initialLoadComplete_&&viewer.loadState_==='success';});
    await expect(viewer.locator('h2,pre,table')).toHaveCount(0);
    await studio.waitForFunction(()=>(window as any).__paperResults.length>0);
    const derived=await studio.evaluate(()=>(window as any).__paperResults);report.offlineInference=derived;
    expect(derived[0].inference.identifier).toBe(nativeInference.identifier);
    expect(derived[0].inference.identifier_type).toBe(nativeInference.identifier_type);
    expect(derived[0].inference.validation_info.title).toBe(nativeInference.validation_info.title);
    const originalDigest=await studio.evaluate(async url=>{const response=await fetch(url!);if(!response.ok)throw Error('Original PDF replay failed: '+response.status);const body=await response.arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',body)),byte=>byte.toString(16).padStart(2,'0')).join('');},await paper.getAttribute('src'));
    expect(originalDigest).toBe(createHash('sha256').update(originals[0]!.body).digest('hex'));
    const downloadedOriginal=studio.waitForEvent('download');await nativeViewer.getByRole('button',{name:'Download',exact:true}).click();
    expect(await readFile((await(await downloadedOriginal).path())!)).toEqual(originals[0]!.body);
    await studio.screenshot({path:info.outputPath('offline-provider-view.png'),fullPage:true});
    if(source.name==='pdf-url'){
      await openSnapshotOutput(studio,'liteparse');
      const output=viewer.frameLocator('iframe[title="LiteParse"]');
      await expect(output.locator('.text-preview').first()).toContainText('Attention Is All You Need',{timeout:60000});
      const downloadJSON=studio.waitForEvent('download');await output.getByRole('link',{name:'JSON',exact:true}).first().click();
      const parsed=JSON.parse(await readFile((await(await downloadJSON).path())!,'utf8'));report.liteparse=parsed;
      expect(parsed.engine.pdf).toBe('LiteParse WASM 2.15.1');expect(parsed.totalPages).toBe(15);expect(parsed.pages).toHaveLength(15);
      expect(parsed.pages.flatMap((page:any)=>page.textItems).length).toBeGreaterThan(100);
      await studio.screenshot({path:info.outputPath('offline-direct-pdf-liteparse.png'),fullPage:true});
    }
    expect(errors).toEqual([]);expect(offlineRequests).toEqual([]);
  }finally {
    report.errors=errors;report.offlineRequests=offlineRequests;
    await studio.screenshot({path:info.outputPath('final-studio.png')}).catch(()=>{});
    await writeFile(info.outputPath('papers-source-report.json'),JSON.stringify(report,null,2));await context.close();
  }
});
