import type {ViewContext} from '@/src/archive/views';
import {cardDOM,summaryCard} from '@/src/archive/cards';
import template from '@/vendor/archivebox/plugins/parse_dom_outlinks/full.html?raw';
export default async function({archive,url}:ViewContext){const doc=await cardDOM(archive),links=doc.querySelectorAll('a[href]'),rows:[string,unknown][]=[['Links',links.length]];for(const link of [...links].slice(0,6)){try{rows.push([link.textContent?.trim()||'URL',new URL(link.getAttribute('href')!,url).href])}catch{}}return summaryCard(template,'Discovered URLs',rows)}
