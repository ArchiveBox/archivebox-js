import {test,expect,chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

// Browser-level dependency regressions supplement the retained real WACZ tests.
// Serve the installed bundles, including Wombat returned by an actual SWReplay.
async function serveInstalledBundles(){
 const require=createRequire(import.meta.url),entry=require.resolve('@webrecorder/wabac');
 const dist=path.dirname(entry),wabacRequire=createRequire(entry);
 const wombat=wabacRequire.resolve('@webrecorder/wombat/dist/wombat.js');
 const server=createServer(async(request,response)=>{
  try{
   const pathname=new URL(request.url||'/','http://localhost').pathname;
   if(pathname==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Live document</title><iframe></iframe>');return;}
   response.setHeader('Content-Type','text/javascript');
   if(pathname==='/test-worker.js'){response.end('import {SWReplay} from "/swlib.js"; new SWReplay();');return;}
   const file=pathname==='/standalone-wombat.js'?wombat:['/index.js','/swlib.js'].includes(pathname)?path.join(dist,pathname.slice(1)):null;
   if(!file){response.writeHead(404);response.end();return;}
   response.end(await readFile(file));
  }catch(error){response.writeHead(500);response.end(String(error));}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {origin:`http://127.0.0.1:${(server.address() as {port:number}).port}`,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}

for(const bundle of ['index.js','swlib.js'])test(`installed ${bundle} preserves classic function hoisting, reassignment and replay closures`,async()=>{
 const server=await serveInstalledBundles(),browser=await chromium.launch({channel:'chromium',headless:true});
 try{
  const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));await page.goto(server.origin);
  const scripts=await page.evaluate(async bundle=>{
   const {Rewriter}=await import('/'+bundle);
   const archived=document.implementation.createHTMLDocument('Archived document');
   (window as any)._wb_wombat={local_init:(name:string)=>name==='document'?archived:(window as any)[name]};
   const rewriter=new Rewriter({baseUrl:'https://original.example/app.js',prefix:location.origin+'/w/20260101mp_/'});
   return [
    'var before = initialize(); function initialize() { initialize = function () { return document.title + ":again"; }; return document.title; } let left = 1, right = 2; function choose() { return "old" + document.title; } let last = 3; function choose() { return document.title; } async function load() { load = async function () { return document.title + ":again"; }; return document.title; } function* items() { items = function* () { yield document.title + ":again"; }; yield document.title; }',
    'var after = initialize(); var sum = left + right + last; var chosen = choose(); var same = initialize === window.initialize; document.title;',
   ].map(text=>rewriter.rewriteJS(text,{rewriteUrl:true}));
  },bundle);
  for(const content of scripts)await page.addScriptTag({content});
  const result=await page.evaluate(async()=>{
   const state=window as any;
   return {before:state.before,after:state.after,sum:state.sum,chosen:state.chosen,same:state.same,async:[await state.load(),await state.load()],generator:[state.items().next().value,state.items().next().value],liveTitle:document.title};
  });
  expect(result).toEqual({before:'Archived document',after:'Archived document:again',sum:6,chosen:'Archived document',same:true,async:['Archived document','Archived document:again'],generator:['Archived document','Archived document:again'],liveTitle:'Live document'});
  expect(errors).toEqual([]);
 }finally{await browser.close();await server.close();}
});

test('installed Wabac retains upstream mutable class declarations',async()=>{
 const server=await serveInstalledBundles(),browser=await chromium.launch({channel:'chromium',headless:true});
 try{
  const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));await page.goto(server.origin);
  const scripts=await page.evaluate(async()=>{
   const modulePath='/index.js';const {Rewriter}=await import(modulePath);const rewriter=new Rewriter({baseUrl:'https://original.example/app.js',prefix:location.origin+'/w/20260101mp_/'});
   return ['class Model { value() { return document.title; } }','Model = class { value() { return "changed"; } }; var value = new Model().value(); document.title;'].map(text=>rewriter.rewriteJS(text,{rewriteUrl:true}));
  });
  for(const content of scripts)await page.addScriptTag({content});
  expect(await page.evaluate(()=>(window as any).value)).toBe('changed');expect(errors).toEqual([]);
 }finally{await browser.close();await server.close();}
});

for(const embedded of [false,true])test(`installed ${embedded?'embedded':'standalone'} Wombat accepts real TrustedHTML for document.write and writeln`,async()=>{
 const server=await serveInstalledBundles(),browser=await chromium.launch({channel:'chromium',headless:true});
 try{
  const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));await page.goto(server.origin);
  if(embedded)await page.evaluate(async()=>{
   await navigator.serviceWorker.register('/test-worker.js',{type:'module'});await navigator.serviceWorker.ready;
   if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));
  });
  const code=await page.evaluate(async embedded=>{const response=await fetch(embedded?'/static/wombat.js':'/standalone-wombat.js');if(!response.ok)throw Error('Installed Wombat not served: '+response.status);return response.text();},embedded);
  const result=await page.evaluate(code=>{
   const win=document.querySelector('iframe')!.contentWindow! as any;win.eval(code);const doc=win.document as Document;const types:string[]=[];
   // Exercise the production wrapper against native iframe DOM writes. Only
   // its HTML transformation is instrumented, so the received type is explicit.
   const wombat=Object.create(win._WBWombat.prototype);
   Object.assign(wombat,{$wbwindow:win,wb_info:{},proxyToObj(value:unknown){return value;},rewriteHtml(value:string){types.push(typeof value);return value.replaceAll('original','rewritten');},initNewWindowWombat(){}});
   wombat.initDocWriteOpenCloseOverride();
   const policy=win.trustedTypes.createPolicy('archivebox-regression',{createHTML:(value:string)=>value});
   const html=policy.createHTML('<p>original TrustedHTML</p>');const trusted=win.trustedTypes.isHTML(html);
   doc.open();doc.write(html);doc.writeln(html);doc.close();
   return {trusted,tag:Object.prototype.toString.call(html),types,text:doc.body.textContent!.trim(),paragraphs:doc.querySelectorAll('p').length};
  },code);
  expect(result).toEqual({trusted:true,tag:'[object TrustedHTML]',types:['string','string'],text:'rewritten TrustedHTMLrewritten TrustedHTML',paragraphs:2});expect(errors).toEqual([]);
 }finally{await browser.close();await server.close();}
});
