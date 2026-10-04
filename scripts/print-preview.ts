import type {Plugin} from 'vite';
import {chromium,type Browser,type BrowserContext} from '@playwright/test';

/** Local companion for Chromium PDF and accessibility rendering. These
 * endpoints are never part of a static build. */
export function printPreview():Plugin{
 return {name:'native-render-preview',configurePreviewServer(server){
  let browser:Promise<Browser>|undefined;
  server.httpServer?.once('close',()=>{void browser?.then(value=>value.close())});
  server.middlewares.use(async(request,response,next)=>{
   if(!['/api/print-pdf','/api/accessibility-tree'].includes(request.url||''))return next();
   const accessibility=request.url==='/api/accessibility-tree';
   const origin=`http://${request.headers.host}`;
   if(request.method!=='POST'||request.headers.origin!==origin||request.headers['content-type']!=='application/json'){
    response.writeHead(403);response.end('Open the output in this player.');return;
   }
   let context:BrowserContext|undefined;
   const disconnected=()=>{void context?.close()};
   response.once('close',disconnected);
   try{
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of request){size+=chunk.length;if(size>16384)throw Error('Native render request is too large');chunks.push(chunk)}
    const {source,landscape}=JSON.parse(Buffer.concat(chunks).toString()),url=new URL(source);
    if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.endsWith('.wacz'))throw Error('Native preview requires a local WACZ URL.');
    browser??=chromium.launch({channel:'chromium',headless:true});
    context=await(await browser).newContext();
    if(response.destroyed)return;
    const external:string[]=[];
    context.on('request',request=>{const target=new URL(request.url());if(/^https?:$/.test(target.protocol)&&target.origin!==origin&&target.href!==url.href)external.push(target.href)});
    await context.route('**/*',route=>{const target=new URL(route.request().url());return /^https?:$/.test(target.protocol)&&target.origin!==origin&&target.href!==url.href?route.abort('blockedbyclient'):route.continue()});
    const page=await context.newPage();
    const address=new URL(origin);address.searchParams.set('source',url.href);address.searchParams.set('print',accessibility?'accessibility':'1');
    await page.goto(address.href,{waitUntil:'domcontentloaded'});
    await page.locator('html[data-pdf-ready],html[data-pdf-error]').waitFor({state:'attached'});
    const error=await page.locator('html').getAttribute('data-pdf-error');if(error)throw Error(error);
    const bytes=accessibility?Buffer.from(JSON.stringify(await(await context.newCDPSession(page)).send('Accessibility.getFullAXTree'))):await page.pdf({printBackground:true,landscape:landscape===true,preferCSSPageSize:true});
    if(external.length)throw Error('Native replay attempted an uncaptured network request: '+external[0]);
    response.writeHead(200,{'Content-Type':accessibility?'application/json':'application/pdf','Content-Length':bytes.length,'Cache-Control':'no-store'});response.end(bytes);
   }catch(error){if(!response.destroyed){response.writeHead(500,{'Content-Type':'text/plain','Cache-Control':'no-store'});response.end(String(error))}}
   finally{response.off('close',disconnected);await context?.close()}
  });
 }};
}
