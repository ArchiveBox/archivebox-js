import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';
import {parse,type DefaultTreeAdapterTypes} from 'parse5';

async function retainedBlog(){const root=process.env.ABX_LIVE_CAPTURE_DIR||'/tmp/abx-wacz-live-final';const files=await readdir(root,{recursive:true});const file=files.find(file=>path.basename(file)==='sweeting-blog.wacz');if(!file)throw Error(`Real Sweeting blog WACZ missing from ${root}`);return path.join(root,file);}
test('canonical article templates preserve real saved Sweeting image sizes offline',async({},testInfo)=>{
  test.setTimeout(180_000);const file=await retainedBlog();let source='';
  for(const bytes of Object.values(unzipSync(await readFile(file),{filter:entry=>entry.name.startsWith('archive/')})))for await(const record of new WARCParser([bytes])){const body=await record.readFully();if(record.warcType==='resource'&&record.warcTargetURI?.startsWith('urn:dom:'))source=new TextDecoder().decode(body);}
  expect(source.length).toBeGreaterThan(10000);
  const originals:{src:string;height?:number;width?:number}[]=[];
  function visit(node:DefaultTreeAdapterTypes.Node){
    if('tagName'in node&&node.tagName==='img'){
      const attrs=Object.fromEntries(node.attrs.map(attr=>[attr.name,attr.value]));const style=Object.fromEntries((attrs.style||'').split(';').filter(part=>part.includes(':')).map(part=>{const index=part.indexOf(':');return[part.slice(0,index).trim().toLowerCase(),part.slice(index+1).trim()];}));
      const height=style.height||attrs.height||'';const width=style.width||attrs.width||'';
      originals.push({src:new URL(attrs.src||'','https://docs.sweeting.me/s/blog').href,height:/^\d+(?:\.\d+)?(?:px)?$/.test(height)?parseFloat(height):undefined,width:/^\d+(?:\.\d+)?(?:px)?$/.test(width)?parseFloat(width):undefined});
    }
    if('childNodes'in node)for(const child of node.childNodes)visit(child);
  }visit(parse(source));
  const small=originals.filter(image=>image.height&&image.height<=80);
  expect(small.length).toBeGreaterThan(3);
  const extension=path.resolve('.output/chrome-mv3');const context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-article-images-')),{channel:'chromium',headless:true,viewport:{width:1440,height:1100},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const origin=`chrome-extension://${new URL(worker.url()).host}`;const studio=await context.newPage();await studio.goto(origin+'/studio.html');await context.setOffline(true);
    const live:string[]=[];context.on('request',request=>{if(/^https?:/.test(request.url()))live.push(request.url());});
    const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(file);
    await expect(studio.getByRole('button',{name:'Download WACZ',exact:true})).toBeVisible({timeout:60_000});
    const capture=await studio.evaluate(async()=>((await chrome.storage.local.get('wacz-captures'))['wacz-captures']as any[])[0]);
    const report:any[]=[];
    for(const plugin of ['readability','defuddle','mercury']){
      const name=plugin[0]!.toUpperCase()+plugin.slice(1);
      await studio.goto(`${origin}/studio.html?capture=${capture.id}&view=${plugin}&embed=1`);
      const shell=studio.frameLocator(`iframe[title="${name} full view"]`);const reader=shell.frameLocator(`iframe[title="${name} reader view"]`);
      await expect(reader.locator('body')).toContainText('Sweeting',{timeout:45_000});
      // The canonical template applies sizing/styles in the reader iframe load event.
      await expect.poll(()=>reader.locator('body').evaluate(node=>getComputedStyle(node).fontFamily),{timeout:45_000}).toContain('Georgia');
      await expect.poll(()=>reader.locator('img').evaluateAll(images=>images.filter(image=>(image as HTMLImageElement).naturalWidth>0).length)).toBeGreaterThan(5);
      const images=await reader.locator('img').evaluateAll(nodes=>nodes.map(node=>{const image=node as HTMLImageElement;const rect=image.getBoundingClientRect();return{src:image.currentSrc,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,width:rect.width,height:rect.height,style:image.getAttribute('style'),parentWidth:image.parentElement!.getBoundingClientRect().width};}));
      const matches=small.flatMap(original=>images.filter(image=>image.src.endsWith(original.src)&&image.naturalHeight>0).map(image=>({original,image})));
      await writeFile(testInfo.outputPath(plugin+'-dimension-probe.json'),JSON.stringify({small,images,matches},null,2));
      expect(matches.length,plugin+' retained small image count').toBeGreaterThan(2);
      for(const {original,image}of matches){expect(image.height,JSON.stringify({plugin,original,image})).toBeLessThanOrEqual(original.height!+1);expect(image.height).toBeGreaterThan(0);}
      expect(matches.some(({original,image})=>image.naturalHeight>original.height!*2),plugin+' must verify an image whose source pixels are much larger than its saved display height').toBe(true);
      expect(images.every(image=>!image.src.startsWith('data:'))).toBe(true);
      expect(images.filter(image=>image.naturalWidth>0).every(image=>image.src.startsWith(origin+'/w/'))).toBe(true);
      await expect(shell.locator('h1')).toContainText(name);await expect(shell.getByRole('link',{name:'Download',exact:true})).toBeVisible();
      const typography=await reader.locator('body').evaluate(node=>({font:getComputedStyle(node).fontFamily,maxWidth:getComputedStyle(node).maxWidth,padding:getComputedStyle(node).paddingLeft}));expect(typography.font).toContain('Georgia');expect(typography.padding).toBe('24px');
      await studio.setViewportSize({width:420,height:900});
      expect(await reader.locator('img').evaluateAll(nodes=>nodes.filter(node=>(node as HTMLImageElement).naturalWidth>0).every(node=>node.getBoundingClientRect().width<=node.ownerDocument.documentElement.clientWidth+1))).toBe(true);
      await studio.screenshot({path:testInfo.outputPath(plugin+'-canonical-mobile.png')});await studio.setViewportSize({width:1440,height:1100});
      report.push({plugin,matches,typography,images});
    }
    expect(live).toEqual([]);await writeFile(testInfo.outputPath('article-dimensions.json'),JSON.stringify({source:file,report,live},null,2));
  }finally{await context.close();}
});
