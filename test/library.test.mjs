import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gasEnvironment} from './gas-fakes.mjs';
import {createCaller} from '../web/rpc.mjs';

const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r.error));return r.value;};
const body='<html><p>Library test</p></html>';
const add=(env,title)=>ok(env.rpc('importDocument',{title,html:body}));
const manifest=(env,id)=>env.files.get(env.files.get(id).appProperties.manifest);
const cold=env=>{env.clearCache();env.resetCounts();};
const downloadIds=env=>env.requests.filter(r=>r.method==='download').map(r=>r.id);

test('cold lists avoid repeated cache lookups and do not fetch HTML or comments',()=>{
  const env=gasEnvironment({longIds:true});
  for(let i=0;i<20;i++)add(env,'Document '+i);
  cold(env);
  assert.equal(ok(env.rpc('listDocuments',{})).documents.length,20);
  assert.equal(env.counts.cacheGet,0);
  assert.equal(env.counts.cacheGetAll,1);
  assert.equal(env.counts.metadataGet,1); // Only the root's import permission.
  assert.equal(downloadIds(env).length,20);
  assert.ok(downloadIds(env).every(id=>env.files.get(id).name==='manifest.json'));
});

test('archives are skipped before downloading manifests; restore keeps fixed URLs',()=>{
  const env=gasEnvironment({longIds:true}),refs=[];
  for(let i=0;i<20;i++)refs.push(add(env,'Document '+i));
  for(const ref of refs.slice(0,19))ok(env.rpc('manageDocument',{documentId:ref.documentId,type:'archive'}));
  cold(env);
  assert.deepEqual(ok(env.rpc('listDocuments',{})).documents.map(d=>d.documentId),[refs[19].documentId]);
  assert.deepEqual(downloadIds(env),[manifest(env,refs[19].documentId).id]);
  const archived=manifest(env,refs[0].documentId);
  cold(env);
  assert.equal(ok(env.rpc('listDocuments',{archived:true})).documents.length,19);
  assert.ok(!downloadIds(env).includes(manifest(env,refs[19].documentId).id));
  // Maintenance and backups omit the view filter and still enumerate archives.
  assert.equal(env.store().listDocuments().ids.length,20);
  assert.match(ok(env.rpc('getDocument',refs[0])).html,/Library test/);
  ok(env.rpc('manageDocument',{documentId:refs[0].documentId,type:'restore'}));
  assert.equal(archived.appProperties.shssArchived,'false');
  assert.equal(ok(env.rpc('listDocuments',{})).documents.length,2);
});

test('unreadable HTML and manifests stay hidden after warming list caches',()=>{
  const env=gasEnvironment(),ref=add(env,'Private');
  ok(env.rpc('listDocuments',{}));
  const m=manifest(env,ref.documentId),state=JSON.parse(m.content),page=env.files.get(state.versions[0].htmlFileId);
  page.capabilities={...page.capabilities,canDownload:false};
  assert.deepEqual(ok(env.rpc('listDocuments',{})).documents,[]);
  page.capabilities={...page.capabilities,canDownload:true};
  m.capabilities={...m.capabilities,canDownload:false};
  assert.deepEqual(ok(env.rpc('listDocuments',{})).documents,[]);
});

test('an archive hint is ignored when manifest content changes externally',()=>{
  const env=gasEnvironment(),ref=add(env,'Edited');
  ok(env.rpc('manageDocument',{documentId:ref.documentId,type:'archive'}));
  const m=manifest(env,ref.documentId),state=JSON.parse(m.content);
  delete state.archivedAt;
  m.content=Buffer.from(JSON.stringify(state));m.size=String(m.content.length);m.version=String(Number(m.version)+1);
  m.sha256Checksum=createHash('sha256').update(m.content).digest('hex');
  cold(env);
  assert.equal(ok(env.rpc('listDocuments',{})).documents[0].title,'Edited');
});

