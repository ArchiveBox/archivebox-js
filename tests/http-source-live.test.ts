import {test,expect,chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';

// Reuse an actual retained capture served with HTTP Range and CORS support.
// No source-site traffic, generated archive, request interception or UI stubs.
test('HTTP WACZ header inspection releases ranges and preserves original gallery downloads',async({},info)=>{
  test.setTimeout(120000);
  const player=process.env.ABX_PLAYER_URL||'http://127.0.0.1:8736/';
  const source=process.env.ABX_HTTP_WACZ||'http://127.0.0.1:8737/commons-gallery.wacz';
  const response=await fetch(source);expect(response.ok).toBe(true);
  const zip=unzipSync(new Uint8Array(await response.arrayBuffer()));
  const originals=new Map<string,{headers:Record<string,string>;requestHeaders:Record<string,string>;digest:string;size:number}>();
  for(const [name,data]of Object.entries(zip))if(name.startsWith('archive/'))for await(const record of new WARCParser([data])){
    const body=await record.readFully(),key=record.warcTargetURI+'@'+Date.parse(record.warcDate!);
    if(record.warcType==='response'&&record.httpHeaders?.headers.get('content-type')?.startsWith('image/')&&record.warcTargetURI?.includes('utm_content=original'))originals.set(key,{headers:Object.fromEntries(record.httpHeaders.headers),requestHeaders:{},digest:createHash('sha256').update(body).digest('hex'),size:body.length});
    else if(record.warcType==='request'&&originals.has(key))originals.get(key)!.requestHeaders=Object.fromEntries(record.httpHeaders?.headers||[]);
  }
  expect(originals.size).toBe(Number(process.env.ABX_HTTP_IMAGE_COUNT||5));
  const browser=await chromium.launch({channel:'chromium',headless:true}),context=await browser.newContext({acceptDownloads:true}),page=await context.newPage();
  const errors:string[]=[],external:string[]=[],ranges:{range:string;url:string}[]=[];
  page.on('pageerror',error=>errors.push(String(error)));context.on('request',request=>{const url=request.url();if(/^https?:/.test(url)&&![new URL(player).origin,new URL(source).origin].includes(new URL(url).origin))external.push(url);if(url===source)ranges.push({url,range:request.headers()['range']||''});});
  try{
    const address=new URL(player);address.searchParams.set('source',source);address.hash='view=gallerydl';await page.goto(address.href);
    const gallery=page.frameLocator('#main-frame-wrapper iframe[title="Image gallery"]');await expect(gallery.locator('#count')).toHaveText(`${originals.size} images`,{timeout:60000});
    await expect.poll(()=>gallery.locator('#gallery .tile img').evaluateAll(images=>images.every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0)),{timeout:30000}).toBe(true);
    // Open every large original's actual request pair repeatedly. Reading only
    // headers must not leave the corresponding multi-megabyte range alive.
    for(let pass=0;pass<2;pass++)for(const [key,original]of originals){
      const separator=key.lastIndexOf('@'),url=key.slice(0,separator),ts=key.slice(separator+1);
      await page.evaluate(({url,ts})=>{location.hash=new URLSearchParams({view:'responses',request:url,ts}).toString()},{url,ts});
      const detail=page.getByRole('region',{name:'Selected request'});await expect(detail.locator('.response-selected code')).toHaveText(url);await expect(detail.locator('.response-headers')).toHaveCount(3);
      const actual=await detail.locator('.response-headers').last().evaluate(dl=>Object.fromEntries([...dl.querySelectorAll('dt')].map(dt=>[dt.textContent!.toLowerCase(),dt.nextElementSibling!.textContent])));
      expect(actual).toEqual(Object.fromEntries(Object.entries(original.requestHeaders).map(([name,value])=>[name.toLowerCase(),value])));
      const responseHeaders=await detail.locator('.response-headers').nth(1).evaluate(dl=>Object.fromEntries([...dl.querySelectorAll('dt')].map(dt=>[dt.textContent!.toLowerCase(),dt.nextElementSibling!.textContent])));
      expect(responseHeaders).toEqual(Object.fromEntries(Object.entries(original.headers).map(([name,value])=>[name.toLowerCase(),value])));
    }
    await page.evaluate(()=>{location.hash='view=gallerydl'});await expect(gallery.locator('#count')).toHaveText(`${originals.size} images`);
    const first=gallery.locator('#gallery .tile img').first(),originalURL=(await first.getAttribute('src'))!.split('id_/')[1]!,expected=[...originals].find(([key])=>key.startsWith(originalURL+'@'))![1];
    const downloading=page.waitForEvent('download');await gallery.locator('#download').click();const download=await downloading;expect(await download.failure()).toBeNull();const filename=info.outputPath(download.suggestedFilename());await download.saveAs(filename);
    const {readFile}=await import('node:fs/promises');const bytes=await readFile(filename);expect(bytes.length).toBe(expected.size);expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected.digest);
    expect(errors).toEqual([]);expect(external).toEqual([]);expect(ranges.length).toBeGreaterThan(10);await expect(page.getByRole('alert')).toHaveCount(0);
    await page.screenshot({path:info.outputPath('http-original-gallery.png'),fullPage:true});await writeFile(info.outputPath('http-range-evidence.json'),JSON.stringify({source,errors,external,ranges,download:{size:bytes.length,sha256:expected.digest}},null,2));
  }finally{await context.close();await browser.close()}
});
