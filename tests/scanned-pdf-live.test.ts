import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';
import init,{LiteParse} from '@llamaindex/liteparse-wasm';
import {openSnapshotOutput} from './snapshot-controls';

test('actual scanned LinnSequencer PDF has offline OCR without a text layer',async({},info)=>{
  test.setTimeout(180000);
  const url='https://github.com/ocrmypdf/OCRmyPDF/blob/main/tests/resources/skew.pdf';
  const extension=path.resolve('.output/chrome-mv3');
  const context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-scanned-pdf-')),{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const errors:string[]=[],live:string[]=[];let studio;
  const report:Record<string,unknown>={url};
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');studio=await context.newPage();studio.on('pageerror',error=>errors.push(String(error)));
    await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    await studio.getByRole('button',{name:/\d+ plugins$/}).click();
    for(const option of await studio.locator('.plugin-option').all()){
      const checkbox=option.locator('input[type=checkbox]').first();
      if(await checkbox.isEnabled())await checkbox.setChecked(['Chrome navigation','Rendered DOM','LiteParse'].includes(await option.locator('strong').innerText()));
    }
    await studio.getByRole('spinbutton',{name:'LITEPARSE_MIN_IMAGE_DIMENSION',exact:true}).fill('5000');
    await studio.getByRole('textbox',{name:'Open URL',exact:true}).fill(url);await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
    await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:90000});
    const capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);report.capture=capture;expect(capture.state,JSON.stringify(capture)).toBe('complete');
    const download=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();const archivePath=info.outputPath('linnsequencer.wacz');await(await download).saveAs(archivePath);
    const originals:Uint8Array[]=[];for(const [name,bytes]of Object.entries(unzipSync(await readFile(archivePath))))if(name.startsWith('archive/'))for await(const record of new WARCParser([bytes])){const body=await record.readFully();if(new TextDecoder().decode(body.subarray(0,5))==='%PDF-')originals.push(body)}
    expect(originals).toHaveLength(1);
    const require=createRequire(import.meta.url);await init({module_or_path:await readFile(require.resolve('@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm'))});const parser=new LiteParse({ocrEnabled:false,imageMode:'off'});
    try{expect((await parser.parse(originals[0]!)).text.trim()).toBe('')}finally{parser.free()}
    await studio.getByRole('button',{name:'Delete capture',exact:true}).click();for(const page of context.pages())if(page!==studio)await page.close();
    await context.setOffline(true);context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url())});await studio.reload();
    const chooser=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await chooser).setFiles(archivePath);await openSnapshotOutput(studio,'liteparse');
    const viewer=studio.locator('#main-frame-wrapper .plugin-view').frameLocator('iframe[title="LiteParse"]');
    await expect(viewer.locator('.text-preview').first()).toContainText('LinnSequencer',{timeout:60000});await expect(viewer.locator('.text-preview').first()).toContainText('MIDI');
    const jsonDownload=studio.waitForEvent('download');await viewer.getByRole('link',{name:'JSON',exact:true}).first().click();const parsed=JSON.parse(await readFile((await(await jsonDownload).path())!,'utf8'));report.parsed=parsed;
    expect(parsed.engine.ocrPages).toBeGreaterThan(0);expect(parsed.totalPages).toBe(1);expect(parsed.pages[0].textItems.length).toBeGreaterThan(20);
    expect(parsed.pages[0].textItems.every((item:any)=>[item.x,item.y,item.width,item.height].every(Number.isFinite))).toBe(true);
    expect(parsed.images).toEqual([]);expect(parsed.screenshots).toEqual([]);expect(errors).toEqual([]);expect(live).toEqual([]);
    await studio.screenshot({path:info.outputPath('scanned-pdf-ocr.png'),fullPage:true});
  }finally{report.errors=errors;report.liveRequests=live;if(studio)await studio.screenshot({path:info.outputPath('final.png'),fullPage:true}).catch(()=>{});await writeFile(info.outputPath('report.json'),JSON.stringify(report,null,2));await context.close()}
});
