import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

for(const url of ['https://the-internet.herokuapp.com/javascript_alerts','https://getbootstrap.com/docs/5.3/components/modal/'])test(`full modalcloser all-plugin capture ${url}`,async({},info)=>{
 test.setTimeout(900000);
 const extension=path.resolve('.output/chrome-mv3'),context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-modal-')),{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 const plugins=(await readdir('abx-plugins/abx_plugins/plugins',{withFileTypes:true})).filter(item=>item.isDirectory()).map(item=>item.name).sort();
 let capture:any;
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),studio=await context.newPage();await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
  await expect(studio.getByRole('button',{name:`${plugins.length} plugins`,exact:true})).toBeVisible();
  const targetPromise=context.waitForEvent('page');
  await studio.getByRole('textbox',{name:'Open URL',exact:true}).fill(url);await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
  const target=await targetPromise;target.on('dialog',()=>{});
  await target.waitForURL(url);await target.waitForLoadState('domcontentloaded');
  if(url.includes('javascript_alerts')){
   for(const [button,result]of [['Click for JS Alert','You successfully clicked an alert'],['Click for JS Confirm','You clicked: Ok'],['Click for JS Prompt','You entered:']]){
    await target.getByRole('button',{name:button,exact:true}).click();await expect(target.locator('#result')).toHaveText(result!);
   }
  }else{
   await target.locator('button[data-bs-target="#exampleModalLive"]').click();
   await expect(target.locator('#exampleModalLive')).toBeHidden();
   await target.getByRole('button',{name:'Launch static backdrop modal',exact:true}).click();
   await expect(target.locator('#staticBackdrop')).toBeHidden();
  }
  await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:780000});
  capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
  expect(capture.plugins.slice().sort()).toEqual(plugins);
  const hook=capture.hooks.find((hook:any)=>hook.plugin==='modalcloser');expect(hook.status,JSON.stringify(hook)).toBe('succeeded');
  if(url.includes('javascript_alerts'))expect(hook.summary).toContain('3 browser dialogs');else expect(hook.summary).toMatch(/[1-9]\d* CSS modals/);
  const behavior=capture.hooks.find((hook:any)=>hook.plugin==='browsertrix_behaviors');expect(behavior.status,JSON.stringify(behavior)).toBe('succeeded');
  for(const name of ['Autofetcher','Autoplay','Autoclick'])expect(behavior.summary).toContain(name);
  const download=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();await(await download).saveAs(info.outputPath('all-plugins.wacz'));
  await target.screenshot({path:info.outputPath('captured-page.png')});
 }finally{await writeFile(info.outputPath('capture.json'),JSON.stringify(capture,null,2));await context.close()}
});
