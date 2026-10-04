import type {ViewContext} from '@/src/archive/views';
import {summaryCard} from '@/src/archive/cards';
import template from '@/vendor/archivebox/plugins/headers/full.html?raw';
export default async function(context:ViewContext){
 const {archive,url}=context;
 const entry=archive.find(url),record=entry?await archive.headers(entry):undefined;
 const rows:[string,unknown][]=[['Status',entry?.status],...Object.entries(record?.headers||{}).slice(0,7)];
 return summaryCard(template,"HTTP Headers",rows);
}
