import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {inspectWaczEvidence,verifyReplayPayloads} from './wacz-evidence';

test('every original payload survives real WACZ import',async({},info)=>{
  test.setTimeout(180000);
  const source=process.env.ABX_REPLAY_WACZ;
  expect(source,'Set ABX_REPLAY_WACZ to a retained real capture').toBeTruthy();
  const hash=async()=>createHash('sha256').update(await readFile(source!)).digest('hex');
  const before=await hash(),evidence=await inspectWaczEvidence(source!);
  await writeFile(info.outputPath('warc-evidence.json'),JSON.stringify(evidence,null,2));
  const extension=path.resolve('.output/chrome-mv3');
  const profile=await mkdtemp(path.join(tmpdir(),'abx-payload-replay-'));
  const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const logs:string[]=[],live:string[]=[];
  context.on('console',message=>logs.push(message.text()));
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const studio=await context.newPage();
    await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    await context.setOffline(true);
    context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url());});
    const chooser=studio.waitForEvent('filechooser');
    await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();
    await(await chooser).setFiles(source!);
    await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:60000});
    const id=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0].id);
    const count=await verifyReplayPayloads(studio,id,true);
    expect(await hash(),'Reading every replay body leaves the original WACZ unchanged').toBe(before);
    await writeFile(info.outputPath('replay.json'),JSON.stringify({source,count,sha256:before,revisits:evidence.revisits},null,2));
    expect(live).toEqual([]);
  }finally{
    await writeFile(info.outputPath('logs.json'),JSON.stringify({source,logs,live},null,2));
    await context.close();
  }
});
