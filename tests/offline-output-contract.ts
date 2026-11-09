import {expect, type Page, type TestInfo} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {appendRequestQuery} from 'warcio';
import {openSnapshotOutput} from './snapshot-controls';
import {verifyReplayPayloads} from './wacz-evidence';
const soft = expect.configure({soft:true});

function merkleLevels(leaves: string[]): string[][] {
  const levels = [leaves];
  while (levels.at(-1)!.length > 1) {
    const current = levels.at(-1)!, next: string[] = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(createHash('sha256').update(current[index]! + (current[index + 1] || current[index])).digest('hex'));
    }
    levels.push(next);
  }
  return levels;
}

/** Shared offline contract: retained regression and real live acquisition use
 * exactly the same selectors, integrity, rendered DOM and inert raw checks. */
export async function verifyOfflineOutputs({studio,testInfo,archiveBytes,zip,manifest,entries,packageEvidence,observedConnections,site,documentURLs,sampledText,report}:{
  studio:Page; testInfo:TestInfo; archiveBytes:Buffer; zip:Record<string,Uint8Array>;
  manifest:any; entries:any[]; packageEvidence:{nativeReferences:number};
  observedConnections:{url:string;network:Record<string,unknown>}[];
  site:{url:string;content:string}; documentURLs:string[]; sampledText:string[]; report:Record<string,unknown>;
}) {
    const imported = await studio.evaluate(async () => ((await chrome.storage.local.get('wacz-captures'))['wacz-captures'] as any[])[0]);
    const replayedPayloads = await verifyReplayPayloads(studio, imported.id);
    expect(replayedPayloads).toBe(entries.length + packageEvidence.nativeReferences);
    report.replayedPayloads = replayedPayloads;
    await expect(studio.locator('#snapshot-output-browser')).toHaveAttribute('aria-busy', 'false');
    const viewerIds=await studio.locator('.thumb-card[data-plugin-name],.thumb-card[data-other-files] a[data-plugin-view]').evaluateAll(items=>items.map(item=>(item as HTMLElement).dataset.pluginName||(item as HTMLElement).dataset.pluginView!));
    expect(new Set(viewerIds).size).toBe(viewerIds.length);
    expect(viewerIds).toEqual(expect.arrayContaining(['hashes','responses','dom','archivewebpage']));
    report.viewers = viewerIds;
    for (const plugin of viewerIds) {
      const viewer=await openSnapshotOutput(studio,plugin);
      await expect(viewer.locator('h2, :scope > iframe, .lazy-pdf-preview > iframe[title="Archived PDF"], wr-coll-replay, .plugin-files .directory-title').first(),plugin).toBeVisible({timeout:30_000});
      if (plugin === 'pdf') {
        await expect(viewer.locator('iframe[title="Archived PDF"]')).toHaveAttribute('src', /^blob:/);
        await expect(viewer.getByRole('progressbar')).toHaveCount(0);
      }
      if (plugin === 'responses') {
        await expect(viewer.getByRole('table', {name:'Archived requests'}).locator('tbody tr').first()).toBeVisible();
      }
      if (await viewer.locator('.plugin-files').count()) {
        await expect(viewer.locator('.plugin-files .directory-entry:not(.parent)').first()).toBeVisible();
      }
      if(['readability','defuddle','mercury'].includes(plugin)&&await viewer.locator(':scope > iframe').count()){
        const name=plugin[0]!.toUpperCase()+plugin.slice(1);
        await expect(viewer.frameLocator(`iframe[title="${name} full view"]`).locator('header h1')).toContainText(name);
      }
      await expect.soft(studio.getByRole('alert'), plugin).toHaveCount(0);
      await expect.soft(viewer.locator('.error'), plugin).toHaveCount(0);
      if (['seo', 'sslcerts', 'readability', 'screenshot'].includes(plugin)) await studio.screenshot({ path: testInfo.outputPath(`viewer-${plugin}.png`) });
      if (plugin === 'hashes') {
        const hashes = viewer.frameLocator('iframe[title="Hashes"]');
        await expect(hashes.locator('.tree')).toBeVisible();
        const hashDownload = studio.waitForEvent('download');
        await hashes.locator('#download').click();
        const hashPath = testInfo.outputPath('hashes.json');
        await (await hashDownload).saveAs(hashPath);
        const integrity = JSON.parse(await readFile(hashPath, 'utf8'));
        const expectedFiles = manifest.resources.map((resource: any) => ({
          path: resource.path, size: zip[resource.path]!.length,
          hash: createHash('sha256').update(zip[resource.path]!).digest('hex'),
        })).sort((left: any, right: any) => left.path.localeCompare(right.path));
        expect(integrity.files).toEqual(expectedFiles);
        const expectedLevels = merkleLevels(expectedFiles.map((file: any) => file.hash));
        expect(integrity.tree_levels).toEqual(expectedLevels);
        expect(integrity.root_hash).toBe(expectedLevels.at(-1)![0]);
        expect(integrity.metadata.file_count).toBe(expectedFiles.length);
        expect(integrity.metadata.total_size).toBe(expectedFiles.reduce((total: number, file: any) => total + file.size, 0));
        expect(integrity.metadata.record_count).toBe(replayedPayloads);
        const warcPath = (entry: any) => entry.filename.startsWith('archive/') ? entry.filename : `archive/${entry.filename}`;
        expect(Object.keys(integrity.warc_records).sort()).toEqual([...new Set(entries.map(warcPath))].sort());
        const branches = Object.values(integrity.warc_records) as {files: {hash: string}[]; root_hash: string; tree_levels: string[][]}[];
        expect(branches.flatMap(branch => branch.files)).toHaveLength(entries.length);
        for (const entry of entries) {
          expect(integrity.warc_records[warcPath(entry)].files).toContainEqual(expect.objectContaining({
            // wabac indexes non-GET exchanges by their complete method/body key.
            url: entry.method && entry.method !== 'GET' ? appendRequestQuery(entry.url, entry.requestBody || '', entry.method) : entry.url,
            offset: Number(entry.offset), hash: entry.digest.replace(/^sha-?256:/, ''),
          }));
        }
        for (const branch of branches) {
          const expected = merkleLevels(branch.files.map(file => file.hash));
          expect(branch.tree_levels).toEqual(expected);
          expect(branch.root_hash).toBe(expected.at(-1)![0]);
        }
        await expect(hashes.locator('.tree > li > details > summary code')).toHaveAttribute('title', integrity.root_hash);
        await expect(hashes.locator('[data-record-url]')).toHaveCount(entries.length);
        report.integrity = {files: expectedFiles.length, payloads: replayedPayloads, rootHash: integrity.root_hash};
      }
      if (plugin === 'dns') {
        const connection = observedConnections.find(item=>/^https?:/.test(item.url));
        expect(connection).toBeDefined();
        const dns = viewer.frameLocator('iframe[title="DNS"]');
        await expect.soft(dns.locator('body')).toContainText(String(connection!.network.remoteIPAddress));
        await expect.soft(dns.locator('body')).toContainText(new URL(connection!.url).hostname);
      }
      if (plugin === 'networktiming') await expect.soft(viewer.locator('table tbody tr').first()).toBeVisible();
      if (plugin === 'search_contents') {
        const search = viewer.frameLocator('iframe[title="Search"]');
        await search.getByRole('searchbox', {name:'Search archived text'}).fill(site.content);
        await expect.soft(search.locator('article').first()).toBeVisible();
      }
    }
    const reexport = studio.waitForEvent('download');
    await studio.getByRole('button', {name:'Download WACZ', exact:true}).click();
    const reexportedBytes = await readFile((await (await reexport).path())!);
    // Native byte comparison avoids enumerating tens of millions of Buffer keys
    // in an object matcher while still comparing every byte, not just a digest.
    expect(reexportedBytes.equals(archiveBytes), 'Re-export must remain byte-identical to the original WACZ').toBe(true);
    const domViewer = await openSnapshotOutput(studio,'dom');
    const dom = domViewer.frameLocator('iframe[title="Offline document"]');
    await expect.soft(dom.locator('body'), 'Final DOM preview must be visible').toBeVisible();
    await expect.soft(dom.locator('body')).toContainText(site.content);
    for (const text of sampledText) await expect.soft(dom.locator('body')).toContainText(text);
    await soft.poll(() => dom.locator('img').evaluateAll(images => images.some(image => (image as HTMLImageElement).currentSrc.includes('/w/') && (image as HTMLImageElement).naturalWidth > 0)), { message: 'DOM images must load from archived responses' }).toBe(true);
    report.offlineDOMImages = await dom.locator('img').evaluateAll(images => images.map(image => ({ src: (image as HTMLImageElement).currentSrc.slice(0, 500), width: (image as HTMLImageElement).naturalWidth })));
    await studio.screenshot({ path: testInfo.outputPath('offline-dom.png') });
    const replayViewer = await openSnapshotOutput(studio,'archivewebpage');
    const replay = replayViewer.frameLocator('iframe[name="___wb_replay_top_frame"]');
    await expect(replay.locator('body'), 'Inert raw document must be attached, not necessarily rendered').toBeAttached();
    // Extension raw replay is deliberately inert. Rendered-page fidelity belongs
    // to the DOM/article views; HTTP interactive replay has its own acceptance tests.
    const rawFrame = replayViewer.locator('iframe[name="___wb_replay_top_frame"]');
    await expect(rawFrame, 'Raw replay frame must be visible').toBeVisible();
    await expect(rawFrame).toHaveAttribute('sandbox', 'allow-same-origin');
    expect((await rawFrame.getAttribute('sandbox'))!.split(/\s+/)).not.toContain('allow-scripts');
    await expect.poll(() => rawFrame.getAttribute('src')).toContain('/w/');
    const rawURL = await rawFrame.getAttribute('src');
    expect(documentURLs.some(url => rawURL!.endsWith('/' + url) || rawURL!.split('#')[0]!.endsWith('/' + url)), 'Raw replay must target an original main-document URL').toBe(true);
    // Inspect the navigation that actually produced the displayed document, not a
    // second fetch that could pass while the iframe displays a replay error page.
    await expect.poll(() => replay.locator('body').evaluate(node => ({
      url:node.ownerDocument.URL, readyState:node.ownerDocument.readyState,
      status:(node.ownerDocument.defaultView!.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming)?.responseStatus,
    })), {message:'Raw frame must display the successful archived main-document response'}).toEqual({url:rawURL,readyState:'complete',status:200});
    // Do not compare rewritten HTML bytes with the original response. Every original
    // body, including this document, was checked through plugin-record above.
    expect(entries.some(entry => documentURLs.includes(entry.url) && entry.status === 200)).toBe(true);
    expect(await replay.locator('body').evaluate(node => Boolean((node.ownerDocument.defaultView as any)._wb_wombat))).toBe(false);
    report.rawReplayContract = {mode:'inert-extension', originalPayloadsVerified:replayedPayloads, url:rawURL};
    report.offlineDocumentText = (await replay.locator('body').innerText()).slice(0, 12_000);
    report.offlineDocumentImages = await replay.locator('img').evaluateAll(images => images.map(image => ({ src: (image as HTMLImageElement).currentSrc.slice(0, 500), width: (image as HTMLImageElement).naturalWidth })));
    await studio.screenshot({ path: testInfo.outputPath('offline-document.png') });
    return {viewerIds};
}
