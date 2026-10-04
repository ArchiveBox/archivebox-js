import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openSnapshotOutput} from './snapshot-controls';

test('real scanned filing has offline OCR, canonical original/text tiles and unchanged WACZ',async({},info)=>{
  test.setTimeout(180000);
  const url='https://raw.githubusercontent.com/scribeocr/ocr-benchmark/main/img/filing_01.png';
  const extension=path.resolve('.output/chrome-mv3');
  const context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-image-ocr-')),{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const errors:string[]=[],live:string[]=[];const report:Record<string,unknown>={url};
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const studio=await context.newPage();studio.on('pageerror',error=>errors.push(String(error)));
    await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    await studio.getByRole('button',{name:/\d+ plugins$/}).click();
    for(const option of await studio.locator('.plugin-option').all()){
      const checkbox=option.locator('input[type=checkbox]').first();
      if(await checkbox.isEnabled())await checkbox.setChecked(['Chrome navigation','Rendered DOM','LiteParse'].includes(await option.locator('strong').innerText()));
    }
    await studio.getByRole('textbox',{name:'Open URL',exact:true}).fill(url);
    await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
    await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:90000});
    const capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
    expect(capture.state,JSON.stringify(capture)).toBe('complete');report.capture=capture;
    const download=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();
    const archivePath=info.outputPath('filing.wacz');await(await download).saveAs(archivePath);
    const before=createHash('sha256').update(await readFile(archivePath)).digest('hex');
    await studio.getByRole('button',{name:'Delete capture',exact:true}).click();
    for(const page of context.pages())if(page!==studio)await page.close();
    await context.setOffline(true);context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url())});
    await studio.reload();const chooser=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await chooser).setFiles(archivePath);
    await openSnapshotOutput(studio,'liteparse');
    const viewer=studio.locator('#main-frame-wrapper .plugin-view').frameLocator('iframe[title="LiteParse"]');
    await expect(viewer.locator('.tile')).toHaveCount(1,{timeout:60000});
    await expect(viewer.locator('.text-preview')).toContainText('UNITED STATES',{timeout:60000});
    await expect(viewer.locator('.text-preview')).toContainText('COMMISSION');
    expect(await viewer.locator('.original img').evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth>0&&!img.src.startsWith('data:'))).toBe(true);
    const jsonDownload=studio.waitForEvent('download');await viewer.getByRole('link',{name:'JSON',exact:true}).click();
    const parsed=JSON.parse(await readFile((await(await jsonDownload).path())!,'utf8'));report.parsed=parsed;
    expect(parsed.engine.ocr).toContain('PaddleOCR');expect(parsed.pages[0].textItems.length).toBeGreaterThan(20);
    expect(parsed.pages[0].textItems.every((item:any)=>[item.x,item.y,item.width,item.height,item.confidence].every(Number.isFinite))).toBe(true);
    const afterDownload=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();
    expect(createHash('sha256').update(await readFile((await(await afterDownload).path())!)).digest('hex')).toBe(before);
    report.text=await viewer.locator('.text-preview').innerText();expect(live).toEqual([]);expect(errors).toEqual([]);
    await studio.screenshot({path:info.outputPath('ocr-original-text.png'),fullPage:true});
  }finally{report.errors=errors;report.liveRequests=live;await writeFile(info.outputPath('ocr-report.json'),JSON.stringify(report,null,2));await context.close();}
});
