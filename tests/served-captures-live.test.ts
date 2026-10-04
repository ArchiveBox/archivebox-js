import {test,expect,chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';

// Public delivery links for the four real all-plugin captures. Exercise the
// HTTP player as a user would, with only the local player/WACZ origins allowed.
test('all requested capture links render through the HTTP range player',async({},info)=>{
 test.setTimeout(240000);
 const browser=await chromium.launch({channel:'chromium',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage();
 const errors:string[]=[],external:string[]=[],ranges:string[]=[];
 page.on('pageerror',error=>errors.push(String(error)));
 context.on('request',request=>{const url=new URL(request.url());if(['http:','https:'].includes(url.protocol)&&!['http://127.0.0.1:8736','http://127.0.0.1:8737'].includes(url.origin))external.push(url.href);if(url.pathname.endsWith('.wacz')&&request.headers().range)ranges.push(request.headers().range!)});
 try{
  for(const [site,plugin]of [['sweeting','ytdlp'],['hacker-news-49944227','forumdl'],['arxiv','papersdl'],['zfsify','git']]){
   const source=`http://127.0.0.1:8737/${site}-all-plugins-20261004.wacz`,url=new URL('http://127.0.0.1:8736/');url.searchParams.set('source',source);url.hash=`view=${plugin}`;await page.goto(url.href);
   const panel=page.locator('#main-frame-wrapper .plugin-view');await expect(panel).toBeVisible({timeout:60000});await expect(panel.locator(':scope > .loading')).toHaveCount(0,{timeout:90000});await expect(panel.getByRole('alert')).toHaveCount(0);
   if(plugin==='ytdlp'){const frame=panel.frameLocator('iframe[title="Archived media"]');await expect(frame.locator('#queue .item')).toHaveCount(10);await expect(frame.locator('#queue')).not.toContainText('init.mp4');const media=frame.locator('#stage audio, #stage video');await expect.poll(()=>media.evaluate((element:HTMLMediaElement)=>element.readyState)).toBeGreaterThanOrEqual(2);await media.evaluate((element:HTMLMediaElement)=>element.play());await expect.poll(()=>media.evaluate((element:HTMLMediaElement)=>element.currentTime)).toBeGreaterThan(0);await media.evaluate((element:HTMLMediaElement)=>element.pause());}
   if(plugin==='forumdl'){const frame=panel.frameLocator('iframe[title="Forum thread"]');await expect(frame.locator('.comment')).toHaveCount(505);await panel.hover();await page.mouse.wheel(0,100000);await expect.poll(()=>panel.evaluate(element=>element.scrollTop)).toBeGreaterThan(1000);await expect(frame.locator('.comment').last()).toBeInViewport();}
   if(plugin==='papersdl')await expect(panel.locator('iframe[title="Archived scientific paper"]')).toHaveAttribute('src',/^blob:http:\/\/127\.0\.0\.1:8736\//);
   if(plugin==='git'){const frame=panel.frameLocator('iframe[title="Archived repository"]');await expect(frame.locator('#name')).toHaveText('pirate / zfsify');await expect(frame.locator('#entries .row')).not.toHaveCount(0);await expect(frame.locator('#readme')).toBeVisible();}
   await page.screenshot({path:info.outputPath(`${site}.png`),fullPage:true});
  }
  expect(errors).toEqual([]);expect(external).toEqual([]);expect(ranges.length).toBeGreaterThan(0);expect(ranges.every(range=>/^bytes=/.test(range))).toBe(true);
 }finally{await writeFile(info.outputPath('report.json'),JSON.stringify({errors,external,ranges},null,2));await browser.close()}
});
