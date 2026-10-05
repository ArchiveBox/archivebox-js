/** Portable ArchiveBox records. No browser, filesystem, or Django dependencies. */
export type ResourceRef = {url:string; ts:number; captureId:string; member?:string[]};
export type ArtifactStorage =
  | {type:'file'; path:string}
  | {type:'wacz-member'; path:string}
  | {type:'warc-response'; url:string; ts:number};

/** size/hash describe the logical payload, not additional allocated disk space.
 * Multiple artifacts may reference the same stored body. */
export type Artifact = {
  type:'Artifact'; id:string; snapshot_id:string; plugin:string; kind:string;
  created_at:string; mimetype:string; size:number; hash:string;
  storage:ArtifactStorage; headers:Record<string,string>; metadata:Record<string,unknown>;
};
export type OutputFile = {path:string; extension:string; mimetype:string; size:number};
export type SnapshotRecord = {
  type:'Snapshot'; id:string; url:string; title:string; depth:number;
  created_at:string; status:'sealed';
  config:Record<string,unknown>; plugin_config?:Record<string,Record<string,unknown>>;
  plugins:string[]; capture_state:'complete'|'partial'|'failed'; final_url?:string; error?:string;
};
export type ArchiveResultRecord = {
  type:'ArchiveResult'; id:string; snapshot_id:string; plugin:string; hook_name:string;
  status:'succeeded'|'noresults'|'skipped'|'failed'; output_str:string;
  start_ts:string; end_ts:string; output_files:OutputFile[];
  output_json:{
    runtime:'browser'; hook_filename:string; ready_ts?:string; termination?:'killed';
    logs:string[]; records:ResourceRef[]; data?:unknown;
  };
};
export type IndexRecord = SnapshotRecord | ArchiveResultRecord;
export const interchange = {format:'archivebox',version:2,index:'index.jsonl',artifacts:'artifacts.jsonl'} as const;

/** Same export policy as archivebox.config.common.redact_sensitive_config. */
export function redactConfig(config:Record<string,unknown>,sensitiveKeys:Iterable<string>=[]):Record<string,unknown> {
  const sensitive=new Set(sensitiveKeys);
  return Object.fromEntries(Object.entries(config).map(([key,value])=>[key,
    value!==null&&value!==''&&(sensitive.has(key)||/TOKEN|SECRET|API_KEY|APIKEY|PASSWORD/i.test(key))?'********':value]));
}

export function jsonl(records:Iterable<unknown>):string {
  return [...records].map(record=>JSON.stringify(record)+'\n').join('');
}
export function parseJSONL<T>(text:string,filename:string):T[] {
  return text.split('\n').flatMap((line,index)=>{
    if(!line.trim())return [];
    try{return [JSON.parse(line) as T]}catch{throw Error(`Invalid JSON in ${filename}:${index+1}`)}
  });
}
export function validatePath(path:string):void {
  if(typeof path!=='string'||!path||/[\\\u0000]/.test(path)||path.includes(':')||path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Invalid artifact path');
}
export function validateArtifact(artifact:Artifact,snapshotId?:string):void {
  if(artifact.type!=='Artifact'||typeof artifact.id!=='string'||!artifact.id.startsWith('urn:')||!artifact.snapshot_id||
    (snapshotId&&artifact.snapshot_id!==snapshotId)||!Number.isFinite(Date.parse(artifact.created_at))||
    !/^[a-zA-Z0-9_-]+$/.test(artifact.plugin)||!Number.isSafeInteger(artifact.size)||artifact.size<0||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.hash))throw Error('Invalid artifact metadata');
  const storage=artifact.storage;
  if(storage?.type==='file'||storage?.type==='wacz-member')validatePath(storage.path);
  else if(storage?.type==='warc-response'){
    if(!/^https?:\/\//.test(storage.url)||!Number.isSafeInteger(storage.ts))throw Error('Invalid archived response reference');
  }else throw Error('Unknown artifact storage type');
}
