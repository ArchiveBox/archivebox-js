import type {ViewContext} from '@/src/archive/views';
import {summaryCard} from '@/src/archive/cards';
import template from '@/vendor/archivebox/plugins/parse_html_urls/full.html?raw';
export default async function({archive}:ViewContext){
 const entry=archive.artifact('index');if(!entry)throw Error('This capture has no text index');
 const {warcHeaders}=await archive.headers(entry),metadata=JSON.parse(warcHeaders['WARC-JSON-Metadata']||'{}');
 return summaryCard(template,'Search',[['Indexed documents',metadata.documents],...(metadata.types||[]).slice(0,4).map((type:string)=>['Content',type] as [string,string])]);
}
