import {test,expect,chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const player=process.env.ABX_SHEETS_PLAYER||'http://127.0.0.1:8736';
const source=process.env.ABX_SHEETS_SOURCE||'http://127.0.0.1:8737/google-spreadsheets-all-plugins-derived-20261004.wacz';
const archive=process.env.ABX_SHEETS_WACZ||'/tmp/abx-wacz-demo/google-spreadsheets-all-plugins-derived-20261004.wacz';
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

test('original Google Sheets app replays its worker, grid and both sheets without original network',async({},info)=>{
 test.setTimeout(90000);
 const original=digest(await readFile(archive)),browser=await chromium.launch({channel:'chromium',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 const external:string[]=[],errors:string[]=[],wasm:string[]=[];
 context.on('request',request=>{const url=new URL(request.url());if(/^https?:$/.test(url.protocol)&&![new URL(player).origin,new URL(source).origin].includes(url.origin))external.push(url.href)});
 page.on('pageerror',error=>errors.push(String(error)));
 context.on('response',response=>{if(response.url().includes('calcworker_wasm.wasm')&&response.ok())wasm.push(response.url())});
 try{
  const started=Date.now();
  await page.goto(`${player}/?source=${encodeURIComponent(source)}#view=archivewebpage`,{waitUntil:'domcontentloaded'});
  const replay=page.frameLocator('#main-frame-wrapper iframe');
  await expect(replay.locator('#t-formula-bar-input')).toHaveText('Date',{timeout:30000});
  const readyMs=Date.now()-started;
  await expect(replay.locator('canvas').first()).toBeVisible();
  await expect(replay.getByText('An error occurred',{exact:true})).toHaveCount(0);
  await expect(replay.locator('.docs-sheet-active-tab')).toContainText('Test Sheet');
  await replay.locator('#t-name-box').fill('B2');await replay.locator('#t-name-box').press('Enter');
  await expect(replay.locator('#t-formula-bar-input')).toHaveText('Joe');
  await page.screenshot({path:info.outputPath('first-sheet.png'),fullPage:true});
  await replay.getByText('this/that',{exact:true}).click();
  await expect(replay.locator('.docs-sheet-active-tab')).toContainText('this/that');
  await replay.locator('#t-name-box').fill('B2');await replay.locator('#t-name-box').press('Enter');
  await expect(replay.locator('#t-formula-bar-input')).toHaveText('BB');
  await page.screenshot({path:info.outputPath('second-sheet.png'),fullPage:true});
  await replay.getByText('Test Sheet',{exact:true}).click();
  await expect(replay.locator('.docs-sheet-active-tab')).toContainText('Test Sheet');
  await expect(replay.locator('#t-formula-bar-input')).toHaveText('Joe');
  await expect.poll(()=>wasm.length).toBeGreaterThan(0);
  expect(wasm.every(url=>url.startsWith(`${player}/w/`))).toBe(true);
  expect(external).toEqual([]);expect(errors).toEqual([]);
  expect(digest(await readFile(archive))).toBe(original);
  await writeFile(info.outputPath('replay.json'),JSON.stringify({readyMs,wasm,external,errors,archiveSha256:original},null,2));
 }finally{await browser.close()}
});

for(const kind of ['document','presentation','drawings'])test(`original Google ${kind} app renders offline without bootstrap errors`,async({},info)=>{
 const appSource=`http://127.0.0.1:8737/google-${kind}-all-plugins-derived-20261004.wacz`;
 const browser=await chromium.launch({channel:'chromium',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 const external:string[]=[],errors:string[]=[];
 context.on('request',request=>{const url=new URL(request.url());if(/^https?:$/.test(url.protocol)&&![new URL(player).origin,new URL(appSource).origin].includes(url.origin))external.push(url.href)});
 page.on('pageerror',error=>errors.push(String(error)));
 try{
  await page.goto(`${player}/?source=${encodeURIComponent(appSource)}#view=archivewebpage`,{waitUntil:'domcontentloaded'});
  const replay=page.frameLocator('#main-frame-wrapper iframe');
  if(kind==='document'){
   await expect(replay.locator('canvas.kix-canvas-tile-content')).toBeVisible({timeout:30000});
   await expect(replay.getByRole('button',{name:'Hide tabs & outlines',exact:true})).toBeVisible();
   await replay.getByRole('button',{name:'Hide tabs & outlines',exact:true}).click();
   await expect(replay.getByRole('button',{name:'Hide tabs & outlines',exact:true})).toBeHidden();
  }else if(kind==='presentation'){
   await expect(replay.locator('#pages')).toContainText('BabyAlbum',{timeout:30000});
   await expect(replay.locator('.punch-filmstrip-thumbnail')).toHaveCount(5);
   await replay.locator('.punch-filmstrip-thumbnail').nth(1).click();
   await expect(replay.locator('#pages')).toContainText('Bathtimeissomuchfun!');
   await replay.locator('.punch-filmstrip-thumbnail').nth(2).click();
   await expect(replay.locator('#pages')).toContainText('Boyslovetheirtoys!');
  }else{
   await expect(replay.locator('#pages')).toContainText('Here’sanimage.',{timeout:30000});
   await expect(replay.locator('#pages image').first()).toBeVisible();
   await replay.getByRole('button',{name:'Hide the menus (Ctrl+Shift+F)',exact:true}).click();
   await expect(replay.getByRole('button',{name:'Show the menus (Ctrl+Shift+F)',exact:true})).toBeVisible();
  }
  await expect(replay.getByText('An error occurred',{exact:true})).toHaveCount(0);
  await page.screenshot({path:info.outputPath(`${kind}.png`),fullPage:true});
  expect(errors).toEqual([]);expect(external).toEqual([]);
  await writeFile(info.outputPath('replay.json'),JSON.stringify({errors,external},null,2));
 }finally{await browser.close()}
});

test('unrelated Sweeting JavaScript replay retains its content and images',async({},info)=>{
 const appSource='http://127.0.0.1:8737/sweeting-all-plugins-20261004.wacz';
 const browser=await chromium.launch({channel:'chromium',headless:true}),context=await browser.newContext(),page=await context.newPage();
 const external:string[]=[],errors:string[]=[];
 context.on('request',request=>{const url=new URL(request.url());if(/^https?:$/.test(url.protocol)&&![new URL(player).origin,new URL(appSource).origin].includes(url.origin))external.push(url.href)});
 page.on('pageerror',error=>errors.push(String(error)));
 try{
  await page.goto(`${player}/?source=${encodeURIComponent(appSource)}#view=archivewebpage`,{waitUntil:'domcontentloaded'});
  const replay=page.frameLocator('#main-frame-wrapper iframe');
  await expect(replay.locator('body')).toContainText('Nick Sweeting');
  await expect(replay.locator('body')).toBeVisible();
  await expect.poll(()=>replay.locator('body').evaluate(()=>Array.from(document.images).filter(image=>image.complete&&image.naturalWidth>0).length)).toBeGreaterThan(4);
  expect(errors).toEqual([]);expect(external).toEqual([]);
  await page.screenshot({path:info.outputPath('sweeting.png')});
 }finally{await browser.close()}
});
