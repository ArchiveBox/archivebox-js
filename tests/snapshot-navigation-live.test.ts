import {test,expect,chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {openSnapshotOutput} from './snapshot-controls';

test('real snapshot navigation reuses rendered outputs and omits known empty cards',async({},info)=>{
 const browser=await chromium.launch({channel:'chromium',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage();
 const requests:string[]=[],errors:string[]=[],timings:{plugin:string;round:number;milliseconds:number}[]=[];
 context.on('request',request=>requests.push(request.url()));page.on('pageerror',error=>errors.push(String(error)));
 const documents=new Map<string,any>(),content=new Map<string,string>();
 try{
  await page.goto('http://127.0.0.1:8736/?source=http%3A%2F%2F127.0.0.1%3A8737%2Fsweeting-all-plugins-20261004.wacz#view=seo');
  for(let round=0;round<2;round++)for(const plugin of ['seo','headers','readability','ytdlp']){
   const start=performance.now(),panel=await openSnapshotOutput(page,plugin);
   await expect(panel.locator(':scope > .loading')).toHaveCount(0,{timeout:60000});
   const frame=panel.locator(':scope > iframe');await expect(frame).toBeVisible();
   await expect.poll(()=>frame.evaluate((frame:HTMLIFrameElement)=>frame.contentDocument?.body?.innerText.length||0)).toBeGreaterThan(50);
   if(plugin==='ytdlp')await expect(panel.frameLocator('iframe').locator('#queue .item')).toHaveCount(10);
   if(plugin==='readability')await expect.poll(()=>panel.frameLocator('iframe').locator('#reader').evaluate((frame:HTMLIFrameElement)=>frame.contentDocument?.body?.innerText.length||0)).toBeGreaterThan(50);
   const text=await frame.evaluate((frame:HTMLIFrameElement)=>frame.contentDocument!.body.innerText);
   if(round===0){documents.set(plugin,await frame.evaluateHandle((frame:HTMLIFrameElement)=>frame.contentDocument));content.set(plugin,text)}
   else expect(text).toEqual(content.get(plugin));
   timings.push({plugin,round,milliseconds:Math.round(performance.now()-start)});
  }
  const retained=Object.fromEntries(await Promise.all([...documents].map(async([plugin,doc])=>[plugin,await doc.evaluate((doc:Document)=>!!doc.defaultView?.frameElement?.isConnected)])));
  const empty=await page.locator('.thumb-card[data-plugin-name]').evaluateAll(cards=>cards.map(card=>(card as HTMLElement).dataset.pluginName).filter(name=>['forumdl','gallerydl','papersdl','git','rss','manifest'].includes(name!)));
  await writeFile(info.outputPath('navigation.json'),JSON.stringify({timings,retained,empty,requests,errors},null,2));
  await page.screenshot({path:info.outputPath('navigation.png'),fullPage:true});
  expect(errors).toEqual([]);
  expect(retained).toEqual({seo:true,headers:true,readability:true,ytdlp:true});
  expect(empty).toEqual([]);
  expect(requests.filter(url=>url.includes('embed=1'))).toEqual([]);
  const media=page.locator('#main-frame-wrapper .plugin-view:visible').frameLocator('iframe').locator('#stage audio, #stage video');
  await media.evaluate((element:HTMLMediaElement)=>element.play());
  await expect.poll(()=>media.evaluate((element:HTMLMediaElement)=>element.currentTime)).toBeGreaterThan(0);
  const playing=await media.elementHandle();
  await openSnapshotOutput(page,'seo');
  expect(await playing!.evaluate((element:HTMLMediaElement)=>element.paused&&element.isConnected)).toBe(true);
 }finally{await browser.close()}
});

test('title stays still and the SSL certificate document scrolls to its end',async({},info)=>{
 const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}});
 try{
  await page.goto('http://127.0.0.1:8736/?source=http%3A%2F%2F127.0.0.1%3A8737%2Fsweeting-all-plugins-20261004.wacz#view=title');
  const title=page.locator('#main-frame-wrapper .plugin-view:visible iframe');
  await expect(title.contentFrame().locator('.page-title')).toHaveText('Nick Sweeting');
  const positions=await title.evaluate(async(frame:HTMLIFrameElement)=>{const values:number[]=[];for(let i=0;i<30;i++){await new Promise(requestAnimationFrame);values.push(frame.contentDocument!.querySelector('.page-title')!.getBoundingClientRect().y)}return values});
  const panel=await openSnapshotOutput(page,'sslcerts'),frame=panel.locator('iframe');
  await expect(frame.contentFrame().locator('.cert')).not.toHaveCount(0);
  await frame.hover();await page.mouse.wheel(0,100000);
  await expect.poll(()=>frame.evaluate((frame:HTMLIFrameElement)=>{const doc=frame.contentDocument!;return doc.documentElement.scrollHeight-doc.defaultView!.innerHeight-doc.defaultView!.scrollY})).toBeLessThanOrEqual(1);
  await expect(frame.contentFrame().locator('.cert').last()).toBeInViewport();
  await page.getByRole('button',{name:'Toggle saved outputs'}).click();
  await expect(page.locator('#snapshot-output-browser')).toBeHidden();
  const geometry=()=>page.locator('#main-frame-wrapper').evaluate(element=>({top:element.getBoundingClientRect().top,bottom:element.getBoundingClientRect().bottom,viewport:innerHeight,header:document.querySelector('.snapshot-detail>header')!.getBoundingClientRect().height}));
  await expect.poll(async()=>{const box=await geometry();return Math.abs(box.bottom-box.viewport)+Math.abs(box.top-box.header)}).toBeLessThanOrEqual(1);
  await page.getByRole('button',{name:'Toggle saved outputs'}).click();
  const replay=await openSnapshotOutput(page,'archivewebpage');
  await expect(replay.locator('wr-coll-replay')).toBeVisible();
  await page.getByRole('button',{name:'Toggle saved outputs'}).click();
  await expect.poll(()=>replay.locator('wr-coll-replay').evaluate(element=>Math.abs(element.getBoundingClientRect().height-element.closest('.plugin-view')!.getBoundingClientRect().height))).toBeLessThanOrEqual(1);
  await writeFile(info.outputPath('layout.json'),JSON.stringify({positions},null,2));
  await page.screenshot({path:info.outputPath('ssl-bottom.png'),fullPage:true});
  expect(Math.max(...positions)-Math.min(...positions)).toBeLessThanOrEqual(1);
 }finally{await browser.close()}
});
