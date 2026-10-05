import {readWaczPackage} from './wacz-evidence';
import {openSnapshotOutput} from './snapshot-controls';
import {inspectWaczEvidence,verifyReplayPayloads} from './wacz-evidence';
import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {unzipSync} from 'fflate';
const execute=promisify(execFile);
const sites=[
  {id:'pipermail',url:'https://lists.opensource.org/pipermail/license-review_lists.opensource.org/2008-January/000031.html'},
  {id:'hypermail',url:'https://hypermail-project.org/archive/98/0001.html'},
  {id:'hackernews',url:'https://news.ycombinator.com/jobs'},
  {id:'discourse',url:'https://meta.discourse.org/t/try-out-the-new-sidebar-and-notification-menus/238821'},
  {id:'phpbb',url:'https://forum.luanti.org/viewtopic.php?f=51&t=9066'},
  {id:'hyperkitty',url:'https://mail.python.org/archives/list/mm3_test@python.org/thread/JNBVEQQBAI67DBT4HFXI3PO4APTKGQZO/'},
];
for(const site of sites)test(`complete upstream forum-dl ${site.id}: native comparison and offline WACZ`,async({},testInfo)=>{
  test.setTimeout(360_000);
  const nativeFile=testInfo.outputPath('native.json');
  await execute('uv',['run','--no-project','--python','3.13','--with','pydantic==1.10.26','--with','beautifulsoup4==4.13.3','--with','lxml==6.0.2','--with','requests==2.32.5','--with','tenacity==9.1.4','--with','dateparser==1.2.2','--with','html2text==2025.4.15','vendor/forum-dl/native-reference.py',site.url,nativeFile],{timeout:180_000});
  const native=JSON.parse(await readFile(nativeFile,'utf8'));
  expect(native.complete,JSON.stringify(native)).toBe(true);expect(native.family).toBe(site.id);expect(native.posts.length).toBeGreaterThan(0);expect(native.modules).toHaveLength(11);
  const profile=await mkdtemp(path.join(tmpdir(),'abx-forum-upstream-'));
  const extension=path.resolve('.output/chrome-mv3');
  const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const studio=await context.newPage();await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    await studio.getByRole('button',{name:/^\d+ plugins$/}).click();
    for(const row of await studio.locator('.plugin-option').all()){
      const checkbox=row.locator('label').first().getByRole('checkbox');if(!await checkbox.isDisabled())await checkbox.setChecked((await row.locator('strong').innerText())==='Forum threads');
    }
    await studio.getByRole('textbox',{name:'Open URL'}).fill(site.url);await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
    await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:250_000});
    const capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
    await writeFile(testInfo.outputPath('capture.json'),JSON.stringify(capture,null,2));
    const downloading=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();const file=testInfo.outputPath(site.id+'.wacz');await(await downloading).saveAs(file);
    const evidence=await inspectWaczEvidence(file);
    await writeFile(testInfo.outputPath('warc-evidence.json'),JSON.stringify(evidence,null,2));
    if(site.id==='phpbb')expect(evidence.requests.filter(request=>request.url===site.url&&request.headers['user-agent']==='forum-dl/0.3.0')).toHaveLength(1);
    const hook=capture.hooks.find((item:any)=>item.plugin==='forumdl');
    expect(hook.status,JSON.stringify(hook)).toBe('succeeded');expect(hook.logs).toContain('Verified identical complete upstream metadata using captured responses only');
    const zip=unzipSync(await readFile(file));const manifest=(await readWaczPackage(zip));
    expect(manifest.metadata.plugins.find((item:any)=>item.id==='forumdl').hooks[0].records).toEqual(hook.records);
    expect(hook.data).toBeUndefined();
    await studio.getByRole('button',{name:'Delete capture',exact:true}).click();for(const page of context.pages())if(page!==studio)await page.close();
    await context.setOffline(true);const live:string[]=[];context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url());});
    const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(file);
    await openSnapshotOutput(studio,'forumdl');
    const importedId=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0].id);
    const verifiedPayloads=await verifyReplayPayloads(studio,importedId);expect(verifiedPayloads).toBeGreaterThan(0);
    await writeFile(testInfo.outputPath('replay-evidence.json'),JSON.stringify({verifiedPayloads},null,2));
    const thread=studio.locator('#main-frame-wrapper .plugin-view').frameLocator('iframe[title="Forum thread"]');
    await expect(thread.locator('.thread-title')).toHaveText(native.threads.map((item:any)=>item.title||'Forum thread'),{timeout:90_000});
    const exporting=studio.waitForEvent('download');await thread.getByRole('link',{name:'Download',exact:true}).click();
    const derived=testInfo.outputPath('offline-forum.jsonl');await(await exporting).saveAs(derived);
    const records=(await readFile(derived,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(new Set(records.map(record=>record.extractor))).toEqual(new Set([native.family]));
    for(const [type,key]of [['board','boards'],['thread','threads'],['post','posts'],['file','files']] as const)expect(records.filter(record=>record.type===type).map(record=>record.item)).toEqual(native[key]);
    // Native metadata comes from the real canonical Download action, never a
    // special test-only UI. The actual template must display each author.
    for(const author of new Set<string>(native.posts.map((post:any)=>post.author).filter(Boolean)))await expect(thread.locator('#content')).toContainText(author);
    if(site.id==='hypermail'||site.id==='discourse')expect(await thread.locator('.comment-children .comment').count()).toBeGreaterThan(0);
    if(site.id==='phpbb')await expect.poll(()=>thread.locator('img[src*="raw.githubusercontent.com"]').first().evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBe(true);
    await expect(thread.locator('img[src^="data:"]')).toHaveCount(0);
    const rawOpening=studio.waitForEvent('popup');await thread.getByRole('link',{name:'View raw',exact:true}).click();const raw=await rawOpening;await raw.waitForLoadState();
    expect((await raw.locator('body').innerText()).trim().split('\n').map(line=>JSON.parse(line))).toEqual(records);await raw.close();
    expect(live).toEqual([]);await studio.screenshot({path:testInfo.outputPath('offline-forum.png'),fullPage:true});
    await thread.getByRole('link',{name:'View all files',exact:true}).click();await expect(studio).toHaveURL(/view=responses/);
  }finally{await context.close();}
});
