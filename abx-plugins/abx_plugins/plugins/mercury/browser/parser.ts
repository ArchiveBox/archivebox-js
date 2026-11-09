import browserScript from '@/vendor/mercury/mercury.browser.js?url';
type Result = { content?: string; title?: string; word_count?: number; error?: boolean; failed?: boolean; message?: string; [key: string]: unknown };
type Parser = { parse(url: string, options: { html: string; contentType: 'html'; fetchAllPages: false }): Promise<Result> };
declare global { interface Window { Mercury?: Parser } }
let loading: Promise<Parser> | undefined;
/** Load the reproducible browser build of the unchanged official parser module. */
export function mercury() {
  return loading ||= new Promise<Parser>((resolve, reject) => {
    const script = document.createElement('script'); script.src = browserScript;
    script.onload = () => window.Mercury ? resolve(window.Mercury) : reject(Error('Postlight browser bundle did not expose Mercury'));
    script.onerror = () => reject(Error('Unable to load the packaged Postlight browser bundle'));
    document.head.append(script);
  });
}
