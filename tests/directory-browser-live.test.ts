import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const player=process.env.ABX_PLAYER_URL||'http://127.0.0.1:8736/';
const source=process.env.ABX_DIRECTORY_WACZ||'http://127.0.0.1:8737/google-spreadsheets-all-plugins-derived-20261004.wacz';
test('real Sheets capture uses the ArchiveBox directory browser',async({page})=>{
  await page.goto(`${player}?source=${encodeURIComponent(source)}#view=googledocs&files=1`);
  const files=page.locator('.plugin-files');
  await expect(files.getByRole('searchbox',{name:'Filter files'})).toBeVisible({timeout:60000});
  for(const name of ['Name','Size','Type'])await expect(files.getByRole('button',{name,exact:true})).toBeVisible();
  await expect(files.locator('.directory-entry:not(.parent)')).toHaveCount(8);
  await expect(files.locator('.entry-size').first()).not.toHaveText('—');
  await files.getByRole('searchbox',{name:'Filter files'}).fill('.csv');
  await expect(files.locator('.directory-entry:visible')).toHaveCount(2);
  const row=files.locator('.directory-entry:visible').first();
  await expect(row.locator('.entry-name')).toHaveText(/\.csv$/);
  const download=page.waitForEvent('download');
  await row.getByRole('link',{name:/^Download /}).click();
  const saved=await download,body=await readFile((await saved.path())!);
  expect(saved.suggestedFilename()).toMatch(/\.csv$/);
  expect(body.length).toBeGreaterThan(0);
  const original=await page.evaluate(async url=>{const response=await fetch(url);if(!response.ok)throw Error(String(response.status));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await response.arrayBuffer()))].map(byte=>byte.toString(16).padStart(2,'0')).join('')},(await row.locator('.entry-download').getAttribute('href'))!);
  expect(createHash('sha256').update(body).digest('hex')).toEqual(original);
  await files.getByRole('searchbox',{name:'Filter files'}).fill('');
  await files.getByRole('button',{name:'Size',exact:true}).click();
  const ascending=await files.locator('.directory-entry').evaluateAll(rows=>rows.map(row=>Number((row as HTMLElement).dataset.size)));
  expect(ascending).toEqual([...ascending].sort((a,b)=>a-b));
  await page.screenshot({path:'/tmp/abx-directory-sheets.png',fullPage:true});
  await page.setViewportSize({width:600,height:900});
  await expect(files.getByRole('searchbox',{name:'Filter files'})).toBeVisible();
  expect(await files.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
});

for(const fixture of [
  {plugin:'gdrive',file:'gdrive-all48-ocr-20261004-2155.wacz'},
  {plugin:'dropbox',file:'dropbox-all48-ocr-20261004-2155.wacz'},
])test(`real ${fixture.plugin} directory navigation, preview and downloads`,async({page})=>{
  const {unzipSync,strFromU8}=await import('fflate');
  const zip=unzipSync(await readFile(`${process.env.ABX_CAPTURE_DIR||'/tmp/abx-wacz-demo'}/${fixture.file}`),{filter:file=>file.name==='datapackage.json'});
  const manifest=JSON.parse(strFromU8(zip['datapackage.json']!));
  const data=manifest.archivebox.plugins.find((plugin:any)=>plugin.id===fixture.plugin).hooks.find((hook:any)=>hook.data?.files).data;
  const errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(`${player}?source=${encodeURIComponent('http://127.0.0.1:8737/'+fixture.file)}#view=${fixture.plugin}`);
  const frame=page.frameLocator(`#main-frame-wrapper iframe[title=${JSON.stringify(data.title)}]`);
  await expect(frame.getByRole('searchbox',{name:'Filter files'})).toBeVisible({timeout:60000});
  const file=data.files.find((file:any)=>fixture.plugin==='gdrive'?file.filename.endsWith('earth.jpg'):file.filename.endsWith('Horizontal_Black.png'));
  for(const part of file.filename.split('/'))await frame.locator('.directory-link').filter({has:frame.locator('.entry-name').filter({hasText:new RegExp('^'+part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/?$')})}).click();
  await expect.poll(()=>frame.locator('#content img').evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth>0)).toBe(true);
  const downloading=page.waitForEvent('download');await frame.getByRole('link',{name:'Download '+file.filename.split('/').at(-1),exact:true}).click();
  const saved=await downloading,body=await readFile((await saved.path())!);
  expect(body.length).toBe(file.size);expect(createHash('sha256').update(body).digest('hex')).toBe(file.sha256);
  await page.screenshot({path:`/tmp/abx-directory-${fixture.plugin}.png`,fullPage:true});
  await frame.getByRole('button',{name:'Close preview',exact:true}).click();
  while(await frame.getByRole('button',{name:'↩ Up One Level',exact:true}).isVisible())await frame.getByRole('button',{name:'↩ Up One Level',exact:true}).click();
  const zipped=page.waitForEvent('download');await frame.getByRole('button',{name:'⬇ Download Zip',exact:true}).click();
  const packed=unzipSync(await readFile((await(await zipped).path())!));
  expect(Object.keys(packed).sort()).toEqual(data.files.map((file:any)=>file.filename).sort());
  for(const file of data.files)expect(createHash('sha256').update(packed[file.filename]!).digest('hex')).toBe(file.sha256);
  await frame.getByRole('searchbox',{name:'Filter files'}).fill('no-such-file-archivebox');
  await expect(frame.locator('.directory-entry:visible')).toHaveCount(0);
  await expect(frame.locator('.empty-state')).toHaveText('No matching files.');
  expect(errors).toEqual([]);
});

test('real Git checkout uses the shared directory browser',async({page})=>{
  await page.goto(`${player}?source=${encodeURIComponent('http://127.0.0.1:8737/zfsify-all-plugins-20261004.wacz')}#view=git`);
  const frame=page.frameLocator('#main-frame-wrapper iframe[title="Archived repository"]');
  await expect(frame.locator('#name')).toHaveText('pirate / zfsify',{timeout:60000});
  await expect(frame.getByRole('searchbox',{name:'Filter files'})).toBeVisible();
  await expect(frame.locator('#readme')).toBeVisible();
  await frame.getByRole('searchbox',{name:'Filter files'}).fill('README');
  await expect(frame.locator('.directory-entry:visible')).toHaveCount(1);
  const downloading=page.waitForEvent('download');await frame.getByRole('link',{name:'Download README.md',exact:true}).click();
  const text=await readFile((await(await downloading).path())!,'utf8');expect(text).toContain('zfsify');
  await frame.getByRole('searchbox',{name:'Filter files'}).fill('');
  await page.screenshot({path:'/tmp/abx-directory-git.png',fullPage:true});
  await frame.getByRole('link',{name:'Browse files',exact:true}).click();
  await expect(page.locator('.plugin-files').getByRole('searchbox',{name:'Filter files'})).toBeVisible();
  await page.locator('.plugin-files').getByRole('searchbox',{name:'Filter files'}).fill('README');
  await expect(page.locator('.plugin-files .directory-entry:visible .entry-name')).toHaveText('README.md');
});
