// Apps Script entry points and the Drive-backed store for SHSSCore (server/core.mjs).
// The build prepends the SHSSCore bundle to this file. Functions ending in "_"
// cannot be called through google.script.run.

const FOLDER_MIME_='application/vnd.google-apps.folder';
const MAX_JSON_BYTES_=1024*1024;
const LOCK_TIMEOUT_MS_=7000;
// CacheService values are limited to 100 KB.
const CACHE_MAX_BYTES_=80000;
// Largest file downloaded in parallel; UrlFetchApp responses are limited to 50 MB.
const PARALLEL_MAX_BYTES_=10*1024*1024;

function isDriveId_(id) {return typeof id==='string'&&/^[\w-]{1,128}$/.test(id);}

// Apps Script blobs take signed bytes (-128..127).
function toSignedBytes_(bytes) {return Array.from(bytes,b=>b>127?b-256:b);}

function timestamp_() {return new Date().toISOString().replace(/[:.]/g,'-');}

// Runs fn while holding the script-wide lock that serializes writes to shared
// files (comments.json and manifest.json). If the lock times out, the
// callback has not run. A caller may already have staged files outside it.
function withScriptLock_(fn, busy) {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(LOCK_TIMEOUT_MS_))throw busy();
  try {return fn();}
  finally {lock.releaseLock();}
}

// Partial OAuth consent must be handled before any Drive or identity call.
function authorization_() {
  const info=ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL,[
    'https://www.googleapis.com/auth/drive','https://www.googleapis.com/auth/userinfo.email'
  ]);
  if(info.getAuthorizationStatus()!==ScriptApp.AuthorizationStatus.REQUIRED)return null;
  return {code:'AUTH_REQUIRED',message:'文書の表示にはGoogle Driveとアカウント情報へのアクセス許可が必要です。「アクセスを許可」から必要な権限を選び、許可後に再読み込みしてください。',
    authorizationUrl:info.getAuthorizationUrl(),retryable:false};
}

function doGet(e) {
  const config = configuration_();
  const template = HtmlService.createTemplateFromFile('Index');
  const url = ScriptApp.getService().getUrl();
  const param = e && e.parameter || {};
  template.boot = JSON.stringify({url, documentId: param.doc || '', versionId: param.v || '',pagePath:param.p||''}).replace(/</g, '\\u003c');
  if (!authorization_() && !email_(config.domain)) return HtmlService.createHtmlOutput('対象のGoogle Workspaceアカウントでアクセスしてください。');
  return template.evaluate().setTitle('SHSS').addMetaTag('viewport','width=device-width, initial-scale=1');
}

function rpc(action, input) {
  try {
    const authorization=authorization_();
    if(authorization)return {ok:false,error:authorization};
    const config = configuration_();
    const store = driveStore_(config.root);
    const run = SHSSCore.createService({
      store, identity: () => identity_(config.domain),
      uuid: () => Utilities.getUuid(), now: () => new Date().toISOString(), digest: digest_,
      // Metadata read before the lock may be stale; re-read it inside.
      locked: fn => withScriptLock_(() => {
        store.clearMetadata();
        return fn();
      }, () => new SHSSCore.AppError('BUSY','保存が混み合っています。再試行してください。',true))
    });
    const value=run(action,input);
    return {ok:true,value:action==='getDocument'&&input?.acceptHtmlGzip===true?packDocument_(value):value};
  } catch(error) {
    if(error instanceof SHSSCore.AppError) return {ok:false,error:{code:error.code,message:error.message,retryable:error.retryable}};
    const detail=String(error?.message||error).replace(/Bearer\s+[^\s]+/gi,'Bearer [redacted]').replace(/(access_token|refresh_token|id_token)=([^&\s]+)/gi,'$1=[redacted]');
    console.error(JSON.stringify({event:'SHSS RPC failed',action:/^[A-Za-z]{1,32}$/.test(action)?action:'invalid',name:error?.name||'Error',message:detail.slice(0,1000)}));
    return {ok:false,error:{code:'INTERNAL',message:'処理に失敗しました。時間をおいて再試行してください。',retryable:true}};
  }
}

// Keep old clients compatible. Compress only substantial pages and only when
// base64 is smaller; the unchanged-page response already omits the body.
function packDocument_(value) {
  if(typeof value.html!=='string'||value.html.length<65536)return value;
  try {
    const packed=Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(value.html,'text/html')).getBytes());
    if(packed.length<value.html.length*0.9){
      const {html,...rest}=value;
      return {...rest,htmlGzip:packed};
    }
  }catch(e){console.warn('Preview compression unavailable');}
  return value;
}

