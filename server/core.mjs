import {AppError, checkHtml, limits, utf8Size} from './html.mjs';
import {inspectZip} from './zip.mjs';
import {renderPackage,utf8Bytes,sanitizeHtml,canonicalPackageHash} from './package.mjs';
import {sanitizeSvg,SVG_POLICY_VERSION} from './svg.mjs';
export {AppError,limits};
export {SVG_POLICY_VERSION};

const fail = (code, message) => {throw new AppError(code, message);};
const invalid = () => fail('INVALID_DATA', '入力または保存データの形式が不正です。');
const denied = () => fail('FORBIDDEN', 'この操作に必要なDrive権限がありません。');
const absent = () => fail('NOT_FOUND', '文書または版が見つかりません。');
const plain = x => !!x && typeof x === 'object' && !Array.isArray(x);
const token = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(x);
const count = x => Number.isSafeInteger(x) && x >= 0;
const hash = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const str = (x,n,min=1) => typeof x === 'string' && x.length>=min && x.length<=n;
const iso = x => str(x,40) && !Number.isNaN(Date.parse(x));
const json = text => {try {return JSON.parse(text);} catch {return invalid();}};
const unique = (list, key) => new Set(list.map(x => x[key])).size === list.length;
function validateStaticSvgFiles(pkg) {
  for(const [path,file] of pkg.files)if(file.mime==='image/svg+xml') {
    try {sanitizeSvg(file.text);}catch(e){if(e instanceof AppError)throw new AppError(e.code,`${path}: ${e.message}`);throw e;}
  }
}

function validateManifest(m, id) {
  const validVersion=v=>plain(v)&&token(v.versionId)&&token(v.folderId)&&hash(v.sourceHash)&&iso(v.createdAt)&&(!v.packageHash||hash(v.packageHash))&&(!v.sourceFileId||token(v.sourceFileId))&&(!v.sourceVersion||str(v.sourceVersion,128))&&(v.pages===undefined?token(v.htmlFileId):Array.isArray(v.pages)&&v.pages.length>0&&v.pages.length<=20&&str(v.startPage,240)&&v.pages.some(p=>p.path===v.startPage)&&unique(v.pages,'path')&&v.pages.every(p=>plain(p)&&str(p.path,240)&&token(p.htmlFileId)&&hash(p.sourceHash))&&Array.isArray(v.files)&&v.files.length<=100&&unique(v.files,'path')&&v.files.every(f=>plain(f)&&str(f.path,240)&&token(f.fileId)&&str(f.mime,80)&&hash(f.sourceHash)&&(f.size===undefined||count(f.size))));
  if (!plain(m) || ![1,2].includes(m.schemaVersion) || m.documentId!==id || !str(m.title,160) || !token(m.commentsFileId) || !token(m.versionsFolderId) || !Array.isArray(m.versions) || !m.versions.length || m.versions.length>200 || !m.versions.every(validVersion) || (m.schemaVersion===1&&m.versions.some(v=>v.pages!==undefined)) || !unique(m.versions,'versionId') || !m.versions.some(v=>v.versionId===m.latestVersionId)) invalid();
  if(m.updatedAt!==undefined&&!iso(m.updatedAt))invalid();
  if(m.archivedAt!==undefined&&!iso(m.archivedAt))invalid();
  return m;
}

