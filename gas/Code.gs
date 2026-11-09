function doGet(e) {
  const config = configuration_();
  const template = HtmlService.createTemplateFromFile('Index');
  const url = ScriptApp.getService().getUrl();
  const param = e && e.parameter || {};
  template.boot = JSON.stringify({url, documentId: param.doc || '', versionId: param.v || '',pagePath:param.p||''}).replace(/</g, '\\u003c');
  if (!email_(config.domain)) return HtmlService.createHtmlOutput('対象のGoogle Workspaceアカウントでアクセスしてください。');
  return template.evaluate().setTitle('SHSS').addMetaTag('viewport','width=device-width, initial-scale=1');
}

function rpc(action, input) {
  try {
    const config = configuration_();
    const store = driveStore_(config.root);
    const run = SHSSCore.createService({
      store, identity: () => identity_(config.domain),
      uuid: () => Utilities.getUuid(), now: () => new Date().toISOString(), digest: digest_,
      locked: fn => {
        const lock=LockService.getScriptLock();
        if(!lock.tryLock(7000)) throw new SHSSCore.AppError('BUSY','保存が混み合っています。再試行してください。',true);
        try {
          store.clearMetadata();
          return fn();
        } finally {lock.releaseLock();}
      }
    });
    return {ok:true,value:run(action,input)};
  } catch(error) {
    if(error instanceof SHSSCore.AppError) return {ok:false,error:{code:error.code,message:error.message,retryable:error.retryable}};
    console.error('SHSS RPC failed');
    return {ok:false,error:{code:'INTERNAL',message:'処理に失敗しました。時間をおいて再試行してください。',retryable:true}};
  }
}

function configuration_() {
  const props=PropertiesService.getScriptProperties();
  const root=props.getProperty('SHSS_ROOT_FOLDER_ID')||'';
  const domain=(props.getProperty('SHSS_DOMAIN')||'').trim().toLowerCase();
  if(!/^[\w-]{1,128}$/.test(root)||!domain) throw new SHSSCore.AppError('CONFIG','管理フォルダとドメインを設定してください。');
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
      if(actor.email===email&&typeof actor.id==='string'&&/^[\w-]{1,128}$/.test(actor.id)&&typeof actor.displayName==='string'&&actor.displayName.length<=160)return {id:actor.id,displayName:actor.displayName};
    }
  }catch(e){console.warn('Identity cache unavailable');}
  const user=Drive.About.get({fields:'user(permissionId,displayName,emailAddress)'}).user;
  if(!user||user.emailAddress?.toLowerCase()!==email||!user.permissionId)return null;
  const actor={id:user.permissionId,displayName:(user.displayName||email).slice(0,160)};
  if(cache)try {cache.put('drive-user:'+email,JSON.stringify({...actor,email}),300);}catch(e){console.warn('Identity cache unavailable');}
  return actor;
}

function hex_(bytes) {return bytes.map(b=>((b+256)%256).toString(16).padStart(2,'0')).join('');}
function digest_(text) {return hex_(typeof text==='string'?Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8):Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,Array.from(text,b=>b>127?b-256:b)));}

