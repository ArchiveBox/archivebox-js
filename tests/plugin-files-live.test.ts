import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {openSnapshotOutput} from './snapshot-controls';

test('all-plugin files stay with their plugin and HTTP references open exact requests',async({},info)=>{
  test.setTimeout(180000);
  const archivePath=process.env.ABX_ALL_PLUGIN_WACZ;
  if(!archivePath)throw Error('ABX_ALL_PLUGIN_WACZ must name a real all-plugin capture');
  const zip=unzipSync(await readFile(archivePath),{filter:file=>file.name==='datapackage.json'});
  const manifest=JSON.parse(new TextDecoder().decode(zip['datapackage.json']));
  expect(manifest.archivebox.plugins).toHaveLength(46);
  const extension=path.resolve('.output/chrome-mv3');
  const context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-plugin-files-')),{channel:'chromium',headless:true,viewport:{width:1500,height:1000},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    await context.setOffline(true);const live:string[]=[];context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url())});
    const choosing=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);
    await expect(page.locator('.stack-shelf')).toBeVisible();
    const loose=page.locator('[data-other-files] .loose-items a');
    for(const link of await loose.all()){await expect(link).toHaveAttribute('data-plugin-view',/\w+/);await expect(link).toHaveAttribute('href',/^#view=\w+&files=1$/)}
    await openSnapshotOutput(page,'screenshot');
    await page.locator('.stack-tray .thumb-card[data-plugin-name="screenshot"]').getByTitle('Open output folder').click();
    await expect(page.locator('.plugin-files').getByRole('heading',{name:'Screenshot',exact:true})).toBeVisible();
    await expect(page.locator('.plugin-files tbody tr').first()).toContainText('image/png');
    await expect(page.locator('.plugin-files tbody')).not.toContainText('application/json');
    await openSnapshotOutput(page,'gallerydl');
    await page.locator('.stack-tray .thumb-card[data-plugin-name="gallerydl"]').getByTitle('Open output folder').click();
    const reference=page.locator('.plugin-files tbody tr a[href^="#view=responses&request="]').first();await expect(reference).toBeVisible();
    const href=await reference.getAttribute('href');const target=new URLSearchParams(href!.slice(1));await reference.click();
    await expect(page.locator('.plugin-view')).toHaveAttribute('data-plugin','responses');
    await expect(page.locator('.response-list tr[aria-selected=true] button')).toHaveAttribute('title',target.get('request')!);
    await page.getByRole('button',{name:'Header matches',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Incoming header rules',exact:true})).toBeVisible();
    const rules=page.getByRole('table',{name:'Header matching rules'});await expect(rules).toHaveCount(1);
    await expect(rules).toContainText('user-agent');await expect(rules).toContainText('Must equal the recorded value when explicitly supplied');
    await expect(page.getByRole('region',{name:'Selected request'})).not.toContainText('Recorded reuse');
    await page.screenshot({path:info.outputPath('header-matching-rules.png')});
    expect(live).toEqual([]);await expect(page.getByRole('alert')).toHaveCount(0);
  }finally{await context.close()}
});
