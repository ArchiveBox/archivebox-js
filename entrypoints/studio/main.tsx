import React from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDownToLine, ChevronRight, FileUp, Globe, Pause, Play, Settings2, Square, Trash2 } from 'lucide-react';
import { CaptureEngine, recoverCapture } from '@/src/capture/engine';
import { hooks, plugins, selectPlugins } from '@/src/capture/registry';
import { listCaptures, readArchive, saveCapture, writeArchive, deleteCapture } from '@/src/archive/storage';
import { ArchiveReader } from '@/src/archive/reader';
import { SnapshotDetail, CaptureActivity, formatSize } from '@/src/ui/SnapshotDetail';
import { captureInfo } from '@/src/archive/capture-info';
import type { Capture } from '@/src/capture/types';
import './style.css';
import { EmbeddedOutput } from '@/src/ui/EmbeddedOutput';

function App() {
  const [tabs,setTabs]=React.useState<chrome.tabs.Tab[]>([]);
  const [tabId,setTabId]=React.useState(Number(new URLSearchParams(location.search).get('tab'))||0);
  const [url,setUrl]=React.useState('');
  const [captures,setCaptures]=React.useState<Capture[]>([]);
  const [selected,setSelected]=React.useState(Object.keys(plugins).filter(name=>plugins[name]!.default_enabled!==false));
  const [settings,setSettings]=React.useState<Record<string,Record<string,unknown>>>({});
  const [engine,setEngine]=React.useState<CaptureEngine>();
  const [active,setActive]=React.useState<Capture>();
  const [archive,setArchive]=React.useState<ArchiveReader>();
  const [error,setError]=React.useState('');
  const [busy,setBusy]=React.useState(false);
  const [running,setRunning]=React.useState(false);
  const [showSettings,setShowSettings]=React.useState(false);
  const [paused,setPaused]=React.useState(false);
  const importInput=React.useRef<HTMLInputElement>(null);
  async function refresh(){setCaptures(await listCaptures());setTabs((await chrome.tabs.query({})).filter(tab=>/^https?:/.test(tab.url||'')));}
  React.useEffect(()=>{void refresh();void chrome.storage.local.get(['wacz-selected','wacz-settings']).then(data=>{if(Array.isArray(data['wacz-selected']))setSelected((data['wacz-selected'] as string[]).filter(n=>plugins[n]));if(data['wacz-settings'])setSettings(data['wacz-settings'] as typeof settings);});},[]);
  async function open(capture:Capture){setBusy(true);setError('');setActive(capture);setArchive(undefined);try{if(capture.file)setArchive(await ArchiveReader.from(await readArchive(capture.id),capture.id));}catch(e){setError(String(e))}finally{setBusy(false)}}
  async function start(){setError('');setShowSettings(false);setRunning(true);setArchive(undefined);
    try{
      let targetId=tabId;let requestedUrl='';
      if(url.trim()){const parsed=new URL(url.trim());if(!/^https?:$/.test(parsed.protocol))throw Error('Use an HTTP or HTTPS URL');requestedUrl=parsed.href;const tab=await chrome.tabs.create({url:'about:blank',active:false});targetId=tab.id!;setTabId(targetId);}
      if(!targetId)throw Error('Choose a browser tab or enter a URL');
      const target=await chrome.tabs.get(targetId);requestedUrl=requestedUrl||target.url||'';if(!/^https?:/.test(requestedUrl))throw Error('Choose an HTTP or HTTPS page');
      await chrome.storage.local.set({'wacz-selected':selected,'wacz-settings':settings});
      const instance=new CaptureEngine(targetId,requestedUrl,selected,capture=>setActive(structuredClone(capture)),settings);setEngine(instance);
      const capture=await instance.run();await refresh();await open(capture);
    }catch(e){setError(String(e))}finally{setRunning(false);setPaused(false)}
  }
  async function download(){if(!active?.file)return;const file=await readArchive(active.id);saveBlob(file,active.file)}
  function saveBlob(blob:Blob,name:string){const objectURL=URL.createObjectURL(blob);const a=document.createElement('a');a.href=objectURL;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(objectURL),60000)}
  async function importFile(file:File){setBusy(true);setError('');const importId=crypto.randomUUID();let imported=false;try{
    const packageReader=await ArchiveReader.from(file);const checks=await packageReader.verifyPackage();if(checks.some(c=>!c.valid))throw Error('Archive failed integrity verification');
    await writeArchive(importId,new Response(file));
    const reader=await ArchiveReader.from(await readArchive(importId),importId);
    const capture = captureInfo(reader, `${importId}.wacz`);
    await saveCapture(capture);imported=true;await refresh();await open(capture);
  }catch(e){setError(String(e))}finally{if(!imported)await deleteCapture(importId).catch(()=>{});setBusy(false)}}
  const planned=hooks.filter(h=>selectPlugins(['chrome',...selected]).includes(h.plugin));
  return <div className={`app-shell ${archive ? 'has-snapshot' : ''}`}>
    <aside className="sidebar"><div className="brand"><img src="/archive.png" width="32" height="32" alt="Archive Icon"/><div>ArchiveBox<span>WACZ EXPERIMENT</span></div></div>
      <div className="sidebar-heading">Snapshots <span>{captures.length}</span></div>
      <button className="new-capture" onClick={()=>{if(!running){setActive(undefined);setArchive(undefined);}}}><span>+</span> New capture</button>
      <div className="capture-list">{captures.map(capture=><button className={`capture-item ${active?.id===capture.id?'selected':''}`} key={capture.id} disabled={running} onClick={()=>void open(capture)}><Globe size={16}/><div><strong>{capture.title||capture.url}</strong><small>{new Date(capture.created).toLocaleDateString()} · {formatSize(capture.size)} · {capture.state}</small></div><ChevronRight size={14}/></button>)}</div>
      <button className="sidebar-import" disabled={running} onClick={()=>importInput.current?.click()}><FileUp size={16}/> Import WACZ</button><input hidden ref={importInput} type="file" accept=".wacz" onChange={e=>{const file=e.target.files?.[0];if(file)void importFile(file);e.target.value=''}}/>
      <p className="sidebar-note">ArchiveBox WACZ</p>
    </aside>
    <main className="workspace">{!archive&&<header className="topbar"><div><span className="eyebrow">ArchiveBox</span><h1>{active?active.title:'Add URLs'}</h1>{active&&<p className="source-url">{active.url}</p>}</div><span className={`badge ${active?.state||''}`}>{running?'Capturing':active?.state||'Local storage'}</span></header>}
      {error&&<div role="alert" className="error">{error}</div>}
      {(!active||running)&&<section className="capture-card"><div className="capture-controls"><label>Browser tab<select aria-label="Browser tab" disabled={running} value={tabId} onChange={e=>setTabId(+e.target.value)}><option value={0}>Choose a tab…</option>{tabs.map(tab=><option key={tab.id} value={tab.id}>{tab.title||tab.url}</option>)}</select></label><span className="or">or</span><label>Open URL<input aria-label="Open URL" disabled={running} type="url" placeholder="https://example.com" value={url} onChange={e=>setUrl(e.target.value)}/></label></div>
        <div className="capture-actions"><button className="primary" disabled={running||busy} onClick={()=>void start()}><Play size={16}/> Capture tab</button><button className="subtle" disabled={running} onClick={()=>setShowSettings(!showSettings)}><Settings2 size={16}/> {selected.length} plugins</button><p>Reloads the selected tab with recording enabled.</p>{running&&<><button onClick={()=>{paused?engine?.runner.unpause():engine?.runner.pause();setPaused(!paused)}}>{paused?<Play size={15}/>:<Pause size={15}/>} {paused?'Resume':'Pause'}</button><button className="danger" onClick={()=>void engine?.runner.abort()}><Square size={14}/> Stop capture</button></>}</div>
      </section>}
      {showSettings&&!running&&<section className="plugin-settings"><div className="section-heading"><h2>Capture plugins</h2><span>{planned.length} numbered hooks</span></div><div className="plugin-grid">{Object.entries(plugins).map(([name,config])=><div className="plugin-option" key={name}><label><input type="checkbox" checked={selected.includes(name)} disabled={name==='chrome'} onChange={e=>setSelected(e.target.checked?[...selected,name]:selected.filter(n=>n!==name))}/><strong>{config.title}</strong><span>{hooks.some(h=>h.plugin===name)?config.category:'view'}</span></label><p>{config.description}</p>{selected.includes(name)&&hooks.some(h=>h.plugin===name)&&<label className="config-field"><span>Hook timeout (seconds)</span><input aria-label={name+' hook timeout'} type="number" min={1} max={3600} value={Number(settings[name]?.HOOK_TIMEOUT??config.timeout??60)} onChange={e=>setSettings({...settings,[name]:{...settings[name],HOOK_TIMEOUT:Number(e.target.value)}})}/></label>}{selected.includes(name)&&Object.entries(config.properties||{}).map(([key,property])=><label className="config-field" key={key}><span>{property.description||key}</span>{property.type==='boolean'?<input type="checkbox" checked={Boolean(settings[name]?.[key]??property.default)} onChange={e=>setSettings({...settings,[name]:{...settings[name],[key]:e.target.checked}})}/>:<input aria-label={key} type={property.type==='number'||property.type==='integer'?'number':'text'} min={property.minimum} max={property.maximum} value={String(settings[name]?.[key]??property.default??'')} onChange={e=>setSettings({...settings,[name]:{...settings[name],[key]:property.type==='number'||property.type==='integer'?Number(e.target.value):e.target.value}})}/>}</label>)}</div>)}</div></section>}
      {active&&<>
        {busy&&<p className="loading">Reading archived evidence…</p>}
        {!running&&!active.file&&<button disabled={busy} onClick={async()=>{setBusy(true);setError('');try{const recovered=await recoverCapture(active);await refresh();await open(recovered)}catch(e){setError(String(e))}finally{setBusy(false)}}}>Recover saved evidence</button>}
        {archive?<SnapshotDetail key={active.id} archive={archive} capture={active} captures={captures} onSelectCapture={open} onDownload={download} onIndex={()=>{setActive(undefined);setArchive(undefined)}}/>:<CaptureActivity capture={active}/>}
        <div className="archive-toolbar"><div><button onClick={()=>{setActive(undefined);setArchive(undefined)}}>← Snapshots</button><button onClick={()=>importInput.current?.click()}>Import WACZ</button>{active.file&&!archive&&<button title="Download archive" onClick={()=>void download()}><ArrowDownToLine size={15}/> Download WACZ</button>}<button className="icon-button" aria-label="Delete capture" disabled={running} onClick={async()=>{try{await deleteCapture(active.id);setActive(undefined);setArchive(undefined);await refresh()}catch(e){setError(String(e))}}}><Trash2 size={16}/></button></div></div>
      </>}

    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('embed')?<EmbeddedOutput/>:<App/>);
