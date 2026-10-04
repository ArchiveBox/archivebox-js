import { EmbeddedOutput } from '../src/ui/EmbeddedOutput';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Archive, FileUp } from 'lucide-react';
import { ArchiveReader } from '../src/archive/reader';
import { captureInfo } from '../src/archive/capture-info';
import { SnapshotDetail } from '../src/ui/SnapshotDetail';
import type { Capture } from '../src/capture/types';
import {printSnapshot} from './print';
import replayWorkerURL from './sw.ts?worker&url';
import '../entrypoints/studio/style.css';

async function startReplay() {
  const started=performance.now();
  // The content-hashed worker URL identifies this exact build. register()
  // installs a changed URL before resolving, without the browser's delayed
  // second update() check on every warm navigation.
  const workerURL=new URL(replayWorkerURL,location.href).href;
  const existing=await navigator.serviceWorker.getRegistration('./');
  const registration=existing?.active?.scriptURL===workerURL&&!existing.installing&&!existing.waiting
    ?existing:await navigator.serviceWorker.register(workerURL,{type:'module',scope:'./'});
  // Even skipWaiting cannot activate while the old worker has pending events.
  // Older replay tabs must release their live archived frames when a new build
  // installs; otherwise a long-lived document request can stall every new tab.
  let reloading=false;
  const watchUpdate=(worker:ServiceWorker|null)=>{
    if(!worker||worker.scriptURL===workerURL)return;
    const changed=()=>{
      if(worker.state==='installed'&&!reloading){reloading=true;location.reload()}
      if(['installed','activated','redundant'].includes(worker.state))worker.removeEventListener('statechange',changed);
    };
    worker.addEventListener('statechange',changed);changed();
  };
  registration.addEventListener('updatefound',()=>watchUpdate(registration.installing));
  watchUpdate(registration.installing||registration.waiting);
  // register() may resolve with the previous active worker while an update is
  // still installing. Do not send a new archive to that retiring worker.
  const replacement = registration.installing || registration.waiting;
  if (replacement && replacement.state !== 'activated') await new Promise<void>((resolve,reject)=>{
    const changed=()=>{
      if(replacement.state==='activated'){replacement.removeEventListener('statechange',changed);resolve()}
      else if(replacement.state==='redundant'){replacement.removeEventListener('statechange',changed);reject(Error('Replay service worker update failed'))}
    };
    replacement.addEventListener('statechange',changed);changed();
  });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));
  performance.measure('archivebox:replay:startup',{start:started});
}
const ready = startReplay();
function App() {
  const [archive,setArchive]=React.useState<ArchiveReader>();
  const [capture,setCapture]=React.useState<Capture>();
  const [error,setError]=React.useState('');
  const [loading,setLoading]=React.useState(false);
  const [source,setSource]=React.useState(new URLSearchParams(location.search).get('source')||'');
  const input=React.useRef<HTMLInputElement>(null);
  async function open(url:string) {
    setLoading(true);setError('');setArchive(undefined);setCapture(undefined);
    try {await ready;const reader=await ArchiveReader.fromURL(url);setArchive(reader);const info=captureInfo(reader,new URL(url,location.href).pathname.split('/').at(-1));setCapture(info);document.title=`${info.title} · ArchiveBox`;
      const address=new URL(location.href);address.searchParams.set('source',new URL(url,location.href).href);history.replaceState(null,'',address);
    } catch(reason){setError(String(reason));}finally{setLoading(false);}
  }
  React.useEffect(()=>{if(source)void open(source);else void ready.catch(reason=>setError(String(reason)));},[]);
  async function importFile(file:File) {
    setLoading(true);setError('');try{await ready;const id=crypto.randomUUID();const root=await navigator.storage.getDirectory();const target=await root.getFileHandle(`${id}.wacz`,{create:true});const writer=await target.createWritable();await file.stream().pipeTo(writer);
      const reader=await ArchiveReader.from(await target.getFile(),id);setArchive(reader);setCapture(captureInfo(reader,file.name));setSource('');
    }catch(reason){setError(String(reason));}finally{setLoading(false);}
  }
  return <div className="web-player">{!archive&&<header className="player-masthead"><div className="brand"><Archive size={27}/><div>ArchiveBox<span>SNAPSHOT DETAIL</span></div></div><div><button onClick={()=>input.current?.click()}><FileUp size={16}/> Open WACZ</button></div><input ref={input} hidden type="file" accept=".wacz" onChange={event=>{const file=event.target.files?.[0];if(file)void importFile(file);event.target.value='';}}/></header>}
    <main className="player-workspace">{capture&&<header className="topbar"><div><span className="eyebrow">ARCHIVED SNAPSHOT</span><h1>{capture.title}</h1><p className="source-url">{capture.finalUrl||capture.url}</p></div><span className={`badge ${capture.state}`}>{capture.state}</span></header>}
      {!archive&&!loading&&<section className="capture-card"><h1>Open an archived snapshot</h1><form className="record-search" onSubmit={event=>{event.preventDefault();void open(source);}}><input aria-label="WACZ URL" type="url" required placeholder="https://…/capture.wacz" value={source} onChange={event=>setSource(event.target.value)}/><button type="submit">Open archive</button></form></section>}
      {error&&<p className="error" role="alert">{error}</p>}{loading&&<p role="status" className="loading">Opening WACZ and reading its index…</p>}
      {archive&&capture&&<SnapshotDetail key={capture.id} archive={archive} capture={capture} onIndex={()=>{setArchive(undefined);setCapture(undefined);history.replaceState(null,'',location.pathname)}} onDownload={async()=>{const a=document.createElement('a');let blobURL='';if(archive.sourceUrl)a.href=archive.sourceUrl;else{const root=await navigator.storage.getDirectory();const handle=await root.getFileHandle(capture.id+'.wacz');blobURL=URL.createObjectURL(await handle.getFile());a.href=blobURL;}a.download=capture.file||'capture.wacz';a.click();if(blobURL)setTimeout(()=>URL.revokeObjectURL(blobURL),60000)}}/>}
    </main></div>;
}
const root=createRoot(document.getElementById('root')!);
void ready.then(()=>new URLSearchParams(location.search).has('print')?printSnapshot():root.render(new URLSearchParams(location.search).has('embed')?<EmbeddedOutput/>:<App/>))
  .catch(error=>root.render(<p className="error" role="alert">{String(error)}</p>));
