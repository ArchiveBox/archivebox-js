import {test,expect} from '@playwright/test';

const player=process.env.ABX_PLAYER_URL||'http://127.0.0.1:8736/';
const source='http://127.0.0.1:8737/google-spreadsheets-all-plugins-derived-20261004.wacz';
test('metadata stack cards use the canonical renderers over a real Sheets capture',async({page})=>{
  const native:string[]=[];page.on('request',request=>{if(/api\/(accessibility-tree|print-pdf)|python-sandbox|ocr-sandbox/.test(request.url()))native.push(request.url())});
  await page.goto(`${player}?source=${encodeURIComponent(source)}#view=title`);
  await expect(page.locator('#snapshot-output-browser')).toHaveAttribute('aria-busy','false');
  const cover=page.locator('.output-stack-metadata iframe[data-plugin-preview]').contentFrame().frameLocator('iframe');
  await expect(cover.locator('.badges .badge').first()).toContainText('outline entries');
  expect(native,'Stack covers must not launch native render or extraction engines').toEqual([]);
  await page.locator('.output-stack-metadata').click();
  // Expanding an ArchiveBox stack also opens its first output. Return to Title
  // so the remaining checks inspect cards independently of that full viewer.
  await page.locator('.stack-tray .thumb-card[data-plugin-name="title"] .thumbnail-click-overlay').click();
  const card=(plugin:string)=>page.locator(`.stack-tray .thumb-card[data-plugin-name="${plugin}"] iframe[data-plugin-preview]`).contentFrame().frameLocator('iframe');
  await expect(card('headers').locator('.exchange .request .header-row').first()).toBeVisible();
  await expect(card('headers').locator('.exchange .response .status')).toHaveText('200');
  await expect(card('hashes').locator('.tree > li > details > summary .filename')).toHaveText('Snapshot');
  await expect(card('accessibility').locator('.badges .badge').first()).toContainText('outline entries');
  await expect(card('accessibility').getByRole('heading',{name:'Document outline',exact:true})).toBeVisible();
  for(const [plugin,selector] of [['dns','.map .answer'],['sslcerts','.cert'],['redirects','.chain'],['parse_dom_outlinks','.rows .row'],['parse_html_urls','.rows .row'],['parse_jsonl_urls','.filter'],['parse_txt_urls','.filter']]){
    await page.locator('.stack-tray .thumb-card[data-plugin-name="'+plugin+'"]').scrollIntoViewIfNeeded();
    await expect(card(plugin!).locator(selector!).first()).toBeVisible();
  }
  expect(native.filter(url=>!/api\/accessibility-tree/.test(url))).toEqual([]);
  expect(native.filter(url=>/api\/accessibility-tree/.test(url)).length).toBeLessThanOrEqual(1);
  await page.screenshot({path:'/tmp/abx-metadata-cards-sheets.png',fullPage:true});
});

test('Sheets headers resolve the recorded navigation and the full hash tree retains response leaves',async({page})=>{
  await page.goto(`${player}?source=${encodeURIComponent(source)}#view=headers`);
  const headers=page.frameLocator('#main-frame-wrapper .plugin-view:visible iframe');
  await expect(headers.locator('.response .status')).toHaveText('200');
  await expect(headers.locator('.request > .url')).toHaveText('https://docs.google.com/spreadsheets/d/1o5t26He2DzTweYeleXOGiDjlU4Jkx896f95VUHVgS8U/edit');
  await expect(headers.locator('.request .header-row').first()).toBeVisible();
  await page.screenshot({path:'/tmp/abx-metadata-headers-full.png',fullPage:true});
  await page.locator('.output-stack-metadata').click();
  await page.locator('.stack-tray .thumb-card[data-plugin-name="hashes"] .thumbnail-click-overlay').click();
  const hashes=page.frameLocator('#main-frame-wrapper .plugin-view:visible iframe');
  await expect(hashes.locator('.tree')).toBeVisible();
  await hashes.locator('.tree > li > details > ul > li > details > summary .filename').filter({hasText:/^archive$/}).click();
  await hashes.locator('details[data-warc] > summary').first().click();
  await expect(hashes.locator('details[data-warc] .filename').filter({hasText:/^Payloads$/}).first()).toBeVisible();
  expect(await hashes.locator('[data-record-url]').count()).toBeGreaterThan(100);
  await page.screenshot({path:'/tmp/abx-metadata-hashes-full.png',fullPage:true});
});

test('Sweeting metadata and activity cards retain canonical diagrams, rows and search',async({page})=>{
  await page.goto(`${player}?source=${encodeURIComponent('http://127.0.0.1:8737/sweeting-all-plugins-20261004.wacz')}#view=headers`);
  await expect(page.locator('#snapshot-output-browser')).toHaveAttribute('aria-busy','false');
  await page.locator('.output-stack-metadata').click();
  await page.locator('.stack-tray .thumb-card[data-plugin-name="headers"] .thumbnail-click-overlay').click();
  const card=(plugin:string)=>page.locator(`.stack-tray .thumb-card[data-plugin-name="${plugin}"] iframe[data-plugin-preview]`).contentFrame().frameLocator('iframe');
  for(const [plugin,selector] of [['headers','.request .header-row'],['hashes','.tree'],['dns','.map .answer'],['sslcerts','.cert'],['redirects','.chain'],['accessibility','.outline'],['parse_dom_outlinks','.rows .row']]){
    await page.locator('.stack-tray .thumb-card[data-plugin-name="'+plugin+'"]').scrollIntoViewIfNeeded();
    await expect(card(plugin!).locator(selector!).first()).toBeVisible();
  }
  await page.screenshot({path:'/tmp/abx-metadata-cards-sweeting.png',fullPage:true});
  await page.locator('.output-stack-other').click();
  const activity=page.locator('.stack-tray .thumb-card[data-plugin-name="browsertrix_behaviors"] iframe').contentFrame();
  await expect(activity.getByRole('searchbox',{name:'Filter activity'})).toBeVisible();
  await expect(activity.locator('.row').first()).toBeVisible();
  await page.screenshot({path:'/tmp/abx-other-cards-sweeting.png',fullPage:true});
  await page.goto(`${player}?source=${encodeURIComponent('http://127.0.0.1:8737/google-sheets-all-plugins-indexed-20261004.wacz')}#view=headers`);
  await expect(page.locator('#snapshot-output-browser')).toHaveAttribute('aria-busy','false');
  await page.locator('.output-stack-other').click();
  const search=page.locator('.stack-tray .thumb-card[data-plugin-name="search_contents"] iframe').contentFrame();
  await expect(search.getByRole('searchbox',{name:'Search archived text'})).toBeVisible();
  await expect(search.locator('.stats .badge')).toHaveText(/\d+ documents/);
  await page.screenshot({path:'/tmp/abx-search-card-sheets.png',fullPage:true});
});