function anchor(a) {
  if (plain(a) && a.type==='region') {
    const r=a.rect;
    if(!str(a.path,500)||!/^body(?:>[a-z][a-z0-9-]*:nth-of-type\([1-9][0-9]*\)){1,20}$/i.test(a.path)||!['IMG','SVG','CANVAS','FIGURE'].includes(a.tag)||!str(a.signature,128,0)||!plain(r)||![r.x,r.y,r.w,r.h].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1)||r.w<=0||r.h<=0||r.x+r.w>1.00001||r.y+r.h>1.00001) invalid();
    return {type:'region',path:a.path,tag:a.tag,signature:a.signature,rect:{x:r.x,y:r.y,w:r.w,h:r.h}};
  }
  if (!plain(a) || a.type!=='text' || !str(a.exact,500) || !a.exact.trim() || !str(a.prefix,120,0) || !str(a.suffix,120,0) || !plain(a.position) || !count(a.position.start) || !count(a.position.end) || a.position.end-a.position.start!==a.exact.length || a.position.end>limits.html) invalid();
  return {type:'text',exact:a.exact,prefix:a.prefix,suffix:a.suffix,position:{start:a.position.start,end:a.position.end,unit:'utf16'},textModel:'shss-visible-text-v1'};
}

export function validateComments(s, id) {
  if (!plain(s)||s.schemaVersion!==1||s.documentId!==id||!count(s.revision)||!Array.isArray(s.threads)||s.threads.length>limits.threads||!Array.isArray(s.appliedOperations)||s.appliedOperations.length>5000) invalid();
  if(s.epoch!==undefined&&!token(s.epoch)) invalid();
  for (const t of s.threads) {
    if (!plain(t)||!token(t.id)||!token(t.versionId)||!hash(t.sourceHash)||!count(t.threadRevision)||!['open','hidden'].includes(t.status)||!Array.isArray(t.messages)||!t.messages.length||t.pagePath!==undefined&&!str(t.pagePath,240)) invalid();
    anchor(t.anchor);
    for (const m of t.messages) {
      if(!plain(m)||!token(m.id)||!token(m.operationId)||!plain(m.author)||!token(m.author.id)||!str(m.author.displayName,160)||!str(m.body,limits.body)||!iso(m.createdAt)) invalid();
      if(m.deletedAt!==undefined&&!iso(m.deletedAt)) invalid();
    }
  }
  for (const op of s.appliedOperations) if(!plain(op)||!token(op.operationId)||!token(op.actorId)||!hash(op.requestHash)||!count(op.revision)||op.revision>s.revision||!iso(op.appliedAt)) invalid();
  if(!unique(s.threads,'id')||!unique(s.appliedOperations,'operationId')) invalid();
  return s;
}

function operation(raw) {
  if(!plain(raw)||!token(raw.operationId)||!token(raw.documentId)||!token(raw.versionId)||!hash(raw.sourceHash)||!plain(raw.payload)) invalid();
  if(raw.pagePath!==undefined&&!str(raw.pagePath,240)) invalid();
  if(raw.epoch!==undefined&&!token(raw.epoch)) invalid();
  const {operationId, documentId, versionId, sourceHash, type, epoch}=raw;
  const p=raw.payload;
  const payload={};
  if(type==='add') payload.anchor=anchor(p.anchor);
  else if(['reply','hide','restore','delete'].includes(type) && token(p.threadId)) payload.threadId=p.threadId;
  else invalid();
  if(type==='add'||type==='reply') {
    if(!str(p.body,limits.body)||!p.body.trim()) invalid();
    payload.body=p.body.trim();
  } else if(type==='delete') {
    if(!token(p.messageId)) invalid();
    payload.messageId=p.messageId;
  } else {
    if(!count(p.expectedThreadRevision)) invalid();
    payload.expectedThreadRevision=p.expectedThreadRevision;
  }
  return {operationId,documentId,versionId,sourceHash,type,...(raw.pagePath===undefined?{}:{pagePath:raw.pagePath}),...(epoch===undefined?{}:{epoch}),payload};
}

