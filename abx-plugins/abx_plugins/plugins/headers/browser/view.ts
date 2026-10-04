import type {ViewContext,ViewResult} from '@/src/archive/views';
import template from '../../../../../vendor/archivebox/plugins/headers/full.html?raw';
import {initializeHeaders} from '@/src/ui/headers-template';
export default async function({archive,capture,url,signal}:ViewContext):Promise<ViewResult>{
  const target=capture?.finalUrl||url;
  const entry=archive.entries.filter(entry=>entry.url===target&&entry.method!=='HEAD').sort((a,b)=>a.ts-b.ts)[0]||archive.entries.find(entry=>entry.url===url&&entry.method!=='HEAD');
  if(!entry)throw Error('Captured page response unavailable');
  signal?.throwIfAborted();const exchange=await archive.exchange(entry);
  const data={url:exchange.url,response_url:exchange.url,status:entry.status,statusText:exchange.statusLine.replace(/^(?:HTTP\/[\d.]+\s+)?\d+\s*/,''),request_headers:exchange.requestHeaders||{},response_headers:exchange.responseHeaders};
  return {title:'HTTP Headers',summary:'',sections:[],presentation:{type:'canonical',plugin:'headers',title:'HTTP Headers',template,data,initialize:initializeHeaders}};
}
