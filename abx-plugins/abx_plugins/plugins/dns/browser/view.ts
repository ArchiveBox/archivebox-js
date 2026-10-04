import type {ViewContext,ViewResult} from '@/src/archive/views';
import template from '../../../../../vendor/archivebox/plugins/dns/full.html?raw';
import {initializeDNS} from '@/src/ui/dns-template';
export default async function({archive,signal}:ViewContext):Promise<ViewResult>{
  const records:Record<string,any>[]=[],seen=new Set<string>();
  for(const entry of archive.entries.filter(entry=>/^https?:/.test(entry.url)).sort((a,b)=>a.ts-b.ts)){
    signal?.throwIfAborted();const record=await archive.headers(entry),metadata=JSON.parse(record.warcHeaders['WARC-JSON-Metadata']||'{}'),network=metadata.network;
    if(!network?.remoteIPAddress)continue;
    const hostname=new URL(entry.url).hostname,ip=network.remoteIPAddress,key=hostname+':'+ip;
    if(hostname===ip||seen.has(key))continue;seen.add(key);
    records.push({hostname,ip,type:ip.includes(':')?'AAAA':'A',port:network.remotePort,url:entry.url,protocol:network.protocol,source:'cdp',ts:new Date(entry.ts).toISOString()});
  }
  const failureEntry=archive.artifact('dns-failures');
  for(const failure of failureEntry?await archive.json<{url:string;error:string;timestamp:number}[]>(failureEntry):[]){
    const hostname=new URL(failure.url).hostname,key=hostname+':NXDOMAIN';if(seen.has(key))continue;seen.add(key);
    records.push({hostname,url:failure.url,type:'NXDOMAIN',error:failure.error,timestamp:failure.timestamp,source:'cdp'});
  }
  return {title:'DNS',summary:'',sections:[],presentation:{type:'canonical',plugin:'dns',title:'DNS',template,data:records,format:'jsonl',initialize:initializeDNS}};
}
