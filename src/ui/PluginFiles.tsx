import React from 'react';
import type { ArchiveEntry, ArchiveReader } from '../archive/reader';
import type { Capture } from '../capture/types';
import { pluginFiles, originalFilename } from '../archive/plugin-files';
import { recordURL } from '../archive/replay';
import { pluginName } from './presentation';
import {views,deriveView} from '../archive/views';

export function PluginFiles({archive,capture,name}:{archive:ArchiveReader;capture:Capture;name:string}){
  const [entries,setEntries]=React.useState<ArchiveEntry[]>();
  const [error,setError]=React.useState('');
  const [derived,setDerived]=React.useState('');
  React.useEffect(()=>{let current=true,objectURL='';const controller=new AbortController();setEntries(undefined);setError('');setDerived('');
    void pluginFiles(archive,capture,name).then(files=>{if(current)setEntries(files)}).catch(reason=>{if(current)setError(String(reason))});
    if(name==='singlefile')void deriveView(name,{archive,capture,url:capture.finalUrl||capture.url,signal:controller.signal}).then(view=>{
      if(!current)return;const document=view.sections.find(section=>section.type==='html');if(document?.type!=='html')throw Error('SingleFile did not return an HTML document');
      objectURL=URL.createObjectURL(new Blob([document.html],{type:'text/html;charset=utf-8'}));setDerived(objectURL);
    }).catch(reason=>{if(current)setError(String(reason))});
    return()=>{current=false;controller.abort();if(objectURL)URL.revokeObjectURL(objectURL)};
  },[archive,capture,name]);
  return <section className="plugin-files view-section"><header><h2>{pluginName(name)}</h2>{views[name]&&<a href={`#view=${name}`}>Open output</a>}</header>
    {error?<p role="alert">{error}</p>:!entries?<p>Loading files…</p>:<div className="table-scroll"><table><thead><tr><th>File</th><th>Type</th><th>Captured</th><th/></tr></thead><tbody>{entries.map(entry=>{
      const http=/^https?:/.test(entry.url),filename=originalFilename(entry);
      const href=http?`#view=responses&request=${encodeURIComponent(entry.url)}&ts=${entry.ts}`:recordURL(archive,entry);
      return <tr key={`${entry.url} ${entry.ts}`}><td><a href={href} target={http?undefined:'_blank'} rel="noopener" title={entry.url}>{filename}</a></td><td>{entry.mime}</td><td>{new Date(entry.ts).toLocaleString()}</td><td><a href={recordURL(archive,entry)} download={filename} onClick={async event=>{
        event.preventDefault();try{const record=await archive.read(entry),url=URL.createObjectURL(new Blob([record.body as BlobPart],{type:entry.mime}));const link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000)}catch(reason){setError(String(reason))}
      }} aria-label={`Download ${filename}`}>⤓</a></td></tr>;
    })}{derived&&<tr><td><a href={derived} target="_blank" rel="noopener">singlefile.html</a></td><td>text/html</td><td>—</td><td><a href={derived} download="singlefile.html" aria-label="Download singlefile.html">⤓</a></td></tr>}</tbody></table>{entries.length===0&&!derived&&<p>{name==='singlefile'?'Rendering SingleFile…':'No saved files'}</p>}</div>}
  </section>;
}
