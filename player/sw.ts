import { PluginReplay } from '../src/replay/PluginReplay';
class PlayerReplay extends PluginReplay {
  override async wrapCSPForFrame(response: Response, request: Request) {
    const url = new URL(request.url), root = new URL(this.prefix);
    // Embedded output frames are the trusted player application, which reads
    // the user-selected WACZ origin. Keep upstream replay CSP on archived pages.
    if (url.origin === root.origin && [root.pathname, new URL('index.html', root).pathname].includes(url.pathname)) return response;
    return super.wrapCSPForFrame(response, request);
  }
}
const replay = new PlayerReplay();
self.addEventListener('message', (event: MessageEvent) => {
  if (!event.data?.archivebox || !event.ports[0]) return;
  const client = event.source as { url?: string } | null;
  const scope = (self as unknown as {registration:{scope:string}}).registration.scope;
  if (!client?.url || ![scope, new URL('index.html', scope).href].includes(client.url.split(/[?#]/)[0]!)) return;
  const work = replay.command(event.data).then(result=>event.ports[0]!.postMessage(result),error=>event.ports[0]!.postMessage({error:String(error)}));
  (event as unknown as {waitUntil(work:Promise<void>):void}).waitUntil(work);
});
