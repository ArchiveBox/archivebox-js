import type {ViewContext} from '@/src/archive/views';
import {summaryCard} from '@/src/archive/cards';
import template from '@/vendor/archivebox/plugins/parse_jsonl_urls/full.html?raw';
export default async function(context:ViewContext){
 const {capture,url}=context;
 const refs=capture?.hooks.filter(hook=>hook.plugin==='parse_jsonl_urls').flatMap(hook=>hook.records||[])||[];const rows:[string,unknown][]=[['Page',url],...refs.slice(0,6).map(ref=>['Source',ref.url] as [string,string])];
 return summaryCard(template,"Discovered URLs",rows);
}
