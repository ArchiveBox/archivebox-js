import {test,expect,chromium,type Page} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openSnapshotOutput} from './snapshot-controls';

const archivePath=process.env.ABX_ACCESSIBILITY_WACZ||'/tmp/abx-wacz-demo/hacker-news-49944227-all-plugins-scroll-20261004.wacz';
const player=process.env.ABX_ACCESSIBILITY_PLAYER||'http://127.0.0.1:8736';
const source=process.env.ABX_ACCESSIBILITY_SOURCE||'http://127.0.0.1:8737/hacker-news-49944227-all-plugins-scroll-20261004.wacz';
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

async function readTree(page:Page){
 const panel=await openSnapshotOutput(page,'accessibility'),frame=panel.frameLocator('iframe[title="Accessibility"]');
 await expect(frame.getByRole('heading',{name:'Accessibility tree',exact:true})).toBeVisible({timeout:60000});
 const downloading=page.waitForEvent('download');await frame.getByRole('link',{name:'Download',exact:true}).click();
 const model=JSON.parse(await readFile((await(await downloading).path())!,'utf8'));
 const nodes:any[]=[];const visit=(node:any)=>{nodes.push(node);for(const child of node.children||[])visit(child)};visit(model.tree);
 expect(nodes.length).toBeGreaterThan(100);
 expect(nodes.some(node=>node.role==='link'&&node.name.includes('I quit OpenAI'))).toBe(true);
 const textboxes=nodes.filter(node=>node.role==='textbox');expect(textboxes.length).toBeGreaterThan(0);
 expect(textboxes.every(node=>node.disabled!==true)).toBe(true);
 expect(model.tree.role).toBe('RootWebArea');
 await page.locator('#main-frame-wrapper').scrollIntoViewIfNeeded();
 return {model,nodes:nodes.length};
}

test('HTTP accessibility derives native Chromium AX only when opened',async({},info)=>{
 const original=await readFile(archivePath),browser=await chromium.launch({channel:'chromium',headless:true});
 const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage(),external:string[]=[],errors:string[]=[],nativeRequests:string[]=[];
 context.on('request',request=>{const url=new URL(request.url());if(/^https?:$/.test(url.protocol)&&![new URL(player).origin,new URL(source).origin].includes(url.origin))external.push(url.href)});
 // Context events also report the service worker forwarding the same request.
 page.on('request',request=>{if(new URL(request.url()).pathname==='/api/accessibility-tree')nativeRequests.push(request.url())});
 page.on('pageerror',error=>errors.push(String(error)));
 try{
  await page.goto(`${player}/?source=${encodeURIComponent(source)}#view=title`,{waitUntil:'domcontentloaded'});
  await expect(page.locator('#snapshot-output-browser')).toHaveAttribute('aria-busy','false');
  await expect(page.locator('.thumb-card[data-plugin-name="accessibility"]')).toHaveCount(1);expect(nativeRequests).toEqual([]);
  const native=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/accessibility-tree');
  const tree=await readTree(page);expect(nativeRequests).toHaveLength(1);
  const response=await native;expect(response.ok()).toBe(true);
  // Read the complete native API independently: this large tree exceeds
  // Chromium's inspector response-body cache, while the real client receives it.
  const independent=await fetch(`${player}/api/accessibility-tree`,{method:'POST',headers:{Origin:player,'Content-Type':'application/json'},body:JSON.stringify({source})});
  expect(independent.ok).toBe(true);const raw=await independent.json();
  expect(raw.nodes.length).toBe(tree.nodes);expect(raw.nodes[0].role.value).toBe(tree.model.tree.role);
  expect(external).toEqual([]);expect(errors).toEqual([]);expect(digest(await readFile(archivePath))).toBe(digest(original));
  await writeFile(info.outputPath('accessibility.json'),JSON.stringify(tree.model,null,2));await page.screenshot({path:info.outputPath('accessibility.png')});
 }finally{await browser.close()}
});

test('extension accessibility derives native Chromium AX offline without changing WACZ',async({},info)=>{
 const original=await readFile(archivePath),extension=path.resolve('.output/chrome-mv3');
 const context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-accessibility-replay-')),{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 const external:string[]=[],errors:string[]=[],rendered:string[]=[];
 context.on('page',page=>page.once('domcontentloaded',()=>{if(page.url().endsWith('/print.html'))rendered.push(page.url())}));
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);await context.setOffline(true);
  context.on('request',request=>{if(/^https?:/.test(request.url()))external.push(request.url())});page.on('pageerror',error=>errors.push(String(error)));
  const choosing=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);
  await expect(page.locator('#snapshot-output-browser')).toHaveAttribute('aria-busy','false',{timeout:60000});
  expect(rendered).toEqual([]);const tree=await readTree(page);expect(rendered).toHaveLength(1);
  expect(context.pages().filter(page=>page.url().endsWith('/print.html'))).toHaveLength(0);
  const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download WACZ',exact:true}).click();
  expect(digest(await readFile((await(await downloading).path())!))).toBe(digest(original));expect(external).toEqual([]);expect(errors).toEqual([]);
  await writeFile(info.outputPath('accessibility.json'),JSON.stringify(tree.model,null,2));await page.screenshot({path:info.outputPath('accessibility.png')});
 }finally{await context.close()}
});
