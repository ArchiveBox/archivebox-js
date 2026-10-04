import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { cpSync,mkdirSync } from 'node:fs';
import path from 'node:path';
import {browserAssets,pythonRuntimeRevision} from './scripts/browser-assets';
import {printPreview} from './scripts/print-preview';
const root=fileURLToPath(new URL('.',import.meta.url));
export default defineConfig({
  preview:{host:'127.0.0.1',headers:{'Access-Control-Allow-Origin':'*'}},
  root:root+'player',publicDir:false,resolve:{alias:{'@':root,'node:buffer':'buffer','node:path':'path-browserify','node:events':'events','node:stream':'readable-stream','node:url':'url'},conditions:['onnxruntime-web-use-extern-wasm']},define:{__ABX_HOOK_PATHS__:'[]',__ABX_PYTHON_RUNTIME_REVISION__:JSON.stringify(pythonRuntimeRevision())},worker:{format:'es',rollupOptions:{output:{entryFileNames:'[name]-[hash].js'}}},
  // Open snapshots may still import their content-hashed chunks after a rebuild.
  // Keep those immutable files available for the lifetime of the local player.
  build:{outDir:root+'.output/player',emptyOutDir:false,rollupOptions:{input:{index:root+'player/index.html',ocr:root+'player/ocr-sandbox.html',python:root+'player/python-sandbox.html'}}},
  plugins:[printPreview(),{name:'player-cache-headers',configurePreviewServer(server){
    server.middlewares.use((request,response,next)=>{
      const pathname=new URL(request.url||'/', 'http://localhost').pathname;
      // HTML picks up builds immediately. Content-hashed assets and workers
      // are immutable; copied runtime assets retain ETag revalidation.
      response.setHeader('Cache-Control',pathname==='/'||pathname.endsWith('.html')?'no-cache':/^\/(?:assets\/)?[^/]+-[\w-]+\.(js|css)$/.test(pathname)?'public, max-age=31536000, immutable':'public, max-age=3600, must-revalidate');
      next();
    });
  }},{name:'browser-runtime-assets',closeBundle(){cpSync(root+'public',root+'.output/player',{recursive:true});for(const asset of browserAssets()){const dest=path.join(root,'.output/player',asset.relativeDest);mkdirSync(path.dirname(dest),{recursive:true});cpSync(asset.absoluteSrc,dest)}}}],
});
