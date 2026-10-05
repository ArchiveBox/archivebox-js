import {test,expect,chromium} from '@playwright/test';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {X509Certificate} from 'node:crypto';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';
const player=process.env.ABX_PLAYER_URL||'http://127.0.0.1:8736/';
test('literal metadata templates preserve social images, certificate actions and accessibility',async({},info)=>{
  const directory=process.env.ABX_LIVE_CAPTURE_DIR||'/var/folders/bk/63jsns1s0gvgtj8tdcss8vy80000gq/T/abx-wacz-acceptance-0lb8q1/captures';
  const file=(await readdir(directory,{recursive:true})).find(file=>path.basename(file)==='sweeting-blog.wacz');expect(file).toBeTruthy();
  const zip=unzipSync(await readFile(path.join(directory,file!)));let ssl:any,ax:any;for(const [name,bytes]of Object.entries(zip))if(name.startsWith('archive/'))for await(const record of new WARCParser([bytes])){const body=await record.readFully();if(record.warcTargetURI?.startsWith('urn:sslcerts:'))ssl=JSON.parse(new TextDecoder().decode(body));if(record.warcTargetURI?.startsWith('urn:accessibility:'))ax=JSON.parse(new TextDecoder().decode(body));}
  expect(ssl.certificates.length).toBeGreaterThan(0);expect(ax.nodes.length).toBeGreaterThan(0);
  // CDP may repeat identical InlineTextBox nodes; identity is its nodeId.
  const axByID=new Map<string,any>();for(const node of ax.nodes){if(axByID.has(node.nodeId))expect(node).toEqual(axByID.get(node.nodeId));axByID.set(node.nodeId,node);}
  const roots=[...axByID.values()].filter(node=>!node.parentId||!axByID.has(node.parentId));expect(roots).toHaveLength(1);
  const reached=new Set<string>();const visit=(id:string)=>{expect(axByID.has(id)).toBe(true);if(reached.has(id))return;reached.add(id);for(const child of axByID.get(id).childIds||[])visit(child);};visit(roots[0].nodeId);expect(reached.size).toBe(axByID.size);

  const browser=await chromium.launch({channel:'chromium',headless:true}),context=await browser.newContext({acceptDownloads:true,viewport:{width:1400,height:1000}}),page=await context.newPage(),external:string[]=[],errors:string[]=[];
  context.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==new URL(player).origin)external.push(request.url())});page.on('pageerror',error=>errors.push(String(error)));
  try{
    await context.grantPermissions(['clipboard-read','clipboard-write']);
    await page.goto(player,{waitUntil:'domcontentloaded'});const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Open WACZ',exact:true}).click();await(await chooser).setFiles(path.join(directory,file!));await page.evaluate(()=>{location.hash='view=seo'});
    const frame=page.frameLocator('#main-frame-wrapper iframe[title="SEO"]');await expect(frame.locator('.link-copy h2')).toBeVisible({timeout:60000});
    expect(await frame.locator('body').evaluate(body=>body.ownerDocument.title)).toBe('SEO');
    await expect(frame.locator('header h1')).toContainText('SEO');await expect(frame.locator('details.metadata')).toHaveAttribute('open','');
    for(const name of ['Like','Comment','Share'])await expect(frame.getByRole('img',{name,exact:true})).toBeVisible();
    await expect.poll(()=>frame.locator('.link-preview > img').evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0&&image.currentSrc.includes('/w/'))).toBe(true);
    expect(await frame.locator('.link-preview').evaluate(element=>getComputedStyle(element).flexDirection)).toBe('row-reverse');
    const visible=await frame.locator('.metadata dl').evaluate(dl=>Object.fromEntries([...dl.querySelectorAll('dt')].map(dt=>[dt.textContent,dt.nextElementSibling!.textContent])));
    const downloading=page.waitForEvent('download');await frame.getByRole('link',{name:'Download',exact:true}).click();const download=await downloading;expect(download.suggestedFilename()).toBe('seo.json');const data=JSON.parse(await readFile((await download.path())!,'utf8'));expect(data).toEqual(visible);expect(data.url).toContain('sweeting.me');
    await expect(frame.locator('.link-copy h2')).toHaveText(data['og:title']||data.title);
    const popup=context.waitForEvent('page');await frame.getByRole('link',{name:'View raw',exact:true}).click();const raw=await popup;await expect(raw.locator('body')).toContainText(data.title);expect(JSON.parse(await raw.locator('body').innerText())).toEqual(data);await raw.close();
    await page.screenshot({path:info.outputPath('seo-canonical-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});expect(await frame.locator('.link-preview').evaluate(element=>getComputedStyle(element).display)).toBe('block');await page.screenshot({path:info.outputPath('seo-canonical-mobile.png'),fullPage:true});
    await frame.getByRole('link',{name:'View all files',exact:true}).click();await expect(page.locator('.plugin-files h1')).toHaveText('SEO');await expect(page.locator('.plugin-files tbody tr').first()).toBeVisible();
    await page.setViewportSize({width:1400,height:1000});await page.evaluate(()=>{location.hash='view=sslcerts'});
    const certificates=page.frameLocator('#main-frame-wrapper iframe[title="SSL Certificates"]');await expect(certificates.locator('.cert').first()).toBeVisible();expect(await certificates.locator('body').evaluate(body=>body.ownerDocument.title)).toBe('SSL Certificates');
    const rootDER=Buffer.from(ssl.certificates.find((record:any)=>record.origin===new URL(ssl.connections[0].url).origin).tableNames.at(-1),'base64'),fingerprint=new X509Certificate(rootDER).fingerprint256.replaceAll(':','').toLowerCase(),card=certificates.locator('.cert').first();
    await expect(card.locator('.hash-row code').last()).toHaveText(fingerprint);await card.locator('.hash-row').last().getByRole('button',{name:'Copy',exact:true}).click();await expect(card.getByRole('button',{name:'Copied',exact:true})).toBeVisible();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(fingerprint);
    const pemDownload=page.waitForEvent('download');await card.getByRole('link',{name:'⤓ PEM',exact:true}).click();const pem=await readFile((await(await pemDownload).path())!,'utf8');expect(Buffer.from(pem.replace(/-----[^-]+-----|\s/g,''),'base64').equals(rootDER)).toBe(true);await expect(card.getByRole('link',{name:'◫ CT logs',exact:true})).toHaveAttribute('href','https://ctlogs.dev/search?q='+fingerprint);await page.screenshot({path:info.outputPath('sslcerts-canonical.png'),fullPage:true});
    await page.evaluate(()=>{location.hash='view=accessibility'});const accessibility=page.frameLocator('#main-frame-wrapper iframe[title="Accessibility"]');await expect(accessibility.getByRole('heading',{name:'Accessibility tree',exact:true})).toBeVisible();expect(await accessibility.locator('body').evaluate(body=>body.ownerDocument.title)).toBe('Accessibility');await expect(accessibility.locator('.badges').first()).toContainText(`◇ ${axByID.size} AX nodes`);
    const closed=accessibility.locator('.ax details:not([open]) > summary').filter({visible:true}).first();await expect(closed).toBeVisible();const summary=await closed.elementHandle();await summary!.click();expect(await summary!.evaluate(element=>element.parentElement!.hasAttribute('open'))).toBe(true);await expect(accessibility.getByRole('heading',{name:'Document outline',exact:true})).toBeVisible();await page.screenshot({path:info.outputPath('accessibility-canonical.png'),fullPage:true});
    expect(external).toEqual([]);expect(errors).toEqual([]);await writeFile(info.outputPath('seo.json'),JSON.stringify(data,null,2));
  }finally{await context.close();await browser.close()}
});
