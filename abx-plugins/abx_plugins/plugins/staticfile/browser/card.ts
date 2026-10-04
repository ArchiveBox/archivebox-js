import type {ViewContext} from '@/src/archive/views';
import {summaryCard} from '@/src/archive/cards';
import template from '@/vendor/archivebox/plugins/headers/full.html?raw';
import {originalFile} from './source';
export default async function(context:ViewContext){
 const source=await originalFile(context);
 const rows:[string,unknown][]=[['URL',source?.url],['Type',source?.entry.mime],['Status',source?.entry.status]];
 return summaryCard(template,"Original file",rows);
}
