import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';

for(const action of ['stop','close'] as const) test(`real blog ${action} preserves partial evidence and releases the tab`,async({},info)=>{
  test.setTimeout(120000);
  const extension=path.resolve('.output/chrome-mv3');
  const profile=await mkdtemp(path.join(tmpdir(),'abx-live-lifecycle-'));
  const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try {
    const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const studioURL=`chrome-extension://${new URL(worker.url()).host}/studio.html`;
    let studio=await context.newPage();await studio.goto(studioURL);
    await studio.getByRole('button',{name:/^\d+ plugins$/}).click();
    for(const row of await studio.locator('.plugin-option').all()) {
      const checkbox=row.locator('label').first().getByRole('checkbox');
      if(await checkbox.isDisabled())continue;
      await checkbox.setChecked(['Console','Infinite scroll','Rendered DOM'].includes(await row.locator('strong').innerText()));
    }
    await studio.getByRole('spinbutton',{name:'INFINISCROLL_TIMEOUT',exact:true}).fill('30');
    await studio.getByRole('spinbutton',{name:'INFINISCROLL_SCROLL_LIMIT',exact:true}).fill('60');
    await studio.getByRole('textbox',{name:'Open URL'}).fill('https://docs.sweeting.me/s/blog');
    await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
    await expect(studio.locator('.hook-row').filter({hasText:'on_Snapshot__45_infiniscroll.ts'}).locator('.hook-status')).toHaveText('running',{timeout:45000});
    const target=context.pages().find(page=>page.url().startsWith('https://docs.sweeting.me/s/blog'))!;
    expect(target).toBeDefined();
    await expect.poll(()=>target.evaluate(()=>scrollY)).toBeGreaterThan(0);
    if(action==='stop')await studio.getByRole('button',{name:'Stop capture',exact:true}).click();
    else {
      await studio.close();studio=await context.newPage();await studio.goto(studioURL);
      await studio.locator('.capture-item').first().click();
      await studio.getByRole('button',{name:'Recover saved evidence',exact:true}).click();
    }
    await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:45000});
    const captures=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[]));
    const capture=captures[0];
    expect(capture.state).toBe('partial');
    expect(capture.hooks.some((hook:any)=>hook.status==='running')).toBe(false);
    if(action==='close')expect(capture.error).toContain('Recovered saved evidence');
    else expect(capture.hooks.find((hook:any)=>hook.plugin==='consolelog').status).toBe('succeeded');
    const download=studio.waitForEvent('download');await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();
    const archivePath=info.outputPath('partial.wacz');await(await download).saveAs(archivePath);
    const zip=unzipSync(await readFile(archivePath));let original='';
    for await(const record of new WARCParser([zip['archive/data.warc.gz']!])) {
      const body=await record.readFully();
      if(record.warcTargetURI==='https://docs.sweeting.me/s/blog' && record.warcType==='response')original=new TextDecoder().decode(body);
    }
    expect(original).toContain('Sweeting');
    await studio.screenshot({path:info.outputPath('partial-capture.png')});
    // Playwright itself has a debugger attached. Prove our session was released
    // by completing a second user-facing capture of the exact same browser tab.
    await studio.getByRole('button',{name:'New capture'}).click();
    await studio.getByRole('textbox',{name:'Open URL'}).fill('');
    await studio.getByRole('combobox',{name:'Browser tab'}).selectOption({label:await target.title()});
    await studio.getByRole('button',{name:/^\d+ plugins$/}).click();
    await studio.locator('.plugin-option').filter({has:studio.locator('strong').filter({hasText:/^Infinite scroll$/})}).locator('label').first().getByRole('checkbox').uncheck();
    await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
    await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:45000});
    const next=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
    expect(next.id).not.toBe(capture.id);expect(next.state,JSON.stringify(next)).toBe('complete');
    expect(next.url).toBe(target.url());
    expect(context.pages().filter(page=>page.url().startsWith('https://docs.sweeting.me/s/blog'))).toHaveLength(1);
    await writeFile(info.outputPath('lifecycle-report.json'),JSON.stringify({action,capture,next,profile},null,2));
  } finally {await context.close();}
});
