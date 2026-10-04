import {openSnapshotOutput} from './snapshot-controls';
import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {WARCParser} from 'warcio';

const sites=[
  {id:'hn-full',url:'https://news.ycombinator.com/item?id=49948254',budget:500,partial:false},
  {id:'discourse-full',url:'https://meta.discourse.org/t/try-out-the-new-sidebar-and-notification-menus/238821',budget:100,partial:false},
  {id:'hn-budget',url:'https://news.ycombinator.com/item?id=49948254',budget:8,partial:true},
];
for(const site of sites)test(`source forum-dl ${site.id}: original pagination and offline extraction`,async({},testInfo)=>{
  test.setTimeout(360_000);
  const profile=await mkdtemp(path.join(tmpdir(),'abx-forum-source-'));
  const extension=path.resolve('.output/chrome-mv3');
  const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const studio=await context.newPage();await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    await studio.getByRole('button',{name:/^\d+ plugins$/}).click();
    for(const row of await studio.locator('.plugin-option').all()){
      const checkbox=row.locator('label').first().getByRole('checkbox');if(!await checkbox.isDisabled())await checkbox.setChecked((await row.locator('strong').innerText())==='Forum threads');
    }
    await studio.getByRole('spinbutton',{name:'FORUMDL_MAX_REQUESTS',exact:true}).fill(String(site.budget));
    await studio.getByRole('textbox',{name:'Open URL'}).fill(site.url);await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
    await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:310_000});
    const capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
    await writeFile(testInfo.outputPath('capture.json'),JSON.stringify(capture,null,2));
    const downloading=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();const file=testInfo.outputPath(site.id+'.wacz');await(await downloading).saveAs(file);
    const hook=capture.hooks.find((item:any)=>item.plugin==='forumdl');
    expect(capture.state,JSON.stringify(capture,null,2)).toBe(site.partial?'partial':'complete');expect(hook.status,JSON.stringify(hook)).toBe(site.partial?'failed':'succeeded');
    if(site.partial)expect(hook.summary).toContain('request budget 8 exhausted');
    const zip=unzipSync(await readFile(file));const manifest=JSON.parse(strFromU8(zip['datapackage.json']!));
    expect(manifest.archivebox.plugins.find((item:any)=>item.id==='forumdl').hooks[0].records).toEqual(hook.records);
    expect(new Set(hook.records.map((ref:any)=>JSON.stringify([ref.url,ref.ts]))).size).toBe(hook.records.length);
    const originals:{url:string;requested:string;data:any}[]=[];
    for(const [name,bytes]of Object.entries(zip))if(name.startsWith('archive/')&&name.endsWith('.warc.gz'))for await(const record of new WARCParser([bytes])){
      const body=await record.readFully();
      expect(record.warcTargetURI||'').not.toMatch(/^urn:forumdl:/);
      if(record.warcType!=='response'||!body.length)continue;
      const mime=record.httpHeaders?.headers.get('content-type')||'';if(!mime.includes('json'))continue;
      const url=record.warcTargetURI||'';const meta=JSON.parse(record.warcHeaders.headers.get('WARC-JSON-Metadata')||'{}');
      originals.push({url,requested:meta.requestedUrl||url,data:JSON.parse(strFromU8(body))});
    }
    let posts:any[]=[];let title='';let expectedCount=0;
    if(site.id.startsWith('hn')){
      const items=originals.filter(item=>/hacker-news\.firebaseio\.com\/v0\/item\//.test(item.url));const byId=new Map(items.filter(item=>item.data).map(item=>[item.data.id,item.data]));const root=byId.get(49948254);expect(root).toBeTruthy();title=root.title;
      const fetchedIds=new Set(items.map(item=>Number(/\/item\/(\d+)/.exec(item.url)![1])));const missing=[...byId.values()].flatMap(item=>item.kids||[]).filter(id=>!fetchedIds.has(id));
      if(!site.partial)expect(missing).toEqual([]);if(site.partial){expect(missing.length).toBeGreaterThan(0);expect(items).toHaveLength(7);}
      posts=[...byId.values()];expectedCount=posts.length;expect(posts.filter(item=>item.type==='comment'&&item.text).length).toBeGreaterThan(0);
    }else{
      const topic=originals.find(item=>item.data?.id===238821&&Array.isArray(item.data.post_stream?.stream))!.data;expect(topic).toBeTruthy();title=topic.title;
      const batches=originals.filter(item=>item.data?.id===238821&&Array.isArray(item.data.post_stream?.posts));const byId=new Map<number,any>();for(const batch of batches)for(const post of batch.data.post_stream.posts)byId.set(post.id,post);
      posts=[...byId.values()];expectedCount=posts.length;expect(batches.length).toBeGreaterThan(5);expect(posts.length).toBeGreaterThanOrEqual(topic.posts_count);
      const requested=new Set<number>(topic.post_stream.posts.map((post:any)=>post.id));
      for(const batch of batches){for(const id of new URL(batch.requested).searchParams.getAll('post_ids[]'))requested.add(Number(id));}
      expect(topic.post_stream.stream.filter((id:number)=>!requested.has(id))).toEqual([]);
      expect(new Set(batches.map(batch=>batch.url)).size).toBe(batches.length);
    }
    await writeFile(testInfo.outputPath('original-pagination.json'),JSON.stringify({originals,expectedCount},null,2));
    await studio.getByRole('button',{name:'Delete capture',exact:true}).click();for(const page of context.pages())if(page!==studio)await page.close();
    await context.setOffline(true);const live:string[]=[];context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url());});
    const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(file);
    await openSnapshotOutput(studio,'forumdl');
    const thread=studio.locator('#main-frame-wrapper .plugin-view').frameLocator('iframe[title="Offline document"]');await expect(thread.locator('h1')).toHaveText(title);
    await expect(thread.locator('[data-post-id]')).toHaveCount(expectedCount,{timeout:30_000});
    if(site.id.startsWith('hn')){
      const capturedIds=new Set(posts.map(post=>post.id));
      const nestedReplies=posts.filter(post=>post.parent!==49948254&&capturedIds.has(post.parent));
      if(!site.partial)expect(nestedReplies.length).toBeGreaterThan(0);
      for(const reply of nestedReplies){
        const parentId=await thread.locator(`[data-post-id="${reply.id}"]`).evaluate(element=>element.parentElement?.parentElement?.querySelector(':scope > section[data-post-id]')?.getAttribute('data-post-id'));
        expect(parentId,`Archived reply ${reply.id} must nest under its original API parent`).toBe(String(reply.parent));
      }
    }
    for(const post of posts.filter(post=>post.text||post.cooked).slice(-3)){
      const text=await studio.evaluate(html=>new DOMParser().parseFromString(html,'text/html').body.textContent||'',post.text||post.cooked);
      await expect(thread.locator(`[data-post-id="${post.id}"]`)).toContainText(text.trim().replace(/\s+/g,' ').slice(0,100));
      await expect(thread.locator(`[data-post-id="${post.id}"] strong`)).toHaveText(post.by||post.username||'[deleted]');
    }
    await expect(studio.locator('#main-frame-wrapper .plugin-view > .muted')).toContainText(site.partial?'Incomplete capture':'Traversal complete');
    await expect(studio.locator('#main-frame-wrapper .plugin-view .error')).toHaveCount(0);expect(live).toEqual([]);await studio.screenshot({path:testInfo.outputPath('offline-forum.png'),fullPage:true});
  }finally{await context.close();}
});
