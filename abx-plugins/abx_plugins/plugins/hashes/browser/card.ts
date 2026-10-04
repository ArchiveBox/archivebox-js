import type {ViewContext} from '@/src/archive/views';
import {summaryCard} from '@/src/archive/cards';
import template from '@/vendor/archivebox/plugins/hashes/full.html?raw';
export default async function(context:ViewContext){
 const {archive}=context;
 const rows:[string,unknown][]=[['Resources',archive.entries.length],...archive.entries.slice(0,5).map(entry=>[entry.url.split('/').at(-1)||entry.url,entry.digest] as [string,string])];
 return summaryCard(template,"Hashes",rows);
}
