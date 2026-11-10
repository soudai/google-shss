import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';

const shell=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
const app=(await build({entryPoints:[new URL('../web/app.js',import.meta.url).pathname],bundle:true,write:false,format:'iife'})).outputFiles[0].text;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const doc=(id,title=id)=>({documentId:id,title,latestVersionId:'v1',updatedAt:'2026-11-01',canManage:true});
async function ui(t){
  const dom=new JSDOM(shell,{url:'https://test.example/',runScripts:'outside-only',pretendToBeVisual:true});
  t.after(()=>dom.window.close());
  const w=dom.window,requests=[],timers=new Map();let next=0;
  w.structuredClone=structuredClone;w.TextDecoder=TextDecoder;w.Math.random=()=>0.5;
  w.setTimeout=(fn,delay)=>{timers.set(++next,{fn,delay});return next;};w.clearTimeout=id=>timers.delete(id);
  w.SHSS_BOOT={};w.SHSS_BRIDGE='/* __SHSS_CONTEXT__ */';
  w.SHSS_API=(action,input)=>new Promise((resolve,reject)=>requests.push({action,input,resolve,reject}));
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.eval(app);await flush();
  const el=id=>w.document.getElementById(id);
  const last=()=>requests.filter(r=>r.action==='listDocuments').at(-1);
  const reply=async(value,request=last())=>{request.resolve({ok:true,value});await flush();};
  const search=async text=>{el('search').value=text;el('search').dispatchEvent(new w.Event('input'));await flush();};
  const runTimer=async delay=>{
    const entry=[...timers].find(([,v])=>v.delay===delay);assert.ok(entry);
    timers.delete(entry[0]);entry[1].fn();await flush();
  };
  return {w,requests,el,last,reply,search,runTimer};
}

test('empty pages continue automatically and never claim there are no documents prematurely',async t=>{
  const u=await ui(t);
  assert.match(u.el('documents').textContent,/読み込み中/);
  await u.reply({documents:[],cursor:'page2'});
  assert.equal(u.last().input.cursor,'page2');
  assert.doesNotMatch(u.el('documents').textContent,/ありません/);
  await u.reply({documents:[doc('found')],cursor:null});
  assert.match(u.el('documents').textContent,/found/);
  assert.doesNotMatch(u.el('documents').textContent,/読み込み中/);
});

test('search scans later pages, shows partial matches and deduplicates changed page boundaries',async t=>{
  const u=await ui(t);
  await u.reply({documents:[doc('first','First')],cursor:'page2'});
  await u.search('target');
  assert.equal(u.last().input.cursor,'page2');
  assert.doesNotMatch(u.el('documents').textContent,/ありません/);
  await u.reply({documents:[doc('target','Target one')],cursor:'page3'});
  assert.match(u.el('documents').textContent,/Target one/);
  assert.equal(u.last().input.cursor,'page3');
  await u.reply({documents:[doc('target','Target one'),doc('last','Target two')],cursor:null});
  assert.equal([...u.el('documents').querySelectorAll('button')].filter(b=>b.textContent==='Target one').length,1);
  assert.match(u.el('documents').textContent,/Target two/);
  await u.search('missing');
  assert.match(u.el('documents').textContent,/一致する文書はありません/);
});

test('clearing search stops further page scans and an old response cannot replace the archive view',async t=>{
  const u=await ui(t);
  await u.reply({documents:[doc('first')],cursor:'page2'});
  await u.search('missing');
  const pending=u.last();
  await u.search('');
  await u.reply({documents:[doc('second')],cursor:'page3'},pending);
  assert.equal(u.last(),pending);
  u.el('more').click();await flush();
  const previous=u.last();
  u.el('archive-view').click();await flush();
  assert.equal(u.last().input.archived,true);
  await u.reply({documents:[doc('archived')],cursor:null});
  await u.reply({documents:[doc('wrong')],cursor:null},previous);
  assert.match(u.el('documents').textContent,/archived/);
  assert.doesNotMatch(u.el('documents').textContent,/wrong/);
});

test('a failed refresh preserves cached rows, ends loading and provides a manual retry',async t=>{
  const u=await ui(t);
  await u.reply({documents:[doc('saved')],cursor:null});
  u.el('library-refresh').click();await flush();
  for(let attempt=0;attempt<3;attempt++){
    u.last().reject(new Error('offline'));await flush();
    if(attempt<2)await u.runTimer(attempt?2000:1000);
  }
  assert.match(u.el('documents').textContent,/saved/);
  assert.match(u.el('library-error').textContent,/通信に失敗/);
  assert.equal(u.el('load-status').textContent,'');
  assert.equal(u.el('library-refresh').disabled,false);
  u.el('library-refresh').click();await flush();
  await u.reply({documents:[doc('recovered')],cursor:null});
  assert.equal(u.el('library-error').hidden,true);
  assert.match(u.el('documents').textContent,/recovered/);
});

test('missing consent clears stale rows and provides a trusted authorization link without retries',async t=>{
  const u=await ui(t);
  await u.reply({documents:[doc('private')],cursor:null});
  u.el('library-refresh').click();await flush();
  const count=u.requests.length;
  u.last().resolve({ok:false,error:{code:'AUTH_REQUIRED',message:'Driveへのアクセス許可が必要です',authorizationUrl:'https://accounts.google.com/o/oauth2/auth?test=1',retryable:false}});
  await flush();
  assert.equal(u.requests.length,count);
  assert.equal(u.el('documents').textContent,'');
  assert.match(u.el('library-error').textContent,/アクセス許可/);
  assert.equal(u.el('library-authorize').hidden,false);
  assert.equal(u.el('library-authorize').target,'_blank');
  assert.equal(u.el('library-authorize').rel,'noopener noreferrer');
  u.el('library-refresh').click();await flush();
  await u.reply({documents:[doc('allowed')],cursor:null});
  assert.equal(u.el('library-authorize').hidden,true);
  assert.match(u.el('documents').textContent,/allowed/);
});

test('untrusted authorization URLs are not rendered and repeated page cursors stop the scan',async t=>{
  const u=await ui(t);
  u.last().resolve({ok:false,error:{code:'AUTH_REQUIRED',message:'Permission needed',authorizationUrl:'https://evil.example/'}});
  await flush();
  assert.equal(u.el('library-authorize').hidden,true);
  u.el('library-refresh').click();await flush();
  await u.reply({documents:[],cursor:'same'});
  await u.reply({documents:[],cursor:'same'});
  assert.match(u.el('library-error').textContent,/続きが取得できません/);
  assert.equal(u.el('library-refresh').disabled,false);
  assert.doesNotMatch(u.el('documents').textContent,/ありません/);
});
