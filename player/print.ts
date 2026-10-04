import {ArchiveReader} from '../src/archive/reader';
import {printableHTML} from '../src/archive/print';

/** Disposable native print document; loads originals through the same player
 * service worker and strips all archived scripts before rendering. */
export async function printSnapshot(){
 try{
  const source=new URLSearchParams(location.search).get('source');if(!source)throw Error('Missing WACZ URL');
  const archive=await ArchiveReader.fromURL(source),url=archive.manifest.archivebox?.finalUrl||archive.manifest.archivebox?.url||archive.pages[0]?.url;
  const parsed=new DOMParser().parseFromString(await printableHTML(archive,url,new URLSearchParams(location.search).get('print')==='accessibility'),'text/html');
  for(const [target,node]of [[document.documentElement,parsed.documentElement],[document.body,parsed.body]])for(const {name,value}of node!.attributes)target!.setAttribute(name,value);
  document.head.replaceChildren(...[...parsed.head.childNodes].map(node=>document.importNode(node,true)));
  document.body.replaceChildren(...[...parsed.body.childNodes].map(node=>document.importNode(node,true)));
  await Promise.all([...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(link=>link.sheet?Promise.resolve():new Promise<void>(resolve=>{link.addEventListener('load',()=>resolve(),{once:true});link.addEventListener('error',()=>resolve(),{once:true})})));
  for(const image of document.images)image.loading='eager';
  await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));await document.fonts.ready;
  document.documentElement.dataset.pdfReady='true';
 }catch(error){document.documentElement.dataset.pdfError=String(error)}
}
