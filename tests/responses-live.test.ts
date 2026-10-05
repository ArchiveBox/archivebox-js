import {readWaczPackage} from './wacz-evidence';
import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';
const file=process.env.ABX_RESPONSES_WACZ||'/tmp/abx-forum-canonical-build9-20261004/forum-upstream-live-comple-335c9-comparison-and-offline-WACZ/phpbb.wacz';
test('Responses inspects original WARC request pairs and header comparisons offline',async({},info)=>{
 const zip=unzipSync(await readFile(file)),requests:{url:string;ts:number;headers:Record<string,string>;responseId:string}[]=[],bodies=new Map<string,Uint8Array>();
 for(const [name,data]of Object.entries(zip))if(name.startsWith('archive/'))for await(const record of new WARCParser([data])){const body=await record.readFully();if(record.warcType==='response')bodies.set(record.warcHeader('WARC-Record-ID')!,body);if(record.warcType==='request')requests.push({url:record.warcTargetURI!,ts:Date.parse(record.warcDate!),headers:Object.fromEntries(record.httpHeaders?.headers||[]),responseId:record.warcHeader('WARC-Concurrent-To')!});}
 const target=requests.find(request=>request.url==='https://forum.luanti.org/viewtopic.php?f=51&t=9066'&&Object.entries(request.headers).some(([key,value])=>key.toLowerCase()==='user-agent'&&value==='forum-dl/0.3.0'))!;
 expect(target).toBeTruthy();
 const profile=await mkdtemp(path.join(tmpdir(),'abx-responses-')),extension=path.resolve('.output/chrome-mv3');
 const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
  await context.setOffline(true);const live:string[]=[];context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url())});
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await chooser).setFiles(file);
  await expect(page.locator('.stack-shelf')).toBeVisible();
  await page.goto(page.url().split('#')[0]+'#'+new URLSearchParams({view:'responses',request:target.url,ts:String(target.ts)}));
  await expect(page.getByRole('searchbox',{name:'Search requests'})).toBeVisible();
  const detail=page.getByRole('region',{name:'Selected request'});
  await expect(detail.locator('.response-selected code')).toHaveText(target.url);
  await expect(detail.locator('.response-headers').last()).toContainText('forum-dl/0.3.0');
  const actual=await detail.locator('.response-headers').last().evaluate(dl=>Object.fromEntries([...dl.querySelectorAll('dt')].map(dt=>[dt.textContent?.toLowerCase(),dt.nextElementSibling?.textContent])));
  expect(actual).toEqual(Object.fromEntries(Object.entries(target.headers).map(([key,value])=>[key.toLowerCase(),value])));
  await page.getByRole('searchbox',{name:'Search requests'}).fill('forum.luanti.org');
  expect(await page.getByRole('table',{name:'Archived requests'}).locator('tbody tr').count()).toBeGreaterThan(0);
  await expect(page.getByRole('table',{name:'Archived requests'})).not.toContainText('urn:');
  await detail.getByRole('button',{name:'Header matches',exact:true}).click();
  await expect(detail.getByRole('table',{name:'Header matching rules'})).toContainText('user-agent');
  await expect(detail.getByRole('table',{name:'Header matching rules'})).toContainText('Must equal the recorded value when explicitly supplied');
  await detail.locator('summary').filter({hasText:'Compare archived request headers'}).click();
  await detail.getByRole('combobox',{name:'Compare request'}).selectOption(target.url+'@'+target.ts);
  await expect(detail.locator('.response-match')).toHaveText('Headers match');
  const ua=detail.locator('details .response-match-table tr').filter({has:page.locator('th').filter({hasText:/^user-agent$/})});
  await expect(ua).toContainText('matched');await expect(ua).toContainText('Explicit request header');
  const browserRequest=requests.find(request=>request.url===target.url&&request.headers['user-agent']!==target.headers['user-agent'])!;expect(browserRequest).toBeTruthy();
  await detail.getByRole('combobox',{name:'Compare request'}).selectOption(browserRequest.url+'@'+browserRequest.ts);await expect(detail.locator('.response-mismatch')).toHaveText('Headers differ');await expect(ua.locator('[data-result=different]')).toHaveText('different');
  const downloading=page.waitForEvent('download');await detail.getByRole('button',{name:'Download',exact:true}).click();const downloaded=info.outputPath('response.html');await(await downloading).saveAs(downloaded);expect(await readFile(downloaded)).toEqual(Buffer.from(bodies.get(target.responseId)!));
  await detail.getByRole('button',{name:'Response',exact:true}).click();await expect(detail.locator('.response-content pre')).toContainText('Minetest');
  await detail.getByRole('button',{name:'Preview',exact:true}).click();await expect(detail.frameLocator('iframe[title="Response preview"]').locator('body')).toContainText('Minetest');
  await detail.getByRole('button',{name:'Timing',exact:true}).click();await expect(detail).toContainText('Waiting (TTFB)');
  await detail.getByRole('button',{name:'Headers',exact:true}).click();
  await page.screenshot({path:info.outputPath('responses.png'),fullPage:true});
  await writeFile(info.outputPath('evidence.json'),JSON.stringify({target,actual,live},null,2));expect(live).toEqual([]);
 }finally{await context.close()}
});

