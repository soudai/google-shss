import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {gasEnvironment} from './gas-fakes.mjs';
import {createCaller} from '../web/rpc.mjs';
import {maxImportBytes} from '../server/limits.mjs';

const ok=reply=>{assert.equal(reply.ok,true,JSON.stringify(reply.error));return reply.value;};
const anchor={type:'text',exact:'Text',prefix:'',suffix:'',position:{start:0,end:4}};
const shell='<!doctype html><html><head><meta charset="utf-8"></head><body><p>Text 日本語</p>';
const html=shell+'</body></html>';
const operation=(d,id)=>({documentId:d.documentId,versionId:d.versionId,sourceHash:d.sourceHash,operationId:id,type:'add',payload:{anchor,body:id}});
function fixture(){
  const env=gasEnvironment();
  const ref=ok(env.rpc('importDocument',{title:'Performance',html}));
  env.clearCache();
  return {env,ref,doc:ok(env.rpc('getDocument',ref))};
}
const replace=(file,content)=>{
  file.content=Buffer.from(content);file.size=String(file.content.length);
  file.version=String(Number(file.version)+1);
  file.sha256Checksum=createHash('sha256').update(file.content).digest('hex');
};

test('a 10 MB preview is compressed and decoded exactly; old clients and unchanged pages stay compatible',async()=>{
  const env=gasEnvironment();
  const tail='</body></html>',body=shell+'<!--'+ 'x'.repeat(10000000-Buffer.byteLength(shell+tail+'<!---->'))+'-->'+tail;
  assert.equal(Buffer.byteLength(body),10000000);
  const ref=ok(env.rpc('importDocument',{title:'Large preview',html:body}));
  const packed=ok(env.rpc('getDocument',{...ref,acceptHtmlGzip:true}));
  assert.equal(packed.html,undefined);assert.ok(packed.htmlGzip);
  assert.ok(Buffer.byteLength(JSON.stringify(packed))<100000);
  const call=createCaller((action,input)=>env.rpc(action,input));
  const result=await call('getDocument',ref);
  assert.equal(result.html,body);assert.equal(result.htmlGzip,undefined);
  const conditional=ok(env.rpc('getDocument',{...ref,acceptHtmlGzip:true,cachedPageHash:result.pageHash}));
  assert.equal(conditional.htmlUnchanged,true);assert.equal(conditional.htmlGzip,undefined);
  assert.equal(ok(env.rpc('getDocument',ref)).html,body);
});

test('preview decoding rejects corrupt and oversized compressed replies',async()=>{
  const packed=gzipSync(Buffer.from(html)).toString('base64');
  let body={htmlGzip:packed.slice(0,-5)};
  const call=createCaller(()=>({ok:true,value:body}));
  await assert.rejects(call('getDocument',{}));
  body={htmlGzip:gzipSync(Buffer.alloc(maxImportBytes+1,65)).toString('base64')};
  await assert.rejects(call('getDocument',{}));
});

test('warm opens and saves use one metadata search and no comment download',()=>{
  const {env,ref,doc}=fixture();
  env.resetCounts();
  assert.equal(ok(env.rpc('getDocument',{...ref,cachedPageHash:doc.pageHash})).htmlUnchanged,true);
  assert.equal(env.counts.metadataList,1);assert.equal(env.counts.driveAppReads,0);
  for(const id of ['first','second']){
    env.resetCounts();
    const saved=ok(env.rpc('submitOperation',operation(doc,id)));
    assert.equal(saved.status,'applied');
    assert.equal(env.counts.metadataList,1);
    assert.equal(env.counts.driveAppReads,0);
    assert.equal(env.counts.writes,1);
  }
  env.resetCounts();
  const retry=ok(env.rpc('submitOperation',operation(doc,'second')));
  assert.equal(retry.comments.threads.length,2);
  assert.equal(env.counts.writes,0);assert.equal(env.counts.driveAppReads,0);
});

test('a write checks metadata after acquiring the lock and preserves external comments',()=>{
  const {env,doc}=fixture();
  const first=ok(env.rpc('submitOperation',operation(doc,'first')));
  const file=[...env.files.values()].find(f=>f.name==='comments.json');
  env.onLock=()=>{
    env.onLock=null;
    const s=JSON.parse(file.content);
    s.threads[0].messages[0].body='Edited outside SHSS';s.revision++;
    replace(file,JSON.stringify(s));
  };
  env.resetCounts();
  const saved=ok(env.rpc('submitOperation',operation(doc,'second')));
  assert.equal(saved.comments.threads[0].messages[0].body,'Edited outside SHSS');
  assert.equal(saved.comments.revision,first.comments.revision+2);
  assert.equal(env.counts.driveAppReads,1);
});

test('cached paths and bytes never grant permission after it is revoked',()=>{
  const {env,doc}=fixture();
  const file=[...env.files.values()].find(f=>f.name==='comments.json');
  env.onLock=()=>{env.onLock=null;file.capabilities={...file.capabilities,canEdit:false};};
  env.resetCounts();
  const reply=env.rpc('submitOperation',operation(doc,'blocked'));
  assert.equal(reply.error.code,'FORBIDDEN');assert.equal(env.counts.writes,0);
  const page=[...env.files.values()].find(f=>f.name==='index.html');
  page.parents=['unrelated-folder'];
  assert.equal(env.rpc('getDocument',{documentId:doc.documentId}).error.code,'NOT_FOUND');
});

test('cache failures fall back to current Drive content and do not turn a successful save into an error',()=>{
  const {env,doc}=fixture();
  env.cacheFails=true;
  const saved=ok(env.rpc('submitOperation',operation(doc,'fallback')));
  assert.equal(saved.comments.threads.length,1);
  assert.equal(ok(env.rpc('getDocument',{documentId:doc.documentId})).comments.threads[0].messages[0].body,'fallback');
});

test('a different version ignores stale lookup hints and validates current content',()=>{
  const {env,ref,doc}=fixture();
  const next=ok(env.rpc('appendVersion',{documentId:ref.documentId,html:html.replace('Text','Next')}));
  assert.notEqual(next.versionId,doc.versionId);
  assert.match(ok(env.rpc('getDocument',next)).html,/Next/);
  assert.match(ok(env.rpc('getDocument',ref)).html,/Text/);
});
