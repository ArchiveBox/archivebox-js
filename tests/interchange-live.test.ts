import {test, expect} from '@playwright/test';
import {readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {unzipSync} from 'fflate';

test('real all-plugin WACZ exposes ArchiveBox JSONL and shared artifact references', async ({}, info) => {
  const filename=process.env.ABX_INTEROP_WACZ;
  expect(filename, 'Provide an actual all-plugin capture in ABX_INTEROP_WACZ').toBeTruthy();
  const zip=unzipSync(await readFile(filename!));
  expect(Object.keys(zip)).toContain('index.jsonl');
  expect(Object.keys(zip)).toContain('artifacts.jsonl');
  const json=(name:string)=>JSON.parse(new TextDecoder().decode(zip[name]!));
  const rows=(name:string)=>new TextDecoder().decode(zip[name]!).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const pkg=json('datapackage.json'), records=rows('index.jsonl'), artifacts=rows('artifacts.jsonl');
  for(const resource of pkg.resources)expect(resource.type, resource.path).toBe('file');
  expect(pkg.archivebox).toEqual({format:'archivebox',version:2,index:'index.jsonl',artifacts:'artifacts.jsonl'});
  const snapshots=records.filter(row=>row.type==='Snapshot');expect(snapshots).toHaveLength(1);
  const snapshot=snapshots[0], results=records.filter(row=>row.type==='ArchiveResult');
  expect(records).toHaveLength(results.length+1);
  expect(snapshot.plugins).toHaveLength(48);
  expect(results).toHaveLength(27);
  expect(new Set(records.map(row=>row.id)).size).toBe(records.length);
  expect(results.some(row=>row.plugin==='singlefile')).toBe(false);
  const captured=JSON.parse(await readFile(path.join(path.dirname(filename!), 'capture.json'), 'utf8'));
  expect(snapshot.id).toBe(captured.id);
  for(const hook of captured.hooks){
    const result=results.find(row=>row.plugin===hook.plugin&&row.hook_name===hook.hook.replace(/\.[^.]+$/,''));
    expect(result, hook.hook).toBeTruthy();
    expect(result.id).toBe(hook.id);
    expect(result.status).toBe(hook.status==='killed'?'failed':hook.status);
    expect(result.start_ts).toBe(new Date(hook.started).toISOString());
    expect(result.end_ts).toBe(new Date(hook.ended).toISOString());
    expect(result.output_files).toEqual([]);
    expect(result.output_json.records).toEqual(hook.records||[]);
  }
  for(const artifact of artifacts){
    expect(artifact.snapshot_id).toBe(snapshot.id);
    expect(artifact.id).toMatch(/^urn:/);
    expect(artifact.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifact.storage.type).toMatch(/^(wacz-member|warc-response)$/);
    if(artifact.storage.type==='wacz-member'){
      const body=zip[artifact.storage.path];expect(body, artifact.storage.path).toBeTruthy();
      expect(createHash('sha256').update(body!).digest('hex')).toBe(artifact.hash.slice(7));
      expect(body!.length).toBe(artifact.size);
    }
  }
  for(const name of ['index.jsonl','artifacts.jsonl']){
    const resource=pkg.resources.find((row:any)=>row.path===name);
    expect(resource.hash).toBe('sha256:'+createHash('sha256').update(zip[name]!).digest('hex'));
    expect(resource.bytes).toBe(zip[name]!.length);
  }
  const extracted=info.outputPath('interchange.json');
  await writeFile(extracted,JSON.stringify({records,artifacts}));
  const validation=execFileSync('uv',['run','--project',process.env.ABX_PYTHON_PROJECT||'../new/abx-dl','--with','jsonschema','python','scripts/validate-interchange.py',extracted],{encoding:'utf8'});
  console.log(validation.trim());
});
