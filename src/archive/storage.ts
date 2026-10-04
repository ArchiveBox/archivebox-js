import type { Capture } from '../capture/types';
import {deleteDerivedCache} from './derived-cache';
const key = 'wacz-captures';
export async function listCaptures(): Promise<Capture[]> { return ((await chrome.storage.local.get(key))[key] || []) as Capture[]; }
export async function saveCapture(capture: Capture): Promise<void> {
  const snapshot = structuredClone(capture);
  await navigator.locks.request('archivebox-wacz-catalog', async () => {
    const captures = await listCaptures();
    await chrome.storage.local.set({ [key]: [snapshot, ...captures.filter(c => c.id !== snapshot.id)] });
  });
}
export async function writeArchive(id: string, response: Response): Promise<number> {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(`${id}.wacz`, { create: true });
  const writer = await file.createWritable();
  if (!response.body) throw Error('Exporter returned no archive');
  await response.body.pipeTo(writer);
  return (await file.getFile()).size;
}
export async function readArchive(id: string): Promise<File> {
  const root = await navigator.storage.getDirectory();
  return (await root.getFileHandle(`${id}.wacz`)).getFile();
}
export async function deleteCapture(id: string) {
  await navigator.locks.request(`archivebox-wacz-capture-${id}`, { ifAvailable: true }, async lock => {
    if (!lock) throw Error('This capture is still running in another studio');
    const replay = await chrome.runtime.sendMessage({ type: 'unmount-wacz', id });
    if (replay?.error) throw Error(replay.error);
    await deleteDerivedCache(id);
    await navigator.locks.request('archivebox-wacz-catalog', async () => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(`${id}.wacz`).catch(error => { if (error.name !== 'NotFoundError') throw error; });
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(`capture-${id}`);
        request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
        request.onblocked = () => reject(Error('Close other viewers before deleting this capture'));
      });
      await chrome.storage.local.set({ [key]: (await listCaptures()).filter(c => c.id !== id) });
    });
  });
}
