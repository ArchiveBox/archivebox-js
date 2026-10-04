import {test,expect,chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import * as mupdf from 'mupdf';
import {openSnapshotOutput} from './snapshot-controls';

test('HTTP PDF card generates a downloadable native PDF from the real HN capture',async({},info)=>{
 const browser=await chromium.launch({channel:'chromium',headless:true}),context=await browser.newContext({acceptDownloads:true}),page=await context.newPage();
 const external:string[]=[],errors:string[]=[];
 context.on('request',request=>{if(/^https?:/.test(request.url())&&!['http://127.0.0.1:8736','http://127.0.0.1:8737'].includes(new URL(request.url()).origin))external.push(request.url())});page.on('pageerror',error=>errors.push(String(error)));
 try{
  await page.goto('http://127.0.0.1:8736/?source=http%3A%2F%2F127.0.0.1%3A8737%2Fhacker-news-49944227-all-plugins-scroll-20261004.wacz#view=title',{waitUntil:'domcontentloaded'});
  const panel=await openSnapshotOutput(page,'pdf');
  await expect(panel.getByRole('button',{name:'Print PDF'})).toHaveCount(0);
  const frame=panel.locator('iframe[title="Archived PDF"]');await expect(frame).toHaveAttribute('src',/^blob:/,{timeout:60000});
  await expect(panel.getByRole('progressbar')).toHaveCount(0);
  await expect.poll(()=>page.frames().some(frame=>frame.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'))).toBe(true);
  const native=page.frames().find(frame=>frame.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'))!;
  await native.waitForFunction(()=>{const viewer=document.querySelector('pdf-viewer') as any;return viewer?.initialLoadComplete_&&viewer.loadState_==='success'});
  const download=page.waitForEvent('download');await native.getByRole('button',{name:'Download',exact:true}).click();const bytes=await readFile((await(await download).path())!);
  const pdf=mupdf.Document.openDocument(bytes,'application/pdf');let text='';const pages=pdf.countPages();
  for(let i=0;i<pages;i++){const page=pdf.loadPage(i),structured=page.toStructuredText('');text+=structured.asText();structured.destroy();page.destroy()}pdf.destroy();
  expect(text).toContain('I quit OpenAI');expect(pages).toBeGreaterThan(1);expect(text.length).toBeGreaterThan(10000);
  expect(context.pages()).toHaveLength(1);expect(external).toEqual([]);expect(errors).toEqual([]);
  await writeFile(info.outputPath('rendered.pdf'),bytes);await page.screenshot({path:info.outputPath('native-pdf.png')});
 }finally{await browser.close()}
});
