import {spawn} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const root=await mkdtemp(path.join(tmpdir(),'abx-wacz-acceptance-'));
const captures=path.join(root,'captures');
console.log(`Real capture and replay evidence: ${root}`);
const run=(files,output)=>new Promise((resolve,reject)=>{
  const child=spawn('pnpm',['exec','playwright','test',...files,`--output=${output}`],{
    stdio:'inherit',env:{...process.env,ABX_LIVE_CAPTURE_DIR:captures},
  });
  child.on('error',reject);child.on('exit',code=>resolve(code??1));
});
const acquisition=await run(['tests/live-sites.test.ts','tests/screenshot-live.test.ts','tests/forum-source-live.test.ts','tests/forum-upstream-live.test.ts','tests/gallery-upstream-live.test.ts','tests/papers-upstream-live.test.ts','tests/pdf-live.test.ts','tests/ocr-live.test.ts','tests/scanned-pdf-live.test.ts','tests/lifecycle-live.test.ts'],captures);
// Failed site assertions still retain real WACZs. Independently test those files
// in the upstream player, and retain both phases' failures without skipping.
const replay=await run(['tests/replaywebpage-live.test.ts','tests/derivations-live.test.ts','tests/ocr-player-live.test.ts'],path.join(root,'replay'));
process.exitCode=acquisition || replay;
