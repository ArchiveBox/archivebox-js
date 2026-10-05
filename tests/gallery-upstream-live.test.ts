import {openSnapshotOutput} from './snapshot-controls';
import {inspectWaczEvidence,verifyReplayPayloads} from './wacz-evidence';
import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {unzipSync,zipSync} from 'fflate';
import {createHash} from 'node:crypto';
import {WARCParser} from 'warcio';
const exec=promisify(execFile);
const cases=[
  {name:'flickr',url:'https://www.flickr.com/photos/departingyyz/16089302239',extractor:'FlickrImageExtractor',fields:['id','filename','extension','width','height','description','title','date','tags','license','license_name']},
  {name:'wallhaven',url:'https://wallhaven.cc/w/5wepm8',extractor:'WallhavenImageExtractor',fields:['id','filename','extension','width','height','date','tags','source','file_size','file_type','resolution']},
  {name:'commons',url:'https://commons.wikimedia.org/wiki/Category:Paintings_by_Claude_Monet_in_Tel_Aviv_Museum_of_Art',extractor:'WikimediaArticleExtractor',fields:['filename','extension','canonicaltitle','sha1','date','num','count','page','lang','width','height','metadata','commonmetadata','extmetadata']},
];
for(const target of cases)test(`full upstream gallery-dl ${target.name}: native comparison, WACZ export/delete/offline derivation`,async({},info)=>{
  test.setTimeout(300000);
  const config={extractor:{retries:0,...(target.name==='commons'?{wikimedia:{wikimediacommons:{root:'https://commons.wikimedia.org'}},wikimediacommons:{limit:2,subcategories:false}}:{})}};
  const configPath=info.outputPath('gallery-dl-config.json');await writeFile(configPath,JSON.stringify(config));
  const reference=await exec('uv',['run','--no-project','--with','gallery-dl==1.32.15','gallery-dl','--config-ignore','--config',configPath,'--resolve-json',target.url],{maxBuffer:32*1024*1024,timeout:120000});
  await writeFile(info.outputPath('upstream-gallery-dl.json'),reference.stdout);await writeFile(info.outputPath('upstream-gallery-dl.log'),reference.stderr);
  const native=JSON.parse(reference.stdout);expect(native.filter((m:any[])=>m[0]===-1)).toEqual([]);const expected=native.filter((m:any[])=>m[0]===3);expect(expected.length).toBeGreaterThan(0);
  const extension=path.resolve('.output/chrome-mv3'),profile=await mkdtemp(path.join(tmpdir(),'abx-gallery-upstream-'));
  const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const studio=await context.newPage();studio.on('console',message=>{if(message.type()==='error')console.error(message.text());});await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    await studio.getByRole('button',{name:/^\d+ plugins$/}).click();for(const row of await studio.locator('.plugin-option').all()){const box=row.locator('label').first().getByRole('checkbox');if(!await box.isDisabled())await box.setChecked(['gallery-dl','Rendered DOM'].includes(await row.locator('strong').innerText()));}
    await studio.getByRole('textbox',{name:'GALLERYDL_CONFIG',exact:true}).fill(JSON.stringify(config));await studio.getByRole('textbox',{name:'Open URL',exact:true}).fill(target.url);await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
    try{await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:220000});}catch(error){await writeFile(info.outputPath('failed-capture-state.json'),JSON.stringify(await studio.evaluate(async()=>await chrome.storage.local.get('wacz-captures')),null,2));await studio.screenshot({path:info.outputPath('failed-capture.png')});throw error;}
    const capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);await writeFile(info.outputPath('capture.json'),JSON.stringify(capture,null,2));
    const downloading=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();const archivePath=info.outputPath(`${target.name}-gallery.wacz`);await(await downloading).saveAs(archivePath);
    const evidence=await inspectWaczEvidence(archivePath);
    if(target.name==='commons'){expect(evidence.requests.some(request=>request.method==='HEAD')).toBe(true);expect(evidence.requests.some(request=>request.url.includes('gcmcontinue='))).toBe(true);}
    expect(capture.hooks.find((hook:any)=>hook.plugin==='gallerydl').status,JSON.stringify(capture)).toBe('succeeded');
    const zip=unzipSync(await readFile(archivePath),{filter:file=>file.name.startsWith('archive/')});const originals=new Set<string>();let metadataCopies=0;
    for(const bytes of Object.values(zip))for await(const record of new WARCParser([bytes])){await record.readFully();const url=record.warcTargetURI||'';if((record.warcType==='response'||record.warcType==='revisit')&&expected.some((item:any[])=>item[1]===url))originals.add(url);if(record.warcType==='resource'&&/gallery.*json/i.test(url))metadataCopies++;}
    expect(originals.size).toBe(expected.length);expect(metadataCopies).toBe(0);
    await studio.getByRole('button',{name:'Delete capture',exact:true}).click();for(const page of context.pages())if(page!==studio)await page.close();await context.setOffline(true);const external:string[]=[];context.on('request',request=>{if(/^https?:/.test(request.url()))external.push(request.url());});
    const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);await openSnapshotOutput(studio,'gallerydl');const imported=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);await verifyReplayPayloads(studio,imported.id);
    const viewer=studio.frameLocator('#main-frame-wrapper iframe[title="Image gallery"]');await expect(viewer.locator('h1')).toContainText('Gallery',{timeout:90000});await expect(viewer.locator('#count')).toHaveText(`${expected.length} images`);await expect(viewer.getByRole('alert')).toHaveCount(0);expect(capture.hooks.find((hook:any)=>hook.plugin==='gallerydl').summary).toContain(target.extractor);
    const images=viewer.locator('#gallery .tile img');await expect(images).toHaveCount(expected.length);
    for(let i=0;i<expected.length;i++){
      const metadata=expected[i][2],filename=String(metadata.filename),extension=String(metadata.extension||'');
      await expect(images.nth(i)).toHaveAttribute('alt',extension&&!filename.toLowerCase().endsWith('.'+extension.toLowerCase())?filename+'.'+extension:filename);
      expect((await images.nth(i).getAttribute('src'))?.endsWith(expected[i][1])).toBe(true);
      await expect.poll(()=>images.nth(i).evaluate((image:HTMLImageElement)=>({loaded:image.naturalWidth>0,replay:image.currentSrc.includes('/w/'),data:image.currentSrc.startsWith('data:')})),{timeout:30000}).toEqual({loaded:true,replay:true,data:false});
    }
    await studio.screenshot({path:info.outputPath(`${target.name}-offline.png`)});expect(external).toEqual([]);await expect(studio.getByRole('alert')).toHaveCount(0);
  }finally{await context.close();}
});