function configuration_() {
  const props=PropertiesService.getScriptProperties();
  const root=props.getProperty('SHSS_ROOT_FOLDER_ID')||'';
  const domain=(props.getProperty('SHSS_DOMAIN')||'').trim().toLowerCase();
  if(!isDriveId_(root)||!domain) throw new SHSSCore.AppError('CONFIG','管理フォルダとドメインを設定してください。');
  return {root,domain};
}

function email_(domain) {
  const active=Session.getActiveUser().getEmail().toLowerCase();
  const effective=Session.getEffectiveUser().getEmail().toLowerCase();
  return active===effective && active.split('@')[1]===domain ? active : null;
}

function identity_(domain) {
  const email=email_(domain);
  if(!email)return null;
  let cache;
  try {
    cache=CacheService.getUserCache();
    const cached=cache.get('drive-user:'+email);
    if(cached) {
      const actor=JSON.parse(cached);
      if(actor.email===email&&isDriveId_(actor.id)&&typeof actor.displayName==='string'&&actor.displayName.length<=160)return {id:actor.id,displayName:actor.displayName};
    }
  }catch(e){console.warn('Identity cache unavailable');}
  const user=Drive.About.get({fields:'user(permissionId,displayName,emailAddress)'}).user;
  if(!user||user.emailAddress?.toLowerCase()!==email||!user.permissionId)return null;
  const actor={id:user.permissionId,displayName:(user.displayName||email).slice(0,160)};
  if(cache)try {cache.put('drive-user:'+email,JSON.stringify({...actor,email}),300);}catch(e){console.warn('Identity cache unavailable');}
  return actor;
}

function hex_(bytes) {return bytes.map(b=>((b+256)%256).toString(16).padStart(2,'0')).join('');}
// SHA-256 hex of a string (as UTF-8) or of a byte array.
function digest_(text) {return hex_(typeof text==='string'?Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8):Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,toSignedBytes_(text)));}

