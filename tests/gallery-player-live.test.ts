import {test,expect,chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openSnapshotOutput} from './snapshot-controls';

for(const source of [{filename:'wallhaven-gallery.wacz',probe:false},{filename:'gallery-untrusted-expression.wacz',probe:true}])test(`HTTP player isolates upstream Python for real ${source.filename}`,async({},info)=>{
  test.setTimeout(120000);
  const captures=process.env.ABX_GALLERY_CAPTURE_DIR;
  expect(captures,'Set ABX_GALLERY_CAPTURE_DIR to a completed gallery-upstream-live output directory').toBeTruthy();
  let archivePath='';for(const dir of await readdir(captures!,{withFileTypes:true})){if(!dir.isDirectory())continue;const candidate=path.join(captures!,dir.name,source.filename);if(await readFile(candidate).then(()=>true,()=>false)){archivePath=candidate;break;}}
  expect(archivePath,`Missing real capture ${source.filename} under ${captures}`).not.toBe('');
  const root=path.resolve('.output/player');
  const server=createServer(async(req,res)=>{try{
    const pathname=decodeURIComponent(new URL(req.url||'/','http://localhost').pathname),filename=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!filename.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
    const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.png':'image/png'};
    const bytes=await readFile(filename);res.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream','Access-Control-Allow-Origin':'*'});res.end(bytes);
  }catch{res.writeHead(404,{'Access-Control-Allow-Origin':'*'});res.end();}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser=await chromium.launch({channel:'chromium',headless:true});const context=await browser.newContext();const page=await context.newPage();
  const external:string[]=[],responses:string[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));context.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(origin+'/'))external.push(request.url());});context.on('response',response=>{if(/^https?:/.test(response.url())&&!response.url().startsWith(origin+'/'))responses.push(response.url());});
  try{
    await page.goto(origin);const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Open WACZ',exact:true}).click();await(await chooser).setFiles(archivePath);await openSnapshotOutput(page,'gallerydl');
    const viewer=page.frameLocator('#main-frame-wrapper iframe[title="Image gallery"]');
    if(source.probe){
      const diagnostics=page.getByRole('alert');await expect(diagnostics).toBeVisible({timeout:60000});await expect(diagnostics).toContainText('SANDBOX_EXTENSION_API=False');await expect(diagnostics).toContainText('Python sandbox blocked connect-src');await expect(diagnostics).toContainText('https://example.com/archivebox-gallery-isolation-probe');
    }else{
      await expect(viewer.locator('h1')).toContainText('Gallery',{timeout:60000});
      await expect(viewer.locator('#count')).toHaveText('1 images');await expect(viewer.getByRole('alert')).toHaveCount(0);await expect.poll(()=>viewer.locator('#gallery .tile img').evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBeGreaterThan(0);await viewer.locator('#gallery .tile img').evaluate((image:HTMLImageElement)=>image.decode());
      const original=await viewer.locator('#gallery .tile img').getAttribute('src');
      const digest=await page.evaluate(async url=>{const body=await(await fetch(url!)).arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',body)),byte=>byte.toString(16).padStart(2,'0')).join('')},original);
      const downloading=page.waitForEvent('download');await viewer.locator('#download').click();const downloaded=await downloading,filename=info.outputPath(downloaded.suggestedFilename());await downloaded.saveAs(filename);expect(createHash('sha256').update(await readFile(filename)).digest('hex')).toBe(digest);expect(external).toEqual([]);
    }
    expect(responses).toEqual([]);expect(errors).toEqual([]);await page.screenshot({path:info.outputPath('http-python-sandbox.png')});await writeFile(info.outputPath('report.json'),JSON.stringify({archivePath,origin,external,responses,errors},null,2));
  }finally{await context.close();await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
