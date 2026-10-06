import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {unzipSync} from 'fflate';
import {readWaczPackage} from './wacz-evidence';
import type {CaptureMetadata} from '../src/archive/metadata';

const player=process.env.ABX_PLAYER_URL||'http://127.0.0.1:8736/';
const sheets='google-spreadsheets-all-plugins-derived-20261004.wacz';
const snapshot=(file:string,view:string)=>`${player}?source=${encodeURIComponent('http://127.0.0.1:8737/'+file)}#view=${view}`;

test('non-forum detection responses stay under Responses, without a forum card or folder',async({page})=>{
  const archive=await readWaczPackage(unzipSync(await readFile('/tmp/abx-wacz-demo/'+sheets)));
  const metadata=archive.metadata as CaptureMetadata;
  const hook=metadata.plugins.find(plugin=>plugin.id==='forumdl')!.hooks[0]!;
  expect(hook.status).toBe('noresults');
  expect(hook.summary).toContain('0 boards, 0 threads, 0 posts, 0 files');
  const probe=hook.records.find(record=>record.url.endsWith('/viewforum.php'))!;
  expect(probe).toBeTruthy();
  await page.goto(snapshot(sheets,'title'));
  await expect(page.locator('#snapshot-output-browser')).toHaveAttribute('aria-busy','false');
  await expect(page.locator('[data-plugin-name="forumdl"],a[data-plugin-view="forumdl"]')).toHaveCount(0);
  for(const view of ['forumdl&files=1','forumdl']){
    await page.goto(snapshot(sheets,view));
    await expect(page).not.toHaveURL(/#view=forumdl/);
    await expect(page.locator('.plugin-view[data-plugin="forumdl"]')).toHaveCount(0);
  }
  await page.goto(snapshot(sheets,'responses'));
  await page.getByRole('searchbox',{name:'Search requests'}).fill('viewforum.php');
  await page.getByRole('table',{name:'Archived requests'}).getByRole('button',{name:probe.url,exact:true}).click();
  await expect(page.locator('.response-selected code')).toHaveText(probe.url);
  await expect(page.getByRole('region',{name:'Selected request'})).toContainText('404');
  await page.locator('.capture-diagnostics > summary').click();
  await expect(page.locator('.hook-row').filter({hasText:'on_Snapshot__49_forumdl.ts'}).locator('.hook-status')).toHaveText('noresults');
  await page.screenshot({path:'/tmp/abx-forum-noresults-sheets.png',fullPage:true});
});

test('real Hacker News forum output and its folder remain available',async({page})=>{
  const file='hacker-news-49944227-all-plugins-scroll-20261004.wacz';
  await page.goto(snapshot(file,'forumdl'));
  await expect(page.locator('#snapshot-output-browser')).toHaveAttribute('aria-busy','false');
  await expect(page.locator('[data-plugin-name="forumdl"]').first()).toBeAttached();
  const forum=page.frameLocator('.plugin-view[data-plugin="forumdl"] iframe');
  await expect(forum.locator('.thread-title')).toBeVisible();
  expect(await forum.locator('.comment').count()).toBeGreaterThan(100);
  await page.goto(snapshot(file,'forumdl&files=1'));
  await expect(page.locator('.plugin-view[data-plugin="forumdl"] #filter-files')).toBeVisible();
  await expect(page.locator('.plugin-view[data-plugin="forumdl"] tbody tr').first()).toBeVisible();
});
