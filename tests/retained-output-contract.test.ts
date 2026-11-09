import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {unzipSync,strFromU8} from 'fflate';
import {WARCParser} from 'warcio';
import {parse,type DefaultTreeAdapterTypes} from 'parse5';
import {inspectWaczEvidence,readWaczPackage} from './wacz-evidence';
import {verifyOfflineOutputs} from './offline-output-contract';

// This is not acquisition evidence or a substitute for the 100-second live gate.
// Pin the actual input bytes. Alternate retained packages require their own hash.
test('retained WACZ: full offline outputs, original bytes and inert extension replay',async({},testInfo)=>{
  test.setTimeout(180_000);
  const archivePath=process.env.ABX_RETAINED_WACZ||'/tmp/archivebox-rendered-dom-capture/sweeting-blog.wacz';
  const expectedHash=process.env.ABX_RETAINED_WACZ_SHA256||(process.env.ABX_RETAINED_WACZ?undefined:'3f9e17682369038c73161bb838ae85d01393b51e9448a901e25649c98a08374f');
  expect(expectedHash,'Alternate retained input requires ABX_RETAINED_WACZ_SHA256').toMatch(/^[a-f0-9]{64}$/);
  const archiveBytes=await readFile(archivePath);
  expect(createHash('sha256').update(archiveBytes).digest('hex')).toBe(expectedHash);
  const zip=unzipSync(archiveBytes),manifest=await readWaczPackage(zip);
  const metadata=manifest.metadata;
  expect(metadata,'Retain actual source identity, never manufacture fixture metadata').toBeDefined();
  const site={url:metadata.finalUrl||metadata.url,content:'Sweeting'};
  expect(site.url.split('#')[0]).toBe('https://docs.sweeting.me/s/blog');
  for(const resource of manifest.resources)expect('sha256:'+createHash('sha256').update(zip[resource.path]!).digest('hex'),resource.path).toBe(resource.hash);
  const packageEvidence=await inspectWaczEvidence(archivePath);
  const entries=strFromU8(zip['indexes/index.cdx']!).trim().split('\n').map(line=>JSON.parse(line.slice(line.indexOf(' {')+1)));
  const observedConnections:{url:string;network:Record<string,unknown>}[]=[];
  let finalDOM=zip['dom/dom.html']?strFromU8(zip['dom/dom.html']):'';
  for(const [name,bytes]of Object.entries(zip))if(name.startsWith('archive/'))for await(const record of new WARCParser([bytes])){
    const body=await record.readFully();
    if(record.warcTargetURI?.startsWith('urn:dom:'))finalDOM=strFromU8(body);
    const extra=JSON.parse(record.warcHeaders.headers.get('WARC-JSON-Metadata')||'{}');
    if(extra.network?.remoteIPAddress)observedConnections.push({url:record.warcTargetURI!,network:extra.network});
  }
  expect(finalDOM).toContain(site.content);expect(observedConnections.length).toBeGreaterThan(0);
  const sampledText:string[]=[];
  function text(node:DefaultTreeAdapterTypes.Node):string{return 'value'in node?node.value:'childNodes'in node?node.childNodes.map(text).join(''):'';}
  function visit(node:DefaultTreeAdapterTypes.Node){
    if('tagName'in node&&['h1','h2'].includes(node.tagName)){
      const value=text(node).trim().replace(/\s+/g,' ');if(value.length>=20)sampledText.push(value);
    }
    if('childNodes'in node)for(const child of node.childNodes)visit(child);
  }
  visit(parse(finalDOM));expect(sampledText.length).toBeGreaterThan(0);
  const report:Record<string,unknown>={archivePath,archiveSha256:expectedHash,site,sourceMetadata:metadata,sampleSource:'saved DOM, not a new live observation',sampledText,packageEvidence};
  const extension=path.resolve('.output/chrome-mv3');
  const context=await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(),'abx-retained-contract-')),{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try{
    const liveRequests:string[]=[],errors:string[]=[],replayResponses:string[]=[];
    context.on('request',request=>{if(/^https?:/.test(request.url()))liveRequests.push(request.url());});
    await context.setOffline(true);
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const studio=await context.newPage();studio.on('pageerror',error=>errors.push(String(error)));
    studio.on('response',response=>{if(response.url().includes('/w/')&&response.fromServiceWorker())replayResponses.push(response.url());});
    await studio.goto(`chrome-extension://${new URL(worker.url()).host}/studio.html`);
    const choosing=studio.waitForEvent('filechooser');await studio.getByRole('button',{name:'Import WACZ',exact:true}).click();await(await choosing).setFiles(archivePath);
    await expect(studio.locator('.stack-shelf')).toBeVisible();
    await verifyOfflineOutputs({studio,testInfo,archiveBytes,zip,manifest,entries,packageEvidence,observedConnections,site,documentURLs:[site.url.split('#')[0]],sampledText,report});
    Object.assign(report,{liveRequests,errors,replayResponses});
    expect(liveRequests).toEqual([]);expect(errors).toEqual([]);expect(replayResponses.length).toBeGreaterThan(0);
  }finally{await writeFile(testInfo.outputPath('retained-output-contract.json'),JSON.stringify(report,null,2));await context.close();}
});
