import {test,expect,chromium,type Page} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';
import packages from '../vendor/papers-dl/packages.json' with {type:'json'};
const player=process.env.ABX_PLAYER_URL||'http://127.0.0.1:8736/';
const source=process.env.ABX_HTTP_WACZ||'http://127.0.0.1:8737/commons-all-plugins.wacz';
const paperFile=process.env.ABX_PAPER_WACZ||'/private/tmp/abx-papers-upstream-build11-all/papers-upstream-live-actua-2784e-inal-PDF-and-offline-replay/arxiv-url.wacz';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function pdf(bytes:Uint8Array,printed:boolean){
  for(const [name,data]of Object.entries(unzipSync(bytes)))if(name.startsWith('archive/'))for await(const record of new WARCParser([data])){
    const body=await record.readFully();if((printed?record.warcTargetURI?.startsWith('urn:pdf:'):/^https:\/\/arxiv.org\/pdf\//.test(record.warcTargetURI||''))&&new TextDecoder().decode(body.slice(0,5))==='%PDF-')return body;
  }
  throw Error('Retained capture contains no expected original PDF');
}
async function downloadNative(page:Page){
  await expect.poll(()=>page.frames().some(frame=>frame.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'))).toBe(true);
  const native=page.frames().find(frame=>frame.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'))!;
  await native.waitForFunction(()=>{const viewer=document.querySelector('pdf-viewer') as any;return viewer?.initialLoadComplete_&&viewer.loadState_==='success'});
  const downloading=page.waitForEvent('download');await native.getByRole('button',{name:'Download',exact:true}).click();const download=await downloading;
  expect(await download.failure()).toBeNull();return readFile((await download.path())!);
}
test('HTTP PDF uses the canonical viewer and downloads original printed PDF bytes',async({},info)=>{
  const expected=await pdf(new Uint8Array(await(await fetch(source)).arrayBuffer()),true);
  const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage({acceptDownloads:true});
  try{
    await page.goto(`${player}?source=${encodeURIComponent(source)}#view=pdf`,{waitUntil:'domcontentloaded'});
    const frame=page.locator('#main-frame-wrapper iframe[title="Archived PDF"]');await expect(frame).toBeVisible({timeout:60000});
    const downloaded=await downloadNative(page);expect(downloaded.equals(Buffer.from(expected)),`Expected PDF SHA256 ${hash(expected)}, downloaded ${hash(downloaded)}`).toBe(true);expect(await frame.getAttribute('src')).toMatch(/^blob:http/);
    await page.screenshot({path:info.outputPath('printed-pdf.png'),fullPage:true});await writeFile(info.outputPath('pdf-proof.json'),JSON.stringify({bytes:downloaded.length,sha256:hash(downloaded)},null,2));
  }finally{await browser.close()}
});
test('HTTP paper assets retain pinned compressed bytes and actual upstream inference works',async({},info)=>{
  const expected=await pdf(await readFile(paperFile),false),browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage({acceptDownloads:true}),errors:string[]=[],external:string[]=[];
  page.context().on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==new URL(player).origin)external.push(request.url())});
  page.on('pageerror',error=>errors.push(String(error)));
  try{
    await page.goto(player,{waitUntil:'domcontentloaded'});
    const assetHashes=await page.evaluate(async packages=>{const results=[];for(const pkg of packages){const response=await fetch(new URL('papers-dl/'+(pkg.assetFilename||pkg.filename),location.href));if(!response.ok)throw Error(`${pkg.filename}: HTTP ${response.status}`);const bytes=await response.arrayBuffer();results.push({filename:pkg.filename,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('')});}return results},packages);
    expect(assetHashes).toEqual(packages.map(pkg=>({filename:pkg.filename,sha256:pkg.sha256})));
    await page.evaluate(()=>{(window as any).__paperResults=[];window.addEventListener('message',({data})=>{if(data?.type==='python-sandbox-message'&&data.message?.type==='result'&&data.message.result?.inference)(window as any).__paperResults.push(data.message.result);});});
    const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Open WACZ',exact:true}).click();await(await chooser).setFiles(paperFile);
    await page.evaluate(()=>{location.hash='view=papersdl'});
    const frame=page.locator('#main-frame-wrapper iframe[title="Archived scientific paper"]');await expect(frame).toBeVisible({timeout:90000});
    expect((await downloadNative(page)).equals(Buffer.from(expected))).toBe(true);await page.waitForFunction(()=>(window as any).__paperResults.length>0);const inferred=await page.evaluate(()=>(window as any).__paperResults[0]);expect(inferred.inference.identifier).toBe('10.48550/arXiv.1706.03762');expect(inferred.inference.validation_info.title).toBe('Attention Is All You Need');await writeFile(info.outputPath('inference.json'),JSON.stringify(inferred,null,2));await expect(page.getByRole('alert')).toHaveCount(0);expect(errors).toEqual([]);expect(external).toEqual([]);
    await page.screenshot({path:info.outputPath('upstream-paper.png'),fullPage:true});await writeFile(info.outputPath('package-hashes.json'),JSON.stringify(assetHashes,null,2));
  }finally{await browser.close()}
});
test('A captured no-result paper hook opens without downloading a Python paper runtime',async()=>{
  const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage(),packages:string[]=[];
  page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/papers-dl/'))packages.push(request.url())});
  try{
    await page.goto(`${player}?source=${encodeURIComponent(source)}#view=papersdl`,{waitUntil:'domcontentloaded'});
    await expect(page.locator('#main-frame-wrapper .plugin-view')).toHaveAttribute('data-plugin','papersdl',{timeout:60000});await expect(page.locator('#main-frame-wrapper')).not.toContainText('Loading');await expect(page.getByRole('alert')).toHaveCount(0);
    expect(packages).toEqual([]);await expect(page.locator('#main-frame-wrapper iframe[title="Archived scientific paper"]')).toHaveCount(0);
  }finally{await browser.close()}
});
