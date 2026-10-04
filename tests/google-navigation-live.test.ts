import {test,expect,chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {openSnapshotOutput} from './snapshot-controls';

const player='http://127.0.0.1:8736';
const source='http://127.0.0.1:8737/google-spreadsheets-all-plugins-derived-20261004.wacz';

test('Sheets exports initially show the selected sheet as a CSV table',async({},info)=>{
 const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage();
 try{
  await page.goto(`${player}/?source=${encodeURIComponent(source)}#view=googledocs`);
  const viewer=page.frameLocator('#main-frame-wrapper .plugin-view[data-plugin="googledocs"] > iframe');
  await expect(viewer.locator('#formats [data-format="csv"]')).toHaveAttribute('aria-pressed','true');
  await expect(viewer.locator('#preview table')).toBeVisible();
  await expect(viewer.locator('#preview table')).toContainText('BB');
  await expect(viewer.locator('#preview iframe')).toHaveCount(0);
  await viewer.locator('#sheet').selectOption({label:'Test Sheet'});
  await expect(viewer.locator('#preview table')).toContainText('Joe');
  await page.screenshot({path:info.outputPath('sheets-table.png'),fullPage:true});
 }finally{await browser.close()}
});

test('rapid real snapshot card navigation leaves a responsive tab and no detached replay errors',async({},info)=>{
 test.setTimeout(120000);
 const browser=await chromium.launch({channel:'chromium',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage();
 const errors:string[]=[],external:string[]=[],crashes:string[]=[];
 page.on('pageerror',error=>errors.push(error.stack||String(error)));page.on('crash',()=>crashes.push('crash'));
 context.on('request',request=>{const url=new URL(request.url());if(/^https?:$/.test(url.protocol)&&!['http://127.0.0.1:8736','http://127.0.0.1:8737'].includes(url.origin))external.push(url.href)});
 const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
 const measurements:unknown[]=[];
 try{
  await page.goto(`${player}/?source=${encodeURIComponent(source)}#view=archivewebpage`,{waitUntil:'domcontentloaded'});
  await expect(page.frameLocator('#main-frame-wrapper iframe').locator('#t-formula-bar-input')).toHaveText('Date',{timeout:30000});
  const listeners=async()=>{const result=await cdp.send('Runtime.evaluate',{expression:'({window:(getEventListeners(window).message||[]).filter(item=>String(item.listener).includes("onReplayMessage")).length,worker:(getEventListeners(navigator.serviceWorker).message||[]).filter(item=>String(item.listener).includes("handleSWMessage")).length})',includeCommandLineAPI:true,returnByValue:true});return result.result.value};
  const initialListeners=await listeners();
  expect(initialListeners).toEqual({window:1,worker:1});
  const singlefile=await openSnapshotOutput(page,'singlefile');
  await expect(singlefile.frameLocator('iframe[title="Offline document"]').locator('body')).toContainText('opensheet test',{timeout:30000});
  for(let round=0;round<3;round++){
   for(const plugin of ['singlefile','dom','accessibility','googledocs','responses','screenshot','seo','headers','readability','archivewebpage'])await openSnapshotOutput(page,plugin);
   await cdp.send('HeapProfiler.collectGarbage');
   measurements.push(await cdp.send('Performance.getMetrics'));
  }
  const output=await openSnapshotOutput(page,'googledocs');
  await expect(output.frameLocator('iframe').locator('#formats button')).not.toHaveCount(0);
  await expect(output.locator('[role="alert"]')).toHaveCount(0);
  await page.screenshot({path:info.outputPath('rapid-navigation.png'),fullPage:true});
  const finalListeners=await listeners();measurements.push({initialListeners,finalListeners});
  expect(finalListeners).toEqual(initialListeners);
  expect(crashes).toEqual([]);expect(errors).toEqual([]);expect(external).toEqual([]);
 }finally{
  await writeFile(info.outputPath('navigation.json'),JSON.stringify({errors,external,crashes,measurements},null,2));
  await browser.close();
 }
});
