import {checkHtml,limits} from './html.mjs';
import {AppError,fail,utf8Bytes,utf8Size} from './util.mjs';
import {inspectZip} from './zip.mjs';
import {renderPackage,sanitizeHtml,canonicalPackageHash} from './package.mjs';
import {sanitizeSvg,SVG_POLICY_VERSION} from './svg.mjs';
import {normalizeAnchor} from '../shared/anchor.mjs';
export {AppError,SVG_POLICY_VERSION,limits};

// Storage layout per document (see gas/Code.gs for the Drive implementation):
//   manifest.json  title, versions and the files of each version
//   comments.json  every thread for every version and page, plus the applied
//                  operation log that makes retries idempotent
const DEFAULT_PAGE = 'index.html';
const MAX_VERSIONS = 200, MAX_PAGES = 20, MAX_PACKAGE_FILES = 100;
// Operations beyond the soft limit are reserved for deletes, so users can still
// remove comments when the log is nearly full. The JSON size limit works the same way.
const MAX_OPERATIONS = 5000, SOFT_MAX_OPERATIONS = 4500, SOFT_JSON_RATIO = 0.8;
const ARCHIVE_ERRORS = ['NOT_FOUND','FORBIDDEN','INVALID_DATA','VERSION_MISMATCH','TOO_LARGE'];

const invalid = () => fail('INVALID_DATA', '入力または保存データの形式が不正です。');
const denied = () => fail('FORBIDDEN', 'この操作に必要なDrive権限がありません。');
const absent = () => fail('NOT_FOUND', '文書または版が見つかりません。');
const plain = x => !!x && typeof x === 'object' && !Array.isArray(x);
const token = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(x);
const count = x => Number.isSafeInteger(x) && x >= 0;
const hash = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const str = (x,n,min=1) => typeof x === 'string' && x.length>=min && x.length<=n;
const iso = x => str(x,40) && !Number.isNaN(Date.parse(x));
const optional = (x,check) => x===undefined || check(x);
const json = text => {try {return JSON.parse(text);} catch {return invalid();}};
const unique = (list, key) => new Set(list.map(x => x[key])).size === list.length;
const title = x => str(x,160) && !!x.trim();
const pagePathOf = thread => thread.pagePath ?? DEFAULT_PAGE;

function validateStaticSvgFiles(pkg) {
  for(const [path,file] of pkg.files)if(file.mime==='image/svg+xml') {
    try {sanitizeSvg(file.text);}catch(e){if(e instanceof AppError)throw new AppError(e.code,`${path}: ${e.message}`);throw e;}
  }
}

const validPage = p => plain(p) && str(p.path,240) && token(p.htmlFileId) && hash(p.sourceHash);
const validFile = f => plain(f) && str(f.path,240) && token(f.fileId) && str(f.mime,80) && hash(f.sourceHash) && optional(f.size,count);
// Schema 1 versions hold one HTML file; schema 2 (ZIP and SVG) versions hold pages and files.
function validPackage(v) {
  return Array.isArray(v.pages) && v.pages.length>0 && v.pages.length<=MAX_PAGES && str(v.startPage,240)
    && v.pages.some(p=>p.path===v.startPage) && unique(v.pages,'path') && v.pages.every(validPage)
    && Array.isArray(v.files) && v.files.length<=MAX_PACKAGE_FILES && unique(v.files,'path') && v.files.every(validFile);
}
function validVersion(v) {
  return plain(v) && token(v.versionId) && token(v.folderId) && hash(v.sourceHash) && iso(v.createdAt)
    && (!v.packageHash||hash(v.packageHash)) && (!v.sourceFileId||token(v.sourceFileId)) && (!v.sourceVersion||str(v.sourceVersion,128))
    && (v.pages===undefined ? token(v.htmlFileId) : validPackage(v));
}
function validateManifest(m, id) {
  if (!plain(m) || ![1,2].includes(m.schemaVersion) || m.documentId!==id || !str(m.title,160) || !token(m.commentsFileId) || !token(m.versionsFolderId)
    || !Array.isArray(m.versions) || !m.versions.length || m.versions.length>MAX_VERSIONS || !m.versions.every(validVersion)
    || (m.schemaVersion===1&&m.versions.some(v=>v.pages!==undefined)) || !unique(m.versions,'versionId')
    || !m.versions.some(v=>v.versionId===m.latestVersionId)) invalid();
  if(!optional(m.updatedAt,iso)||!optional(m.archivedAt,iso))invalid();
  return m;
}

const anchor = a => normalizeAnchor(a) ?? invalid();

