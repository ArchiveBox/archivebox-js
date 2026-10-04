import { Downloader } from '../../vendor/archivewebpage/downloader';
import type { Capture, HookStatus, RecordRef } from './types';
import {digestMessage} from '@webrecorder/wabac/swlib';

export type PluginConfigurations = Record<string, Record<string, unknown>>;
export type PluginFile = {
  url:string;ts:number;mime:string;status:number;headers:Record<string,string>;
  metadata:Record<string,unknown>;hash:string;bytes:number;
} & ({path:string;record?:never}|{path?:never;record:{url:string;ts:number}});

/** Custom datapackage.archivebox metadata. Evidence references address original
 * WARC responses or native ZIP members by URI and Unix milliseconds from hook RPCs.
 * A null config means it was not saved (for example, an older recovered capture).
 * Response bodies and derived reports are deliberately excluded. This manifest
 * is the sole portable copy of capture status, configuration and hook diagnostics.
 */
export interface PluginManifest {
  format: 'archivebox-plugins';
  version: 1;
  captureId: string;
  state: Capture['state'];
  created: number;
  url: string;
  finalUrl?: string;
  title: string;
  error?: string;
  files?: PluginFile[];
  plugins: {
    id: string;
    config: Record<string, unknown> | null;
    hooks: {
      name: string;
      status: HookStatus;
      started: number;
      ready?: number;
      ended?: number;
      summary?: string;
      logs: string[];
      records: RecordRef[];
      data?: unknown;
    }[];
  }[];
}

export function createPluginManifest(capture: Capture, configurations?: PluginConfigurations): PluginManifest {
  return {
    format: 'archivebox-plugins', version: 1, captureId: capture.id, state: capture.state,
    created: capture.created, url: capture.url, finalUrl: capture.finalUrl, title: capture.title, error: capture.error,
    plugins: [...new Set([...capture.plugins, ...capture.hooks.map(hook => hook.plugin)])].map(id => ({
      id,
      // Snapshot JSON at export initialization, before the upstream stream runs.
      config: configurations?.[id] ? JSON.parse(JSON.stringify(configurations[id])) : null,
      hooks: capture.hooks.filter(hook => hook.plugin === id).map(hook => ({
        name: hook.hook, status: hook.status, started: hook.started,
        ...(hook.ready !== undefined ? {ready: hook.ready} : {}),
        ...(hook.ended !== undefined ? {ended: hook.ended} : {}),
        ...(hook.summary !== undefined ? {summary: hook.summary.slice(0, 1024)} : {}),
        ...(hook.data !== undefined ? {data:hook.data} : {}),
        logs: [...hook.logs],
        records: (hook.records || []).map(({url, ts, captureId}) => ({url, ts, captureId})),
      })),
    })),
  };
}

/** Route generated evidence into native members through upstream ZIP hashing.
 * HTTP WARC/CDX generation and datapackage-digest.json remain upstream-owned.
 */
export class PluginDownloader extends Downloader {
  private readonly pluginManifest: PluginManifest;
  constructor(options: ConstructorParameters<typeof Downloader>[0], capture: Capture, configurations?: PluginConfigurations) {
    super(options);
    this.pluginManifest = createPluginManifest(capture, configurations);
  }
  override shouldExportWARCResource(resource:any):boolean {
    return !(resource.url.startsWith('urn:')&&resource.extraOpts?.resource);
  }
  override async addExtraFiles(zip:any[],sizeCallback?:((size:number)=>void)|null) {
    const evidence:any[]=[],http=new Map<string,{url:string;ts:number}>();
    const digest=async(resource:any)=>resource.digest||await digestMessage(await this.evidenceBytes(resource),'sha-256');
    for await(const resource of this.iterResources(this.firstResources)){
      if(!this.shouldExportWARCResource(resource))evidence.push(resource);
      else if(/^https?:/.test(resource.url)){
        const hash=await digest(resource);if(!http.has(hash))http.set(hash,{url:resource.url,ts:resource.ts});
      }
    }
    const files:PluginFile[]=[],paths=new Map<string,string>(),used=new Set<string>();
    this.pluginManifest.files=files;
    const safe=(value:unknown)=>String(value||'evidence').replace(/[^a-zA-Z0-9_-]/g,'-');
    const identity=(resource:any)=>safe(resource.extraOpts?.plugin)+'/'+safe(resource.url.split(':')[1]);
    const counts=new Map<string,number>(),positions=new Map<string,number>();
    for(const resource of evidence)counts.set(identity(resource),(counts.get(identity(resource))||0)+1);
    evidence.sort((a,b)=>a.ts-b.ts||a.url.localeCompare(b.url));
    for(const resource of evidence){
      const hash=await digest(resource),reference=http.get(hash);
      const base={url:resource.url,ts:resource.ts,mime:resource.mime||'application/octet-stream',status:resource.status||200,
        headers:Object.fromEntries(new Headers(resource.respHeaders||{})),metadata:{...resource.extraOpts},hash,bytes:0};
      if(reference){
        // The response already owns these exact bytes. Retain the evidence's
        // identity and metadata, with a reference to that indexed HTTP body.
        const bytes=await this.evidenceBytes(resource);files.push({...base,bytes:bytes.length,record:reference});continue;
      }
      const existing=paths.get(hash);
      if(existing){files.push({...base,path:existing});continue;}
      const plugin=safe(resource.extraOpts?.plugin),kind=safe(resource.url.split(':')[1]),key=identity(resource);
      const index=(positions.get(key)||0)+1;positions.set(key,index);
      const mime=base.mime.split(';')[0]!.toLowerCase();
      const extension=({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','text/html':'html','application/json':'json','application/x-ndjson':'jsonl','text/plain':'txt','application/pdf':'pdf','application/zip':'zip'} as Record<string,string>)[mime]||'bin';
      let name=plugin==='screenshot'&&kind==='fullPage'?'screenshot':kind;
      if(plugin==='screenshot'&&kind==='fullPage'){name+='-'+String(resource.extraOpts?.screenshot?.tile?.index+1||index).padStart(2,'0');}
      else if((counts.get(key)||0)>1)name+='-'+String(index).padStart(4,'0');
      let path=`${plugin}/${name}.${extension}`,suffix=1;while(used.has(path))path=`${plugin}/${name}-${++suffix}.${extension}`;
      used.add(path);paths.set(hash,path);files.push({...base,path});
      this.addFile(zip,path,this.generateEvidence(resource),sizeCallback);
    }
  }
  private async evidenceBytes(resource:any):Promise<Uint8Array> {
    const payload=await this.db.loadPayload(resource,{});
    if(!payload)throw Error(`Missing original generated evidence: ${resource.url}`);
    return payload instanceof Uint8Array?payload:await payload.readFully();
  }
  private async *generateEvidence(resource:any){yield await this.evidenceBytes(resource);}
  override getDataPackageMetadata(): Record<string, unknown> {
    for(const file of this.pluginManifest.files||[])if(file.path){
      const stats=this.fileStats.find(stats=>stats.filename===file.path);
      if(!stats?.hash)throw Error(`Original evidence ZIP member was not hashed: ${file.path}`);
      const actual=`sha256:${stats.hash}`;
      if(file.hash.replace(/^sha-256:/,'sha256:')!==actual)throw Error(`Original evidence digest changed: ${file.url}`);
      file.hash=actual;file.bytes=stats.size;
    }
    return {archivebox: this.pluginManifest};
  }
}
