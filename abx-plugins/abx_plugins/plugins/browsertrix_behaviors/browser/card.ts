import type {ViewContext} from '@/src/archive/views';
import {summaryCard} from '@/src/archive/cards';
import template from '@/vendor/archivebox/plugins/parse_html_urls/full.html?raw';
export default async function(context:ViewContext){
 const {archive}=context;
 const entry=archive.artifact('browsertrix_behaviors'),data=entry?await archive.json(entry):{};
 const rows:[string,unknown][]=[['Behavior',data.behavior],['Enabled',data.behaviors?.join(', ')],['Steps',data.steps],['Activity',Array.isArray(data.logs)?data.logs.slice(0,2).map((line:any)=>typeof line==='string'?line:JSON.stringify(line)).join('\n'):'']];
 return summaryCard(template,"Browser Behaviors",rows);
}
