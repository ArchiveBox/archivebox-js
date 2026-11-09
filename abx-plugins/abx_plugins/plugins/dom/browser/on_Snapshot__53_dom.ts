import type {HookContext} from '@/src/capture/types';

/** Observe the settled live page after scrolling, Browsertrix and screenshots.
 * Generated DOM belongs to this plugin; original HTTP bytes remain in WARC. */
export default async function(ctx:HookContext){
 ctx.signal.throwIfAborted();
 const captured=await ctx.page.evaluate<{html:string;sourceUrl:string;baseURI:string}|null>(`(() => {
  if(!/^https?:$/.test(location.protocol)||!['text/html','application/xhtml+xml'].includes(document.contentType))return null;
  // An inert owner document avoids rerunning live custom-element constructors.
  // Read computed dimensions from the originals, but write only to the clone.
  const clone=document.implementation.createHTMLDocument('').importNode(document.documentElement,true);
  const originals=document.querySelectorAll('img,svg');
  clone.querySelectorAll('img,svg').forEach((image,index)=>{
   const style=getComputedStyle(originals[index]);
   if(parseFloat(style.width)>0&&parseFloat(style.height)>0){
    image.style.width=style.width;image.style.height=style.height;
    if(image.tagName.toLowerCase()==='svg'){image.setAttribute('width',style.width);image.setAttribute('height',style.height)}
   }
  });
  // Keep native serialized form attributes, never password/file input values.
  clone.querySelectorAll('input[type="password"],input[type="file"]').forEach(input=>input.removeAttribute('value'));
  return {html:(document.doctype?new XMLSerializer().serializeToString(document.doctype):'')+clone.outerHTML,sourceUrl:location.href,baseURI:document.baseURI};
 })()`);
 if(!captured||captured.html.length<=100)return {status:'noresults' as const,records:[],summary:'No rendered HTML document'};
 ctx.signal.throwIfAborted();
 const record=await ctx.archive.addResource({kind:'dom',mime:'text/html',body:captured.html,sourceUrl:captured.sourceUrl,metadata:{baseURI:captured.baseURI}});
 return {records:[record],summary:`Rendered DOM saved (${new TextEncoder().encode(captured.html).length} bytes)`};
}
