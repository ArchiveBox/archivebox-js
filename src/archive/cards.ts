import type {ArchiveReader} from './reader';
import type {ViewContext} from './views';

/** Cards consume capture evidence independently of full-view derivations. */
export type CardModule={default:(context:ViewContext)=>Promise<string>};
const documents=new WeakMap<ArchiveReader,Promise<Document>>();
/** Shared, inert, read-only source for summaries. Never mutate this document. */
export function cardDOM(archive:ArchiveReader){
 let pending=documents.get(archive);
 if(!pending){pending=archive.sourceDOM();documents.set(archive,pending);pending.catch(()=>documents.delete(archive))}
 return pending;
}
export function cardDocument(template:string){
 const doc=new DOMParser().parseFromString(template.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''),'text/html');
 doc.querySelectorAll('header,nav').forEach(node=>node.remove());
 doc.documentElement.style.overflow='hidden';doc.body.style.overflow='hidden';
 return doc;
}
export const cardHTML=(doc:Document)=>'<!doctype html>'+doc.documentElement.outerHTML;
export function cardElement(doc:Document,tag:string,text:unknown='',className=''){
 const node=doc.createElement(tag);node.textContent=String(text??'');node.className=className;return node;
}
/** The original metadata templates' panel, heading and definition-list markup. */
export function summaryCard(template:string,title:string,rows:[string,unknown][]){
 const doc=cardDocument(template),content=doc.querySelector('main')||doc.body;
 content.replaceChildren();const panel=cardElement(doc,'section','','panel');
 panel.append(cardElement(doc,'h2',title));const list=doc.createElement('dl');
 for(const [name,value]of rows){if(value===undefined||value===null||value==='')continue;list.append(cardElement(doc,'dt',name),cardElement(doc,'dd',value))}
 panel.append(list);content.append(panel);return cardHTML(doc);
}
export function hookSummary(context:ViewContext,plugin:string){return context.capture?.hooks.filter(hook=>hook.plugin===plugin).map(hook=>hook.summary||'').join('; ')||''}