function validMessage(m) {
  return plain(m) && token(m.id) && token(m.operationId) && plain(m.author) && token(m.author.id) && str(m.author.displayName,160)
    && str(m.body,limits.body) && iso(m.createdAt) && optional(m.deletedAt,iso);
}
function validateThread(t) {
  if (!plain(t)||!token(t.id)||!token(t.versionId)||!hash(t.sourceHash)||!count(t.threadRevision)||!['open','hidden'].includes(t.status)||!Array.isArray(t.messages)||!t.messages.length||!optional(t.pagePath,p=>str(p,240))) invalid();
  anchor(t.anchor);
  if(!t.messages.every(validMessage)) invalid();
}
export function validateComments(s, id) {
  if (!plain(s)||s.schemaVersion!==1||s.documentId!==id||!count(s.revision)||!Array.isArray(s.threads)||s.threads.length>limits.threads||!Array.isArray(s.appliedOperations)||s.appliedOperations.length>MAX_OPERATIONS) invalid();
  if(!optional(s.epoch,token)) invalid();
  s.threads.forEach(validateThread);
  for (const op of s.appliedOperations) if(!plain(op)||!token(op.operationId)||!token(op.actorId)||!hash(op.requestHash)||!count(op.revision)||op.revision>s.revision||!iso(op.appliedAt)) invalid();
  if(!unique(s.threads,'id')||!unique(s.appliedOperations,'operationId')) invalid();
  return s;
}