// This is actual upstream filter evaluation on a real public capture, not an
// injected handler. Capture configuration is user-entered; imported config is
// untrusted and must be unable to bypass the archived-response transport.
test('imported gallery Python expressions cannot fetch live HTTP or access extension APIs',async({},info)=>{
  test.setTimeout(180000);
  const probe='https://example.com/archivebox-gallery-isolation-probe';
  const expression=`(__import__('builtins').print('SANDBOX_EXTENSION_API=' + str(hasattr(__import__('js'), 'chrome') and hasattr(__import__('js').chrome, 'runtime'))), __import__('pyodide').ffi.run_sync(__import__('js').fetch('${probe}')))[1]`;
  const config={extractor:{retries:0}};
  const extension=path.resolve('.output/chrome-mv3'),profile=await mkdtemp(path.join(tmpdir(),'abx-gallery-isolation-'));
  const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const responses:string[]=[];context.on('response',response=>{if(response.url()===probe)responses.push(response.url());});
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const studio=await context.newPage();await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    await studio.getByRole('button',{name:/^\d+ plugins$/}).click();for(const row of await studio.locator('.plugin-option').all()){const box=row.locator('label').first().getByRole('checkbox');if(!await box.isDisabled())await box.setChecked(['gallery-dl','Rendered DOM'].includes(await row.locator('strong').innerText()));}
    await studio.getByRole('textbox',{name:'GALLERYDL_CONFIG',exact:true}).fill(JSON.stringify(config));await studio.getByRole('textbox',{name:'Open URL',exact:true}).fill('https://wallhaven.cc/w/5wepm8');await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
    await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:120000});
    const capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);await writeFile(info.outputPath('capture.json'),JSON.stringify(capture,null,2));expect(capture.hooks.find((hook:any)=>hook.plugin==='gallerydl').status,JSON.stringify(capture)).toBe('succeeded');
    const downloading=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();const archivePath=info.outputPath('gallery-expression.wacz');await(await downloading).saveAs(archivePath);
    await inspectWaczEvidence(archivePath);
    // Retain the original real capture. Only the second archive's untrusted
    // configuration changes; every recorded HTTP/WARC byte stays identical.
    const members=unzipSync(await readFile(archivePath));const metadata=JSON.parse(new TextDecoder().decode(members['datapackage.json']));
    const records=new TextDecoder().decode(members['index.jsonl']!).trim().split('\n').map(line=>JSON.parse(line));
    records.find((record:any)=>record.type==='Snapshot').config.GALLERYDL_CONFIG=JSON.stringify({extractor:{retries:0,'image-filter':expression}});
    members['index.jsonl']=new TextEncoder().encode(records.map(record=>JSON.stringify(record)+'\n').join(''));
    Object.assign(metadata.resources.find((resource:any)=>resource.path==='index.jsonl'),{bytes:members['index.jsonl'].length,hash:'sha256:'+createHash('sha256').update(members['index.jsonl']).digest('hex')});
    members['datapackage.json']=new TextEncoder().encode(JSON.stringify(metadata));members['datapackage-digest.json']=new TextEncoder().encode(JSON.stringify({path:'datapackage.json',hash:'sha256:'+createHash('sha256').update(members['datapackage.json']).digest('hex')}));
    const adversarialPath=info.outputPath('gallery-untrusted-expression.wacz');await writeFile(adversarialPath,zipSync(members,{level:0}));
    const after=unzipSync(await readFile(adversarialPath));for(const [name,bytes] of Object.entries(members))if(name.startsWith('archive/'))expect(after[name]).toEqual(bytes);
    await studio.getByRole('button',{name:'Delete capture',exact:true}).click();for(const page of context.pages())if(page!==studio)await page.close();
    // Keep the browser online: the sandbox policy itself must block the fetch.
    const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(adversarialPath);await openSnapshotOutput(studio,'gallerydl');const imported=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);await verifyReplayPayloads(studio,imported.id);
    const diagnostics=studio.getByRole('alert');await expect(diagnostics).toBeVisible({timeout:60000});await expect(diagnostics).toContainText('SANDBOX_EXTENSION_API=False');await expect(diagnostics).toContainText('Python sandbox blocked connect-src');await expect(diagnostics).toContainText(probe);expect(responses).toEqual([]);
    await studio.screenshot({path:info.outputPath('blocked-python-expression.png')});
  }finally{await context.close();}
});
