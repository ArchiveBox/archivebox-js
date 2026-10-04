import type {ViewContext} from '@/src/archive/views';
import {summaryCard} from '@/src/archive/cards';
import template from '@/vendor/archivebox/plugins/redirects/full.html?raw';
export default async function(context:ViewContext){
 const {archive,capture,url}=context;
 const redirects=archive.entries.filter(entry=>entry.status>=300&&entry.status<400);
 const rows:[string,unknown][]=[['Original URL',capture?.url||url],['Final URL',url],['Recorded redirects',redirects.length]];
 return summaryCard(template,"Redirects",rows);
}