// Each document is a folder under root, tagged with appProperties.shss='document':
//   manifest.json, comments.json, versions/<versionId>/{index.html | page-N.html, source-N}
// Every lookup checks the parent folder, name and MIME type, so an ID taken from
// a manifest cannot point outside its document.
function driveStore_(root) {
  const folder=FOLDER_MIME_;
  const fields='id,name,mimeType,parents,trashed,size,version,sha256Checksum,appProperties,capabilities(canDownload,canEdit,canModifyContent,canAddChildren,canMoveItemWithinDrive)';
  const metadata=new Map(), preparedDocuments=new Set();
  const fail=(code,message)=>{throw new SHSSCore.AppError(code,message);};
  const notFound=()=>fail('NOT_FOUND','文書または版が見つかりません。');
  const forbidden=()=>fail('FORBIDDEN','この操作に必要なDrive権限がありません。');
  const unavailable=error=>/file not found|insufficient (?:file )?permissions|access denied|permission denied|not authorized|do not have permission|forbidden|\b(?:403|404)\b/i.test(String(error?.message||error));
  const idOk=isDriveId_;
  // Metadata is cached per request; clearMetadata() resets it inside the lock.
  function meta(id) {
    if(!idOk(id))return null;
    if(metadata.has(id))return metadata.get(id);
    try {
      const f=Drive.Files.get(id,{fields,supportsAllDrives:true});
      const value=f.trashed?null:f;
      metadata.set(id,value);
      return value;
    }catch(e){if(unavailable(e))return null;throw e;}
  }
  const child=(f,parent,mime)=>!!(f&&f.mimeType===mime&&f.parents?.includes(parent));
  const writable=f=>f?.capabilities?.canEdit===true&&f?.capabilities?.canModifyContent===true;
  function list(parent,where,limit,cursor) {
    const parents=Array.isArray(parent)?parent:[parent],scope=parents.map(id=>"'"+id+"' in parents").join(' or ');
    return Drive.Files.list({q:`(${scope}) and trashed = false and ${where}`,fields:`nextPageToken,incompleteSearch,files(${fields})`,pageSize:limit,pageToken:cursor,orderBy:'createdTime desc',supportsAllDrives:true,includeItemsFromAllDrives:true});
  }
  function prefetch(clauses) {
    if(!clauses.length)return;
    // Split long queries instead of falling back to a GET for every file.
    const batches=[];let batch=[],length=0;
    for(const clause of clauses){
      if(clause.length>4700)continue; // Missing files still fall back to GET.
      if(length+clause.length>4700){batches.push(batch);batch=[];length=0;}
      batch.push(clause);length+=clause.length+4;
    }
    if(batch.length)batches.push(batch);
    for(const parts of batches)try {
      const q='trashed = false and ('+parts.join(' or ')+')';
      let cursor;const seen=new Set();
      do {
        const page=Drive.Files.list({q,fields:'nextPageToken,files('+fields+')',pageSize:100,pageToken:cursor,
          supportsAllDrives:true,includeItemsFromAllDrives:true});
        for(const file of page.files||[]){
          if(idOk(file.id)&&!file.trashed&&file.capabilities)metadata.set(file.id,file);
        }
        cursor=page.nextPageToken;
        if(seen.has(cursor))break;
        seen.add(cursor);
      }while(cursor&&seen.size<5);
    }catch(e){console.warn('Drive metadata prefetch unavailable');}
  }
  // Cache lookup paths, never permissions. A warm open/save can fetch all
  // ancestors and the page's metadata together. Every result is still checked
  // against the current manifest, Drive capabilities, parents and checksum.
  const pathHints=new Map();
  const hintKey=id=>'document-path:'+digest_(root+':'+id);
  function readPathHint(id) {
    try {
      const hint=JSON.parse(CacheService.getUserCache().get(hintKey(id))||'null');
      if(hint&&[hint.versionsFolderId,hint.folderId,hint.versionId].every(idOk)
        &&/^(?:index|page-\d{1,2})\.html$/.test(hint.pageName)) {
        pathHints.set(id,hint);
        return hint;
      }
    }catch(e){console.warn('Path hint unavailable');}
    return null;
  }
  function rememberPathHint(ref) {
    const hint={versionsFolderId:ref.versionsFolderId,folderId:ref.v.folderId,versionId:ref.v.versionId,
      pageName:ref.page?'page-'+ref.v.pages.indexOf(ref.page)+'.html':'index.html'};
    if(JSON.stringify(pathHints.get(ref.documentId))===JSON.stringify(hint))return;
    try {CacheService.getUserCache().put(hintKey(ref.documentId),JSON.stringify(hint),300);}
    catch(e){console.warn('Path hint unavailable');}
  }
  function prepareDocuments(ids,{listing=false}={}) {
    const pending=ids.filter(id=>idOk(id)&&!preparedDocuments.has(id));
    if(!pending.length)return;
    for(const id of pending)preparedDocuments.add(id);
    const parents=pending.map(id=>"'"+id+"' in parents").join(' or ');
    const names=listing?"name = 'manifest.json'":"name = 'manifest.json' or name = 'comments.json' or name = 'versions'";
    const clauses=["("+parents+") and ("+names+")"];
    const hint=!listing&&pending.length===1?readPathHint(pending[0]):null;
    if(hint){
      clauses.push("('"+hint.versionsFolderId+"' in parents and name = '"+hint.versionId+"')");
      clauses.push("('"+hint.folderId+"' in parents and name = '"+hint.pageName+"')");
    }
    prefetch(clauses);
  }
  const sha256Hex=bytes=>hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,bytes));
  // Contents fetched in parallel by preloadFiles, by file ID. Each is used once.
  const downloads=new Map();
  // Returns {text, sha256} where sha256 is the hash of the bytes as stored.
  function download(file, max) {
    if(!file?.capabilities?.canDownload)forbidden();
    if(Number(file.size)>max)fail('TOO_LARGE','ファイルが上限を超えています。');
    const ready=downloads.get(file.id);
    if(ready&&ready.version===file.version) {
      downloads.delete(file.id);
      if(ready.size>max)fail('TOO_LARGE','ファイルが上限を超えています。');
      return ready;
    }
    let blob;
    try {blob=DriveApp.getFileById(file.id).getBlob();}catch(e){if(unavailable(e))forbidden();throw e;}
    const bytes=blob.getBytes();
    if(bytes.length>max)fail('TOO_LARGE','ファイルが上限を超えています。');
    return {text:blob.getDataAsString('UTF-8'),sha256:sha256Hex(bytes)};
  }
  // Reads a file as strict UTF-8: the bytes must hash the same as the decoded text re-encoded.
  function blobText(file, max) {
    const {text,sha256}=download(file,max);
    if(sha256!==digest_(text))fail('INVALID_DATA','UTF-8のファイルを指定してください。');
    return text;
  }
  // Reads a stored page and returns the SHA-256 of its bytes. Pages were written
  // by this app from valid strings, so when the hash matches the recorded page
  // hash, the bytes are known to be valid UTF-8 and need no second check.
  function blobTextWithHash(file, max) {
    const {text,sha256}=download(file,max);
    return {text,sha256};
  }
  const cacheable=file=>!!file?.version&&Number(file.size)<=CACHE_MAX_BYTES_&&file.capabilities?.canDownload===true;
  // The checksum also binds cached bytes when Drive metadata and a concurrent
  // download describe different versions. No cache is used without canDownload.
  const cacheKey=file=>'file-text:'+digest_(file.id+':'+file.version+':'+(file.sha256Checksum||''));
  // Texts loaded in bulk from the user cache by preloadFiles, keyed like the cache.
  const cachedTexts=new Map(),cacheMisses=new Set();
  // Loads several files at once: cached texts in one CacheService call, and the
  // rest downloaded in parallel. Later reads use the results. This is only an
  // optimization; anything not loaded here is read one by one as before, which
  // also reports any error.
  function preloadFiles(files) {
    const unique=[...new Map(files.filter(f=>idOk(f?.id)).map(f=>[f.id,f])).values()];
    const keys=[...new Set(unique.filter(cacheable).map(cacheKey))].filter(key=>!cachedTexts.has(key));
    if(keys.length) {
      try {
        const found=CacheService.getUserCache().getAll(keys);
        for(const key of keys){if(found[key]!==undefined)cachedTexts.set(key,found[key]);else cacheMisses.add(key);}
      }catch(e){console.warn('File cache unavailable');}
    }
    const pending=unique.filter(f=>f.capabilities?.canDownload===true&&Number(f.size)<=PARALLEL_MAX_BYTES_
      &&/^[a-f0-9]{64}$/i.test(f.sha256Checksum||'')
      &&!downloads.has(f.id)&&!(cacheable(f)&&cachedTexts.has(cacheKey(f))));
    // One file gains nothing from a parallel request.
    if(pending.length<2)return;
    let responses;
    try {
      const authorization='Bearer '+ScriptApp.getOAuthToken();
      responses=UrlFetchApp.fetchAll(pending.map(f=>({
        url:'https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(f.id)+'?alt=media&supportsAllDrives=true',
        headers:{Authorization:authorization},muteHttpExceptions:true,followRedirects:false
      })));
    }catch(e){console.warn('Parallel download unavailable');return;}
    responses.forEach((response,i)=>{
      const file=pending[i];
      try {
        if(response.getResponseCode()!==200)return;
        const bytes=response.getContent();
        if(bytes.length!==Number(file.size))return;
        const sha256=sha256Hex(bytes);
        // The version used for caching must match the downloaded bytes.
        if(file.sha256Checksum.toLowerCase()!==sha256)return;
        downloads.set(file.id,{version:file.version,size:bytes.length,sha256,text:response.getContentText('UTF-8')});
      }catch(e){console.warn('Parallel response unavailable');}
    });
  }
  // Small files are cached per user for 5 minutes, keyed by Drive file version.
  function readCachedText(file,max) {
    if(!file?.capabilities?.canDownload)forbidden();
    if(Number(file.size)>max)fail('TOO_LARGE','ファイルが上限を超えています。');
    if(!cacheable(file)) return blobText(file,max);
    let cache;
    const key=cacheKey(file);
    if(cachedTexts.has(key))return cachedTexts.get(key);
    try {
      cache=CacheService.getUserCache();
      const cached=cacheMisses.has(key)?null:cache.get(key);
      if(cached!==null)return cached;
    }catch(e){console.warn('File cache unavailable');}
    const text=blobText(file,max);
    if(cache&&(!file.sha256Checksum||file.sha256Checksum.toLowerCase()===digest_(text))){
      try {cache.put(key,text,300);}catch(e){console.warn('File cache unavailable');}
    }
    return text;
  }
  function create(parent,name,mime,text,appProperties) {
    const options={fields:'id',supportsAllDrives:true};
    const file={name,mimeType:mime,parents:[parent],appProperties};
    return Drive.Files.create(file,text===undefined?null:Utilities.newBlob(text,mime,name),options).id;
  }
  function write(id,mime,text) {
    try {return Drive.Files.update({},id,Utilities.newBlob(text,mime),{fields:'version',supportsAllDrives:true});}
    catch(e){if(unavailable(e))forbidden();throw e;}
  }
  function canAdd(id) {const f=meta(id);return f?.mimeType===folder && f.capabilities?.canAddChildren===true;}
  let archiveId;
  function archiveFolder(createIfMissing=false) {
    const props=PropertiesService.getScriptProperties(),key='SHSS_ARCHIVE_LOCATION';
    if(archiveId===undefined){
      let saved;try{saved=JSON.parse(props.getProperty(key)||'null');}catch{}
      archiveId=saved?.root===root&&idOk(saved.id)?saved.id:null;
      if(!archiveId){
        const matches=list(root,`mimeType = '${folder}' and appProperties has { key='shss' and value='archive' }`,2);
        if((matches.files||[]).length>1)fail('CONFIG','SHSSのarchiveフォルダが複数あります。管理者に確認してください。');
        archiveId=matches.files?.[0]?.id||null;
        if(archiveId)props.setProperty(key,JSON.stringify({root,id:archiveId}));
      }
    }
    if(!archiveId&&createIfMissing){
      if(!canAdd(root))forbidden();
      archiveId=create(root,'archive',folder,undefined,{shss:'archive'});
      props.setProperty(key,JSON.stringify({root,id:archiveId}));
    }
    return archiveId;
  }
  function moveDocument(d,archived) {
    const f=meta(d.id);
    if(f?.capabilities?.canEdit!==true||f.capabilities.canMoveItemWithinDrive!==true)forbidden();
    const destination=archived?archiveFolder(true):root,target=meta(destination);
    // Move within the configured root. Never accept a caller-selected parent.
    if(!target||target.mimeType!==folder||target.capabilities?.canAddChildren!==true
      ||(archived&&(!child(target,root,folder)||target.appProperties?.shss!=='archive')))forbidden();
    const changingParent=!f.parents?.includes(destination);
    if(!changingParent&&f.appProperties?.shssStorage==='folders-v1')return;
    try {
      Drive.Files.update({appProperties:{shssStorage:'folders-v1'}},d.id,null,{
        ...(changingParent?{addParents:destination,removeParents:(f.parents||[]).join(',')}:{}),
        fields:'id',supportsAllDrives:true
      });
      metadata.delete(d.id);
    }catch(e){if(unavailable(e))forbidden();throw e;}
  }
  return {
    clearMetadata() {archiveId=undefined;metadata.clear();preparedDocuments.clear();cachedTexts.clear();cacheMisses.clear();downloads.clear();pathHints.clear();},
    preloadFiles,
    prefetchVersions(refs) {
      const clauses=new Set();
      for(const {documentId,versionsFolderId,v,page} of refs){
        if(!metadata.has(versionsFolderId)){
          clauses.add("('"+documentId+"' in parents and name = 'versions')");
        }
        if(!metadata.has(v.folderId)){
          clauses.add("('"+versionsFolderId+"' in parents and name = '"+v.versionId+"')");
        }
        const fileId=page?.htmlFileId??v.htmlFileId;
        if(!metadata.has(fileId)){
          const name=page?'page-'+v.pages.indexOf(page)+'.html':'index.html';
          clauses.add("('"+v.folderId+"' in parents and name = '"+name+"')");
        }
      }
      prefetch([...clauses]);
      if(refs.length===1)rememberPathHint(refs[0]);
    },
    listSources(cursor) {
      const page=list(root,`mimeType = 'text/html'`,20,cursor);
      return {files:(page.files||[]).filter(f=>f.capabilities?.canDownload&&/\.html?$/i.test(f.name))
        .map(f=>({id:f.id,name:f.name,version:f.version||null})),cursor:page.nextPageToken||null};
    },
    findImportedSource(sourceFileId) {
      const find=parent=>{
        const page=list(parent,`mimeType = '${folder}' and appProperties has { key='sourceFileId' and value='${sourceFileId}' }`,20);
        return (page.files||[]).find(f=>f.appProperties?.shss==='document')?.id||null;
      };
      const active=find(root);if(active)return active;
      const archive=archiveFolder();return archive?find(archive):null;
    },
    listDocuments(cursor,{archived}={}) {
      let parent=root;
      // Normal views never inspect the archive. Maintenance uses one union
      // query so a move between the two folders cannot shift its page boundary.
      if(archived!==false){
        const archive=archiveFolder();
        if(archived===true){if(!archive)return {ids:[],cursor:null};parent=archive;}
        else if(archive)parent=[root,archive];
      }
      const page=list(parent,`mimeType = '${folder}' and appProperties has { key='shss' and value='document' }`,20,cursor);
      if(page.incompleteSearch)throw new SHSSCore.AppError('LIST_INCOMPLETE','Driveの検索を完了できませんでした。再読み込みしてください。',true);
      const files=page.files||[],ids=[],manifests=[];
      for(const file of files)metadata.set(file.id,file);
      prepareDocuments(files.map(f=>f.id),{listing:true});
      for(const file of files){
        const manifest=metadata.get(file.appProperties?.manifest)||meta(file.appProperties?.manifest);
        if(!child(manifest,file.id,'application/json')||manifest.name!=='manifest.json'||!manifest.capabilities?.canDownload)continue;
        ids.push(file.id);
        if(Number(manifest.size)<=MAX_JSON_BYTES_)manifests.push(manifest);
      }
      preloadFiles(manifests);
      return {ids,cursor:page.nextPageToken||null};
    },
    findDocument(id) {
      const f=meta(id);
      if(!f||f.mimeType!==folder||f.trashed||f.appProperties?.shss!=='document')return null;
      const inRoot=child(f,root,folder);
      if(!inRoot&&!f.parents?.includes(archiveFolder()))return null;
      prepareDocuments([id]);
      const manifest=meta(f.appProperties.manifest);
      if(!child(manifest,id,'application/json')||manifest.name!=='manifest.json'||!manifest.capabilities?.canDownload)return null;
      return {manifestId:manifest.id,manifestCanEdit:writable(manifest),manifestText:readCachedText(manifest,MAX_JSON_BYTES_),
        ...(!inRoot?{archived:true}:f.appProperties?.shssStorage==='folders-v1'?{archived:false}:{})};
    },
    htmlFile(docId, versionsId, version) {
      if(!child(meta(versionsId),docId,folder)||!child(meta(version.folderId),versionsId,folder))notFound();
      const f=meta(version.htmlFileId);
      if(!child(f,version.folderId,'text/html')||f.name!=='index.html'||!f.capabilities?.canDownload)notFound();
      return f;
    },
    pageFile(docId, versionsId, version, page) {
      if(!child(meta(versionsId),docId,folder)||!child(meta(version.folderId),versionsId,folder))notFound();
      const f=meta(page.htmlFileId),index=version.pages.indexOf(page);
      if(!child(f,version.folderId,'text/html')||f.name!==`page-${index}.html`||f.appProperties?.shssPagePath!==page.path||!f.capabilities?.canDownload)notFound();
      return f;
    },
    // Small pages come from the cache as text; core hashes them. Large pages are
    // read once and returned with the hash of their bytes.
    readHtml: f=>cacheable(f)?readCachedText(f,SHSSCore.limits.html):blobTextWithHash(f,SHSSCore.limits.html),
    commentsFile(docId,id) {
      const f=meta(id);
      return child(f,docId,'application/json')&&f.name==='comments.json'&&f.capabilities?.canDownload ? {id,canEdit:writable(f),meta:f} : null;
    },
    // Writes re-read metadata under the lock. A version+checksum-bound cache
    // can then avoid downloading the same JSON again, including on retries.
    readComments: (f,{cached=false}={})=>cached&&f.meta.sha256Checksum?readCachedText(f.meta,MAX_JSON_BYTES_):blobText(f.meta,MAX_JSON_BYTES_),
    writeComments(f,text) {
      const version=write(f.id,'application/json',text)?.version;
      if(version)try {
        const saved={...f.meta,version,sha256Checksum:digest_(text),size:Utilities.newBlob(text).getBytes().length};
        if(cacheable(saved))CacheService.getUserCache().put(cacheKey(saved),text,300);
      }catch(e){console.warn('Saved comment cache unavailable');}
      return version;
    },
    readSource(id) {
      const f=meta(id);
      if(!f)notFound();
      if(!/\.html?$/i.test(f.name)||!['text/html','text/plain','application/octet-stream'].includes(f.mimeType))fail('UNSUPPORTED','単一のHTMLファイルを指定してください。');
      const text=blobText(f,SHSSCore.limits.html);
      if(f.sha256Checksum&&f.sha256Checksum.toLowerCase()!==digest_(text))fail('VERSION_MISMATCH','元のHTMLが読み込み中に変更されました。');
      return {text,version:f.version||null};
    },
    canImport: ()=>!!canAdd(root),
    canManage: d=>d.manifestCanEdit===true,
    canArchive: d=>meta(d.id)?.capabilities?.canEdit===true&&meta(d.id)?.capabilities?.canMoveItemWithinDrive===true,
    moveDocument,
    canAppend(d) {
      const versions=meta(d.manifest.versionsFolderId);
      return child(versions,d.id,folder)&&versions.capabilities?.canAddChildren===true&&d.manifestCanEdit===true;
    },
    createDocument(title, manifestFor, sourceFileId) {
      const id=create(root,title,folder);
      const versionsFolderId=create(id,'versions',folder);
      const commentsFileId=create(id,'comments.json','application/json',JSON.stringify({schemaVersion:1,documentId:id,revision:0,threads:[],appliedOperations:[]}));
      const m=manifestFor({id,manifest:{versionsFolderId,commentsFileId}});
      const manifest=create(id,'manifest.json','application/json',JSON.stringify(m));
      // Publish the folder to the index only after its files exist.
      Drive.Files.update({appProperties:{shss:'document',shssStorage:'folders-v1',manifest,...(sourceFileId?{sourceFileId}:{})}},id,null,{fields:'id',supportsAllDrives:true});
      return {documentId:id,versionId:m.latestVersionId};
    },
    createVersion(parent,versionId,html) {
      const folderId=create(parent,versionId,folder);
      return {versionId,folderId,htmlFileId:create(folderId,'index.html','text/html',html)};
    },
    createPackageVersion(parent,versionId,pkg,rendered,digest) {
      const folderId=create(parent,versionId,folder),files=[],pages=[];
      let index=0;
      for(const [path,file] of pkg.files) {
        const name=`source-${index++}`,blob=Utilities.newBlob(toSignedBytes_(file.bytes),file.mime,name);
        const fileId=Drive.Files.create({name,mimeType:file.mime,parents:[folderId],appProperties:{shssPath:path,shssType:'source'}},blob,{fields:'id',supportsAllDrives:true}).id;
        files.push({path,fileId,mime:file.mime,size:file.bytes.length,sourceHash:digest(file.bytes)});
      }
      for(const path of pkg.pages) {
        const html=rendered.get(path),name=`page-${pages.length}.html`;
        pages.push({path,htmlFileId:create(folderId,name,'text/html',html,{shssPagePath:path,shssType:'page'}),sourceHash:digest(html)});
      }
      return {versionId,folderId,startPage:pkg.startPage,files,pages,...(files.some(f=>f.mime==='image/svg+xml')?{svgPolicyVersion:SHSSCore.SVG_POLICY_VERSION}:{})};
    },
    listLegacyDocuments() {
      // A processed folder leaves this query, so moving folders cannot shift
      // a saved page cursor and accidentally skip the next batch.
      const page=list(root,`mimeType = '${folder}' and appProperties has { key='shss' and value='document' } and not appProperties has { key='shssStorage' and value='folders-v1' }`,20);
      if(page.incompleteSearch)throw new SHSSCore.AppError('LIST_INCOMPLETE','Driveの検索を完了できませんでした。再実行してください。',true);
      return {ids:(page.files||[]).map(f=>f.id),hasMore:!!page.nextPageToken};
    },
    migrateArchive(id) {
      const d=this.findDocument(id),f=meta(id);
      if(!d||f?.capabilities?.canEdit!==true)return 'skipped';
      if(f.appProperties?.shssStorage==='folders-v1')return 'unchanged';
      const m=SHSSCore.validateManifest(JSON.parse(d.manifestText),id);
      if(m.archivedAt){
        if(!this.canArchive({id}))return 'skipped';
        moveDocument({id},true);
        return 'moved';
      }
      Drive.Files.update({appProperties:{shssStorage:'folders-v1'}},id,null,{fields:'id',supportsAllDrives:true});
      metadata.delete(id);
      return 'unchanged';
    },
    writeManifest: (d,m)=>write(d.manifestId,'application/json',JSON.stringify(m)),
    // Trashes a version folder that was never recorded in the manifest.
    discardVersion(folderId) {
      if(idOk(folderId))Drive.Files.update({trashed:true},folderId,null,{fields:'id',supportsAllDrives:true});
    }
  };
}

