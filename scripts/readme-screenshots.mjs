// Photograph the real player and retained all-plugin WACZ, without changing page content.
import {chromium,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

const player=process.env.ABX_README_PLAYER||'http://127.0.0.1:8736';
const source=process.env.ABX_README_WACZ||'http://127.0.0.1:8737/google-sheets-all-plugins-indexed-20261004.wacz';
const output=path.resolve('docs/assets');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chromium',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
const page=await context.newPage();
const errors=[];
page.on('pageerror',error=>errors.push(error.stack||String(error)));
try{
  await page.goto(`${player}/?source=${encodeURIComponent(source)}#view=googledocs`,{waitUntil:'domcontentloaded'});
  await expect(page.locator('#snapshot-output-browser')).toHaveAttribute('aria-busy','false');
  const viewer=page.frameLocator('.plugin-view[data-plugin="googledocs"] > iframe');
  await expect(viewer.locator('#preview table')).toBeVisible();
  await viewer.locator('#sheet').selectOption({label:'Test Sheet'});
  await expect(viewer.locator('#preview table')).toContainText('Joe');
  for(const frame of await page.locator('.stack-shelf iframe').all())await expect.poll(()=>frame.evaluate(frame=>{
    const ready=frame=>{const doc=frame.contentDocument;if(!doc?.body||doc.readyState!=='complete')return false;return Boolean(doc.body.innerText.length||doc.querySelector('img,iframe,svg'))&&[...doc.querySelectorAll('iframe')].every(ready)};
    return ready(frame);
  })).toBe(true);
  await expect.poll(()=>page.locator('.stack-shelf img').evaluateAll(images=>images.every(image=>image.complete&&image.naturalWidth>0))).toBe(true);
  await page.screenshot({path:path.join(output,'snapshot.png')});

  await page.goto(`${player}/?source=${encodeURIComponent(source)}#view=responses`,{waitUntil:'domcontentloaded'});
  await expect(page.getByRole('table',{name:'Archived requests'})).toBeVisible();
  await page.getByRole('button',{name:'Toggle saved outputs'}).click();
  await page.getByRole('combobox',{name:'Resource type',exact:true}).selectOption('CSS');
  await page.getByRole('table',{name:'Archived requests'}).locator('tbody tr button').first().click();
  await expect(page.getByRole('region',{name:'Selected request'}).locator('.response-headers').first()).toContainText('200');
  await page.screenshot({path:path.join(output,'responses.png')});

  await page.goto(`${player}/?source=${encodeURIComponent(source)}#view=search_contents`,{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Toggle saved outputs'}).click();
  const search=page.frameLocator('.plugin-view[data-plugin="search_contents"] > iframe');
  await search.getByRole('searchbox',{name:'Search archived text'}).fill('Favorite number');
  await expect(search.locator('mark').first()).toBeVisible();
  await expect(search.locator('.stats')).toContainText('matching documents');
  await page.screenshot({path:path.join(output,'search.png')});
  expect(errors).toEqual([]);
}finally{await browser.close()}
