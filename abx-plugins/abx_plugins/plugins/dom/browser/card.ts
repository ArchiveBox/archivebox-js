import type {ViewContext} from '@/src/archive/views';
import type {ArchiveReader} from '@/src/archive/reader';
import {replayHTML} from '@/src/archive/replay';
import {capturedDOM} from './document';
const previews=new WeakMap<ArchiveReader,Promise<string>>();
export default function({archive,url}:ViewContext){
 let preview=previews.get(archive);
 if(!preview){preview=(async()=>{const captured=await capturedDOM(archive);if(captured)return replayHTML(archive,captured.documentElement.outerHTML,url);const entry=archive.documentEntry();if(!entry)throw Error('No archived HTML');return replayHTML(archive,await archive.text(entry),url)})();previews.set(archive,preview);preview.catch(()=>previews.delete(archive))}
 return preview;
}
