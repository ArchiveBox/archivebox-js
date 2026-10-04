import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile,lstat,readlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {unzipSync} from 'fflate';
import {openSnapshotOutput} from './snapshot-controls';
const execute=promisify(execFile);
test('requested Git WACZ reconstructs a native checkout ZIP offline',async({},info)=>{
 const archivePath=process.env.ABX_GIT_WACZ;if(!archivePath)throw Error('Set ABX_GIT_WACZ to the real requested GitHub all-plugin capture');
 const manifest=JSON.parse(new TextDecoder().decode(unzipSync(await readFile(archivePath),{filter:file=>file.name==='datapackage.json'})['datapackage.json']));
 const hook=manifest.archivebox.plugins.find((plugin:any)=>plugin.id==='git').hooks[0];expect(hook.status,JSON.stringify(hook)).toBe('succeeded');const expectedHead=hook.summary.match(/[0-9a-f]{40}/)?.[0];expect(expectedHead).toBeTruthy();
 const extension=path.resolve('.output/chrome-mv3'),profile=await mkdtemp(path.join(tmpdir(),'abx-git-offline-'));
 const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);await context.setOffline(true);
  const live:string[]=[],errors:string[]=[];context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url())});page.on('pageerror',error=>errors.push(String(error)));
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await chooser).setFiles(archivePath);await openSnapshotOutput(page,'git');
  const frame=page.frameLocator('#main-frame-wrapper iframe[title="Archived repository"]');await expect(frame.locator('#name')).toHaveText('pirate / zfsify');await expect(frame.locator('#entries .row')).not.toHaveCount(0);await expect(frame.locator('#readme')).toBeVisible();
  const download=page.waitForEvent('download',{timeout:30000});await frame.getByRole('button',{name:'Download checkout',exact:true}).click();const zip=info.outputPath('zfsify-checkout.zip');await(await download).saveAs(zip);
  const extracted=info.outputPath('extracted');await execute('unzip',['-q',zip,'-d',extracted]);const dir=path.join(extracted,'git');
  const head=(await execute('git',['-C',dir,'rev-parse','HEAD'])).stdout.trim();expect(head).toBe(expectedHead);
  const fsck=await execute('git',['-C',dir,'fsck','--full']);expect(fsck.stderr).not.toMatch(/error:|fatal:|missing /);
  const status=await execute('git',['-C',dir,'status','--porcelain']);expect(status.stdout).toBe('');
  const index=(await execute('git',['-C',dir,'ls-files','--stage','-z'])).stdout.split('\0').filter(Boolean);
  expect(index.length).toBeGreaterThan(0);
  for(const entry of index){const [meta,filename]=entry.split('\t'),mode=meta!.split(' ')[0];const stat=await lstat(path.join(dir,filename!));if(mode==='100755')expect(stat.mode&0o111).toBe(0o111);if(mode==='120000'){expect(stat.isSymbolicLink()).toBe(true);expect(await readlink(path.join(dir,filename!))).toBe((await execute('git',['-C',dir,'show',`HEAD:${filename}`])).stdout)}}
  const readme=await frame.locator('#readme-link').innerText();expect(await frame.frameLocator('iframe[title="'+readme+'"]').locator('body').innerText()).toContain((await readFile(path.join(dir,readme),'utf8')).trim().slice(0,80));
  await page.screenshot({path:info.outputPath('git-offline.png'),fullPage:true});await writeFile(info.outputPath('native-git.json'),JSON.stringify({head,files:index.length,fsck,status,live,errors},null,2));expect(live).toEqual([]);expect(errors).toEqual([]);
 }finally{await context.close()}
});
