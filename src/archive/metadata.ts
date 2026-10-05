import {interchange,parseJSONL,validateArtifact,type Artifact,type ArchiveResultRecord,type IndexRecord,type ResourceRef} from '../../abx-plugins/shared/records';
import type {Capture,HookStatus} from '../capture/types';

export type PluginFile = {
  url:string;ts:number;mime:string;status:number;headers:Record<string,string>;
  metadata:Record<string,unknown>;hash:string;bytes:number;
} & ({path:string;record?:never}|{path?:never;record:{url:string;ts:number}});

/** Runtime projection for existing plugin views; never serialized into WACZ. */
export type CaptureMetadata = {
  captureId:string; state:Capture['state']; created:number; url:string; finalUrl?:string;
  title:string; error?:string; tags?:string; files:PluginFile[];
  plugins:{id:string;config:Record<string,unknown>|null;hooks:{
    id?:string;name:string;status:HookStatus;started:number;ended?:number;ready?:number;
    summary?:string;logs:string[];records:ResourceRef[];data?:unknown;
  }[]}[];
};

export function artifactFile(artifact:Artifact):PluginFile {
  validateArtifact(artifact);
  const base={url:artifact.id,ts:Date.parse(artifact.created_at),mime:artifact.mimetype,status:200,
    headers:artifact.headers,metadata:artifact.metadata,hash:artifact.hash,bytes:artifact.size};
  if(artifact.storage.type==='wacz-member')return {...base,path:artifact.storage.path};
  if(artifact.storage.type==='warc-response')return {...base,record:{url:artifact.storage.url,ts:artifact.storage.ts}};
  throw Error('A WACZ artifact cannot refer to a host filesystem file');
}

export async function readCaptureMetadata(manifest:any,read:(path:string)=>Promise<Uint8Array>):Promise<CaptureMetadata|undefined> {
  const descriptor=manifest.archivebox;
  if(!descriptor)return undefined;
  // Existing immutable experimental captures predate the interchange records.
  // One read boundary keeps those captures usable; all writes use JSONL only.
  if(descriptor.format==='archivebox-plugins'&&descriptor.version===1)return {...descriptor,files:descriptor.files||[]};
  if(descriptor.format!==interchange.format||descriptor.version!==interchange.version||
    descriptor.index!==interchange.index||descriptor.artifacts!==interchange.artifacts)throw Error('Unsupported ArchiveBox interchange version');
  const decoder=new TextDecoder();
  const [indexBytes,artifactBytes]=await Promise.all([read(interchange.index),read(interchange.artifacts)]);
  const records=parseJSONL<IndexRecord>(decoder.decode(indexBytes),interchange.index);
  const artifacts=parseJSONL<Artifact>(decoder.decode(artifactBytes),interchange.artifacts);
  const snapshots=records.filter(record=>record.type==='Snapshot');
  if(snapshots.length!==1)throw Error('Expected one Snapshot in capture index.jsonl');
  const snapshot=snapshots[0]!;
  const results=records.filter((record):record is ArchiveResultRecord=>record.type==='ArchiveResult');
  const identities=new Set<string>();
  for(const record of records){
    if(!record.id||identities.has(record.id))throw Error('Duplicate or missing ArchiveBox record ID');
    identities.add(record.id);
  }
  for(const artifact of artifacts)validateArtifact(artifact,snapshot.id);
  for(const result of results){
    if(result.snapshot_id!==snapshot.id||!['succeeded','failed','skipped','noresults'].includes(result.status)||
      !Number.isFinite(Date.parse(result.start_ts))||!Number.isFinite(Date.parse(result.end_ts)))throw Error('Invalid ArchiveResult metadata');
    for(const ref of result.output_json.records){
      if(ref.captureId!==snapshot.id||!Number.isSafeInteger(ref.ts))throw Error('ArchiveResult references a different capture');
    }
  }
  return {captureId:snapshot.id,state:snapshot.capture_state,created:Date.parse(snapshot.created_at),url:snapshot.url,
    finalUrl:snapshot.final_url,title:snapshot.title,error:snapshot.error,files:artifacts.map(artifactFile),
    plugins:snapshot.plugins.map(id=>({id,config:{...snapshot.config,...snapshot.plugin_config?.[id]},hooks:results.filter(result=>result.plugin===id).map(result=>({
      id:result.id,name:result.output_json.hook_filename,status:result.output_json.termination||result.status,
      started:Date.parse(result.start_ts),ended:Date.parse(result.end_ts),
      ...(result.output_json.ready_ts?{ready:Date.parse(result.output_json.ready_ts)}:{}),
      summary:result.output_str,logs:result.output_json.logs,records:result.output_json.records,data:result.output_json.data,
    }))})),
  };
}
