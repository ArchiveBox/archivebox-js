import {test,expect,chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
const player=process.env.ABX_PLAYER_URL||'http://127.0.0.1:8736/';
const source=process.env.ABX_HTTP_WACZ||'http://127.0.0.1:8737/commons-all-plugins.wacz';
test('real HTTP WACZ ranges and screenshot replay respect browser caching',async({},info)=>{
 const netlog=info.outputPath('netlog.json');
 const browser=await chromium.launch({channel:'chromium',headless:true,args:[`--log-net-log=${netlog}`]}),context=await browser.newContext(),page=await context.newPage(),requests:{method:string;range:string;url:string;cacheControl:string;fromServiceWorker:boolean}[]=[],external:string[]=[];
 context.on('request',request=>{const url=request.url();if(url===source)requests.push({url,method:request.method(),range:request.headers()['range']||'',cacheControl:request.headers()['cache-control']||'',fromServiceWorker:!!request.serviceWorker()});else if(/^https?:/.test(url)&&new URL(url).origin!==new URL(player).origin)external.push(url)});
 try{
  await page.goto(`${player}?source=${encodeURIComponent(source)}#view=screenshot`,{waitUntil:'domcontentloaded'});
  const image=page.frameLocator('#main-frame-wrapper iframe[title="Screenshot"]').locator('img.screenshot-fullscreen').first();await expect(image).toBeVisible({timeout:60000});await expect.poll(()=>image.evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBe(true);
  const stack=page.locator('.output-stack-raster');if(await stack.getAttribute('aria-expanded')!=='true')await stack.click();
  const cover=page.locator('.thumb-card[data-plugin-name="screenshot"] img.screenshot-thumbnail');await expect(cover).toHaveCount(1);await expect.poll(()=>cover.evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBe(true);
  // The cover is the original viewport JPEG; the full view may use separate
  // full-page PNG tiles. Reopening must reuse each role's genuine resource.
  const resources={cover:(await cover.getAttribute('src'))!,fullPage:(await image.getAttribute('src'))!};
  for(const url of Object.values(resources)){expect(new URL(url).origin).toBe(new URL(player).origin);expect(decodeURIComponent(url)).toMatch(/urn:(?:screenshot|fullPage):/);}
  await page.evaluate(()=>{location.hash='view=responses'});await expect(image).toBeHidden();
  await page.locator('.thumb-card[data-plugin-name="screenshot"]').click();await expect(image).toBeVisible();
  await expect(cover).toHaveAttribute('src',resources.cover);await expect(image).toHaveAttribute('src',resources.fullPage);
  await expect.poll(()=>image.evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBe(true);
  // Navigation can leave genuine archive range requests in flight. Probe the
  // stable HTTP cache after those requests finish, not during entry replacement.
  await page.waitForLoadState('networkidle');
  // Real requests against the retained capture, without intercepted responses.
  const repeated=await page.evaluate(async source=>{const results=[];for(let i=0;i<2;i++){const response=await fetch(source,{headers:{Range:'bytes=-65536'}});const bytes=await response.arrayBuffer();results.push({status:response.status,range:response.headers.get('content-range'),cache:response.headers.get('cache-control'),length:bytes.byteLength,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('')});}return results},source);
  expect(repeated[0]).toEqual(repeated[1]);expect(repeated[0]!.status).toBe(206);expect(repeated[0]!.length).toBe(65536);expect(repeated[0]!.range).toMatch(/^bytes \d+-\d+\/\d+$/);expect(repeated[0]!.cache).toMatch(/max-age=\d+/);
  // Context events include both page requests and service-worker forwarding.
  expect(requests.filter(request=>request.range==='bytes=-65536'&&!request.fromServiceWorker)).toHaveLength(2);
  expect(requests.filter(request=>request.method==='GET').every(request=>/^bytes=(?:\d+-\d+|-\d+)$/.test(request.range))).toBe(true);expect(requests.some(request=>request.range.startsWith('bytes=-'))).toBe(true);expect(requests.filter(request=>request.method==='GET').some(request=>request.cacheControl.includes('no-cache'))).toBe(false);expect(external).toEqual([]);
  await page.screenshot({path:info.outputPath('cached-screenshot.png'),fullPage:true});await writeFile(info.outputPath('http-cache.json'),JSON.stringify({requests,repeated,external,resources},null,2));
 }finally{await context.close();await browser.close()}
 // NetLog observes Chromium's actual sparse HTTP-cache reads. DevTools can
 // report fromDiskCache=false for a cached range forwarded by a service worker.
 const log=JSON.parse(await readFile(netlog,'utf8')),types=log.constants.logEventTypes;
 // Chromium may log headers twice when restarting one cache transaction.
 // Count the two logical requests by their NetLog source IDs, not log lines.
 const reads=[...new Map<number,any>(log.events.filter((event:any)=>event.type===types.HTTP_CACHE_CALLER_REQUEST_HEADERS&&event.params.headers.includes('Range: bytes=-65536')).map((event:any)=>[event.source.id,event])).values()];
 expect(reads).toHaveLength(2);
 const events=log.events.filter((event:any)=>event.source.id===reads[1].source.id).map((event:any)=>event.type);
 expect(events).toContain(types.HTTP_CACHE_READ_DATA);
 expect(events).not.toContain(types.HTTP_TRANSACTION_SEND_REQUEST);
});
