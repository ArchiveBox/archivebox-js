// Measure the normal all-plugin studio flow, including export to a WACZ file.
import {chromium,expect} from '@playwright/test';
import {mkdir,mkdtemp,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const output=path.resolve(process.env.ABX_BENCHMARK_OUTPUT);
const url=process.env.ABX_BENCHMARK_URL||'https://sweeting.me';
await mkdir(output,{recursive:true});
const extension=path.resolve('.output/chrome-mv3');
const plugins=(await readdir('abx-plugins/abx_plugins/plugins',{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();
const started=performance.now();
const context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-benchmark-')),{
  channel:'chromium',headless:true,acceptDownloads:true,
  args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--log-net-log=${path.join(output,'netlog.json')}`],
});
let timer;
try {
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const studio=await context.newPage();
  await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
  await studio.getByRole('button',{name:`${plugins.length} plugins`,exact:true}).click();
  await expect(studio.locator('.plugin-option')).toHaveCount(plugins.length);
  for(const row of await studio.locator('.plugin-option').all())await expect(row.locator('label').first().getByRole('checkbox')).toBeChecked();
  await studio.getByRole('button',{name:`${plugins.length} plugins`,exact:true}).click();
  await studio.getByRole('textbox',{name:'Open URL',exact:true}).fill(url);
  const clicked=performance.now();
  await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
  timer=setInterval(()=>void studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures']||[])[0]).then(async capture=>{
    if(!capture)return;
    await writeFile(path.join(output,'capture-progress.json'),JSON.stringify(capture,null,2));
    console.log(JSON.stringify({state:capture.state,hooks:capture.hooks.map(h=>({plugin:h.plugin,status:h.status,summary:h.summary}))}));
  }).catch(error=>console.error(error)),10000);
  await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:900000});
  const downloading=studio.waitForEvent('download');
  await studio.getByRole('button',{name:'Download WACZ',exact:true}).click();
  await(await downloading).saveAs(path.join(output,'capture.wacz'));
  const completed=performance.now();
  const capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures']||[])[0]);
  await writeFile(path.join(output,'capture.json'),JSON.stringify(capture,null,2));
  await writeFile(path.join(output,'timing.json'),JSON.stringify({url,startup_through_export_seconds:(completed-started)/1000,click_through_export_seconds:(completed-clicked)/1000,browser:context.browser()?.version(),plugins},null,2));
  expect(capture.plugins.slice().sort()).toEqual(plugins);
  expect(capture.hooks.filter(h=>['running','pending'].includes(h.status))).toEqual([]);
  console.log('WACZ exported',capture.state);
}finally{clearInterval(timer);await context.close()}
