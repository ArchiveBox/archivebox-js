import {readWaczPackage} from './wacz-evidence';
import {test,expect,chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile,readdir,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {openSnapshotOutput} from './snapshot-controls';

for(const source of [{filename:'filing.wacz',text:'UNITED STATES',pages:1},{filename:'linnsequencer.wacz',text:'LinnSequencer',pages:1},{filename:'attention-is-all-you-need.wacz',text:'Attention Is All You Need',pages:15}])test(`standalone player reads saved OCR from real ${source.filename} without starting OCR`,async({},info)=>{
  const captures=process.env.ABX_LIVE_CAPTURE_DIR||'/tmp/abx-ocr-final-captures';
  let archivePath='';for(const dir of await readdir(captures,{withFileTypes:true})){const candidate=path.join(captures,dir.name,source.filename);if(dir.isDirectory()&&await stat(candidate).catch(()=>undefined)){archivePath=candidate;break}}
  expect(archivePath,`Missing real capture ${source.filename} under ${captures}`).not.toBe('');
  const zip=unzipSync(await readFile(archivePath)),manifest=(await readWaczPackage(zip));
  const saved=manifest.metadata.files.filter((file:any)=>file.metadata.plugin==='liteparse').map((file:any)=>JSON.parse(new TextDecoder().decode(zip[file.path]))).find((parsed:any)=>parsed.text.includes(source.text));
  expect(saved).toBeDefined();
  const root=path.resolve('.output/player');
  const server=createServer(async(req,res)=>{try{
    const pathname=decodeURIComponent(new URL(req.url||'/','http://localhost').pathname),filename=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!filename.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
    const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.png':'image/png'};
    const bytes=await readFile(filename);res.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream'});res.end(bytes);
  }catch{res.writeHead(404);res.end()}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser=await chromium.launch({channel:'chromium',headless:true});const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
  const external:string[]=[],errors:string[]=[],ocrRequests:string[]=[];page.on('pageerror',error=>errors.push(String(error)));context.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(origin+'/'))external.push(request.url());if(/ocr-sandbox|\/ocr\/|liteparse_wasm|paddleocr|ort-wasm/.test(request.url()))ocrRequests.push(request.url())});
  try{
    await page.goto(origin);const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Open WACZ',exact:true}).click();await(await chooser).setFiles(archivePath);
    await openSnapshotOutput(page,'liteparse');const viewer=page.locator('#main-frame-wrapper .plugin-view').frameLocator('iframe[title="LiteParse"]');
    await expect(viewer.getByRole('heading',{name:'LiteParse'})).toBeVisible();
    await expect(viewer.getByRole('navigation',{name:'Output actions'})).toBeVisible();
    await expect(viewer.locator('.text-preview').first()).toContainText(source.text,{timeout:60000});
    if(source.filename!=='filing.wacz')await expect(viewer.locator('.original iframe').first()).toHaveAttribute('src',/^blob:/);
    const search=viewer.getByRole('searchbox',{name:'Search filenames or original URLs'});
    await search.fill('no-file-matches-this-query');await expect(viewer.locator('#empty')).toBeVisible();await expect(viewer.locator('.tile:visible')).toHaveCount(0);
    await search.fill('');await expect(viewer.locator('.tile').first()).toBeVisible();await expect(viewer.locator('#empty')).toBeHidden();
    await expect(viewer.locator('.file-actions').first().getByRole('link',{name:'Original',exact:true})).toHaveAttribute('href',source.filename==='filing.wacz'?/\/w\//:/^blob:/);
    const download=page.waitForEvent('download');await viewer.getByRole('link',{name:'JSON',exact:true}).first().click();const parsed=JSON.parse(await readFile((await(await download).path())!,'utf8'));
    expect(parsed).toEqual(saved);if(source.filename!=='attention-is-all-you-need.wacz')expect(parsed.engine.ocrPages).toBeGreaterThan(0);expect(parsed.totalPages).toBe(source.pages);expect(parsed.pages[0].textItems.length).toBeGreaterThan(20);expect(external).toEqual([]);expect(errors).toEqual([]);expect(ocrRequests).toEqual([]);expect(page.frames().filter(frame=>frame.url().includes('ocr-sandbox'))).toHaveLength(0);
    await expect(page.locator('.stack-tray [data-resource-preview="liteparse"]')).toContainText(source.text,{timeout:60000});
    await openSnapshotOutput(page,'search_contents');const archivedSearch=page.locator('#main-frame-wrapper').frameLocator('iframe[title="Search"]');
    await archivedSearch.getByRole('searchbox',{name:'Search archived text',exact:true}).fill(source.text);await expect(archivedSearch.locator('.row').filter({hasText:source.text}).first()).toBeVisible();
    expect(ocrRequests).toEqual([]);expect(external).toEqual([]);expect(errors).toEqual([]);
    await page.screenshot({path:info.outputPath('standalone-ocr.png'),fullPage:true});await writeFile(info.outputPath('report.json'),JSON.stringify({archivePath,origin,parsed,external,errors},null,2));
  }finally{await context.close();await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()))}
});
