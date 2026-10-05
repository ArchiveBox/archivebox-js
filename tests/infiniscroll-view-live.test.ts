import {readWaczPackage} from './wacz-evidence';
import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {unzipSync} from 'fflate';
test('real captured scrolling diagram preserves measurements and frame geometry offline',async({},info)=>{
 const file=process.env.ABX_SCROLL_WACZ||'/tmp/abx-wacz-demo/sweeting-all-plugins-20261004.wacz';
 const zip=unzipSync(await readFile(file)),manifest=(await readWaczPackage(zip)),files=manifest.metadata.files||manifest.metadata.nativeFiles;
 const hook=manifest.metadata.plugins.find((plugin:any)=>plugin.id==='infiniscroll').hooks.find((hook:any)=>hook.records?.length),resource=files.find((item:any)=>item.url===hook.records[0].url),evidence=JSON.parse(new TextDecoder().decode(zip[resource.path]!));
 const observedAt=(item:any)=>Number.isFinite(item.metadata.frame?.timestamp)?item.metadata.frame.timestamp*1000:item.metadata.receivedAt;
 const recorded=files.filter((item:any)=>item.metadata?.frame).sort((a:any,b:any)=>observedAt(a)-observedAt(b));
 const before=recorded.filter((item:any)=>observedAt(item)<=hook.started).at(-1),after=recorded.find((item:any)=>observedAt(item)>=hook.ended);
 const during=recorded.filter((item:any)=>observedAt(item)>hook.started&&observedAt(item)<hook.ended);
 const frames=evidence.frames?.length?during:[before,...during,after].filter(Boolean);
 expect(frames.length).toBeGreaterThan(0);
 const remote=process.env.ABX_SCROLL_HTTP,player=process.env.ABX_PLAYER_URL||'http://127.0.0.1:8736/';
 const extension=path.resolve('.output/chrome-mv3'),context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-scroll-view-')),{channel:'chromium',headless:true,acceptDownloads:true,args:remote?[]:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 try{
  const page=await context.newPage(),live:string[]=[],localHTTP:string[]=[],errors:string[]=[],allowed=remote?new Set([new URL(player).origin,new URL(remote).origin]):new Set<string>();context.on('request',request=>{if(/^https?:/.test(request.url())){if(allowed.has(new URL(request.url()).origin))localHTTP.push(request.url());else live.push(request.url())}});page.on('pageerror',error=>errors.push(String(error)));
  if(remote){await page.goto(`${player}?source=${encodeURIComponent(remote)}#view=infiniscroll`);await expect(page.locator('.stack-shelf')).toBeVisible();}
  else{const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);await context.setOffline(true);const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await chooser).setFiles(file);await expect(page.locator('.stack-shelf')).toBeVisible();await page.goto(page.url().split('#')[0]+'#view=infiniscroll');}
  const view=page.frameLocator('#main-frame-wrapper iframe[title="Infinite Scroll"]'),diagram=view.getByRole('img',{name:'Scroll positions over document height'});
  await expect(diagram).toBeVisible();await expect(diagram.locator('[data-initial-height]')).toHaveAttribute('data-initial-height',String(evidence.initialHeight));await expect(diagram.locator('[data-document-height]')).toHaveAttribute('data-document-height',String(evidence.finalHeight));
  const expected=[...(evidence.frames||[]).map((frame:any)=>({timestamp:frame.timestamp,y:frame.y,height:frame.viewportHeight,image:false})),...frames.map((item:any)=>({timestamp:observedAt(item),y:item.metadata.frame.scrollOffsetY,height:item.metadata.frame.deviceHeight/(item.metadata.frame.pageScaleFactor||1),image:true}))].sort((a,b)=>a.timestamp-b.timestamp);
  await expect(diagram.locator('[data-frame]')).toHaveCount(expected.length);for(const [index,frame]of expected.entries()){await expect(diagram.locator(`[data-frame="${index}"]`)).toHaveAttribute('data-scroll-y',String(frame.y));await expect(diagram.locator(`[data-frame="${index}"]`)).toHaveAttribute('data-viewport-height',String(frame.height));const scale=Number(await diagram.locator('[data-document-height]').getAttribute('height'))/evidence.finalHeight;expect(Number(await diagram.locator(`[data-frame="${index}"]`).getAttribute('y'))-44).toBeCloseTo(frame.y*scale,6);expect(Number(await diagram.locator(`[data-frame="${index}"]`).getAttribute('height'))).toBeCloseTo(frame.height*scale,6);}
  for(const phase of ['Initial','Final']){const measured=evidence.frames?.find((frame:any)=>frame.phase===phase);if(measured){const height=phase==='Initial'?evidence.initialHeight:evidence.finalHeight,pages=Math.ceil(height/measured.viewportHeight),screens=Number((height/measured.viewportHeight).toFixed(2)).toLocaleString();await expect(view.locator('.metric').filter({has:view.getByText(phase+' height',{exact:true})}).locator('small')).toHaveText(`${screens} screens · ${pages} pages`);}}
  await expect(view.locator('tbody tr')).toHaveCount(expected.length);await expect(view.locator('.metrics')).toContainText(String(evidence.steps));
  await expect(view.locator('img[alt="Captured page screenshot"]')).not.toHaveCount(0);
  await expect.poll(()=>view.locator('img[alt="Captured page screenshot"]').evaluateAll(images=>images.every(image=>(image as HTMLImageElement).naturalWidth>0))).toBe(true);
  for(let index=0;index<expected.length;index++){await view.locator('tbody tr').nth(index).click();await expect(view.locator('tbody tr').nth(index)).toHaveAttribute('aria-selected','true');await expect(view.locator('input[type="range"]')).toHaveValue(String(index));}
  if(evidence.frames?.length){
   await view.locator('tbody tr').first().click();const slider=view.getByRole('slider',{name:'Captured scroll position'});await slider.scrollIntoViewIfNeeded();
   let start=(await slider.boundingBox())!;const vertical=start.height>start.width;
   const documentGeometry=()=>slider.evaluate(element=>{const box=element.getBoundingClientRect();return{x:box.x+scrollX,y:box.y+scrollY,width:box.width,height:box.height}});
   await slider.press('Home');const measurementBox=await documentGeometry(),imageIndex=expected.findIndex(frame=>frame.image);
   for(let index=0;index<imageIndex;index++)await slider.press(vertical?'ArrowDown':'ArrowRight');
   const imageBox=await documentGeometry();await writeFile(info.outputPath('slider-layout.json'),JSON.stringify({measurementBox,imageBox,imageIndex},null,2));
   for(const key of ['x','y','width','height'] as const)expect(imageBox[key],JSON.stringify({measurementBox,imageBox})).toBeCloseTo(measurementBox[key],1);
   await slider.press('Home');await slider.scrollIntoViewIfNeeded();start=(await slider.boundingBox())!;
   const geometry=()=>slider.evaluate(element=>{const box=element.getBoundingClientRect();return{x:box.x,y:box.y,width:box.width,height:box.height}});
   const baseline=await geometry(),drag:any[]=[{selected:0,image:expected[0]?.image,box:baseline}];
   // Send real Chromium pointer events directly. Playwright's drag interception
   // waits on setTimeout callbacks inside this deliberately scriptless frame.
   const point=(index:number)=>{const ratio=index/(expected.length-1);return vertical?{x:start.x+start.width/2,y:start.y+8+(start.height-16)*ratio}:{x:start.x+8+(start.width-16)*ratio,y:start.y+start.height/2}};
   await slider.hover();start=(await slider.boundingBox())!;
   const pointer=await context.newCDPSession(page),initial=point(0);
   await pointer.send('Input.dispatchMouseEvent',{type:'mouseMoved',...initial,button:'none',buttons:0,modifiers:0,force:0});
   await pointer.send('Input.dispatchMouseEvent',{type:'mousePressed',...initial,button:'left',buttons:1,clickCount:1,modifiers:0,force:0.5});
   try{for(const index of [1,2,3,4,5]){const target=point(index);await pointer.send('Input.dispatchMouseEvent',{type:'mouseMoved',...target,button:'left',buttons:1,modifiers:0,force:0.5});const selected=Number(await slider.inputValue());drag.push({selected,image:expected[selected]?.image,box:await geometry()});}}finally{await pointer.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point(5),button:'left',buttons:0,clickCount:1});await pointer.detach()}
   await writeFile(info.outputPath('slider-drag.json'),JSON.stringify({baseline,drag},null,2));
   for(const item of drag)for(const key of ['x','y','width','height'] as const)expect(item.box[key],JSON.stringify(drag)).toBeCloseTo(baseline[key],1);
   const selected=Number(await slider.inputValue());await expect(view.locator('tbody tr').nth(selected)).toHaveAttribute('aria-selected','true');await expect(diagram.locator('[data-frame="'+selected+'"]')).toHaveAttribute('stroke-opacity','1');
   expect(new Set(drag.map(item=>item.image))).toEqual(new Set([false,true]));expect(new Set(drag.map(item=>item.selected)).size).toBeGreaterThan(2);expect(start.height).toBeGreaterThan(start.width*3);
  }
  const download=page.waitForEvent('download');await view.getByRole('link',{name:'Download',exact:true}).click();expect(JSON.parse(await readFile((await(await download).path())!,'utf8'))).toEqual(evidence);
  await page.screenshot({path:info.outputPath('infiniscroll.png'),fullPage:true});await writeFile(info.outputPath('measurements.json'),JSON.stringify({evidence,expected,live,localHTTP,errors},null,2));expect(live).toEqual([]);expect(errors).toEqual([]);if(remote)expect(localHTTP).toContain(remote);
 }finally{await context.close()}
});