function driveStore_(root) {
  const folder='application/vnd.google-apps.folder';
  const fields='id,name,mimeType,parents,trashed,size,version,sha256Checksum,appProperties,capabilities(canDownload,canEdit,canModifyContent,canAddChildren)';
  const metadata=new Map(), preparedDocuments=new Set();
  const fail=(code,message)=>{throw new SHSSCore.AppError(code,message);};
  const notFound=()=>fail('NOT_FOUND','文書または版が見つかりません。');
  const forbidden=()=>fail('FORBIDDEN','この操作に必要なDrive権限がありません。');
  const unavailable=error=>/file not found|insufficient (?:file )?permissions|access denied|permission denied|not authorized|do not have permission|forbidden|\b(?:403|404)\b/i.test(String(error.message||error));
  const idOk=id=>typeof id==='string'&&/^[\w-]{1,128}$/.test(id);
  function meta(id) {
    if(!idOk(id))return null;
    if(metadata.has(id))return metadata.get(id);
    try {
      const f=Drive.Files.get(id,{fields,supportsAllDrives:true});
      return f.trashed?null:f;
    }catch(e){if(unavailable(e))return null;throw e;}
  }
  const child=(f,parent,mime)=>!!(f&&f.mimeType===mime&&f.parents?.includes(parent));
  const writable=f=>f?.capabilities?.canEdit===true&&f?.capabilities?.canModifyContent===true;
  function list(parent,where,limit,cursor) {
    return Drive.Files.list({q:`'${parent}' in parents and trashed = false and ${where}`,fields:`nextPageToken,files(${fields})`,pageSize:limit,pageToken:cursor,orderBy:'createdTime desc',supportsAllDrives:true,includeItemsFromAllDrives:true});
  }
  function prefetch(clauses) {
    if(!clauses.length)return;
    const q='trashed = false and ('+clauses.join(' or ')+')';
    // Search is an optimization. Fetch any missing files by ID.
    if(q.length>4800)return;
    try {
      const page=Drive.Files.list({q,fields:'files('+fields+')',pageSize:100,
        supportsAllDrives:true,includeItemsFromAllDrives:true});
      for(const file of page.files||[]){
        if(idOk(file.id)&&!file.trashed&&file.capabilities)metadata.set(file.id,file);
      }
    }catch(e){console.warn('Drive metadata prefetch unavailable');}
  }
  function prepareDocuments(ids) {
    const pending=ids.filter(id=>idOk(id)&&!preparedDocuments.has(id));
    if(!pending.length)return;
    for(const id of pending)preparedDocuments.add(id);
    const parents=pending.map(id=>"'"+id+"' in parents").join(' or ');
    prefetch(["("+parents+") and (name = 'manifest.json' or name = 'comments.json' or name = 'versions')"]);
  }
  function blobText(file, max) {
    if(!file?.capabilities?.canDownload)forbidden();
    if(Number(file.size)>max)fail('TOO_LARGE','ファイルが上限を超えています。');
    let blob;
    try {blob=DriveApp.getFileById(file.id).getBlob();}catch(e){if(unavailable(e))forbidden();throw e;}
    const bytes=blob.getBytes();
    if(bytes.length>max)fail('TOO_LARGE','ファイルが上限を超えています。');
    const text=blob.getDataAsString('UTF-8');
    if(hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,bytes))!==digest_(text))fail('INVALID_DATA','UTF-8のファイルを指定してください。');
    return text;
  }
  function readCachedText(file,max) {
    if(!file?.capabilities?.canDownload)forbidden();
    if(Number(file.size)>max)fail('TOO_LARGE','ファイルが上限を超えています。');
    if(!file.version || !(Number(file.size)<=80000)) return blobText(file,max);
    let cache;
    const key='file-text:'+digest_(file.id+':'+file.version);
    try {
      cache=CacheService.getUserCache();
      const cached=cache.get(key);
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
  return {
    clearMetadata() {metadata.clear();preparedDocuments.clear();},
    prefetchVersions(refs) {
      const clauses=new Set();
      for(const {versionsFolderId,v,page} of refs){
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
    },
    listSources(cursor) {
      const page=list(root,`mimeType = 'text/html'`,20,cursor);
      return {files:(page.files||[]).filter(f=>f.capabilities?.canDownload&&/\.html?$/i.test(f.name))
        .map(f=>({id:f.id,name:f.name,version:f.version||null})),cursor:page.nextPageToken||null};
    },
    findImportedSource(sourceFileId) {
      const page=list(root,`mimeType = '${folder}' and appProperties has { key='sourceFileId' and value='${sourceFileId}' }`,20);
      return (page.files||[]).find(f=>f.appProperties?.shss==='document')?.id||null;
    },
    listDocuments(cursor) {
      const page=list(root,`mimeType = '${folder}' and appProperties has { key='shss' and value='document' }`,20,cursor);
      const files=page.files||[];
      const ids=files.map(f=>f.id);
      for(const file of files)metadata.set(file.id,file);
      prepareDocuments(ids);
      return {ids,cursor:page.nextPageToken||null};
    },
    findDocument(id) {
      const f=meta(id);
      if(!child(f,root,folder)||f.trashed||f.appProperties?.shss!=='document')return null;
      prepareDocuments([id]);
      const manifest=meta(f.appProperties.manifest);
      if(!child(manifest,id,'application/json')||manifest.name!=='manifest.json'||!manifest.capabilities?.canDownload)return null;
      return {manifestId:manifest.id,manifestCanEdit:writable(manifest),manifestText:readCachedText(manifest,1024*1024)};
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
    readHtml: f=>readCachedText(f,8*1024*1024),
    commentsFile(docId,id) {
      const f=meta(id);
      return child(f,docId,'application/json')&&f.name==='comments.json'&&f.capabilities?.canDownload ? {id,canEdit:writable(f),meta:f} : null;
    },
    readComments: (f,{cached=false}={})=>cached?readCachedText(f.meta,1024*1024):blobText(f.meta,1024*1024),
    writeComments: (f,text)=>write(f.id,'application/json',text)?.version,
    readSource(id) {
      const f=meta(id);
      if(!f)notFound();
      if(!/\.html?$/i.test(f.name)||!['text/html','text/plain','application/octet-stream'].includes(f.mimeType))fail('UNSUPPORTED','単一のHTMLファイルを指定してください。');
      const text=blobText(f,2*1024*1024);
      if(f.sha256Checksum&&f.sha256Checksum.toLowerCase()!==digest_(text))fail('VERSION_MISMATCH','元のHTMLが読み込み中に変更されました。');
      return {text,version:f.version||null};
    },
    canImport: ()=>!!canAdd(root),
    canManage: d=>d.manifestCanEdit===true,
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
      Drive.Files.update({appProperties:{shss:'document',manifest,...(sourceFileId?{sourceFileId}:{})}},id,null,{fields:'id',supportsAllDrives:true});
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
        const name=`source-${index++}`,blob=Utilities.newBlob(Array.from(file.bytes,b=>b>127?b-256:b),file.mime,name);
        const fileId=Drive.Files.create({name,mimeType:file.mime,parents:[folderId],appProperties:{shssPath:path,shssType:'source'}},blob,{fields:'id',supportsAllDrives:true}).id;
        files.push({path,fileId,mime:file.mime,size:file.bytes.length,sourceHash:digest(file.bytes)});
      }
      for(const path of pkg.pages) {
        const html=rendered.get(path),name=`page-${pages.length}.html`;
        pages.push({path,htmlFileId:create(folderId,name,'text/html',html,{shssPagePath:path,shssType:'page'}),sourceHash:digest(html)});
      }
      return {versionId,folderId,startPage:pkg.startPage,files,pages,...(files.some(f=>f.mime==='image/svg+xml')?{svgPolicyVersion:SHSSCore.SVG_POLICY_VERSION}:{})};
    },
    writeManifest: (d,m)=>write(d.manifestId,'application/json',JSON.stringify(m))
  };
}

// Run from the Apps Script editor as the storage administrator. The trailing
// underscore keeps these maintenance functions unavailable to google.script.run.
function backupAllComments_() {
  const config=configuration_(),props=PropertiesService.getScriptProperties();
  const backupRoot=props.getProperty('SHSS_BACKUP_FOLDER_ID')||'';
  if(!/^[\w-]{1,128}$/.test(backupRoot)||backupRoot===config.root)throw new Error('SHSS_BACKUP_FOLDER_IDに別の非公開フォルダを設定してください。');
  const root=Drive.Files.get(backupRoot,{fields:'id,mimeType,capabilities(canAddChildren)',supportsAllDrives:true});
  if(root.mimeType!=='application/vnd.google-apps.folder'||root.capabilities?.canAddChildren!==true)throw new Error('バックアップフォルダに追加できません。');
  const store=driveStore_(config.root);let cursor=null,count=0;
  do {
    const page=store.listDocuments(cursor);
    for(const id of page.ids) {
      const record=store.findDocument(id);if(!record)continue;
      const manifest=JSON.parse(record.manifestText),file=store.commentsFile(id,manifest.commentsFileId);
      if(!file)continue;
      const lock=LockService.getScriptLock();
      if(!lock.tryLock(7000))throw new Error('保存処理中です。再試行してください。');
      try {
        const raw=store.readComments(file),state=SHSSCore.validateComments(JSON.parse(raw),id);
        const name=`comments-${id}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
        Drive.Files.create({name,mimeType:'application/json',parents:[backupRoot],appProperties:{shssBackupDocumentId:id,shssBackupRevision:String(state.revision)}},Utilities.newBlob(raw,'application/json',name),{fields:'id',supportsAllDrives:true});
      }finally{lock.releaseLock();}
      const backups=[];let next=null;
      do {
        const page=Drive.Files.list({q:`'${backupRoot}' in parents and trashed = false and appProperties has { key='shssBackupDocumentId' and value='${id}' }`,fields:'files(id,createdTime),nextPageToken',pageSize:100,pageToken:next,orderBy:'createdTime desc',supportsAllDrives:true,includeItemsFromAllDrives:true});
        backups.push(...(page.files||[]));next=page.nextPageToken||null;
      }while(next);
      for(const old of backups.slice(10))Drive.Files.update({trashed:true},old.id,null,{fields:'id',supportsAllDrives:true});
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
  if(![docId,backupId,backupRoot].every(id=>/^[\w-]{1,128}$/.test(id))||backupRoot===config.root)throw new Error('復旧対象IDと別のバックアップフォルダIDを設定してください。');
  const backup=Drive.Files.get(backupId,{fields:'id,mimeType,parents,appProperties,size,capabilities(canDownload)',supportsAllDrives:true});
  if(backup.mimeType!=='application/json'||!backup.parents?.includes(backupRoot)||backup.appProperties?.shssBackupDocumentId!==docId||!backup.capabilities?.canDownload)throw new Error('この文書のバックアップではありません。');
  const store=driveStore_(config.root),record=store.findDocument(docId);
  if(!record)throw new Error('文書を読み取れません。');
  const manifest=JSON.parse(record.manifestText),file=store.commentsFile(docId,manifest.commentsFileId);
  if(!file?.canEdit)throw new Error('コメントファイルの編集権限がありません。');
  if(Number(backup.size)>1024*1024)throw new Error('バックアップが上限を超えています。');
  const raw=DriveApp.getFileById(backupId).getBlob().getDataAsString('UTF-8');
  const restored=SHSSCore.validateComments(JSON.parse(raw),docId);
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(7000))throw new Error('保存処理中です。再試行してください。');
  try {
    let currentRevision=0;
    try {currentRevision=SHSSCore.validateComments(JSON.parse(store.readComments(file)),docId).revision;}catch(e){console.warn('Current comments cannot be parsed; restoring backup');}
    restored.revision=Math.max(currentRevision,restored.revision)+1;
    restored.epoch=Utilities.getUuid();
    const serialized=JSON.stringify(restored);
    if(Utilities.newBlob(serialized).getBytes().length>1024*1024)throw new Error('復旧後のJSONが上限を超えています。');
    const before=DriveApp.getFileById(file.id).getBlob();
    const beforeName=`pre-restore-${docId}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    Drive.Files.create({name:beforeName,mimeType:'application/json',parents:[backupRoot],appProperties:{shssPreRestoreDocumentId:docId}},before,{fields:'id',supportsAllDrives:true});
    store.writeComments(file,serialized);
  }finally{lock.releaseLock();}
  console.log(`Restored ${docId} from ${backupId} at revision ${restored.revision}`);
}
