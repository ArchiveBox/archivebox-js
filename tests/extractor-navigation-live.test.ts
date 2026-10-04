import {test,expect,chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {openSnapshotOutput} from './snapshot-controls';

test('full forum and media views keep their documents and geometry between visits',async({},info)=>{
 const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}}),report:any[]=[];
 try{
  for(const [site,plugin,title]of [['hacker-news-49944227-all-plugins-scroll-20261004','forumdl','Forum thread'],['sweeting-all-plugins-20261004','ytdlp','Archived media']]){
   const started=performance.now();await page.goto(`http://127.0.0.1:8736/?source=${encodeURIComponent(`http://127.0.0.1:8737/${site}.wacz`)}#view=${plugin}`);
   const panel=page.locator('#main-frame-wrapper .plugin-view:visible'),frame=panel.locator(`iframe[title="${title}"]`);
   if(plugin==='forumdl')await expect(frame.contentFrame().locator('.comment')).not.toHaveCount(0,{timeout:60000});
   else await expect(frame.contentFrame().locator('#queue .item')).toHaveCount(10,{timeout:60000});
   const cold=performance.now()-started,document=await frame.evaluateHandle((frame:HTMLIFrameElement)=>frame.contentDocument!),geometry=await frame.evaluate((frame:HTMLIFrameElement)=>({width:frame.contentWindow!.innerWidth,height:frame.contentWindow!.innerHeight}));
   const visits=[];
   for(let visit=0;visit<3;visit++){
    await openSnapshotOutput(page,'title');
    const hidden=await document.evaluate((doc:Document)=>({width:doc.defaultView!.innerWidth,height:doc.defaultView!.innerHeight,connected:!!doc.defaultView?.frameElement?.isConnected}));
    const start=performance.now();await openSnapshotOutput(page,plugin!);
    const same=await frame.evaluate((frame:HTMLIFrameElement,doc:Document)=>frame.contentDocument===doc,document);
    visits.push({milliseconds:performance.now()-start,hidden,same});
   }
   report.push({plugin,cold,geometry,visits,measures:await page.evaluate(()=>performance.getEntriesByType('measure').map(entry=>({name:entry.name,duration:entry.duration,detail:(entry as PerformanceMeasure).detail})))});
   await writeFile(info.outputPath('extractor-navigation.json'),JSON.stringify(report,null,2));
  }
  for(const item of report)for(const visit of item.visits){expect(visit.same).toBe(true);expect(visit.hidden).toEqual({...item.geometry,connected:true})}
 }finally{await browser.close()}
});

test('refresh reuses complete forum and media derivations without restarting Python',async({},info)=>{
 const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}}),report:any[]=[];
 const external:string[]=[];page.on('request',request=>{const url=new URL(request.url());if(/^https?:$/.test(url.protocol)&&!['http://127.0.0.1:8736','http://127.0.0.1:8737'].includes(url.origin))external.push(url.href)});
 try{
  for(const [site,plugin,title,count]of [
   ['hacker-news-49944227-all-plugins-scroll-20261004','forumdl','Forum thread',517],
   ['sweeting-all-plugins-20261004','ytdlp','Archived media',10],
  ] as const){
   const samples:any[]=[];
   for(let visit=0;visit<2;visit++){
    const started=performance.now();
    if(visit)await page.reload();
    else await page.goto(`http://127.0.0.1:8736/?source=${encodeURIComponent(`http://127.0.0.1:8737/${site}.wacz`)}#view=${plugin}`);
    const frame=page.frameLocator(`#main-frame-wrapper .plugin-view:visible iframe[title="${title}"]`);
    await expect(frame.locator(plugin==='forumdl'?'.comment':'#queue .item')).toHaveCount(count,{timeout:60000});
    samples.push({milliseconds:performance.now()-started,text:await frame.locator('body').innerText(),measures:await page.evaluate(()=>performance.getEntriesByType('measure').map(entry=>({name:entry.name,duration:entry.duration,detail:(entry as PerformanceMeasure).detail})))});
   }
   report.push({plugin,samples});await writeFile(info.outputPath('extractor-refresh.json'),JSON.stringify(report,null,2));
   expect(samples[1].text).toBe(samples[0].text);
   expect(samples[1].measures.filter((entry:any)=>entry.name.endsWith(':extract'))).toEqual([]);
   expect(samples[1].measures.some((entry:any)=>entry.name==='archivebox:derivation-cache'&&entry.detail.hit)).toBe(true);
  }
  expect(external).toEqual([]);
 }finally{await browser.close()}
});
