export const pageKey=d=>JSON.stringify([d.documentId,d.versionId,d.pagePath||'index.html',d.sourceHash]);
const requestKey=({operationId,...request})=>JSON.stringify(request);

// Serialize writes while the UI remains available. Retrying preserves the exact request.
export class CommentOutbox {
  constructor(send,{changed=()=>{},saved=()=>{},failed=()=>{},limit=30}={}) {
    Object.assign(this,{send,changed,saved,failed,limit});
    this.entries=[];this.running=false;this.snapshots=new Map();
  }
  active(d) {return d?this.entries.filter(e=>e.state!=='failed'&&pageKey(e.request)===pageKey(d)):[];}
  errors(d) {return d?this.entries.filter(e=>e.state==='failed'&&pageKey(e.request)===pageKey(d)):[];}
  busy(d,threadId) {return this.active(d).some(e=>e.request.payload.threadId===threadId);}
  enqueue(request,meta) {
    const key=requestKey(request),existing=this.entries.find(e=>e.key===key);
    if(existing){if(existing.state==='failed')this.retry(existing);return existing;}
    if(this.entries.length>=this.limit)throw new Error('未保存の操作が多いため、保存完了を待ってください。');
    const entry={key,request:structuredClone(request),meta,state:'queued',started:performance.now()};
    this.entries.push(entry);this.changed();void this.pump();return entry;
  }
  retry(entry) {if(entry.state!=='failed')return;entry.state='queued';entry.error=null;entry.started=performance.now();this.changed();void this.pump();}
  dismiss(entry) {if(entry.state!=='failed')return;this.entries=this.entries.filter(e=>e!==entry);this.changed();}
  prefer(d,result) {
    const saved=this.snapshots.get(pageKey(d));
    if(!saved||saved.at+300000<Date.now()||(saved.result.epoch||null)!==(result.epoch||null)||saved.result.revision<=result.revision)return result;
    // A saved snapshot may update data, never the permissions from a fresh read.
    return {...result,revision:saved.result.revision,versionToken:saved.result.versionToken,
      threads:saved.result.threads.map(t=>({...t,messages:t.messages.map(m=>({...m,canDelete:result.canWrite&&m.canDelete}))}))};
  }
  async pump() {
    if(this.running)return;
    const entry=this.entries.find(e=>e.state==='queued');if(!entry)return;
    this.running=true;entry.state='saving';this.changed();
    try {
      const result=await this.send(entry.request);
      if(result.status!=='applied'||result.operationId!==entry.request.operationId||!result.comments)throw new Error('保存結果を確認できません。再試行してください。');
      this.entries=this.entries.filter(e=>e!==entry);
      const key=pageKey(entry.request);this.snapshots.delete(key);
      this.snapshots.set(key,{at:Date.now(),result:result.comments});
      let bytes=[...this.snapshots.values()].reduce((n,value)=>n+JSON.stringify(value).length*2,0);
      for(const [id,value] of this.snapshots){
        if(bytes<=8*1024*1024&&this.snapshots.size<=8)break;
        bytes-=JSON.stringify(value).length*2;this.snapshots.delete(id);
      }
      this.saved(entry,result);
    }catch(error){entry.state='failed';entry.error=error;this.failed(entry,error);}
    finally{this.running=false;this.changed();void this.pump();}
  }
}

// Title updates are coalesced and can be retried without creating the document again.
export class TitleTask {
  constructor(rename,{documentId,title,changed=()=>{},saved=()=>{}}) {
    Object.assign(this,{rename,documentId,desired:title,confirmed:title,changed,saved});
    this.running=false;this.error=null;
  }
  get pending(){return this.running||this.desired!==this.confirmed;}
  setTitle(title){this.desired=title;this.error=null;this.changed();}
  async flush() {
    if(this.running||!this.pending)return;
    this.running=true;this.error=null;this.changed();
    try {
      while(this.desired!==this.confirmed) {
        const title=this.desired;
        await this.rename({documentId:this.documentId,type:'rename',title});
        this.confirmed=title;this.lastSavedAt=performance.now();this.saved(title);
      }
    }catch(error){this.error=error;}
    finally{this.running=false;this.changed();}
  }
}
