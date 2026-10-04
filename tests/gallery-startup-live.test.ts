import {test,expect,chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {openSnapshotOutput} from './snapshot-controls';

test('gallery originals paint without starting background OCR',async({},info)=>{
  test.setTimeout(90000);
  const context=await chromium.launch({headless:true});const page=await context.newPage({viewport:{width:1440,height:1000}});
  const requests:{url:string;at:number}[]=[],errors:string[]=[];const started=Date.now();
  page.context().on('request',request=>requests.push({url:request.url(),at:Date.now()-started}));page.on('pageerror',error=>errors.push(String(error)));
  try{
    await page.goto('http://127.0.0.1:8736/?source=http%3A%2F%2F127.0.0.1%3A8737%2Fcommons-all-plugins.wacz#view=gallerydl');
    const gallery=page.frameLocator('#main-frame-wrapper iframe[title="Image gallery"]');
    await expect(gallery.locator('#count')).toHaveText('12 images',{timeout:20000});
    const first=gallery.locator('#gallery img').first();await expect.poll(()=>first.evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0),{timeout:10000}).toBe(true);
    const painted=Date.now()-started;
    expect(requests.filter(request=>/ocr-sandbox|paddle|liteparse.*wasm/i.test(request.url)),'Gallery must not launch OCR for unrelated thumbnails').toEqual([]);
    expect(requests.filter(request=>/^https?:/.test(request.url)&&!request.url.startsWith('http://127.0.0.1:8736/')&&!request.url.startsWith('http://127.0.0.1:8737/'))).toEqual([]);
    expect(errors).toEqual([]);await page.screenshot({path:info.outputPath('gallery-startup.png')});
    await openSnapshotOutput(page,'liteparse');
    const documents=page.frameLocator('#main-frame-wrapper iframe[title="LiteParse"]');
    await expect(documents.locator('.tile').first()).toBeVisible({timeout:10000});
    await expect(page.locator('iframe[src*="ocr-sandbox"]')).toHaveCount(1,{timeout:15000});
    await openSnapshotOutput(page,'gallerydl');
    await expect(page.locator('iframe[src*="ocr-sandbox"]')).toHaveCount(0);
    await expect(gallery.locator('#count')).toHaveText('12 images',{timeout:3000});
    await writeFile(info.outputPath('timing.json'),JSON.stringify({painted,requests,errors},null,2));
  }finally{await writeFile(info.outputPath('requests.json'),JSON.stringify({elapsed:Date.now()-started,requests,errors},null,2));await context.close();}
});
