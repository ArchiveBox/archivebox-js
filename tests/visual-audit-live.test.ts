import {test,expect,chromium,type Locator} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {openSnapshotOutput} from './snapshot-controls';

const captures=[
 ['hn','hacker-news-49944227-all-plugins-scroll-20261004.wacz'],
 ['sweeting','sweeting-all-plugins-20261004.wacz'],
 ['arxiv','arxiv-all-plugins-20261004.wacz'],
 ['github','zfsify-all-plugins-20261004.wacz'],
 ['commons','commons-all-plugins.wacz'],
];
const special:Record<string,string[]>={sweeting:['ytdlp','readability','seo','sslcerts','singlefile'],arxiv:['papersdl','liteparse'],github:['git'],commons:['gallerydl','rss','responses']};
async function ready(panel:Locator,plugin:string){
 await expect(panel.locator(':scope > .loading')).toHaveCount(0,{timeout:60000});
 await expect(panel.locator('[role=alert]')).toHaveCount(0);
 if(plugin==='archivewebpage'){await expect(panel.locator('wr-coll-replay')).toBeVisible();return}
 if(plugin==='pdf'||plugin==='papersdl'){
  const frame=panel.locator('iframe');await expect(frame).toHaveAttribute('src',/^blob:/,{timeout:60000});
  const host=await frame.contentFrame().owner().elementHandle(),outer=await host!.contentFrame();
  await expect.poll(()=>outer?.childFrames().some(frame=>frame.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'))).toBe(true);
  const native=outer!.childFrames().find(frame=>frame.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'))!;
  await native.waitForFunction(()=>{const viewer=document.querySelector('pdf-viewer') as any;return viewer?.initialLoadComplete_&&viewer.loadState_==='success'});return;
 }
 const frame=panel.locator(':scope > iframe');
 if(await frame.count()){
  if(plugin==='screenshot'){await expect.poll(()=>frame.contentFrame().locator('img').first().evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0);return}
  await expect.poll(()=>frame.evaluate((frame:HTMLIFrameElement)=>frame.contentDocument?.body?.innerText.length||0),{timeout:30000}).toBeGreaterThan(10);
  const inside=frame.contentFrame();
  if(plugin==='forumdl')await expect(inside.locator('.comment').first()).toBeVisible();
  if(plugin==='gallerydl'){
   await expect(inside.locator('#gallery img').first()).toBeVisible();
   await expect.poll(()=>inside.locator('#gallery img').evaluateAll(images=>images.every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0)),{timeout:30000}).toBe(true);
  }
  if(plugin==='ytdlp')await expect(inside.locator('#queue .item').first()).toBeVisible();
  if(plugin==='git')await expect(inside.locator('#entries .directory-entry').first()).toBeVisible();
  if(plugin==='liteparse'){
   const text=inside.locator('.tile .text-preview').first();await text.scrollIntoViewIfNeeded();
   await expect(text).not.toHaveText('Loading parsed text…',{timeout:60000});await expect(text).not.toContainText('Error:');
  }
  if(['readability','defuddle','mercury'].includes(plugin))await expect.poll(()=>inside.locator('#reader').evaluate((frame:HTMLIFrameElement)=>frame.contentDocument?.body?.innerText.length||0)).toBeGreaterThan(20);
 }
}
async function inspect(panel:Locator){
 return panel.evaluate(element=>{
  const result:any[]=[];
  const visit=(root:Element,depth=0)=>{
   const doc=root.ownerDocument,win=doc.defaultView!;
   const visible=(el:Element)=>{const box=el.getBoundingClientRect();return box.width>0&&box.height>0&&box.bottom>0&&box.top<win.innerHeight};
   result.push({depth,title:doc.title,text:(root as HTMLElement).innerText?.slice(0,4000),width:doc.documentElement.clientWidth,scrollWidth:doc.documentElement.scrollWidth,height:win.innerHeight,scrollHeight:doc.documentElement.scrollHeight,
    brokenImages:[...root.querySelectorAll('img')].filter(image=>visible(image)&&image.complete&&!image.naturalWidth).map(image=>({src:image.src,alt:image.alt})),
    visibleImages:[...root.querySelectorAll('img')].filter(visible).map(image=>({width:image.width,height:image.height,naturalWidth:image.naturalWidth,src:image.src.slice(0,180)}))});
   for(const frame of root.querySelectorAll('iframe')){try{if(visible(frame)&&frame.contentDocument?.body)visit(frame.contentDocument.body,depth+1)}catch{}}
  };visit(element);return result;
 });
}
test('visual audit of every available card and full viewer over real all-plugin captures',async({},info)=>{
 test.setTimeout(900000);
 const browser=await chromium.launch({channel:'chromium',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage();
 const report:any[]=[];const errors:any[]=[],external:string[]=[],seen=new Set<string>();let phase='';
 page.on('pageerror',error=>errors.push({phase,error:String(error),stack:error.stack}));
 context.on('request',request=>{if(/^https?:/.test(request.url())&&!['http://127.0.0.1:8736','http://127.0.0.1:8737'].includes(new URL(request.url()).origin))external.push(request.url())});
 try{
  for(const [site,file]of captures){
   phase=`${site}:open`;await page.goto(`http://127.0.0.1:8736/?source=${encodeURIComponent('http://127.0.0.1:8737/'+file)}#view=title`,{waitUntil:'domcontentloaded'});
   await expect(page.locator('.stack-shelf')).toBeVisible({timeout:30000});
   await expect(page.locator('#snapshot-output-browser')).toHaveAttribute('aria-busy','false');
   const names=await page.locator('.thumb-card[data-plugin-name]').evaluateAll(cards=>cards.map(card=>(card as HTMLElement).dataset.pluginName!));
   for(const group of ['html','raster','article_text','embedded_media','metadata','other']){
    phase=`${site}:cards:${group}`;const stack=page.locator(`.output-stack-${group}`);if(!await stack.count())continue;
    if(await stack.getAttribute('aria-expanded')!=='true')await stack.click();
    const tray=page.locator('.stack-tray');await expect(tray).toBeVisible();
    // Wait for the actual visible summary documents, not a timer or full engine.
    for(const frame of await tray.locator('iframe[data-plugin-preview]').all())await expect.poll(()=>frame.evaluate((frame:HTMLIFrameElement)=>{
     const loaded=(frame:HTMLIFrameElement):boolean=>{const doc=frame.contentDocument;if(!doc?.body||doc.readyState!=='complete'||(!frame.hasAttribute('srcdoc')&&frame.src==='about:blank'))return false;return !!(doc.body.innerText.length||doc.querySelector('img,iframe,svg'))&&[...doc.images].every(image=>image.complete)&&[...doc.querySelectorAll('iframe')].every(loaded)};return loaded(frame);
    }),{timeout:30000}).toBeTruthy();
    for(const preview of await tray.locator('[data-resource-preview]').all())await expect(preview).not.toHaveText('Loading…');
    await page.screenshot({path:info.outputPath(`${site}-cards-${group}.png`),fullPage:true});
    report.push({site,kind:'cards',group,documents:await inspect(tray)});
   }
   for(const plugin of names.filter(name=>!seen.has(name)||special[site!]?.includes(name))){
    phase=`${site}:full:${plugin}`;const row:any={site,kind:'full',plugin};report.push(row);
    try{
     const start=performance.now(),panel=await openSnapshotOutput(page,plugin);await ready(panel,plugin);row.openMs=Math.round(performance.now()-start);
     await page.getByRole('button',{name:'Toggle saved outputs'}).click();await expect(page.locator('#snapshot-output-browser')).toBeHidden();
     await expect.poll(()=>page.locator('.header-top').evaluate(element=>element.getBoundingClientRect().top)).toBe(0);
     await page.screenshot({path:info.outputPath(`${site}-full-${plugin}.png`)});row.documents=await inspect(panel);
     await page.getByRole('button',{name:'Toggle saved outputs'}).click();
     // Reopen through the same user controls while the output remains retained.
     if(plugin!=='title'){
      await openSnapshotOutput(page,'title');const repeat=performance.now();const again=await openSnapshotOutput(page,plugin);await ready(again,plugin);row.repeatMs=Math.round(performance.now()-repeat);
     }
     seen.add(plugin);console.log(`${site} ${plugin}: ${row.openMs}ms open / ${row.repeatMs??'-'}ms repeat`);
    }catch(error){row.error=String(error);await page.screenshot({path:info.outputPath(`${site}-error-${plugin}.png`)});if(await page.locator('#snapshot-output-browser').isHidden())await page.getByRole('button',{name:'Toggle saved outputs'}).click();}
    await writeFile(info.outputPath('audit.json'),JSON.stringify({report,errors,external},null,2));
   }
  }
 }finally{await writeFile(info.outputPath('audit.json'),JSON.stringify({report,errors,external},null,2));await browser.close()}
 expect(report.filter(row=>row.error)).toEqual([]);expect(errors).toEqual([]);expect(external).toEqual([]);
});

test('plugin folders and gallery originals render at a laptop viewport',async({},info)=>{
 test.setTimeout(180000);
 const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage({viewport:{width:1280,height:800}}),seen=new Set<string>();
 try{
  for(const [site,file]of captures){
   await page.goto(`http://127.0.0.1:8736/?source=${encodeURIComponent('http://127.0.0.1:8737/'+file)}#view=title`);
   await expect(page.locator('#snapshot-output-browser')).toHaveAttribute('aria-busy','false');
   const plugins=await page.locator('a[data-plugin-view]').evaluateAll(links=>links.map(link=>(link as HTMLElement).dataset.pluginView!));
   for(const plugin of plugins.filter(name=>!seen.has(name))){
    const panel=await openSnapshotOutput(page,plugin);await expect(panel.locator('tbody tr').first()).toBeVisible();await expect(panel.locator('[role=alert]')).toHaveCount(0);
    await page.getByRole('button',{name:'Toggle saved outputs'}).click();await page.screenshot({path:info.outputPath(`${site}-files-${plugin}.png`)});await page.getByRole('button',{name:'Toggle saved outputs'}).click();seen.add(plugin);
   }
  }
  const panel=await openSnapshotOutput(page,'gallerydl');await ready(panel,'gallerydl');
  await page.getByRole('button',{name:'Toggle saved outputs'}).click();
  const gallery=panel.frameLocator('iframe'),images=gallery.locator('#gallery img');await expect(images).toHaveCount(12);
  for(const [index,image]of (await images.all()).entries()){
   const pixels=await image.screenshot({path:info.outputPath(`gallery-image-${index}.png`)});
   const colors=await page.evaluate(async bytes=>{const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d')!;ctx.drawImage(bitmap,0,0);const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data,colors=new Set<string>();for(let i=0;i<rgba.length;i+=4)colors.add(`${rgba[i]},${rgba[i+1]},${rgba[i+2]}`);bitmap.close();return colors.size},Array.from(pixels));
   expect(colors,`Gallery image ${index} must paint`).toBeGreaterThan(100);
  }
  await gallery.locator('#gallery .tile > a').first().click();await expect(gallery.getByRole('dialog',{name:'Image preview'})).toBeVisible();await expect.poll(()=>gallery.locator('#viewer-image').evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBe(true);
  await page.screenshot({path:info.outputPath('gallery-modal.png')});await gallery.getByRole('button',{name:'Close image'}).click();await expect(gallery.getByRole('dialog')).not.toBeVisible();
  await page.screenshot({path:info.outputPath('gallery-complete.png')});
 }finally{await browser.close()}
});

test('one OCR runtime processes all real Sweeting images and retains their results',async({},info)=>{
 const browser=await chromium.launch({channel:'chromium',headless:true}),context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1100}}),page=await context.newPage();
 const requests:string[]=[],results:any[]=[];page.on('request',request=>{if(request.resourceType()==='document')requests.push(request.url())});
 try{
  await page.goto('http://127.0.0.1:8736/?source='+encodeURIComponent('http://127.0.0.1:8737/sweeting-all-plugins-20261004.wacz')+'#view=liteparse');
  const panel=page.locator('#main-frame-wrapper .plugin-view:visible'),frame=panel.frameLocator('iframe[title="LiteParse"]');await expect(frame.locator('.tile')).toHaveCount(4);
  const started=performance.now();
  await page.getByRole('button',{name:'Toggle saved outputs'}).click();
  await expect(frame.locator('.file-actions a[title="Open JSON"][href]')).toHaveCount(4,{timeout:90000});
  for(const link of await frame.getByRole('link',{name:'JSON',exact:true}).all()){
   const download=page.waitForEvent('download');await link.click();const file=await(await download).path();const {readFile}=await import('node:fs/promises');const data=JSON.parse(await readFile(file!,'utf8'));expect(data.engine.ocrPages).toBe(1);expect(data.totalPages).toBe(1);results.push({ms:Math.round(performance.now()-started),text:data.text});
  }
  await page.screenshot({path:info.outputPath('ocr-complete.png'),fullPage:true});
  await writeFile(info.outputPath('ocr.json'),JSON.stringify({requests,results},null,2));
  expect(results).toHaveLength(4);
  expect(requests.filter(url=>url.endsWith('/ocr-sandbox.html'))).toHaveLength(1);
 }finally{await browser.close()}
});

test('cards hide known empty outputs and retain the original Git card scale',async({},info)=>{
 const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}});
 try{
  for(const [file,absent]of [['hacker-news-49944227-all-plugins-scroll-20261004.wacz',['parse_netscape_urls','parse_rss_urls']],['sweeting-all-plugins-20261004.wacz',['staticfile']]] as const){
   await page.goto('http://127.0.0.1:8736/?source='+encodeURIComponent('http://127.0.0.1:8737/'+file)+'#view=title');
   await expect(page.frameLocator('#main-frame-wrapper .plugin-view:visible iframe').locator('.page-title')).not.toBeEmpty();
   for(const plugin of absent)await expect.soft(page.locator(`.thumb-card[data-plugin-name="${plugin}"]`)).toHaveCount(0);
  }
  await page.goto('http://127.0.0.1:8736/?source='+encodeURIComponent('http://127.0.0.1:8737/zfsify-all-plugins-20261004.wacz')+'#view=title');
  await openSnapshotOutput(page,'git');
  await expect(page.frameLocator('#main-frame-wrapper .plugin-view:visible iframe').locator('#description')).toContainText('Live reformat an Ubuntu');
  const card=page.locator('.stack-tray .thumb-card[data-plugin-name="git"] iframe[data-plugin-preview]');
  await expect(card.contentFrame().locator('#name')).toHaveText('pirate / zfsify');
  expect(await card.evaluate((frame:HTMLIFrameElement)=>frame.getBoundingClientRect().width/frame.contentWindow!.innerWidth)).toBeGreaterThan(.9);
  await page.screenshot({path:info.outputPath('git-card.png')});
 }finally{await browser.close()}
});
