import type {ViewContext} from '@/src/archive/views';
import {summaryCard} from '@/src/archive/cards';
import template from '@/vendor/archivebox/plugins/dns/full.html?raw';
export default async function(context:ViewContext){
 const {archive}=context;
 const hosts=[...new Set(archive.entries.filter(entry=>/^https?:/.test(entry.url)).map(entry=>new URL(entry.url).hostname))];
 const rows:[string,unknown][]=[['Hosts',hosts.length]];
 for(const host of hosts.slice(0,5)){const entry=archive.entries.find(entry=>entry.url.startsWith('https://'+host+'/')||entry.url.startsWith('http://'+host+'/'))!;const record=await archive.headers(entry),network=JSON.parse(record.warcHeaders['WARC-JSON-Metadata']||'{}').network;rows.push([host,network?.remoteIPAddress||entry.url])}
 return summaryCard(template,"DNS",rows);
}
