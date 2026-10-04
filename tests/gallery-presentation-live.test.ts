import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {openSnapshotOutput} from './snapshot-controls';

test('canonical gallery displays real Commons originals, cover, modal and download offline',async({},info)=>{
  test.setTimeout(180000);
  const directory=process.env.ABX_GALLERY_CAPTURE_DIR;
  expect(directory,'Set ABX_GALLERY_CAPTURE_DIR to completed gallery-upstream-live evidence').toBeTruthy();
  let source='';for(const dir of await readdir(directory!,{withFileTypes:true})){if(!dir.isDirectory())continue;const filename=path.join(directory!,dir.name,'commons-gallery.wacz');if(await readFile(filename).then(()=>true,()=>false)){source=filename;break;}}
  expect(source,'A real Commons WACZ is required').not.toBe('');
  const extension=path.resolve('.output/chrome-mv3');
  const context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-gallery-ui-')),{channel:'chromium',headless:true,acceptDownloads:true,viewport:{width:1440,height:1100},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);await context.setOffline(true);
    const external:string[]=[];context.on('request',request=>{if(/^https?:/.test(request.url()))external.push(request.url())});
    const choosing=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(source);await openSnapshotOutput(page,'gallerydl');
    const gallery=page.frameLocator('#main-frame-wrapper iframe[title="Image gallery"]');await expect(gallery.locator('#count')).toHaveText('5 images',{timeout:90000});
    const images=gallery.locator('#gallery .tile img');await expect(images).toHaveCount(5);
    for(const image of await images.all())await expect.poll(()=>image.evaluate((image:HTMLImageElement)=>({width:image.naturalWidth,replay:image.currentSrc.includes('/w/'),data:image.currentSrc.startsWith('data:')}))).toMatchObject({replay:true,data:false});
    await expect.poll(()=>images.evaluateAll(images=>images.every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0))).toBe(true);
    await expect(gallery.locator('body')).not.toContainText('Source and transport');await expect(gallery.locator('body')).not.toContainText('bundled extractor');
    const cover=page.locator('[data-resource-preview="gallerydl"] .gallerydl-thumbnail img');expect(await cover.count()).toBeGreaterThan(0);await expect.poll(()=>cover.evaluateAll(images=>images.every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0))).toBe(true);
    // The two 83MP originals render via Chromium's scaled decoder, while
    // img.decode() rejects them despite successful scaled painting. Check
    // actual painted pixels rather than that unrelated allocation API.
    for(let i=0;i<5;i++){
      const pixels=await images.nth(i).screenshot({path:info.outputPath(`commons-original-${i+1}.png`)});
      const colors=await page.evaluate(async bytes=>{const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d')!;ctx.drawImage(bitmap,0,0);const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data,colors=new Set<string>();for(let i=0;i<rgba.length;i+=4)colors.add(`${rgba[i]},${rgba[i+1]},${rgba[i+2]}`);bitmap.close();return colors.size},Array.from(pixels));
      expect(colors,`Original ${i+1} must actually paint image pixels`).toBeGreaterThan(100);
    }
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({path:info.outputPath('commons-canonical-gallery.png'),fullPage:true});
    await gallery.locator('#gallery .tile > a').first().click();await expect(gallery.getByRole('dialog',{name:'Image preview'})).toBeVisible();await expect.poll(()=>gallery.locator('#viewer-image').evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBe(true);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.screenshot({path:info.outputPath('commons-image-modal.png'),fullPage:true});
    const originalURL=(await images.first().getAttribute('src'))!.split('id_/')[1]!;
    const originalDigest=await page.evaluate(async originalURL=>{const capture=((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0];const index=await chrome.runtime.sendMessage({type:'inspect-wacz',id:capture.id});return index.entries.find((entry:any)=>entry.url===originalURL)?.digest as string|undefined},originalURL);
    expect(originalDigest).toBeTruthy();
    const downloading=page.waitForEvent('download');await gallery.locator('#viewer-download').click();const download=await downloading;const filename=info.outputPath(download.suggestedFilename());await download.saveAs(filename);expect(await download.failure()).toBeNull();expect(createHash('sha256').update(await readFile(filename)).digest('hex')).toBe(originalDigest!.replace(/^sha-?256:/i,'').toLowerCase());
    await gallery.getByRole('button',{name:'Close image'}).click();await expect(gallery.getByRole('dialog')).not.toBeVisible();
    await page.setViewportSize({width:390,height:844});await expect.poll(()=>gallery.locator('#gallery').evaluate(element=>getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(2);await page.screenshot({path:info.outputPath('commons-canonical-gallery-mobile.png'),fullPage:true});
    expect(external).toEqual([]);await expect(page.getByRole('alert')).toHaveCount(0);
  }finally{await context.close();}
});