test('legacy archive metadata can be upgraded in pages without changing stored content',()=>{
  const env=gasEnvironment(),originals=new Map();
  for(let i=0;i<21;i++){
    const ref=add(env,'Legacy '+i);
    if(i<20)ok(env.rpc('manageDocument',{documentId:ref.documentId,type:'archive'}));
    const m=manifest(env,ref.documentId);
    m.appProperties={};originals.set(m.id,Buffer.from(m.content));
  }
  const first=env.indexArchives(),last=env.indexArchives();
  assert.equal(first.indexed,20);assert.equal(first.hasMore,true);
  assert.equal(last.indexed,1);assert.equal(last.hasMore,false);
  for(const [id,bytes] of originals)assert.deepEqual(env.files.get(id).content,bytes);
  cold(env);
  const firstPage=ok(env.rpc('listDocuments',{}));
  assert.deepEqual(firstPage.documents,[]);assert.ok(firstPage.cursor);
  assert.deepEqual(downloadIds(env),[]);
  assert.equal(ok(env.rpc('listDocuments',{cursor:firstPage.cursor})).documents[0].title,'Legacy 20');
});

test('long Drive IDs are fetched in bounded batches instead of one request per file',()=>{
  const env=gasEnvironment({longIds:90});
  for(let i=0;i<20;i++)add(env,'Long '+i);
  cold(env);
  assert.equal(ok(env.rpc('listDocuments',{})).documents.length,20);
  assert.equal(env.counts.metadataGet,1);
  assert.ok(env.counts.metadataList<10);
  assert.ok(env.requests.filter(r=>r.q).every(r=>r.q.length<=4800));
});

test('partial OAuth consent and incomplete Drive searches are errors, never empty libraries',()=>{
  const env=gasEnvironment();env.missingScopes=true;
  const missing=env.rpc('listDocuments',{});
  assert.equal(missing.error.code,'AUTH_REQUIRED');assert.equal(missing.error.retryable,false);
  assert.match(missing.error.authorizationUrl,/^https:\/\/accounts.google.com\//);
  assert.equal(env.counts.metadataList,0);assert.equal(env.counts.metadataGet,0);
  env.missingScopes=false;
  assert.equal(ok(env.rpc('listDocuments',{})).documents.length,0);
  env.incompleteSearch=true;
  const incomplete=env.rpc('listDocuments',{});
  assert.equal(incomplete.error.code,'LIST_INCOMPLETE');assert.equal(incomplete.error.retryable,true);
});

test('list retries are bounded and do not retry missing consent or write failures',async()=>{
  const waits=[];let calls=0;
  const call=createCaller(()=>{
    calls++;
    if(calls===1)throw new Error('connection lost');
    if(calls===2)return {ok:false,error:{code:'INTERNAL',message:'temporary',retryable:true}};
    return {ok:true,value:{documents:[]}};
  },{wait:async ms=>waits.push(ms),random:()=>0.5});
  assert.deepEqual(await call('listDocuments'),{documents:[]});
  assert.equal(calls,3);assert.deepEqual(waits,[1000,2000]);
  for(const [action,error] of [['listDocuments',{code:'AUTH_REQUIRED',message:'consent',retryable:false}],['appendVersion',{code:'INTERNAL',message:'unknown',retryable:true}]]){
    let attempts=0;
    const fail=createCaller(()=>{attempts++;return {ok:false,error};},{wait:async()=>{}});
    await assert.rejects(fail(action),e=>e.code===error.code);
    assert.equal(attempts,1);
  }
  let attempts=0;
  const offline=createCaller(()=>{attempts++;throw new Error('offline');},{wait:async()=>{}});
  await assert.rejects(offline('listDocuments'));
  assert.equal(attempts,3);
});

test('metadata prefetch follows Drive pagination before falling back to individual reads',()=>{
  const env=gasEnvironment();
  for(let i=0;i<5;i++)add(env,'Paged '+i);
  env.listPageSize=2;cold(env);
  const page=ok(env.rpc('listDocuments',{}));
  assert.equal(page.documents.length,2);assert.ok(page.cursor);
  assert.equal(env.counts.metadataGet,1);
});