test('Responses explains incoming header matching from preserved headers immediately',async({},info)=>{
 const filename=process.env.ABX_ALL_RESPONSES_WACZ||'/tmp/abx-all-plugins-commons-build14-20261004/all-plugins-live-all-plugi-ef16b-enshot-and-metadata-offline/commons-all-plugins.wacz';
 const zip=unzipSync(await readFile(filename)),manifest=(await readWaczPackage(zip));
 expect(manifest.metadata.plugins).toHaveLength(46);
 const target={url:'https://commons.wikimedia.org/static/favicon/commons.ico',ts:0};
 let original:Record<string,string>|undefined;
 for(const [name,data]of Object.entries(zip))if(name.startsWith('archive/'))for await(const record of new WARCParser([data])){await record.readFully();if(record.warcType==='request'&&record.warcTargetURI===target.url&&!original){original=Object.fromEntries(record.httpHeaders?.headers||[]);target.ts=Date.parse(record.warcDate!);}}
 expect(original).toBeTruthy();expect(Object.keys(original!)).not.toHaveLength(0);
 const profile=await mkdtemp(path.join(tmpdir(),'abx-response-reuse-')),extension=path.resolve('.output/chrome-mv3');
 const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
  await context.setOffline(true);const live:string[]=[];context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url())});
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await chooser).setFiles(filename);await expect(page.locator('.stack-shelf')).toBeVisible();
  await page.goto(page.url().split('#')[0]+'#'+new URLSearchParams({view:'responses',request:target.url,ts:String(target.ts)}));
  const detail=page.getByRole('region',{name:'Selected request'});await expect(detail.locator('.response-selected code')).toHaveText(target.url);
  await detail.getByRole('button',{name:'Header matches',exact:true}).click();await expect(detail.getByRole('heading',{name:'Incoming header rules'})).toBeVisible();
  const rules=detail.getByRole('table',{name:'Header matching rules'});
  const rows=await rules.locator('tbody tr').evaluateAll(rows=>rows.map(row=>[...row.querySelectorAll('th,td')].map(cell=>cell.textContent)));
  for(const [name,value]of Object.entries(original!)){const row=rows.find(row=>row[0]===name.toLowerCase());expect(row,`Recorded header ${name}`).toBeTruthy();expect(row![1]).toBe(value);}
  expect(rows.find(row=>row[0]==='user-agent')?.slice(2)).toEqual(['Explicit','Must equal the recorded value when explicitly supplied']);
  expect(rows.find(row=>row[0]==='accept-encoding')?.slice(2)).toEqual(['Ignored','Transport encoding; the preserved payload is decoded']);
  await expect(detail.locator('details')).not.toHaveAttribute('open');
  await expect(detail).not.toContainText('Recorded reuse');
  await page.locator('.responses-inspector').screenshot({path:info.outputPath('incoming-header-rules.png')});
  await writeFile(info.outputPath('header-rules-evidence.json'),JSON.stringify({target,original,rows,live},null,2));expect(live).toEqual([]);
 }finally{await context.close()}
});
