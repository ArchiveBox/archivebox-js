import {test,expect,chromium} from '@playwright/test';
import {readFile} from 'node:fs/promises';

test('captured feed redirects remain visible as complete feed output',async()=>{
 const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage({acceptDownloads:true});
 const external:string[]=[];page.on('request',request=>{const url=new URL(request.url());if(/^https?:$/.test(url.protocol)&&!['http://127.0.0.1:8736','http://127.0.0.1:8737'].includes(url.origin))external.push(url.href)});
 try{
  await page.goto('http://127.0.0.1:8736/?source=http%3A%2F%2F127.0.0.1%3A8737%2Fcommons-all-plugins.wacz#view=rss');
  const view=page.frameLocator('#main-frame-wrapper .plugin-view:visible iframe[title="Feeds"]');
  await expect(view.locator('.stats')).toContainText('1 feeds');
  // The original Atom response has 49 entries, despite its limit=50 URL.
  await expect(view.locator('.rows .row')).toHaveCount(49);
  await expect(view.locator('#content')).not.toContainText('Feed not archived');
  const downloading=page.waitForEvent('download');await view.getByRole('link',{name:'Download',exact:true}).click();
  const data=JSON.parse(await readFile((await(await downloading).path())!,'utf8'));
  expect(data).toHaveLength(1);expect(data[0].url).toContain('action=feedrecentchanges');expect(data[0].feed.items).toHaveLength(49);
  expect(external).toEqual([]);
 }finally{await browser.close()}
});
