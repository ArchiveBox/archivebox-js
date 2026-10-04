import type {ViewContext} from '@/src/archive/views';
import {summaryCard,cardDOM} from '@/src/archive/cards';
import template from '@/vendor/archivebox/plugins/accessibility/full.html?raw';
export default async function(context:ViewContext){
 const {archive,url}=context,source=await cardDOM(archive);
 const rows:[string,unknown][]=[['Page',source.title||url],['Headings',source.querySelectorAll('h1,h2,h3,h4,h5,h6').length],['Controls',source.querySelectorAll('input,button,select,textarea').length]];
 return summaryCard(template,"Page semantics",rows);
}
