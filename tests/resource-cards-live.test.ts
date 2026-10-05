import {readWaczPackage} from './wacz-evidence';
import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {openSnapshotOutput} from './snapshot-controls';

const source='http://127.0.0.1:8737/hacker-news-49944227-all-plugins-scroll-20261004.wacz';
const address=`http://127.0.0.1:8736/?source=${encodeURIComponent(source)}#view=responses`;

test('response cards ignore the real HN spacer and omit empty LiteParse',async({},info)=>{
 const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage();
 const external:string[]=[];page.context().on('request',request=>{if(/^https?:/.test(request.url())&&!['http://127.0.0.1:8736','http://127.0.0.1:8737'].includes(new URL(request.url()).origin))external.push(request.url())});
 try{
  await page.goto(address);await openSnapshotOutput(page,'responses');
  const preview=page.locator('.stack-tray [data-resource-preview="responses"]');
  await expect(preview.locator('.responses-thumbnail img').first()).toBeVisible();
  await expect(preview.locator('img[data-name="s.gif"]')).toHaveCount(0);
  await expect(page.locator('.thumb-card[data-plugin-name="liteparse"]')).toHaveCount(0);
  await expect.poll(()=>preview.locator('img').evaluateAll(images=>images.every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>1))).toBe(true);
  await page.getByRole('searchbox',{name:'Search requests'}).fill('/s.gif');
  await expect(page.locator('.responses-inspector tbody tr')).not.toHaveCount(0);
  expect(external).toEqual([]);
  await page.screenshot({path:info.outputPath('responses.png'),fullPage:true});
 }finally{await browser.close()}
});

test('all-plugin image and PDF captures keep their LiteParse previews',async({},info)=>{
 const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage();
 try{
  for(const site of ['sweeting','arxiv']){
   await page.goto(`http://127.0.0.1:8736/?source=${encodeURIComponent(`http://127.0.0.1:8737/${site}-all-plugins-20261004.wacz`)}#view=responses`,{waitUntil:'domcontentloaded'});
   await openSnapshotOutput(page,'responses');
   await expect(page.locator('.thumb-card[data-plugin-name="liteparse"]')).toHaveCount(1);
   await expect(page.locator('.stack-tray [data-resource-preview="liteparse"] .liteparse-thumbnail-tile').first()).toBeVisible();
   if(site==='arxiv'){
    const panel=await openSnapshotOutput(page,'liteparse'),frame=panel.frameLocator('iframe[title="LiteParse"]');
    await frame.getByRole('searchbox',{name:'Search filenames or original URLs'}).fill('2610.02208');
    await frame.locator('.tile:visible .text-preview').scrollIntoViewIfNeeded();
    await expect(frame.locator('.tile:visible .text-preview')).toContainText('Sphere Encoder 2',{timeout:60000});
   }
   await page.screenshot({path:info.outputPath(`${site}-liteparse.png`),fullPage:true});
  }
 }finally{await browser.close()}
});

test('all-plugin DOM and scrolling survive browser restart',async({},info)=>{
 const profile=await mkdtemp(path.join(tmpdir(),'abx-resource-cards-'));
 const zip=unzipSync(await readFile('/tmp/abx-wacz-demo/hacker-news-49944227-all-plugins-scroll-20261004.wacz'));
 const manifest=(await readWaczPackage(zip)).metadata;
 const enabled=manifest.plugins.map((plugin:any)=>plugin.id);
 expect(enabled).toHaveLength(46);for(const id of ['dom','singlefile','infiniscroll'])expect(enabled).toContain(id);
 const evidence=JSON.parse(new TextDecoder().decode(zip['infiniscroll/infiniscroll.json']!));expect(evidence.steps).toBe(10);
 const rounds=[];
 for(let round=0;round<2;round++){
  const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:1440,height:1100}}),page=await context.newPage();
  try{
   await page.goto(address);
   for(const plugin of ['dom','singlefile']){
    await expect(page.locator(`.thumb-card[data-plugin-name="${plugin}"]`)).toHaveCount(1);
    const panel=await openSnapshotOutput(page,plugin);
    await expect(panel.frameLocator('iframe[title="Offline document"]').locator('body')).toContainText(manifest.title.replace(' | Hacker News',''));
   }
   const panel=await openSnapshotOutput(page,'infiniscroll'),frame=panel.frameLocator('iframe[title="Infinite Scroll"]');
   await expect(frame.getByRole('img',{name:'Scroll positions over document height'})).toBeVisible();
   await expect(frame.locator('.metric').filter({has:frame.getByText('Scroll steps',{exact:true})}).locator('strong')).toHaveText(String(evidence.steps));
   rounds.push({round,positions:await frame.locator('[data-frame]').count()});
   await page.screenshot({path:info.outputPath(`scroll-${round}.png`),fullPage:true});
  }finally{await context.close()}
 }
 await writeFile(info.outputPath('reopened.json'),JSON.stringify({enabled,rounds},null,2));
});
