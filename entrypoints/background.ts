import {removeClosedTabHeaderRules} from '../src/capture/request-headers';
import { PluginReplay } from '../src/replay/PluginReplay';

export default defineBackground(() => {
  const replay = new PluginReplay();
  chrome.tabs.onRemoved.addListener(tabId=>{void removeClosedTabHeaderRules(tabId).catch(console.error);});
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!sender.url || new URL(sender.url).origin !== new URL(chrome.runtime.getURL('studio.html')).origin || new URL(sender.url).pathname !== '/studio.html') return;
    if (!['mount-wacz','unmount-wacz','inspect-wacz','wacz-record'].includes(message.type)) return;
    void replay.command(message).then(reply,error=>reply({error:String(error)}));return true;
  });
  chrome.action.onClicked.addListener(tab => { void chrome.tabs.create({ url: chrome.runtime.getURL(`studio.html?tab=${tab.id || ''}`) }); });
  const owners = new Map<number, chrome.runtime.Port>();
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'wacz-capture-lifetime') return;
    let tabId: number | undefined;
    port.onMessage.addListener(message => {
      if (message.type === 'claim' && Number.isInteger(message.tabId)) {
        tabId = message.tabId; owners.set(tabId!, port); port.postMessage({ type: 'claimed' });
      }
      if (message.type === 'release' && tabId !== undefined && owners.get(tabId) === port) owners.delete(tabId);
    });
    port.onDisconnect.addListener(() => {
      if (tabId !== undefined && owners.get(tabId) === port) {
        owners.delete(tabId);
        // A closed studio cannot run its finally block. Chrome owns debugger sessions
        // at extension scope, so the surviving background context must detach it.
        void chrome.debugger.detach({ tabId }).catch(() => {});
      }
    });
  });
});
