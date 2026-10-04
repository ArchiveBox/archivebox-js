import {test,expect,chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';

// Retained all-plugin capture, original native ZIP evidence, actual HTTP player.
test('HTTP native evidence renders screenshot and complete accessibility beside forum results',async({},info)=>{
  test.setTimeout(180000);
  const source=process.env.ABX_HTTP_WACZ||'http://127.0.0.1:8737/hacker-news-49944227-all-plugins-20261004.wacz';
  const player=process.env.ABX_PLAYER_URL||'http://127.0.0.1:8736/';
  const response=await fetch(source);expect(response.ok).toBe(true);const zip=unzipSync(new Uint8Array(await response.arrayBuffer()));
  const manifest=JSON.parse(new TextDecoder().decode(zip['datapackage.json'])),files=manifest.archivebox.files;
  const shots=files.filter((file:any)=>file.metadata.plugin==='screenshot'),axFile=files.find((file:any)=>file.metadata.plugin==='accessibility');
  expect(shots.length).toBeGreaterThan(0);expect(axFile.path).toBeTruthy();const ax=JSON.parse(new TextDecoder().decode(zip[axFile.path]));const nodes=new Set(ax.nodes.map((node:any)=>node.nodeId)).size;expect(nodes).toBeGreaterThan(0);
  const browser=await chromium.launch({channel:'chromium',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage(),errors:string[]=[],external:string[]=[];
  page.on('pageerror',error=>errors.push(String(error)));context.on('request',request=>{if(/^https?:/.test(request.url())&&![new URL(source).origin,new URL(player).origin].includes(new URL(request.url()).origin))external.push(request.url())});
  try{
    const address=new URL(player);address.searchParams.set('source',source);address.hash='view=forumdl';await page.goto(address.href);
    const forum=page.frameLocator('#main-frame-wrapper iframe[title="Forum thread"]');await expect(forum.locator('#content')).toContainText('I quit OpenAI',{timeout:90000});
    await expect(forum.locator('#content')).toContainText('505');await page.screenshot({path:info.outputPath('http-forum.png'),fullPage:true});
    await page.evaluate(()=>location.hash='view=screenshot');const screenshot=page.frameLocator('#main-frame-wrapper iframe[title="Screenshot"]'),images=screenshot.locator('img.screenshot-fullscreen');await expect(images).toHaveCount(shots.length);
    for(const image of await images.all()){
      await expect.poll(()=>image.evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBe(true);
      const url=(await image.getAttribute('src'))!,file=shots.find((file:any)=>url.endsWith(encodeURIComponent(file.url)));expect(file).toBeDefined();
      const actual=await page.evaluate(async url=>{const response=await fetch(url);const bytes=await response.arrayBuffer();return {status:response.status,length:bytes.byteLength,hash:[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('')}},url);
      expect(actual).toEqual({status:200,length:zip[file.path]!.length,hash:createHash('sha256').update(zip[file.path]!).digest('hex')});
    }
    await page.screenshot({path:info.outputPath('http-screenshot.png'),fullPage:true});
    await page.evaluate(()=>location.hash='view=accessibility');const accessibility=page.frameLocator('#main-frame-wrapper iframe[title="Accessibility"]');await expect(accessibility.locator('.badges').first()).toContainText(`◇ ${nodes} AX nodes`);
    await expect(accessibility.getByRole('heading',{name:'Accessibility tree',exact:true})).toBeVisible();await expect(accessibility.locator('.ax')).toContainText(manifest.archivebox.title);await page.screenshot({path:info.outputPath('http-accessibility.png'),fullPage:true});
    await expect(page.getByRole('alert')).toHaveCount(0);expect(errors).toEqual([]);expect(external).toEqual([]);await writeFile(info.outputPath('report.json'),JSON.stringify({source,shots:shots.length,nodes,errors,external},null,2));
  }finally{await browser.close()}
});
