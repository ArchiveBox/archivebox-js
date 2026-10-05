import {readWaczPackage} from './wacz-evidence';
import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import * as mupdf from 'mupdf';
import {openSnapshotOutput} from './snapshot-controls';

test('opening PDF automatically prints the archived page without changing WACZ',async({},info)=>{
  const archivePath=process.env.ABX_LAZY_PDF_WACZ;if(!archivePath)throw Error('ABX_LAZY_PDF_WACZ must name a new all-plugin webpage capture without a printed PDF');
  const original=await readFile(archivePath),zip=unzipSync(original),manifest=(await readWaczPackage(zip));
  expect(manifest.metadata.plugins.some((plugin:{id:string})=>plugin.id==='pdf')).toBe(true);
  expect(Object.keys(zip).filter(name=>name.startsWith('pdf/'))).toEqual([]);
  const extension=path.resolve('.output/chrome-mv3'),context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-lazy-pdf-')),{channel:'chromium',headless:true,acceptDownloads:true,viewport:{width:1440,height:1000},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const external:string[]=[],errors:string[]=[],printConsole:string[]=[],styles:string[]=[],redirects:unknown[]=[],imageRequests:string[]=[];
  context.on('page',page=>{page.on('request',request=>{if(page.url().endsWith('/print.html')&&request.resourceType()==='image')imageRequests.push(request.url())});page.on('console',message=>{if(page.url().endsWith('/print.html'))printConsole.push(message.type()+': '+message.text())});page.on('requestfailed',request=>{if(page.url().endsWith('/print.html'))printConsole.push('failed: '+request.url()+': '+request.failure()?.errorText)});page.on('response',response=>{if(page.url().endsWith('/print.html')){if(response.ok()&&response.request().resourceType()==='stylesheet')styles.push(response.url());if(response.status()>=300&&response.status()<400)void response.allHeaders().then(headers=>redirects.push({url:response.url(),status:response.status(),headers}))}})});
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);await context.setOffline(true);context.on('request',request=>{if(/^https?:/.test(request.url()))external.push(request.url())});page.on('pageerror',error=>errors.push(String(error)));
    const choosing=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);await expect(page.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:60000});
    const before=await page.evaluate(async()=>{const capture=((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0];const index=await chrome.runtime.sendMessage({type:'inspect-wacz',id:capture.id});return{id:capture.id,entries:index.entries,hooks:capture.hooks}});
    expect(before.entries.filter((entry:{url:string})=>entry.url.startsWith('urn:pdf:'))).toEqual([]);expect(before.hooks.filter((hook:{plugin:string})=>hook.plugin==='pdf')).toEqual([]);
    await openSnapshotOutput(page,'pdf');
    await expect(page.locator('#main-frame-wrapper').getByRole('button',{name:'Print PDF',exact:true})).toHaveCount(0);
    const frame=page.locator('#main-frame-wrapper iframe[title="Archived PDF"]');await expect(frame).toHaveAttribute('src',/^blob:/,{timeout:60000});
    const bytes=Buffer.from(await frame.evaluate(async(node:HTMLIFrameElement)=>Array.from(new Uint8Array(await(await fetch(node.src.split('#')[0]!)).arrayBuffer()))));expect(bytes.subarray(0,5).toString()).toBe('%PDF-');
    await writeFile(info.outputPath('printed.pdf'),bytes);const document=mupdf.Document.openDocument(bytes,'application/pdf');expect(document.countPages()).toBeGreaterThan(0);let text='';
    for(let index=0;index<document.countPages();index++){const page=document.loadPage(index),structured=page.toStructuredText('');text+=structured.asText();structured.destroy();page.destroy()}document.destroy();expect(text.trim().length).toBeGreaterThan(20);
    if(new URL(manifest.metadata.url).hostname==='github.com')expect(text.toLowerCase()).toContain(new URL(manifest.metadata.url).pathname.split('/')[2]!.toLowerCase());
    expect(context.pages().filter(item=>item.url().endsWith('/print.html'))).toHaveLength(0);
    const after=await page.evaluate(async id=>await chrome.runtime.sendMessage({type:'inspect-wacz',id}),before.id);expect(after.entries).toEqual(before.entries);
    const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download WACZ',exact:true}).click();const exported=await readFile((await(await downloading).path())!);expect(createHash('sha256').update(exported).digest('hex')).toBe(createHash('sha256').update(original).digest('hex'));
    await writeFile(info.outputPath('report.json'),JSON.stringify({archivePath,pdfBytes:bytes.length,text,entries:before.entries.length,external,errors,printConsole,styles},null,2));
    if(new URL(manifest.metadata.url).pathname==='/pirate/zfsify'){
      const originalImage='https://github.com/pirate/zfsify/raw/main/docs/assets/recordings/phase-1.gif';
      const replayImage=imageRequests.find(url=>url.endsWith('/'+originalImage));expect(replayImage,'Print replay must request the original redirecting GitHub image').toBeTruthy();
      const decoded=await page.evaluate(async url=>{const image=new Image();image.src=url;try{await image.decode();return{url,width:image.naturalWidth,height:image.naturalHeight,error:''}}catch(error){return{url,width:image.naturalWidth,height:image.naturalHeight,error:String(error)}}},replayImage!);
      await writeFile(info.outputPath('redirect-image.json'),JSON.stringify(decoded,null,2));expect(decoded.error).toBe('');expect(decoded.width).toBeGreaterThan(0);expect(decoded.height).toBeGreaterThan(0);
    }
    expect(printConsole.filter(line=>line.includes('ERR_UNSAFE_REDIRECT'))).toEqual([]);
    expect(external).toEqual([]);expect(errors).toEqual([]);expect(styles.length,'Archived page styles must load into the printed document').toBeGreaterThan(0);expect(printConsole.filter(line=>line.startsWith('failed:')&&line.endsWith(': inspector'))).toEqual([]);await page.screenshot({path:info.outputPath('lazy-pdf.png')});
  }finally{await writeFile(info.outputPath('print-resources.json'),JSON.stringify({printConsole,styles,external,errors,redirects,imageRequests},null,2));await context.close()}
});
