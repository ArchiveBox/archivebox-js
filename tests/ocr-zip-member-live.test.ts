import {test,expect,chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';
import {openSnapshotOutput} from './snapshot-controls';

for(const environment of ['extension','HTTP player'])test(`saved ZIP-member OCR and exact original image replay in ${environment}`,async({},info)=>{
 const archivePath=process.env.ABX_ZIP_OCR_WACZ||'/tmp/abx-search-sheets-20261004/googledocs-live-Google-spr-4dfc6-nal-viewer-and-offline-WACZ/spreadsheets-all-plugins.wacz';
 const bytes=await readFile(archivePath),zip=unzipSync(bytes),manifest=JSON.parse(new TextDecoder().decode(zip['datapackage.json']!));
 const plugins=(await readdir(path.resolve('abx-plugins/abx_plugins/plugins'),{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();
 expect(manifest.archivebox.plugins.map((plugin:any)=>plugin.id).sort()).toEqual(plugins);
 const file=manifest.archivebox.files.find((file:any)=>file.metadata.plugin==='liteparse'&&file.metadata.document.source.member?.at(-1)==='Thumbnails/thumbnail.png');expect(file).toBeDefined();
 const document=file.metadata.document,parsed=JSON.parse(new TextDecoder().decode(zip[file.path]));expect(parsed.text).toContain('Favorite number');expect(parsed.engine.ocrPages).toBe(1);
 let original:Uint8Array|undefined;
 for(const [name,content]of Object.entries(zip))if(name.startsWith('archive/'))for await(const record of new WARCParser([content])){const body=await record.readFully();if(record.warcType==='response'&&record.warcTargetURI===document.source.url&&Date.parse(record.warcDate!)===document.source.ts)original=body}
 expect(original).toBeDefined();for(const member of document.source.member)original=unzipSync(original!)[member];expect(original).toBeDefined();
 const digest=createHash('sha256').update(original!).digest('hex');expect(document.digest).toBe('sha256:'+digest);expect(document.size).toBe(original!.length);
 expect(Object.keys(zip).filter(name=>name.startsWith('liteparse/')).every(name=>name.endsWith('.json'))).toBe(true);
 const root=path.resolve('.output/player'),server=createServer(async(req,res)=>{try{
  const pathname=decodeURIComponent(new URL(req.url||'/','http://localhost').pathname),filename=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!filename.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
  const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.png':'image/png'};
  const content=await readFile(filename);res.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream'});res.end(content);
 }catch{res.writeHead(404);res.end()}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const extension=path.resolve('.output/chrome-mv3'),context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-zip-ocr-')),{channel:'chromium',headless:true,acceptDownloads:true,args:environment==='extension'?[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]:[]});
 const errors:string[]=[],external:string[]=[],ocrRequests:string[]=[];
 try{
  const page=await context.newPage();page.on('pageerror',error=>errors.push(String(error)));
  context.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(origin+'/'))external.push(request.url());if(/ocr-sandbox|\/ocr\/|liteparse_wasm|paddleocr|ort-wasm/.test(request.url()))ocrRequests.push(request.url())});
  if(environment==='extension'){
   const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');await context.setOffline(true);await page.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
  }else await page.goto(origin);
  const choosing=page.waitForEvent('filechooser');await page.getByRole('button',{name:environment==='extension'?'Import WACZ':'Open WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);
  await openSnapshotOutput(page,'liteparse');const viewer=page.locator('#main-frame-wrapper').frameLocator('iframe[title="LiteParse"]');
  const image=viewer.getByRole('img',{name:'thumbnail.png',exact:true});await image.scrollIntoViewIfNeeded();
  await expect.poll(()=>image.evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth>0)).toBe(true);await expect(image).toHaveAttribute('src',/^blob:/);
  const originalBytes=await image.evaluate(async(img:HTMLImageElement)=>Array.from(new Uint8Array(await(await fetch(img.src)).arrayBuffer())));expect(createHash('sha256').update(new Uint8Array(originalBytes)).digest('hex')).toBe(digest);
  const tile=viewer.locator('.tile').filter({has:viewer.getByRole('img',{name:'thumbnail.png',exact:true})});await expect(tile.locator('.text-preview')).toContainText('Favorite number');
  const downloading=page.waitForEvent('download');await tile.getByRole('link',{name:'JSON',exact:true}).click();expect(JSON.parse(await readFile((await(await downloading).path())!,'utf8'))).toEqual(parsed);
  const cardImage=page.locator('.stack-tray [data-resource-preview="liteparse"] img[alt="thumbnail.png"]');await expect.poll(()=>cardImage.evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBe(true);
  expect(page.frames().filter(frame=>frame.url().includes('ocr-sandbox'))).toHaveLength(0);expect(ocrRequests).toEqual([]);expect(external).toEqual([]);expect(errors).toEqual([]);
  await page.locator('#main-frame-wrapper').screenshot({path:info.outputPath('zip-member-ocr.png')});await writeFile(info.outputPath('report.json'),JSON.stringify({archivePath,document,digest,parsed,errors,external,ocrRequests},null,2));
 }finally{await context.close();await new Promise<void>(resolve=>server.close(()=>resolve()))}
});
