import {test,expect,chromium,type BrowserContext} from '@playwright/test';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';
import {parse,type DefaultTreeAdapterTypes} from 'parse5';
import {inspectWaczEvidence,readWaczPackage} from './wacz-evidence';
import {openSnapshotOutput} from './snapshot-controls';

test('DOM capture observes an inert clone and replays original resource identities offline',async({},info)=>{
  const fixture=path.resolve('tests/fixtures/dom-capture');
  const html=await readFile(path.join(fixture,'page.html'));
  const svg=await readFile(path.join(fixture,'probe.svg'));
  // Serve real fixture files over HTTP; capture uses the ordinary browser and recorder.
  const server=createServer((request,response)=>{
    const pathname=new URL(request.url||'/','http://localhost').pathname;
    const file=pathname==='/fixture/page.html'?{bytes:html,mime:'text/html'}:pathname==='/fixture/assets/probe.svg'?{bytes:svg,mime:'image/svg+xml'}:undefined;
    if(!file){response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Content-Type':file.mime,'Content-Length':file.bytes.length});response.end(file.bytes);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const sourceURL=origin+'/fixture/page.html',baseURI=origin+'/fixture/assets/';
  const extension=path.resolve('.output/chrome-mv3');
  let context:BrowserContext|undefined;
  try{
    context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-dom-contract-')),{channel:'chromium',headless:true,acceptDownloads:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const studio=await context.newPage();await studio.goto('chrome-extension://'+new URL(worker.url()).host+'/studio.html');
    await studio.getByRole('button',{name:/^\d+ plugins$/}).click();
    for(const row of await studio.locator('.plugin-option').all()){
      const checkbox=row.locator('label').first().getByRole('checkbox');
      if(!await checkbox.isDisabled())await checkbox.setChecked((await row.locator('strong').innerText())==='Rendered DOM');
    }
    await studio.getByRole('textbox',{name:'Open URL'}).fill(sourceURL);
    await studio.getByRole('button',{name:'Capture tab',exact:true}).click();
    await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:60000});
    const capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
    expect(capture.state).toBe('complete');expect(capture.plugins.slice().sort()).toEqual(['chrome','dom']);
    const observed=capture.hooks.find((hook:any)=>hook.plugin==='dom');expect(observed.status).toBe('succeeded');
    expect(observed.started).toBeGreaterThanOrEqual(capture.hooks.filter((hook:any)=>hook.plugin==='chrome').at(-1).ended);
    const target=context.pages().find(page=>page.url()===sourceURL)!;expect(target).toBeDefined();
    const live=await target.evaluate(()=>({html:document.documentElement.outerHTML,before:(window as any).observedHTML,constructors:(window as any).constructions,
      dimensions:[...document.querySelectorAll('img,svg')].map(node=>({id:node.id,width:getComputedStyle(node).width,height:getComputedStyle(node).height,style:node.getAttribute('style')}))}));
    expect(live.constructors).toBe(1);expect(live.html).toBe(live.before);
    expect(live.dimensions.map(image=>image.style)).toEqual([null,null,null]);
    const [download]=await Promise.all([studio.waitForEvent('download'),studio.getByRole('button',{name:'Download WACZ',exact:true}).click()]);
    const filename=info.outputPath('dom-contract.wacz');await download.saveAs(filename);
    await inspectWaczEvidence(filename);
    const zip=unzipSync(await readFile(filename)),manifest=await readWaczPackage(zip);
    for(const resource of manifest.resources)expect('sha256:'+createHash('sha256').update(zip[resource.path]!).digest('hex')).toBe(resource.hash);
    const evidence=manifest.metadata!.files.find((file:{url:string})=>file.url.startsWith('urn:dom:'))!;
    expect(evidence.path).toBe('dom/dom.html');expect(evidence.metadata.baseURI).toBe(baseURI);expect(evidence.metadata.sourceUrl).toBe(sourceURL);
    const source=new TextDecoder().decode(zip[evidence.path!]);
    const elements=new Map<string,Record<string,string>>();
    function visit(node:DefaultTreeAdapterTypes.Node){if('tagName'in node){const attrs=Object.fromEntries(node.attrs.map(attr=>[attr.name,attr.value]));if(attrs.id)elements.set(attrs.id,attrs);}if('childNodes'in node)for(const child of node.childNodes)visit(child);}
    visit(parse(source));
    expect(elements.get('password')).not.toHaveProperty('value');expect(elements.get('file')).not.toHaveProperty('value');
    expect(elements.get('text')!.value).toBe('Serialized form attribute');
    for(const image of live.dimensions){const attrs=elements.get(image.id)!;const style=Object.fromEntries(attrs.style!.split(';').filter(Boolean).map(part=>part.trim().split(/:\s*/)));expect(style.width).toBe(image.width);expect(style.height).toBe(image.height);}
    expect(elements.get('vector')!.width).toBe('36px');expect(elements.get('vector')!.height).toBe('18px');
    expect(elements.get('original')!.src).toBe('probe.svg?from=dom#original');expect(elements.get('dynamic')!.src).toBe('probe.svg?from=dom#dynamic');
    let originalHTML:Uint8Array|undefined;
    for(const [name,bytes]of Object.entries(zip))if(name.startsWith('archive/'))for await(const record of new WARCParser([bytes])){const body=await record.readFully();if(record.warcType==='response'&&record.warcTargetURI===sourceURL)originalHTML=body;}
    expect(Buffer.from(originalHTML!)).toEqual(html);
    await studio.getByRole('button',{name:'Delete capture',exact:true}).click();await target.close();await context.setOffline(true);
    const liveRequests:string[]=[];context.on('request',request=>{if(/^https?:/.test(request.url()))liveRequests.push(request.url())});
    const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(filename);
    const output=await openSnapshotOutput(studio,'dom'),frame=output.frameLocator('iframe[title="Offline document"]');
    await expect(frame.locator('body')).toContainText('Only present after the page runs');
    await expect.poll(()=>frame.locator('img').evaluateAll(images=>images.map(image=>(image as HTMLImageElement).naturalWidth))).toEqual([1024,1024]);
    for(const id of ['original','dynamic']){
      await expect(frame.locator('#'+id)).toHaveCSS('width','96px');await expect(frame.locator('#'+id)).toHaveCSS('height','48px');
      const currentSrc=await frame.locator('#'+id).evaluate(image=>(image as HTMLImageElement).currentSrc);
      expect(currentSrc).toContain('/'+baseURI+'probe.svg?from=dom');
      expect(currentSrc.startsWith('chrome-extension://'+new URL(worker.url()).host+'/w/')).toBe(true);
    }
    await expect(frame.locator('#vector')).toHaveCSS('width','36px');await expect(frame.locator('#vector')).toHaveCSS('height','18px');
    await expect(frame.locator('script')).toHaveCount(0);expect(await frame.locator('body').evaluate(node=>(node.ownerDocument.defaultView as any).constructions)).toBeUndefined();
    expect(liveRequests).toEqual([]);await writeFile(info.outputPath('dom-contract.json'),JSON.stringify({capture,live,evidence,liveRequests},null,2));
  }finally{try{await context?.close();}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}}
});
