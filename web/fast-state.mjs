// Only this tab owns these bytes. Never persist document or comment bodies.
// maxBytes is an estimate (two bytes per character) and must hold a page from
// the largest import (10 MiB), or reopening it would download it again.
export class PreviewCache {
  constructor(load,{now=Date.now,ttl=300000,maxEntries=4,maxBytes=64*1024*1024}={}) {
    Object.assign(this,{load,now,ttl,maxEntries,maxBytes});
    this.entries=new Map();this.requests=new Map();this.epoch=0;
  }
  key({documentId,versionId='',pagePath=''}) {return JSON.stringify([documentId,versionId,pagePath]);}
  peek(input) {
    const key=this.key(input);
    for(const [id,entry] of this.entries) {
      if(entry.expires<=this.now()){this.entries.delete(id);continue;}
      if(entry.keys.has(key)){
        const {html,...details}=entry.value;
        const value={...structuredClone(details),html};
        if(this.now()-entry.savedAt>30000){
          // Keep the last discussion visible while it revalidates. Its stale
          // epoch must not enable posting until a fresh snapshot arrives.
          value.commentsStale=true;
        }
        return value;
      }
    }
    return null;
  }
  remember(input,value) {
    const id=this.key(value),requestKey=this.key(input);
    const keys=new Set([...(this.entries.get(id)?.keys||[]),id,requestKey]);
    for(const [key,entry] of this.entries)if(key!==id)entry.keys.delete(requestKey);
    const {html,...details}=value;
    const size=((html?.length||0)+JSON.stringify(details).length)*2;
    this.entries.delete(id);
    if(size>this.maxBytes)return;
    this.entries.set(id,{keys,value:{...structuredClone(details),html},size,savedAt:this.now(),expires:this.now()+this.ttl});
    let total=[...this.entries.values()].reduce((sum,entry)=>sum+entry.size,0);
    for(const [key,entry] of this.entries) {
      if(this.entries.size<=this.maxEntries&&total<=this.maxBytes)break;
      total-=entry.size;this.entries.delete(key);
    }
  }
  request(input) {
    const key=this.key(input);
    if(this.requests.has(key))return this.requests.get(key);
    const epoch=this.epoch;
    const cached=this.peek(input);
    const request=cached?.pageHash?{...input,cachedPageHash:cached.pageHash}:input;
    const promise=Promise.resolve().then(()=>this.load(request)).then(value=>{
      if(value.htmlUnchanged){
        if(!cached||cached.pageHash!==value.pageHash||typeof cached.html!=='string')throw new Error('プレビューを再取得してください。');
        const {htmlUnchanged,...details}=value;
        value={...details,html:cached.html};
      }
      if(epoch===this.epoch)this.remember(input,value);
      return value;
    }).finally(()=>{if(this.requests.get(key)===promise)this.requests.delete(key);});
    this.requests.set(key,promise);return promise;
  }
  // A completed save is already a checked snapshot. Keep it with the page so
  // navigating away and back does not briefly show an empty discussion.
  updateComments(input,comments) {
    for(const entry of [...this.entries.values()]){
      const d=entry.value;
      if(d.documentId===input.documentId&&d.versionId===input.versionId
        &&d.pagePath===(input.pagePath||'index.html')&&d.sourceHash===input.sourceHash&&d.canReadComments){
        this.remember(input,{...d,comments,commentsError:null});
      }
    }
  }
  clearComments(documentId) {
    this.epoch++;this.requests.clear();
    for(const entry of this.entries.values())if(entry.value.documentId===documentId){
      entry.value.comments=null;entry.value.commentsError={message:'コメントを更新中…'};
    }
  }
  // Keeps the pages but treats everything else as out of date: comments are
  // dropped and requests in flight will not be stored. request() always asks
  // the server, sending the cached page hash, so an unchanged page is not sent
  // again while anything newer replaces the cached copy.
  markStale() {
    this.epoch++;this.requests.clear();
    for(const entry of this.entries.values()){
      entry.value.comments=null;entry.value.commentsError={message:'コメントを更新中…'};
    }
  }
  clear() {
    this.epoch++;this.entries.clear();this.requests.clear();
  }
}

// A provisional view only. IDs, authors and timestamps are replaced by the server.
export function optimisticComments(threads,{type,payload,operationId},now=new Date().toISOString()) {
  // Only copy the thread being edited. Large discussions and a queue of
  // comments should not repeatedly clone every message and anchor.
  const next=threads.slice();
  const existing=next.find(t=>t.messages.some(m=>m.operationId===operationId));
  if(existing&&(type==='add'||type==='reply'))return {threads:next,threadId:existing.id};
  const message={id:'pending-'+operationId,body:payload.body?.trim(),author:{displayName:'自分'},createdAt:now,canDelete:false,pending:true};
  const threadId=type==='add'?'pending-'+operationId:payload.threadId;
  if(type==='add')next.push({id:threadId,anchor:payload.anchor,status:'open',messages:[message]});
  else {
    const index=next.findIndex(t=>t.id===threadId);
    if(index!==-1) {
      const thread={...next[index],messages:[...next[index].messages]};
      next[index]=thread;
      if(type==='reply')thread.messages.push(message);
      if(type==='delete')thread.messages=thread.messages.filter(m=>m.id!==payload.messageId);
      if(type==='hide'||type==='restore')thread.status=type==='hide'?'hidden':'open';
    }
  }
  return {threads:next.filter(t=>t.messages.length),threadId};
}