// Run from the Apps Script editor as the storage administrator. The trailing
// underscore keeps these maintenance functions unavailable to google.script.run.
// Move archives saved by older versions into the dedicated archive folder.
// Run again until hasMore is false; fix permissions first if skipped is nonzero.
function migrateArchivedDocuments_() {
  const config=configuration_(),store=driveStore_(config.root),page=store.listLegacyDocuments();
  const result={moved:0,unchanged:0,skipped:0,hasMore:page.hasMore};
  for(const id of page.ids){
    const status=withScriptLock_(()=>{
      store.clearMetadata();
      return store.migrateArchive(id);
    },()=>new Error('保存処理中です。時間をおいて再実行してください。'));
    result[status]++;
  }
  console.log(JSON.stringify(result));
  return result;
}

function backupAllComments_() {
  const BACKUPS_PER_DOCUMENT=10;
  const config=configuration_(),props=PropertiesService.getScriptProperties();
  const backupRoot=props.getProperty('SHSS_BACKUP_FOLDER_ID')||'';
  if(!isDriveId_(backupRoot)||backupRoot===config.root)throw new Error('SHSS_BACKUP_FOLDER_IDに別の非公開フォルダを設定してください。');
  const root=Drive.Files.get(backupRoot,{fields:'id,mimeType,capabilities(canAddChildren)',supportsAllDrives:true});
  if(root.mimeType!==FOLDER_MIME_||root.capabilities?.canAddChildren!==true)throw new Error('バックアップフォルダに追加できません。');
  const store=driveStore_(config.root);let cursor=null,count=0;
  do {
    const page=store.listDocuments(cursor);
    for(const id of page.ids) {
      const record=store.findDocument(id);if(!record)continue;
      const manifest=JSON.parse(record.manifestText),file=store.commentsFile(id,manifest.commentsFileId);
      if(!file)continue;
      withScriptLock_(()=>{
        const raw=store.readComments(file),state=SHSSCore.validateComments(JSON.parse(raw),id);
        const name=`comments-${id}-${timestamp_()}.json`;
        Drive.Files.create({name,mimeType:'application/json',parents:[backupRoot],appProperties:{shssBackupDocumentId:id,shssBackupRevision:String(state.revision)}},Utilities.newBlob(raw,'application/json',name),{fields:'id',supportsAllDrives:true});
      },()=>new Error('保存処理中です。再試行してください。'));
      // Keep the newest BACKUPS_PER_DOCUMENT backups of each document.
      const backups=[];let next=null;
      do {
        const page=Drive.Files.list({q:`'${backupRoot}' in parents and trashed = false and appProperties has { key='shssBackupDocumentId' and value='${id}' }`,fields:'files(id,createdTime),nextPageToken',pageSize:100,pageToken:next,orderBy:'createdTime desc',supportsAllDrives:true,includeItemsFromAllDrives:true});
        backups.push(...(page.files||[]));next=page.nextPageToken||null;
      }while(next);
      for(const old of backups.slice(BACKUPS_PER_DOCUMENT))Drive.Files.update({trashed:true},old.id,null,{fields:'id',supportsAllDrives:true});
      count++;
    }
    cursor=page.cursor;
  }while(cursor);
  console.log(`Backed up ${count} SHSS documents`);
}