export function createService({store, identity, digest, uuid, now, locked}) {
  function document(id) {
    if (!token(id)) invalid();
    const record=store.findDocument(id);
    if(!record) absent();
    return {...record, id, manifest:validateManifest(json(record.manifestText),id)};
  }
  function resolveVersion(record,id,pagePath) {
    if(id!==undefined&&!token(id)) invalid();
    const v=record.manifest.versions.find(v=>v.versionId===(id??record.manifest.latestVersionId));
    if(!v) absent();
    const path=pagePath??v.startPage??'index.html';
    const page=v.pages?.find(p=>p.path===path);
    if(v.pages?!page:path!=='index.html') absent();
    return {documentId:record.id,versionsFolderId:record.manifest.versionsFolderId,v,page,pagePath:path,pageHash:page?.sourceHash??v.sourceHash};
  }
  function versionFile({documentId,versionsFolderId,v,page}) {
    return page?store.pageFile(documentId,versionsFolderId,v,page):store.htmlFile(documentId,versionsFolderId,v);
  }
  function version(record,id,pagePath) {
    const ref=resolveVersion(record,id,pagePath);
    store.prefetchVersions?.([ref]);
    return {...ref,file:versionFile(ref)};
  }
  function verifyHtml({v,file,pageHash},includeHtml=false) {
    if((v.svgPolicyVersion!==undefined||v.files?.some(f=>f.mime==='image/svg+xml'))&&v.svgPolicyVersion!==SVG_POLICY_VERSION) {
      fail('UNSAFE_SVG','SVGの安全検査をやり直して新版を取り込んでください。');
    }
    // Drive supplies a checksum for stored content when available.
    const checksum=file.sha256Checksum?.toLowerCase();
    const html=includeHtml||!hash(checksum) ? store.readHtml(file) : undefined;
    if((html===undefined ? checksum : digest(html))!==pageHash) {
      fail('VERSION_MISMATCH','HTMLの内容が登録した版と一致しません。');
    }
    return html;
  }
  function commentFile(record) {return store.commentsFile(record.id,record.manifest.commentsFileId);}
  function state(record,file,cached=false) {return validateComments(json(store.readComments(file,{cached})),record.id);}
  function commentVersion(file,v,actor,pagePath,driveVersion=file.meta?.version) {
    return driveVersion ? `${file.id}:${driveVersion}:${v.versionId}:${v.sourceHash}:${pagePath}:${actor.id}` : null;
  }
  function snapshot(s,v,actor,canWrite,versionToken=null,pagePath='index.html') {
    const threads=[];
    for(const thread of s.threads) {
      if(thread.versionId!==v.versionId||thread.sourceHash!==v.sourceHash||(thread.pagePath??'index.html')!==pagePath) continue;
      const messages=thread.messages.filter(message=>message.deletedAt===undefined).map(message=>({
        ...message,canDelete:canWrite&&message.author.id===actor.id
      }));
      if(messages.length) threads.push({...thread,messages});
    }
    return {revision:s.revision,epoch:s.epoch||null,canWrite,versionToken,threads};
  }
  function source(input) {
    if(typeof input.svg==='string') {
      if(input.html!==undefined||input.sourceFileId!==undefined||input.zipBase64!==undefined)invalid();
      sanitizeSvg(input.svg);
      const bytes=utf8Bytes(input.svg),wrapper='<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><img src="image.svg" alt="SVG" style="max-width:100%;height:auto"></body></html>';
      const pkg={files:new Map([['index.html',{mime:'text/html',text:wrapper,bytes:utf8Bytes(wrapper)}],['image.svg',{mime:'image/svg+xml',text:input.svg,bytes}]]),pages:['index.html'],startPage:'index.html'};
      const packageHash=canonicalPackageHash(pkg,digest);
      return {type:'package',pkg,rendered:renderPackage(pkg),sourceHash:packageHash,packageHash};
    }
    if(typeof input.zipBase64==='string') {
      if(input.html!==undefined||input.sourceFileId!==undefined)invalid();
      const started=Date.now(),pkg=inspectZip(input.zipBase64,started);
      validateStaticSvgFiles(pkg);
      if(!pkg.startPage){if(!pkg.pages.includes(input.startPage))fail('INVALID_ARCHIVE','開始ページを選んでください。');pkg.startPage=input.startPage;}
      const rendered=renderPackage(pkg,started);
      const packageHash=canonicalPackageHash(pkg,digest);
      return {type:'package',pkg,rendered,sourceHash:packageHash,packageHash};
    }
    if ((typeof input.html==='string')===token(input.sourceFileId)) invalid();
    const file=token(input.sourceFileId)?store.readSource(input.sourceFileId):null;
    const {html,hasSvg}=sanitizeHtml(checkHtml(file?file.text:input.html));
    return {type:'html',html:checkHtml(html),
      ...(hasSvg?{svgPolicyVersion:SVG_POLICY_VERSION}:{}),
      ...(file?{sourceFileId:input.sourceFileId,sourceVersion:file.version}:{})};
  }
  function writeVersion(record, selected) {
    const versionId=uuid();
    return selected.type==='package'
      ? {...store.createPackageVersion(record.manifest.versionsFolderId,versionId,selected.pkg,selected.rendered,digest),sourceHash:selected.sourceHash,packageHash:selected.packageHash,createdAt:now()}
      : {...store.createVersion(record.manifest.versionsFolderId,versionId,selected.html),sourceHash:digest(selected.html),createdAt:now(),...(selected.sourceFileId?{sourceFileId:selected.sourceFileId,sourceVersion:selected.sourceVersion}:{}),
          ...(selected.svgPolicyVersion===undefined?{}:{svgPolicyVersion:selected.svgPolicyVersion})};
  }
  const api={
    inspectPackage(input) {
      if(input.documentId){const d=document(input.documentId);if(!store.canAppend(d))denied();}
      else if(!store.canImport())denied();
      const pkg=inspectZip(input.zipBase64);
      validateStaticSvgFiles(pkg);
      return {pages:pkg.pages,startPage:pkg.startPage};
    },
    listSources(input) {
      if(input.cursor!==undefined&&!str(input.cursor,4096))invalid();
      if(!store.canImport())denied();
      return store.listSources(input.cursor);
    },
    listDocuments(input) {
      if (input.cursor!==undefined&&!str(input.cursor,4096)) invalid();
      if(input.archived!==undefined&&typeof input.archived!=='boolean')invalid();
      const {ids,cursor}=store.listDocuments(input.cursor);
      const readable=fn=>{
        try {return fn();}
        catch(e){if(e instanceof AppError&&['NOT_FOUND','FORBIDDEN','INVALID_DATA','VERSION_MISMATCH','TOO_LARGE'].includes(e.code))return [];throw e;}
      };
      const candidates=ids.flatMap(id=>readable(()=>{
        const d=document(id);
        const {title,latestVersionId,archivedAt,updatedAt,versions}=d.manifest;
        const canManage=store.canManage(d);
        if(!!archivedAt!==!!input.archived||(input.archived&&!canManage))return [];
        return [{ref:resolveVersion(d),summary:{documentId:id,title,latestVersionId,updatedAt:updatedAt||versions.at(-1).createdAt,canManage}}];
      }));
      store.prefetchVersions?.(candidates.map(({ref})=>ref));
      const documents=candidates.flatMap(({ref,summary})=>readable(()=>{
        versionFile(ref);
        return [summary];
      }));
      return {documents,cursor,canImport:store.canImport()};
    },
    getDocument(input,actor) {
      const d=document(input.documentId),ref=version(d,input.versionId,input.pagePath),{v}=ref;
      const htmlUnchanged=input.cachedPageHash===ref.pageHash&&ref.file.sha256Checksum?.toLowerCase()===ref.pageHash;
      const html=verifyHtml(ref,!htmlUnchanged),file=commentFile(d);
      let comments=null,commentsError=null;
      if(file) {
        try {comments=state(d,file,true);}
        catch(e) {
          commentsError=e instanceof AppError ? {code:e.code,message:e.message} : {code:'INTERNAL',message:'コメントの取得に失敗しました。'};
        }
      }
      return {documentId:d.id,title:d.manifest.title,versionId:v.versionId,sourceHash:v.sourceHash,...(v.packageHash?{packageHash:v.packageHash}:{}),pageHash:ref.pageHash,...(htmlUnchanged?{htmlUnchanged:true}:{html}),pagePath:ref.pagePath,pages:v.pages?.map(p=>p.path)||['index.html'],
        versions:d.manifest.versions.map(({versionId,createdAt})=>({versionId,createdAt})),
        canReadComments:!!file,canWriteComments:!!file?.canEdit,canAppend:store.canAppend(d),canManage:store.canManage(d),archived:!!d.manifest.archivedAt,
        comments:comments ? snapshot(comments,v,actor,!!file.canEdit,commentVersion(file,v,actor,ref.pagePath),ref.pagePath) : null,commentsError};
    },
    getComments(input,actor) {
      const d=document(input.documentId),ref=version(d,input.versionId,input.pagePath),{v}=ref,file=commentFile(d);
      if(!file) denied();
      verifyHtml(ref);
      const versionToken=commentVersion(file,v,actor,ref.pagePath);
      if(versionToken && input.versionToken===versionToken && input.canWrite===!!file.canEdit) return {unchanged:true};
      const s=state(d,file,true);
      return snapshot(s,v,actor,!!file.canEdit,versionToken,ref.pagePath);
    },
    manageDocument(input) {
      if(!['rename','archive','restore'].includes(input.type))invalid();
      if(input.type==='rename'&&(!str(input.title,160)||!input.title.trim()))invalid();
      return locked(()=>{
        const d=document(input.documentId);
        if(!store.canManage(d))denied();
        const m={...d.manifest,updatedAt:now()};
        if(input.type==='rename')m.title=input.title.trim();
        if(input.type==='archive')m.archivedAt=now();
        if(input.type==='restore')delete m.archivedAt;
        store.writeManifest(d,m);
        return {documentId:d.id,title:m.title,archived:!!m.archivedAt};
      });
    },
    importDocument(input) {
      if(!str(input.title,160)||!input.title.trim()) invalid();
      if(!store.canImport()) denied();
      const selected=source(input);
      return locked(()=>{
        if(!store.canImport()) denied();
        if(selected.sourceFileId) {
          const existing=store.findImportedSource(selected.sourceFileId);
          if(existing) {
            const d=document(existing),last=d.manifest.versions.at(-1);
            if(last.sourceHash===digest(selected.html)&&last.svgPolicyVersion===selected.svgPolicyVersion)return {documentId:d.id,versionId:last.versionId};
            if(!store.canAppend(d))denied();
            if(d.manifest.versions.length>=200)fail('TOO_LARGE','版の上限に達しました。');
            const v=writeVersion(d,selected);
            store.writeManifest(d,{...d.manifest,latestVersionId:v.versionId,updatedAt:now(),versions:[...d.manifest.versions,v]});
            return {documentId:d.id,versionId:v.versionId};
          }
        }
        return store.createDocument(input.title.trim(), record=>{
          const v=writeVersion(record,selected);
          return {...record.manifest,schemaVersion:selected.type==='package'?2:1,documentId:record.id,title:input.title.trim(),latestVersionId:v.versionId,versions:[v]};
        },selected.sourceFileId);
      });
    },
    appendVersion(input) {
      const prior=document(input.documentId);
      if(!store.canAppend(prior))denied();
      const selected=source(input);
      return locked(()=>{
        const d=document(input.documentId);
        if(!store.canAppend(d)) denied();
        if(d.manifest.versions.length>=200) fail('TOO_LARGE','版の上限に達しました。');
        const v=writeVersion(d,selected);
        store.writeManifest(d,{...d.manifest,schemaVersion:selected.type==='package'?2:d.manifest.schemaVersion,latestVersionId:v.versionId,updatedAt:now(),versions:[...d.manifest.versions,v]});
        return {documentId:d.id,versionId:v.versionId};
      });
    },
    submitOperation(input,actor) {
      const op=operation(input);
      return locked(()=>{
        const d=document(op.documentId),ref=version(d,op.versionId,op.pagePath),{v}=ref,file=commentFile(d);
        if(!file?.canEdit) denied();
        verifyHtml(ref);
        if(op.sourceHash!==v.sourceHash) fail('VERSION_MISMATCH','開いている版を再読み込みしてください。');
        const s=state(d,file),requestHash=digest(JSON.stringify(op));
        if(s.epoch!==undefined&&op.epoch!==s.epoch)fail('VERSION_MISMATCH','コメントが復旧されています。再読み込みしてください。');
        const seen=s.appliedOperations.find(o=>o.operationId===op.operationId);
        if(seen) {
          if(seen.actorId!==actor.id||seen.requestHash!==requestHash) invalid();
          return {operationId:op.operationId,status:'applied',revision:seen.revision,threadId:seen.threadId||null,
            comments:snapshot(s,v,actor,true,commentVersion(file,v,actor,ref.pagePath),ref.pagePath)};
        }
        if(s.appliedOperations.length>=5000 || (op.type!=='delete'&&s.appliedOperations.length>=4500)) fail('TOO_LARGE','操作履歴の上限に達しました。');
        const p=op.payload, ts=now();
        const message=()=>({id:uuid(),operationId:op.operationId,author:{id:actor.id,displayName:actor.displayName},body:p.body,createdAt:ts});
        const threadId=op.type==='add'?uuid():p.threadId;
        if(op.type==='add') {
          if(s.threads.length>=limits.threads) fail('TOO_LARGE','コメント数の上限に達しました。');
          s.threads.push({id:threadId,versionId:v.versionId,sourceHash:v.sourceHash,...(v.pages?{pagePath:ref.pagePath}:{}),threadRevision:1,anchor:p.anchor,status:'open',messages:[message()]});
        } else {
          const t=s.threads.find(t=>t.id===p.threadId&&t.versionId===v.versionId&&t.sourceHash===v.sourceHash&&(t.pagePath??'index.html')===ref.pagePath);
          if(!t) absent();
          if(op.type==='delete') {
            const target=t.messages.find(m=>m.id===p.messageId&&m.deletedAt===undefined);
            if(!target) absent();
            if(target.author.id!==actor.id) denied();
            target.deletedAt=ts;
          } else if(!t.messages.some(m=>m.deletedAt===undefined)) {
            absent();
          } else if(op.type==='reply') {
            if(t.status==='hidden') fail('CONFLICT','非表示のコメントです。');
            t.messages.push(message());
          } else {
            if(t.threadRevision!==p.expectedThreadRevision) fail('CONFLICT','コメントが更新されています。');
            t.status=op.type==='hide'?'hidden':'open';
          }
          t.threadRevision++;
        }
        s.revision++;
        s.appliedOperations.push({operationId:op.operationId,actorId:actor.id,requestHash,threadId,revision:s.revision,appliedAt:ts});
        const serialized=JSON.stringify(s);
        if(utf8Size(serialized)>(op.type==='delete'?limits.json:Math.floor(limits.json*.8))) fail('TOO_LARGE','コメントJSONの上限に達しました。');
        const savedVersion=store.writeComments(file,serialized);
        return {operationId:op.operationId,status:'applied',revision:s.revision,threadId,
          comments:snapshot(s,v,actor,true,commentVersion(file,v,actor,ref.pagePath,savedVersion??null),ref.pagePath)};
      });
    }
  };
  return (name,input={})=>{
    const actor=identity();
    if(!actor||!token(actor.id)||!str(actor.displayName,160)) fail('UNAUTHENTICATED','Googleアカウントを確認できません。');
    if(typeof name!=='string'||!Object.prototype.hasOwnProperty.call(api,name)||!plain(input)) invalid();
    return api[name](input,actor);
  };
}