// Validates a client operation and returns a normalized copy. Its JSON form is
// hashed to detect a reused operationId with different content.
function operation(raw) {
  if(!plain(raw)||!token(raw.operationId)||!token(raw.documentId)||!token(raw.versionId)||!hash(raw.sourceHash)||!plain(raw.payload)) invalid();
  if(!optional(raw.pagePath,p=>str(p,240))||!optional(raw.epoch,token)) invalid();
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

const SVG_WRAPPER='<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><img src="image.svg" alt="SVG" style="max-width:100%;height:auto"></body></html>';

// Creates the RPC dispatcher. Dependencies are injected so the same code runs on
// Apps Script (gas/Code.gs) and in tests:
//   store     Drive access and permission checks
//   identity  returns {id, displayName} of the caller, or null
//   digest    SHA-256 hex of a string (UTF-8) or byte array
//   uuid, now ID and ISO timestamp generators
//   locked    runs a function while holding the script-wide write lock
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
    const path=pagePath??v.startPage??DEFAULT_PAGE;
    const page=v.pages?.find(p=>p.path===path);
    if(v.pages?!page:path!==DEFAULT_PAGE) absent();
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
  // Confirms the stored page still matches the hash recorded at import time.
  // Returns the HTML when it had to be read (or includeHtml is set).
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
  // A token that changes whenever the comments file, the page or the caller
  // changes, so polling clients can skip unchanged snapshots.
  function commentVersion(file,v,actor,pagePath,driveVersion=file.meta?.version) {
    return driveVersion ? `${file.id}:${driveVersion}:${v.versionId}:${v.sourceHash}:${pagePath}:${actor.id}` : null;
  }
  const onPage=(thread,v,pagePath)=>thread.versionId===v.versionId&&thread.sourceHash===v.sourceHash&&pagePathOf(thread)===pagePath;
  // The comments visible on one page of one version, without deleted messages.
  function snapshot(s,v,actor,canWrite,versionToken=null,pagePath=DEFAULT_PAGE) {
    const threads=[];
    for(const thread of s.threads) {
      if(!onPage(thread,v,pagePath)) continue;
      const messages=thread.messages.filter(message=>message.deletedAt===undefined).map(message=>({
        ...message,canDelete:canWrite&&message.author.id===actor.id
      }));
      if(messages.length) threads.push({...thread,messages});
    }
    return {revision:s.revision,epoch:s.epoch||null,canWrite,versionToken,threads};
  }
  function svgSource(svg) {
    sanitizeSvg(svg);
    const pkg={files:new Map([[DEFAULT_PAGE,{mime:'text/html',text:SVG_WRAPPER,bytes:utf8Bytes(SVG_WRAPPER)}],['image.svg',{mime:'image/svg+xml',text:svg,bytes:utf8Bytes(svg)}]]),pages:[DEFAULT_PAGE],startPage:DEFAULT_PAGE};
    const packageHash=canonicalPackageHash(pkg,digest);
    return {type:'package',pkg,rendered:renderPackage(pkg),sourceHash:packageHash,packageHash};
  }
  function zipSource(zipBase64,startPage) {
    const started=Date.now(),pkg=inspectZip(zipBase64,started);
    validateStaticSvgFiles(pkg);
    if(!pkg.startPage){if(!pkg.pages.includes(startPage))fail('INVALID_ARCHIVE','開始ページを選んでください。');pkg.startPage=startPage;}
    const rendered=renderPackage(pkg,started);
    const packageHash=canonicalPackageHash(pkg,digest);
    return {type:'package',pkg,rendered,sourceHash:packageHash,packageHash};
  }
  // Validates exactly one of svg, zipBase64, html or sourceFileId.
  function source(input) {
    if(typeof input.svg==='string') {
      if(input.html!==undefined||input.sourceFileId!==undefined||input.zipBase64!==undefined)invalid();
      return svgSource(input.svg);
    }
    if(typeof input.zipBase64==='string') {
      if(input.html!==undefined||input.sourceFileId!==undefined)invalid();
      return zipSource(input.zipBase64,input.startPage);
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
  // Adds a version to an existing document. Call while holding the lock.
  function addVersion(d, selected) {
    if(!store.canAppend(d)) denied();
    if(d.manifest.versions.length>=MAX_VERSIONS) fail('TOO_LARGE','版の上限に達しました。');
    const v=writeVersion(d,selected);
    store.writeManifest(d,{...d.manifest,schemaVersion:selected.type==='package'?2:d.manifest.schemaVersion,latestVersionId:v.versionId,updatedAt:now(),versions:[...d.manifest.versions,v]});
    return {documentId:d.id,versionId:v.versionId};
  }
  // Applies one comment operation to the state in place and returns the thread ID.
  function apply(s,op,v,pagePath,actor,ts) {
    const p=op.payload;
    const message=()=>({id:uuid(),operationId:op.operationId,author:{id:actor.id,displayName:actor.displayName},body:p.body,createdAt:ts});
    if(op.type==='add') {
      if(s.threads.length>=limits.threads) fail('TOO_LARGE','コメント数の上限に達しました。');
      const threadId=uuid();
      s.threads.push({id:threadId,versionId:v.versionId,sourceHash:v.sourceHash,...(v.pages?{pagePath}:{}),threadRevision:1,anchor:p.anchor,status:'open',messages:[message()]});
      return threadId;
    }
    const t=s.threads.find(t=>t.id===p.threadId&&onPage(t,v,pagePath));
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
    return p.threadId;
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
      if(!optional(input.cursor,c=>str(c,4096)))invalid();
      if(!store.canImport())denied();
      return store.listSources(input.cursor);
    },
    listDocuments(input) {
      if(!optional(input.cursor,c=>str(c,4096))) invalid();
      if(!optional(input.archived,a=>typeof a==='boolean'))invalid();
      const {ids,cursor}=store.listDocuments(input.cursor);
      // Documents the caller cannot read, or that are damaged, are left out of the list.
      const readable=fn=>{
        try {return fn();}
        catch(e){if(e instanceof AppError&&ARCHIVE_ERRORS.includes(e.code))return [];throw e;}
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
      // The client already holds this page; skip sending it again.
      const htmlUnchanged=input.cachedPageHash===ref.pageHash&&ref.file.sha256Checksum?.toLowerCase()===ref.pageHash;
      const html=verifyHtml(ref,!htmlUnchanged),file=commentFile(d);
      let comments=null,commentsError=null;
      if(file) {
        try {comments=state(d,file,true);}
        catch(e) {
          commentsError=e instanceof AppError ? {code:e.code,message:e.message} : {code:'INTERNAL',message:'コメントの取得に失敗しました。'};
        }
      }
      return {documentId:d.id,title:d.manifest.title,versionId:v.versionId,sourceHash:v.sourceHash,...(v.packageHash?{packageHash:v.packageHash}:{}),pageHash:ref.pageHash,...(htmlUnchanged?{htmlUnchanged:true}:{html}),pagePath:ref.pagePath,pages:v.pages?.map(p=>p.path)||[DEFAULT_PAGE],
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
      if(input.type==='rename'&&!title(input.title))invalid();
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
      if(!title(input.title)) invalid();
      if(!store.canImport()) denied();
      const selected=source(input);
      return locked(()=>{
        if(!store.canImport()) denied();
        // Re-importing a Drive file appends to the document created from it.
        const existing=selected.sourceFileId&&store.findImportedSource(selected.sourceFileId);
        if(existing) {
          const d=document(existing),last=d.manifest.versions.at(-1);
          if(last.sourceHash===digest(selected.html)&&last.svgPolicyVersion===selected.svgPolicyVersion)return {documentId:d.id,versionId:last.versionId};
          return addVersion(d,selected);
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
      return locked(()=>addVersion(document(input.documentId),selected));
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
        const isDelete=op.type==='delete';
        if(s.appliedOperations.length>=(isDelete?MAX_OPERATIONS:SOFT_MAX_OPERATIONS)) fail('TOO_LARGE','操作履歴の上限に達しました。');
        const ts=now(),threadId=apply(s,op,v,ref.pagePath,actor,ts);
        s.revision++;
        s.appliedOperations.push({operationId:op.operationId,actorId:actor.id,requestHash,threadId,revision:s.revision,appliedAt:ts});
        const serialized=JSON.stringify(s);
        if(utf8Size(serialized)>(isDelete?limits.json:Math.floor(limits.json*SOFT_JSON_RATIO))) fail('TOO_LARGE','コメントJSONの上限に達しました。');
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