function restoreCommentsFromBackup_() {
  const config=configuration_(),props=PropertiesService.getScriptProperties();
  const docId=props.getProperty('SHSS_RESTORE_DOCUMENT_ID')||'';
  const backupId=props.getProperty('SHSS_RESTORE_BACKUP_ID')||'';
  const backupRoot=props.getProperty('SHSS_BACKUP_FOLDER_ID')||'';
  if(![docId,backupId,backupRoot].every(isDriveId_)||backupRoot===config.root)throw new Error('復旧対象IDと別のバックアップフォルダIDを設定してください。');
  const backup=Drive.Files.get(backupId,{fields:'id,mimeType,parents,appProperties,size,capabilities(canDownload)',supportsAllDrives:true});
  if(backup.mimeType!=='application/json'||!backup.parents?.includes(backupRoot)||backup.appProperties?.shssBackupDocumentId!==docId||!backup.capabilities?.canDownload)throw new Error('この文書のバックアップではありません。');
  const store=driveStore_(config.root),record=store.findDocument(docId);
  if(!record)throw new Error('文書を読み取れません。');
  const manifest=JSON.parse(record.manifestText),file=store.commentsFile(docId,manifest.commentsFileId);
  if(!file?.canEdit)throw new Error('コメントファイルの編集権限がありません。');
  if(Number(backup.size)>MAX_JSON_BYTES_)throw new Error('バックアップが上限を超えています。');
  const raw=DriveApp.getFileById(backupId).getBlob().getDataAsString('UTF-8');
  const restored=SHSSCore.validateComments(JSON.parse(raw),docId);
  withScriptLock_(()=>{
    // A higher revision and a new epoch make open clients reload instead of
    // overwriting the restored comments with stale operations.
    let currentRevision=0;
    try {currentRevision=SHSSCore.validateComments(JSON.parse(store.readComments(file)),docId).revision;}catch(e){console.warn('Current comments cannot be parsed; restoring backup');}
    restored.revision=Math.max(currentRevision,restored.revision)+1;
    restored.epoch=Utilities.getUuid();
    const serialized=JSON.stringify(restored);
    if(Utilities.newBlob(serialized).getBytes().length>MAX_JSON_BYTES_)throw new Error('復旧後のJSONが上限を超えています。');
    const before=DriveApp.getFileById(file.id).getBlob();
    const beforeName=`pre-restore-${docId}-${timestamp_()}.json`;
    Drive.Files.create({name:beforeName,mimeType:'application/json',parents:[backupRoot],appProperties:{shssPreRestoreDocumentId:docId}},before,{fields:'id',supportsAllDrives:true});
    store.writeComments(file,serialized);
  },()=>new Error('保存処理中です。再試行してください。'));
  console.log(`Restored ${docId} from ${backupId} at revision ${restored.revision}`);
}
