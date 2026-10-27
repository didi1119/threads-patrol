import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';
import {it,expect} from 'vitest';

it('constructs the production ingestion redirect mode inside workerd, not Node fetch',async()=>{
  const source=readFileSync(fileURLToPath(new URL('./cloudflare-worker.ts',import.meta.url)),'utf8');
  const mode=source.match(/redirect:\s*"(manual|error|follow)"/)?.[1];
  const script=`export default {fetch(){const r=new Request(new URL('https://example.com/api/ingest'),{method:'POST',redirect:${JSON.stringify(mode)},signal:new AbortController().signal,body:'{}'});return Response.json({redirect:r.redirect,url:r.url});}}`;
  const mf=new Miniflare({workers:[{config:{name:'ingestion-runtime-test',compatibilityDate:'2026-09-27',manifest:{mainModule:'probe.js',modules:{'probe.js':{type:'esm',contents:script}}}}}]});
  try{const response=await mf.dispatchFetch('http://localhost/');expect(response.status).toBe(200);expect(await response.json()).toEqual({redirect:'manual',url:'https://example.com/api/ingest'});}finally{await mf.dispose();}
},15000);
