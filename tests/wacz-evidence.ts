import {expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {WARCParser} from 'warcio';
import {readCaptureMetadata} from '../src/archive/metadata';

/** Read metadata through the same JSONL boundary as the player, retaining the
 * actual datapackage descriptor separately from the runtime projection. */
export async function readWaczPackage(zip:Record<string,Uint8Array>){
  const manifest=JSON.parse(new TextDecoder().decode(zip['datapackage.json']!));
  const metadata=await readCaptureMetadata(manifest,async name=>{
    if(!zip[name])throw Error(`Missing WACZ member: ${name}`);return zip[name]!;
  });
  return {...manifest,metadata};
}

/** Inspect real exported records, including payloads and recorded requests. */
export async function inspectWaczEvidence(filename:string){
  const canonicalDigest=(value:string|null|undefined)=>(value||'').replace(/^sha-/i,'sha').toLowerCase();
  const bodies=new Map<string,string>(),requests:{url:string;method:string;headers:Record<string,string>}[]=[];
  const httpBodies=new Map<string,number>();
  const originals=new Map<string,{url:string;date:string;digest:string}>(),references:{id:string;url:string;date:string;digest:string}[]=[];
  const zip=unzipSync(await readFile(filename)),manifest=await readWaczPackage(zip);
  const files=manifest.metadata?.files;
  let revisits=0;
  for(const [name,bytes]of Object.entries(zip)){
    if(!name.startsWith('archive/'))continue;
    for await(const record of new WARCParser([bytes])){
      const body=await record.readFully();
      if(files!==undefined&&record.warcType!=='warcinfo')expect(record.warcTargetURI,'New exports keep generated URN bytes outside WARC').toMatch(/^https?:/);
      if(record.warcType==='request')requests.push({url:record.warcTargetURI||'',method:record.httpHeaders?.statusline.split(' ')[0]||'',headers:Object.fromEntries(record.httpHeaders?.headers||[])});
      if(record.warcType==='revisit'){
        revisits++;expect(body.byteLength,'WARC revisits must reference the original payload').toBe(0);
        references.push({id:record.warcHeader('WARC-Refers-To')||'',url:record.warcRefersToTargetURI||'',date:record.warcRefersToDate||'',digest:canonicalDigest(record.warcPayloadDigest)});
      }
      if(['response','resource'].includes(record.warcType||''))originals.set(record.warcHeader('WARC-Record-ID')||'',{url:record.warcTargetURI||'',date:record.warcDate||'',digest:canonicalDigest(record.warcPayloadDigest)});
      if(record.warcType==='response'&&/^https?:/.test(record.warcTargetURI||''))httpBodies.set(createHash('sha256').update(body).digest('hex'),body.length);
      if(['response','resource'].includes(record.warcType||'')&&body.byteLength){
        const digest=createHash('sha256').update(body).digest('hex');
        expect(bodies.has(digest),`Repeated payload in WACZ: ${record.warcTargetURI}; original ${bodies.get(digest)}`).toBe(false);
        bodies.set(digest,record.warcTargetURI||'');
      }
    }
  }
  for(const {id,...reference}of references){expect(id,'Revisit must identify its original record').not.toBe('');expect(originals.get(id),`Revisit ${id} must refer to the literal original WARC URI, date and digest`).toEqual(reference);}
  const nativePaths=new Set<string>();
  if(files!==undefined){
    expect(Array.isArray(files)).toBe(true);
    const identities=new Set<string>();
    for(const file of files){
      expect(file.url).toMatch(/^urn:/);expect(file.status).toBe(200);expect(Number.isFinite(file.ts)).toBe(true);
      const identity=`${file.url} ${file.ts}`;expect(identities.has(identity),'Native evidence identity is indexed once').toBe(false);identities.add(identity);
      expect(file.metadata.resource).toBe(true);expect(file.metadata.plugin).toMatch(/^[a-zA-Z0-9_-]+$/);expect(file.metadata.captureId).toBe(manifest.metadata.captureId);expect(file.metadata.sourceUrl).toMatch(/^https?:/);
      expect(file.headers['content-type']).toBe(file.mime);expect(Number(file.headers['content-length'])).toBe(file.bytes);
      expect(Boolean(file.path)!==Boolean(file.record),'Native evidence has exactly one body reference').toBe(true);
      expect(file.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      if(file.record){
        expect(file.record.url).toMatch(/^https?:/);expect(Number.isFinite(file.record.ts)).toBe(true);
        expect(httpBodies.get(file.hash.slice(7)),'Native HTTP alias matches an actual original response payload').toBe(file.bytes);
      }else{
        expect(file.path).toMatch(/^[a-zA-Z0-9_-]+\/[^/]+$/);expect(file.path).not.toMatch(/^(responses|papersdl|pdf)\//);
        const bytes=zip[file.path];if(!bytes)throw Error(`Missing native member ${file.path}`);
        const hash=createHash('sha256').update(bytes).digest('hex');expect(file.hash).toBe('sha256:'+hash);expect(file.bytes).toBe(bytes.length);
        const packaged=manifest.resources.find((resource:any)=>resource.path===file.path);expect(packaged?.hash).toBe(file.hash);expect(packaged?.bytes).toBe(file.bytes);
        if(!nativePaths.has(file.path)){
          expect(bodies.has(hash),`Repeated raw payload across WARC/native members: ${file.path}; original ${bodies.get(hash)}`).toBe(false);
          bodies.set(hash,file.path);nativePaths.add(file.path);
        }
      }
    }
    const contractFiles=manifest.archivebox?['index.jsonl']:[];
    const nonCoreMembers=Object.keys(zip).filter(name=>!name.endsWith('/')&&!/^(archive|pages|indexes)\//.test(name)&&!['datapackage.json','datapackage-digest.json',...contractFiles].includes(name));
    expect(nonCoreMembers.sort(),'Every generated ZIP member has an original evidence reference').toEqual([...nativePaths].sort());
  }
  return {requests,revisits,payloads:bodies.size,nativeReferences:files?.length||0,nativeFiles:[...nativePaths]};
}

/** Resolve every CDX record through the production replay endpoint, including
 * revisits of POSTs and evidence resources; verify the indexed original bytes. */
export async function verifyReplayPayloads(page:Page,captureId:string,verifyHeaderBodies=false){
  const result=await page.evaluate(async({id,verifyHeaderBodies})=>{
    const index=await chrome.runtime.sendMessage({type:'inspect-wacz',id});
    if(!index?.ok)throw Error(index?.error||'Could not inspect WACZ');
    const failures:string[]=[];let headerBodies=0;
    for(const entry of index.entries){
      const response=await fetch(chrome.runtime.getURL(`plugin-record/${id}/${entry.ts}/${encodeURIComponent(entry.url)}`));
      if(!response.ok){failures.push(`${entry.url}: HTTP ${response.status}: ${await response.text()}`);continue;}
      const body=await response.arrayBuffer();
      const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',body)),byte=>byte.toString(16).padStart(2,'0')).join('');
      const expected=entry.digest.replace(/^sha-?256:/i,'').toLowerCase();
      if(actual!==expected)failures.push(`${entry.url}: ${actual} != ${expected}`);
      if(verifyHeaderBodies&&!entry.native&&entry.length<=64*1024){
        const metadata=await chrome.runtime.sendMessage({type:'wacz-record',id,url:entry.url,ts:entry.ts});
        if(!metadata.ok){failures.push(`${entry.url}: ${metadata.error}`);continue;}
        if(metadata.body){
          headerBodies++;
          const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(metadata.body))),byte=>byte.toString(16).padStart(2,'0')).join('');
          if(digest!==expected)failures.push(`${entry.url}: header-read body ${digest} != ${expected}`);
        }
      }
    }
    return {count:index.entries.length,failures,headerBodies};
  },{id:captureId,verifyHeaderBodies});
  if(verifyHeaderBodies)expect(result.headerBodies,'Small bodies from the header read retain their exact original hashes').toBeGreaterThan(0);
  expect(result.failures).toEqual([]);return result.count;
}
