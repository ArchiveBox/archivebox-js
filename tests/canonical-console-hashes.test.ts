import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {createHash} from 'node:crypto';
import {WARCParser} from 'warcio';
const file='/tmp/abx-all-plugins-commons-build14-20261004/all-plugins-live-all-plugi-ef16b-enshot-and-metadata-offline/commons-all-plugins.wacz';
test('canonical console and hashes use original WACZ offline',async({},info)=>{
 const extension=path.resolve('.output/chrome-mv3'),profile=await mkdtemp(path.join(tmpdir(),'abx-console-hashes-'));
 const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);await context.setOffline(true);
  const live:string[]=[];context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url())});
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await chooser).setFiles(file);await expect(page.locator('.stack-shelf')).toBeVisible();
  await page.goto(page.url().split('#')[0]+'#view=consolelog');
  const consoleFrame=page.locator('#main-frame-wrapper .plugin-view').frameLocator('iframe[title="Console"]');
  await expect(consoleFrame.locator('h1')).toContainText('Console');await expect(consoleFrame.locator('.log-row')).not.toHaveCount(0);
  const download=page.waitForEvent('download');await consoleFrame.locator('#download').click();const saved=info.outputPath('console.jsonl');await(await download).saveAs(saved);const logs=(await readFile(saved,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(await consoleFrame.locator('.log-row').count()).toBe(logs.length);
  const originalZip=unzipSync(await readFile(file));let events:any[]=[];for(const [name,bytes] of Object.entries(originalZip))if(name.startsWith('archive/'))for await(const record of new WARCParser([bytes])){const body=await record.readFully();if(record.warcTargetURI?.startsWith('urn:consolelog:'))events=JSON.parse(new TextDecoder().decode(body))}
  expect(logs.length).toBe(events.length);expect(logs.map(row=>row.timestamp)).toEqual(events.map(({method,params})=>method==='Log.entryAdded'?params.entry.timestamp:params.timestamp));
  await page.screenshot({path:info.outputPath('console-messages.png'),fullPage:true});
  await consoleFrame.getByLabel('Filter console level').selectOption('error');expect(await consoleFrame.locator('.log-row').count()).toBe(logs.filter(row=>['error','assert','pageerror','request_failed'].includes(row.type)).length);
  await consoleFrame.getByLabel('Filter console messages').fill('no-such-message-archivebox-test');await expect(consoleFrame.locator('.empty')).toHaveText('No matching console messages');await page.screenshot({path:info.outputPath('console.png'),fullPage:true});
  await page.goto(page.url().split('#')[0]+'#view=hashes');const hashes=page.locator('#main-frame-wrapper .plugin-view').frameLocator('iframe[title="Hashes"]');await expect(hashes.locator('.tree')).toBeVisible();
  const hashDownload=page.waitForEvent('download');await hashes.locator('#download').click();const savedHashes=info.outputPath('hashes.json');await(await hashDownload).saveAs(savedHashes);const data=JSON.parse(await readFile(savedHashes,'utf8')),zip=unzipSync(await readFile(file)),manifest=JSON.parse(new TextDecoder().decode(zip['datapackage.json']));
  expect(data.files).toEqual(manifest.resources.map((resource:any)=>({path:resource.path,size:resource.bytes,hash:resource.hash.replace(/^sha-?256:/,'')})).sort((a:any,b:any)=>a.path.localeCompare(b.path)));
  for(const item of data.files)expect(createHash('sha256').update(zip[item.path]!).digest('hex')).toBe(item.hash);
  const cdx=new TextDecoder().decode(zip['indexes/index.cdx']).trim().split('\n').map(line=>JSON.parse(line.slice(line.indexOf(' {')+1)));
  const leaves=Object.values(data.warc_records).flatMap((branch:any)=>branch.files);
  expect(leaves).toHaveLength(cdx.length);
  for(const entry of cdx){const branch=data.warc_records[entry.filename.startsWith('archive/')?entry.filename:`archive/${entry.filename}`];expect(branch.files).toContainEqual(expect.objectContaining({url:entry.url,offset:Number(entry.offset),hash:entry.digest.replace(/^sha-?256:/,'')}));}
  for(const branch of Object.values(data.warc_records) as any[]){let hashes=branch.files.map((item:any)=>item.hash);while(hashes.length>1){const next=[];for(let i=0;i<hashes.length;i+=2)next.push(createHash('sha256').update(hashes[i]+(hashes[i+1]||hashes[i])).digest('hex'));hashes=next}expect(branch.root_hash).toBe(hashes[0]);}
  let level=data.files.map((item:any)=>item.hash);while(level.length>1){const next=[];for(let i=0;i<level.length;i+=2)next.push(createHash('sha256').update(level[i]+(level[i+1]||level[i])).digest('hex'));level=next}expect(data.root_hash).toBe(level[0]);
  await hashes.locator('summary').filter({hasText:'archive'}).click();await expect(hashes.locator('.filename').filter({hasText:'data.warc.gz'})).toBeVisible();await expect(hashes.locator('.tree > li > details > summary code')).toHaveAttribute('title',data.root_hash);
  await hashes.locator('[data-warc="archive/data.warc.gz"] > summary').click();await hashes.locator('summary').filter({hasText:'Payloads'}).click();await expect(hashes.locator('[data-record-url]')).toHaveCount(cdx.length);await expect(hashes.getByText('commons.wikimedia.org',{exact:true})).toBeVisible();await page.screenshot({path:info.outputPath('hashes.png'),fullPage:true});expect(live).toEqual([]);
 }finally{await context.close()}
});
