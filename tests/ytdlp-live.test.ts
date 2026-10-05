import {readWaczPackage} from './wacz-evidence';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';
import {readFile,readdir} from 'node:fs/promises';
import MiniSearch from 'minisearch';
import {searchOptions} from '../abx-plugins/abx_plugins/plugins/search_contents/browser/index';
import {openSnapshotOutput} from './snapshot-controls';
import {inspectWaczEvidence,verifyReplayPayloads} from './wacz-evidence';
import {execFileSync} from 'node:child_process';
import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const cases=[
 {name:'headers',url:'https://httpbingo.org/headers'},
 {name:'generic-html5',url:'https://www.w3schools.com/html/html5_video.asp'},
 {name:'archive-org',url:'https://archive.org/details/BigBuckBunny_328'},
 {name:'captions',url:'https://iandevlin.github.io/mdn/video-player-with-captions/'},
 {name:'youtube',url:'https://www.youtube.com/watch?v=jNQXAC9IVRw'},
];
for(const site of cases)test(`upstream yt-dlp WASM ${site.name}`,async({},info)=>{
 test.setTimeout(900000);
 const plugins=(await readdir('abx-plugins/abx_plugins/plugins',{withFileTypes:true})).filter(item=>item.isDirectory()).map(item=>item.name).sort();
 const extension=path.resolve('.output/chrome-mv3');
 const profile=await mkdtemp(path.join(tmpdir(),'abx-ytdlp-'));
 const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 const logs:string[]=[],wire:any[]=[];let capture:any;
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const studio=await context.newPage();studio.on('console',message=>logs.push(message.text()));studio.on('pageerror',error=>logs.push(String(error)));
  await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
  const cdp=await context.newCDPSession(studio);await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent',event=>{if(event.request.url.includes('/youtubei/v1/player')){let item=wire.find(item=>item.requestId===event.requestId);if(!item){item={requestId:event.requestId};wire.push(item);}Object.assign(item,{url:event.request.url,method:event.request.method,body:event.request.postData,initialHeaders:event.request.headers});}});
  cdp.on('Network.requestWillBeSentExtraInfo',event=>{let request=wire.find(item=>item.requestId===event.requestId);if(!request){request={requestId:event.requestId};wire.push(request);}request.headers=Object.fromEntries(Object.entries(event.headers).filter(([name])=>/^(user-agent|origin|referer|sec-fetch-mode)$/i.test(name)));});
  await studio.getByRole('button',{name:/^\d+ plugins$/}).click();
  for(const row of await studio.locator('.plugin-option').all()){
   await expect(row.locator('label').first().getByRole('checkbox')).toBeChecked();
  }
  await studio.getByRole('textbox',{name:'Open URL'}).fill(site.url);
  await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
  await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:780000});
  capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
  expect(capture.plugins.slice().sort()).toEqual(plugins);
  const download=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();await(await download).saveAs(info.outputPath(`${site.name}.wacz`));
  await writeFile(info.outputPath('warc-evidence.json'),JSON.stringify(await inspectWaczEvidence(info.outputPath(`${site.name}.wacz`)),null,2));
  const hook=capture.hooks.find((hook:any)=>hook.plugin==='ytdlp');
  if(site.name==='headers'){
    expect(hook.status).toBe('noresults');
    const responses:any[]=[],requests:any[]=[];
    for(const bytes of Object.values(unzipSync(await readFile(info.outputPath(site.name+'.wacz')),{filter:entry=>entry.name.startsWith('archive/')})))for await(const record of new WARCParser([bytes])){
      const body=await record.readFully();
      if(record.warcTargetURI===site.url){
        if(record.warcType==='request')requests.push(Object.fromEntries(record.httpHeaders!.headers));
        if(record.warcType==='response')responses.push(JSON.parse(new TextDecoder().decode(body)));
      }
    }
    await writeFile(info.outputPath('echo.json'),JSON.stringify({requests,responses},null,2));
    const intended=requests.map(headers=>headers['user-agent']||headers['User-Agent']).filter(Boolean);
    expect(intended.length).toBeGreaterThan(0);
    expect(intended.at(-1)).not.toContain('HeadlessChrome');
    expect(responses.at(-1).headers['User-Agent']).toEqual([intended.at(-1)]);
    expect(responses.at(-1).headers['Accept-Encoding']).toEqual(['identity']);
    expect(responses.at(-1).headers['Sec-Fetch-Mode']).toEqual(['navigate']);
    expect(await studio.evaluate(()=>chrome.declarativeNetRequest.getSessionRules())).toEqual([]);
    return;
  }
  expect(hook.status,hook.summary+"\n"+hook.logs.slice(-5).join("\n")).toBe('succeeded');
  expect(hook.records.length).toBeGreaterThan(0);
  if(site.name==='captions'){
    const native=JSON.parse(execFileSync('uv',['run','--with','yt-dlp==2026.8.19','--with','certifi','yt-dlp','--ignore-config','--skip-download','--dump-single-json','--write-subs','--write-auto-subs','--sub-langs','all','--extractor-retries','0','--retries','0',site.url],{cwd:'/tmp',encoding:'utf8'}));
    const expected=Object.entries(native.requested_subtitles).map(([language,track]:[string,any])=>({language,ext:track.ext,url:track.url}));
    expect(hook.data.tracks.map((track:any)=>({language:track.language,ext:track.ext,url:track.url}))).toEqual(expected);
    expect(hook.data.tracks.every((track:any)=>track.status==='captured')).toBe(true);
    await writeFile(info.outputPath('native-info.json'),JSON.stringify(native,null,2));
    const zip=unzipSync(await readFile(info.outputPath(site.name+'.wacz'))),manifest=(await readWaczPackage(zip));
    const indexFile=manifest.metadata.files.find((file:any)=>file.path==='search_contents/index.json');
    expect(indexFile,'Final capture search index').toBeDefined();
    expect(capture.hooks.find((hook:any)=>hook.plugin==='search_contents').status).toBe('succeeded');
    const saved=JSON.parse(new TextDecoder().decode(zip[indexFile.path])),index=MiniSearch.loadJS(saved.index,searchOptions);
    expect(saved.documents.every((document:any)=>!Object.hasOwn(document,'text'))).toBe(true);
    expect(saved.index.storedFields).toEqual({});
    expect(Object.keys(zip).filter(name=>name.startsWith('ytdlp/')),'Subtitles and transcripts are not copied into plugin files').toEqual([]);
    const subtitleURLs=new Set(expected.map(track=>track.url)),responseCopies=new Map<string,number>();
    for(const [name,bytes]of Object.entries(zip))if(name.startsWith('archive/'))for await(const record of new WARCParser([bytes])){
      await record.readFully();
      if(record.warcType==='response'&&subtitleURLs.has(record.warcTargetURI!))responseCopies.set(record.warcTargetURI!,(responseCopies.get(record.warcTargetURI!)||0)+1);
    }
    const queries={en:'innocent blood',de:'unschuldiges Blut',es:'sangre inocente'};
    const matches=[];
    for(const track of expected){
      expect(responseCopies.get(track.url),`${track.language} subtitle payload copies in WARC`).toBe(1);
      const query=queries[track.language as keyof typeof queries];expect(query).toBeTruthy();
      expect(saved.documents.filter((document:any)=>document.ref.url===track.url)).toHaveLength(1);
      const documents=index.search(query).map(result=>saved.documents[result.id]);
      expect(documents.some((document:any)=>document.ref.url===track.url),`${track.language} subtitles searchable`).toBe(true);
      matches.push({language:track.language,query,documents});
    }
    await writeFile(info.outputPath('subtitle-search.json'),JSON.stringify(matches,null,2));
  }
  await studio.getByRole('button',{name:'Delete capture',exact:true}).click();
  for(const page of context.pages())if(page!==studio)await page.close();
  await context.setOffline(true);const live:string[]=[];
  context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url());});
  const chooser=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await chooser).setFiles(info.outputPath(site.name+'.wacz'));
  await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:30000});
  const importedId=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0].id);
  await writeFile(info.outputPath('replay-evidence.json'),JSON.stringify({records:await verifyReplayPayloads(studio,importedId)},null,2));
  await openSnapshotOutput(studio,'ytdlp');
  const media=studio.frameLocator('#main-frame-wrapper iframe[title="Archived media"]');
  await expect(media.locator('#count')).toContainText('playable',{timeout:90000});
  if(site.name==='captions'){
    await expect(media.locator('#language option')).toHaveCount(3);
    await expect(media.locator('#transcript .cue').first()).toBeVisible();
    await openSnapshotOutput(studio,'search_contents');
    const search=studio.frameLocator('#main-frame-wrapper iframe[title="Search"]');
    for(const [language,query]of Object.entries({en:'innocent blood',de:'unschuldiges Blut',es:'sangre inocente'})){
      await search.getByRole('searchbox',{name:'Search archived text',exact:true}).fill(query);
      await expect(search.locator('.row').filter({hasText:`sintel-${language}.vtt`}).locator('mark').first()).toBeVisible();
    }
  }
  expect(live).toEqual([]);
  await studio.screenshot({path:info.outputPath('offline.png')});
 }finally{await writeFile(info.outputPath('ytdlp-report.json'),JSON.stringify({site,capture,logs,wire:wire.filter(item=>item.url)},null,2));await context.close();}
});
