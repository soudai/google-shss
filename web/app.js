import {PreviewCache,optimisticComments} from './fast-state.mjs';
import {CommentOutbox,pageKey} from './background.mjs';
import {UNKNOWN_IMPORT,createImportDialog} from './import-dialog.mjs';
import {createCaller,scriptRunApi} from './rpc.mjs';
import {$,button,create} from './dom.mjs';
import {isRegionAnchor,isTextAnchor,normalizeAnchor} from '../shared/anchor.mjs';
(() => {
  const boot=window.SHSS_BOOT;
  const bridge=window.SHSS_BRIDGE;
  delete window.SHSS_BOOT;delete window.SHSS_BRIDGE;
  const call=createCaller(window.SHSS_API||scriptRunApi(google.script.run));
  let current=null,frame=null,context=null,frameReady=false,found=null,threads=[],confirmedThreads=[],selected=null,draft=null,filter='open',cursor=null;
  let generation=0,commentRequest=0,previewTimer,noticeTimer,pollTimer,refreshing=false,revision=null,commentVersion=null,commentEpoch=null,pollDelay=15000,regionMode=false;
  // Background imports; set once the import dialog is created below.
  let imports=null;
  let replyId=null,archiveView=false,libraryDocuments=[],manageId=null;
  let validating=false,commentNotice='',prefetchTimer,prefetchBusy=false,openingAt=0;
  // Local DOM measurements contain durations only; no content or telemetry is sent.
  function afterPaint(element,start,key,valid=()=>true) {
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if(valid())element.dataset[key]=String(Math.round(performance.now()-start));
    }));
  }
  const previews=new PreviewCache(input=>call('getDocument',input));
  let prefetchQueue=[];
  function queuePreviews(inputs) {
    clearTimeout(prefetchTimer);prefetchQueue=inputs.filter(input=>!previews.peek(input)).slice(0,2);
    prefetchTimer=setTimeout(prefetchNext,250);
  }
  async function prefetchNext() {
    // Prefetching yields to uploads, which need the bandwidth more.
    if(prefetchBusy||outbox.running||imports.busy||document.hidden||!prefetchQueue.length)return;
    prefetchBusy=true;
    try {await previews.request(prefetchQueue.shift());}catch{}
    finally {prefetchBusy=false;if(prefetchQueue.length)prefetchTimer=setTimeout(prefetchNext,250);}
  }
  const titleTasks=new Set();
  let outboxRenderQueued=false;
  function scheduleOutboxRender() {
    if(outboxRenderQueued)return;
    outboxRenderQueued=true;
    queueMicrotask(()=>{
      outboxRenderQueued=false;
      renderBackground();
      if(current){renderPreservingReply();sync();status();}
    });
  }
  const outbox=new CommentOutbox(request=>call('submitOperation',request),{
    changed:scheduleOutboxRender,
    saved:(entry,result)=>{
      previews.clearComments(entry.request.documentId);
      if(current&&pageKey(current)===pageKey(entry.request)&&current.canReadComments){
        if(selected==='pending-'+entry.request.operationId)selected=result.threadId;
        revision=null;applyComments({...result.comments,canWrite:current.canWriteComments},false);
        const timing=$('comment-status');timing.dataset.saveOutcome='saved';afterPaint(timing,entry.started,'saveMs',()=>current&&pageKey(current)===pageKey(entry.request));
        commentNotice='保存しました';status();scheduleRefresh();
      }
    },
    failed:(entry,error)=>{
      if(!current||pageKey(current)!==pageKey(entry.request))return;
      if(error.code==='FORBIDDEN'||error.code==='NOT_FOUND'){current.canWriteComments=false;previews.clear();outbox.snapshots.delete(pageKey(current));}
      const {type,payload}=entry.request;
      if(type==='add'&&!draft){draft=payload.anchor;$('body').value=entry.meta.body;selected='draft';panel(true);}
      if(type==='reply'&&!replyId){replyId=payload.threadId;replyDrafts.set(replyId,entry.meta.body);panel(true);}
      $('comment-status').dataset.saveOutcome='failed';scheduleRefresh();
    }
  });
  function status(text='') {
    const active=outbox.active(current).length,failed=outbox.errors(current).length;
    $('comment-status').textContent=failed?'保存を確認できない操作があります。「保存状況」から再試行できます。':
      active?'保存中…（'+active+'件）':commentNotice||text||(current?.canWriteComments?'':'閲覧のみ');
  }
  function renderPreservingReply() {
    const input=$('reply-input'),focused=input&&document.activeElement===input;
    const selection=focused?[input.selectionStart,input.selectionEnd]:null;
    render();
    const next=$('reply-input');if(selection&&next&&!next.disabled){next.focus({preventScroll:true});next.setSelectionRange(...selection);}
  }
  function showSaveDialog() {$('save-dialog').showModal();renderBackground();}
  function importRow(job) {
    const li=create('li');li.append(create('strong','取り込み: '+job.label));
    const uploading=job.state==='uploading';
    li.append(create('p',job.state==='failed'?(job.unknown?UNKNOWN_IMPORT:job.error.message):uploading?'アップロード中…':'取り込み待ち'));
    if(job.state==='failed'){
      if(job.unknown)li.append(button('文書一覧を確認',()=>{imports.dismiss(job);$('save-dialog').close();library();}));
      else li.append(button('再試行',()=>imports.retry(job)),button('やめる',()=>imports.dismiss(job)));
    }
    return li;
  }
  function renderBackground() {
    const failures=outbox.entries.filter(e=>e.state==='failed').length+[...titleTasks].filter(t=>t.pending&&t.error).length+imports.failed.length;
    const saving=outbox.entries.filter(e=>e.state!=='failed').length+[...titleTasks].filter(t=>t.pending&&!t.error).length;
    const uploading=imports.active.length;
    $('save-status').textContent=failures?'未保存 '+failures+'件':uploading?'取り込み中…（'+uploading+'件）':saving?'保存中…（'+saving+'件）':'';
    $('save-details').hidden=!outbox.entries.length&&![...titleTasks].some(t=>t.pending)&&!imports.jobs.length;
    if(!$('save-dialog').open)return;
    const rows=imports.jobs.map(importRow);
    rows.push(...outbox.entries.map(entry=>{
      const li=create('li');li.append(create('strong',entry.meta.title+' / '+(entry.request.pagePath||'index.html')));
      if(entry.request.payload.body)li.append(create('p',entry.request.payload.body));
      li.append(create('p',entry.state==='failed'?entry.error.message:entry.state==='saving'?'保存中…':'保存待ち'));
      li.append(button('文書を開く',async()=>{
        $('save-dialog').close();await open(entry.request.documentId,entry.request.versionId,entry.request.pagePath);
        if(current&&pageKey(current)===pageKey(entry.request)){panel(true);historyPage(current);}
      }));
      if(entry.state==='failed'){
        li.append(button('再試行',()=>outbox.retry(entry)),button('再試行をやめる',()=>{
          outbox.dismiss(entry);notify('再試行を停止しました。保存結果は文書を再読み込みして確認してください。');
        }));
      }
      return li;
    }));
    for(const task of titleTasks)if(task.pending){
      const li=create('li');li.append(create('strong','タイトル: '+task.desired),create('p',task.error?.message||'タイトルを保存中…'));
      if(task.error)li.append(button('タイトルを再試行',()=>task.flush()));
      rows.push(li);
    }
    $('save-list').replaceChildren(...(rows.length?rows:[create('li','すべて保存しました。')]));
  }
  window.addEventListener('beforeunload',event=>{
    if(outbox.entries.length||imports.busy||[...titleTasks].some(t=>t.pending)){event.preventDefault();event.returnValue='';}
  });
  let messageWindow=0,messageCount=0;
  const replyDrafts=new Map();
  const pageDrafts=new Map();
  const draftKey=d=>`${d.documentId}:${d.versionId}:${d.pagePath||'index.html'}`;
  // A short message at the bottom of the screen, optionally with one action.
  // Messages with an action stay longer so there is time to use it.
  function notify(text,action=null) {
    const notice=$('notice');
    notice.replaceChildren(create('span',text));
    if(action)notice.append(button(action.label,()=>{notice.hidden=true;action.run();}));
    notice.hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>notice.hidden=true,action?10000:3800);
  }
  function panel(open) {$('comments').hidden=!open;$('toggle').setAttribute('aria-expanded',String(open));}
  function bar(view,canImport=false) {
    for(const id of ['versions','share','toggle','preview-reload','region-toggle'])$(id).hidden=!view;
    if(!view)$('pages').hidden=true;
    $('import').hidden=!canImport;
  }
  function dropFrame() {if($('external-dialog').open)$('external-dialog').close();frame?.remove();frame=null;context=null;frameReady=false;messageWindow=0;messageCount=0;clearTimeout(previewTimer);}
  function clean() {
    validating=false;commentNotice='';clearTimeout(prefetchTimer);prefetchQueue=[];$('load-status').textContent='';
    dropFrame();clearTimeout(pollTimer);commentRequest++;revision=null;commentVersion=null;commentEpoch=null;pollDelay=15000;setRegionMode(false);current=null;threads=[];confirmedThreads=[];selected=null;draft=null;filter='open';replyId=null;found=null;
    $('body').value='';$('compose').hidden=true;$('comment-status').textContent='';panel(false);
  }
  function renderLibrary() {
    const query=$('search').value.trim().toLocaleLowerCase();
    const rows=libraryDocuments.filter(d=>d.title.toLocaleLowerCase().includes(query)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    $('documents').replaceChildren(...rows.map(d=>{
      const li=create('li');
      const link=button(d.title,async()=>{await open(d.documentId,d.latestVersionId,undefined,'',d.title);if(current?.documentId===d.documentId)historyPage(current);});
      const warm=()=>queuePreviews([{documentId:d.documentId,versionId:d.latestVersionId}]);
      link.addEventListener('pointerenter',warm);link.addEventListener('focus',warm);
      li.append(link);
      if(d.canManage) {
        li.append(button('名前を変更',()=>{
          manageId=d.documentId;$('manage-name').value=d.title;$('manage-dialog').showModal();
        }));
        li.append(button(archiveView?'戻す':'アーカイブ',async()=>{
          try {
            await call('manageDocument',{documentId:d.documentId,type:archiveView?'restore':'archive'});documentsChanged();
            library();
          }catch(e){notify(e.message);}
        }));
      }
      return li;
    }));
    if(!rows.length&&!cursor)$('documents').append(create('li',query?'一致する文書はありません。':'文書がありません。'));
    queuePreviews(rows.slice(0,2).map(d=>({documentId:d.documentId,versionId:d.latestVersionId})));
  }
  // The last first page of each list, shown at once while a fresh copy loads.
  const libraryCache=new Map();
  // Drops cached previews and lists after a title, version or archive change.
  function documentsChanged() {previews.clear();libraryCache.clear();}
  async function library(more=false) {
    const ticket=++generation,view=archiveView;
    if(!more){
      clean();$('library').hidden=false;$('viewer').hidden=true;$('title').textContent='';cursor=null;
      const cached=libraryCache.get(view);
      libraryDocuments=cached?[...cached.documents]:[];bar(false,cached?.canImport);
      if(cached)renderLibrary();else $('documents').replaceChildren(create('li','読み込み中…','meta'));
      $('load-status').textContent=cached?'更新中…':'';$('more').hidden=true;
    }
    $('more').disabled=true;
    try {
      const page=await call('listDocuments',{...(cursor?{cursor}:{}),archived:view});
      if(ticket!==generation)return;
      if(!more){libraryDocuments=[];libraryCache.set(view,page);}
      cursor=page.cursor;bar(false,page.canImport);$('more').hidden=!cursor;
      libraryDocuments.push(...page.documents);renderLibrary();
    }catch(e){if(ticket===generation)notify(e.message);}
    finally {if(ticket===generation){$('more').disabled=false;$('load-status').textContent='';}}
  }

  function mountPreview(d,started=performance.now()) {
    const f=create('iframe');
    f.title=d.title;f.setAttribute('sandbox','allow-scripts');f.referrerPolicy='no-referrer';
    context={shss:1,session:crypto.randomUUID(),documentId:d.documentId,versionId:d.versionId,pagePath:d.pagePath};
    const policy="default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
    const bootScript=bridge.replace('__SHSS_CONTEXT__',JSON.stringify(context));
    // CSP and the bridge precede every token from the source. The source bytes are stored separately.
    f.srcdoc='<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+policy+'"><script>'+bootScript+'<'+ '/script>'+d.html.replace(/^\s*<!doctype[^>]*>/i,'');
    let loaded=false;
    f.addEventListener('load',()=>{
      if(frame!==f)return;
      if(loaded){dropFrame();$('preview').textContent='プレビュー内の移動を停止しました。';return;}
      loaded=true;sync();afterPaint($('preview'),started,'displayMs',()=>frame===f);
    });
    frame=f;$('preview').replaceChildren(f);
    previewTimer=setTimeout(()=>{if(frame===f&&!frameReady)notify('HTMLのコメント機能を初期化できませんでした。');},8000);
  }
  function showDocument(d,fragment='',provisional=false) {
    for(const task of titleTasks)if(task.documentId===d.documentId&&task.lastSavedAt>=openingAt)d={...d,title:task.confirmed};
    const reuse=current&&current.documentId===d.documentId&&current.versionId===d.versionId&&current.pagePath===d.pagePath&&current.html===d.html;
    if(current&&!reuse){
      if(draft)pageDrafts.set(draftKey(current),{draft,body:$('body').value});
      draft=null;selected=null;found=null;$('body').value='';
    }
    current={...d,canWriteComments:!provisional&&d.canWriteComments,canPrepareComment:provisional&&d.canWriteComments,canAppend:!provisional&&d.canAppend};
    validating=provisional;$('title').textContent=d.title;bar(true);
    $('load-status').textContent=provisional?'更新を確認中…':'';
    $('pages').replaceChildren(...d.pages.map(path=>{const option=create('option',path);option.value=path;return option;}));
    $('pages').value=d.pagePath;$('pages').hidden=d.pages.length<2;
    if(!reuse) {
      const saved=pageDrafts.get(draftKey(d));if(saved){draft=saved.draft;$('body').value=saved.body;selected='draft';}
      dropFrame();mountPreview(d,openingAt);
      if(fragment){const target=frame,expected=context;target.addEventListener('load',()=>{if(frame===target)target.contentWindow.postMessage({...expected,type:'fragment',fragment},'*');},{once:true});}
    }
    // Cached comments are a preview; permission must be rechecked before any edit.
    if(d.comments) {
      revision=null;
      applyComments(provisional?{...d.comments,canWrite:false}:d.comments);
    }else {
      confirmedThreads=[];current.canWriteComments=false;render();sync();
      status(d.commentsError?.message||'コメントへのアクセス権がありません。');
    }
    if(draft){panel(true);renderComposer();}
  }
  // title, when known from the list, is shown while the document loads.
  async function open(documentId,versionId,pagePath,fragment='',title='') {
    if(current){if(draft)pageDrafts.set(draftKey(current),{draft,body:$('body').value});else pageDrafts.delete(draftKey(current));}
    const input={documentId,...(versionId?{versionId}:{}),...(pagePath?{pagePath}:{})};
    const cached=previews.peek(input),ticket=++generation;openingAt=performance.now();$('preview').dataset.displayMs='';$('preview').dataset.source=cached?'prefetched':'network';clean();bar(false);$('library').hidden=true;$('viewer').hidden=false;
    $('preview').textContent='読み込み中…';$('title').textContent=title;
    if(cached)showDocument(cached,fragment,true);
    try {
      const d=await previews.request(input);
      if(ticket!==generation)return;
      showDocument(d,fragment);
      if(d.canReadComments)scheduleRefresh();
      const at=d.pages.indexOf(d.pagePath);
      queuePreviews([d.pages[at+1],d.pages[at-1]].filter(Boolean).map(pagePath=>({documentId:d.documentId,versionId:d.versionId,pagePath})));
    }catch(e){if(ticket===generation){
      previews.clear();clean();bar(false);$('title').textContent='';
      $('preview').replaceChildren(create('p',e.message),button('再試行',()=>open(documentId,versionId,pagePath,fragment)),button('文書一覧',()=>library()));
    }}
  }
  function applyComments(result,renderNow=true) {
    if(result.unchanged) {
      status(current.canWriteComments?'':'閲覧のみ');
      return;
    }
    result=outbox.prefer(current,result);
    const changed=revision!==result.revision||current.canWriteComments!==result.canWrite||commentVersion!==result.versionToken;
    commentVersion=result.versionToken;
    commentEpoch=result.epoch||null;
    current.canWriteComments=result.canWrite;
    status(validating?'更新を確認中…':result.canWrite?'':'閲覧のみ');
    if(!changed)return;
    revision=result.revision;
    confirmedThreads=result.threads;
    if(renderNow){renderPreservingReply();sync();}
  }

  function scheduleRefresh() {
    clearTimeout(pollTimer);
    if(current?.canReadComments && !validating && !document.hidden)pollTimer=setTimeout(refresh,pollDelay);
  }
  async function refresh() {
    if(!current || validating || outbox.active(current).length || refreshing || document.hidden){scheduleRefresh();return;}
    refreshing=true;
    const d=current, request=++commentRequest;
    try {
      const result=await call('getComments',{documentId:d.documentId,versionId:d.versionId,pagePath:d.pagePath,versionToken:commentVersion,canWrite:d.canWriteComments});
      if(current!==d||request!==commentRequest)return;
      applyComments(result);
      pollDelay=15000;
    }catch(e){if(current===d&&request===commentRequest){
      if(e.code==='FORBIDDEN'||e.code==='NOT_FOUND'){previews.clear();d.canReadComments=false;d.canWriteComments=false;confirmedThreads=[];revision=null;commentVersion=null;render();sync();}
      else pollDelay=Math.min(pollDelay*2,120000);
      $('comment-status').textContent=e.message;
    }}finally{refreshing=false;scheduleRefresh();}
  }
  function sync(focus=false) {
    if(!frameReady||!frame||!context)return;
    const items=threads.filter(t=>t.status==='open').map(({id,anchor})=>({id,anchor}));
    if(draft)items.push({id:'draft',anchor:draft});
    frame.contentWindow.postMessage({...context,type:'annotations',items,selected,focus,regionMode},'*');
  }
  function confirmExternalLink(value) {
    const dialog=$('external-dialog');
    if(dialog.open||typeof value!=='string'||value.length>2048||!/^https:\/\//i.test(value))return;
    let url;
    try {url=new URL(value);}catch{return;}
    if(url.protocol!=='https:'||url.username||url.password)return;
    $('external-url').textContent=url.href;
    $('external-open').href=url.href;
    dialog.showModal();
  }
  $('external-open').onclick=()=>$('external-dialog').close();
  // Messages from the preview iframe (web/bridge.js). The frame runs untrusted
  // HTML, so every field is checked before use.
  window.addEventListener('message',e=>{
    const p=e.data;
    if(!frame||e.source!==frame.contentWindow||e.origin!=='null'||!p||p.shss!==1||p.session!==context.session||p.documentId!==context.documentId||p.versionId!==context.versionId||p.pagePath!==context.pagePath)return;
    const now=Date.now();
    if(now-messageWindow>=1000){messageWindow=now;messageCount=0;}
    if(++messageCount>30)return;
    try {if(JSON.stringify(p).length>64*1024)return;}catch{return;}
    if(p.type==='ready'&&!frameReady){frameReady=true;clearTimeout(previewTimer);if(!p.highlights)notify('このブラウザでは引用を強調できません。');render();sync();}
    if(!frameReady)return;
    if(p.type==='external-link'){confirmExternalLink(p.href);return;}
    if(p.type==='page'&&typeof p.targetPath==='string'&&current.pages.includes(p.targetPath)&&typeof p.fragment==='string'&&p.fragment.length<=128){navigatePage(p.targetPath,p.fragment);return;}
    if(p.type==='region-cancel'){setRegionMode(false);sync();return;}
    if(p.type==='blocked')$('comment-status').textContent='HTML内の外部読み込みをブロックしました。';
    if(p.type==='locations'&&Array.isArray(p.found)&&p.found.length<=501){found=new Set(p.found.filter(id=>typeof id==='string'&&id.length<=128));updateLocations();}
    if(p.type!=='selection'||!(isTextAnchor(p.anchor)||(regionMode&&isRegionAnchor(p.anchor)))||(!current.canWriteComments&&!current.canPrepareComment))return;
    if(draft&&$('body').value.trim()){panel(true);return;}
    draft=normalizeAnchor(p.anchor);
    if(regionMode)setRegionMode(false);
    selected='draft';panel(true);renderComposer();sync();if(draft.type==='region')$('body').focus();
  });
  function updateLocations() {
    for(const el of $('threads').querySelectorAll('.missing'))el.hidden=!found||found.has(el.dataset.thread);
  }
  function enableCommentShortcut(input,submit) {
    submit.title='Ctrl+Enterで投稿';
    submit.setAttribute('aria-keyshortcuts','Control+Enter');
    input.addEventListener('keydown',event=>{
      if(event.key!=='Enter'||!event.ctrlKey||event.altKey||event.metaKey||event.shiftKey||event.isComposing)return;
      event.preventDefault();
      if(!event.repeat)submit.click();
    });
  }
  function renderComposer() {
    $('compose').hidden=!draft;$('selection').textContent=draft?.type==='region'?'図の領域':draft?.exact||'';
    $('submit').disabled=!current?.canWriteComments||outbox.entries.length>=outbox.limit;$('body').disabled=!current?.canWriteComments&&!current?.canPrepareComment;$('cancel').disabled=false;
  }
  function render() {
    threads=outbox.active(current).reduce((view,entry)=>optimisticComments(view,entry.request).threads,confirmedThreads);
    $('active').setAttribute('aria-pressed',String(filter==='open'));$('hidden').setAttribute('aria-pressed',String(filter==='hidden'));
    const canWrite=current?.canWriteComments;
    const view=threads.filter(t=>t.status===filter);
    const cards=view.map(t=>{
      const canChange=canWrite&&!t.id.startsWith('pending-')&&!outbox.busy(current,t.id);
      const card=create('article',undefined,'thread'+(selected===t.id?' selected':''));
      const label=t.anchor.type==='region'?'図の領域':t.anchor.exact;
      const quote=button(label,()=>{
        selected=t.id;render();if(innerWidth<=720)panel(false);sync(true);
      },!frameReady||t.status==='hidden');quote.className='quote';quote.setAttribute('aria-label','引用箇所: '+label);card.append(quote);
      if(t.status==='open'){const missing=create('p','位置不明','missing');missing.dataset.thread=t.id;card.append(missing);}
      for(const m of t.messages) {
        const row=create('div',undefined,'message');
        row.append(create('span',m.author.displayName+' · '+(m.pending?'保存中…':new Date(m.createdAt).toLocaleString('ja-JP')),'meta'),create('p',m.body));
        if(m.canDelete) {
          const remove=button('削除',()=>{
            const dialog=$('delete-dialog');
            dialog.returnValue='';
            dialog.addEventListener('close',()=>{
              if(dialog.returnValue==='delete')mutate('delete',{threadId:t.id,messageId:m.id});
            },{once:true});
            dialog.showModal();
          },!canChange);
          remove.setAttribute('aria-label','このコメントを削除');
          const controls=create('div',undefined,'actions');controls.append(remove);row.append(controls);
        }
        card.append(row);
      }
      const actions=create('div',undefined,'actions');
      if(t.status==='open')actions.append(button('返信',()=>{replyId=t.id;render();$('reply-input')?.focus();},!canChange));
      actions.append(button(t.status==='hidden'?'表示に戻す':'非表示にする',()=>mutate(t.status==='hidden'?'restore':'hide',{threadId:t.id,expectedThreadRevision:t.threadRevision}),!canChange));
      card.append(actions);
      if(replyId===t.id&&t.status==='open') {
        const form=create('form');const input=create('textarea');input.id='reply-input';input.required=true;input.maxLength=2000;input.setAttribute('aria-label','返信本文');input.disabled=!canChange;input.value=replyDrafts.get(t.id)||'';
        input.addEventListener('input',()=>replyDrafts.set(t.id,input.value));
        const controls=create('div',undefined,'actions');const submit=create('button','投稿','primary');submit.disabled=!canChange;
        enableCommentShortcut(input,submit);
        controls.append(button('閉じる',()=>{replyId=null;render();}),submit);form.append(input,controls);
        form.addEventListener('submit',e=>{e.preventDefault();if(input.value.trim())mutate('reply',{threadId:t.id,body:input.value});});card.append(form);
      }
      return card;
    });
    $('threads').replaceChildren(...(cards.length?cards:[create('p',filter==='open'?'コメントはありません。':'非表示のコメントはありません。','meta')]));
    updateLocations();renderComposer();
  }
  function mutate(type,payload) {
    if(!current?.canWriteComments||validating||payload.threadId&&outbox.busy(current,payload.threadId))return;
    const d=current,{documentId,versionId,sourceHash}=d;
    const request={documentId,versionId,sourceHash,type,payload,...(d.pagePath!=='index.html'||d.pages.length>1?{pagePath:d.pagePath}:{}),...(commentEpoch?{epoch:commentEpoch}:{}),operationId:crypto.randomUUID()};
    const timing=$('comment-status');timing.dataset.feedbackMs='';timing.dataset.saveMs='';timing.dataset.saveOutcome='pending';
    let entry;
    try {entry=outbox.enqueue(request,{title:d.title,body:payload.body});}
    catch(error){notify(error.message);return;}
    commentNotice='';commentRequest++;clearTimeout(pollTimer);previews.clearComments(documentId);
    if(type==='add'){draft=null;$('body').value='';pageDrafts.delete(draftKey(d));selected='pending-'+entry.request.operationId;filter='open';}
    if(type==='reply'){replyDrafts.delete(payload.threadId);replyId=null;}
    if(type==='hide'&&selected===payload.threadId)selected=null;
    scheduleOutboxRender();
    afterPaint(timing,entry.started,'feedbackMs',()=>current&&pageKey(current)===pageKey(d));
  }

  enableCommentShortcut($('body'),$('submit'));
  $('compose').addEventListener('submit',e=>{
    e.preventDefault();const body=$('body').value;if(draft&&body.trim())mutate('add',{anchor:draft,body});
  });
  $('save-details').onclick=showSaveDialog;
  $('cancel').onclick=()=>{draft=null;$('body').value='';if(selected==='draft')selected=null;renderComposer();sync();};
  $('toggle').onclick=()=>panel($('comments').hidden);$('close').onclick=()=>{panel(false);$('toggle').focus();};
  function setRegionMode(enabled) {
    regionMode=enabled;
    $('region-toggle').setAttribute('aria-pressed',String(enabled));
    $('region-toggle').textContent=enabled?'範囲選択をやめる':'図にコメント';
    $('region-help').hidden=!enabled;
  }
  $('region-toggle').onclick=()=>{
    if(!current?.canWriteComments){notify('コメントを投稿する権限が必要です。');return;}
    setRegionMode(!regionMode);panel(true);sync();
  };
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&regionMode){setRegionMode(false);sync();}});
  $('active').onclick=()=>{filter='open';render();};$('hidden').onclick=()=>{filter='hidden';render();};
  $('reload').onclick=()=>refresh();$('home').onclick=()=>{library();if(globalThis.google?.script?.history?.push)google.script.history.push({}, {},'');else history.pushState({},'',location.pathname);};$('more').onclick=()=>library(true);
  function historyPage(d,mode='push') {
    const params={doc:d.documentId,v:d.versionId,p:d.pagePath};
    if(globalThis.google?.script?.history?.[mode])google.script.history[mode]({},params,'');
    else {const url=new URL(location.href);for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);history[mode==='push'?'pushState':'replaceState']({},'',url);}
  }
  async function navigatePage(path,fragment='',mode='push') {
    const d=current;if(!d||!d.pages.includes(path)){if(d)$('pages').value=d.pagePath;return;}
    await open(d.documentId,d.versionId,path,fragment);
    if(current?.documentId===d.documentId&&current?.versionId===d.versionId&&current?.pagePath===path&&mode)historyPage(current,mode);
  }
  $('pages').onchange=()=>navigatePage($('pages').value);
  $('search').oninput=renderLibrary;
  $('archive-view').onclick=()=>{archiveView=!archiveView;$('archive-view').setAttribute('aria-pressed',String(archiveView));library();};
  $('manage-cancel').onclick=()=>$('manage-dialog').close();
  $('manage-form').onsubmit=async e=>{
    e.preventDefault();
    try {
      await call('manageDocument',{documentId:manageId,type:'rename',title:$('manage-name').value});
      documentsChanged();$('manage-dialog').close();library();
    }catch(error){notify(error.message);}
  };
  $('preview-reload').onclick=()=>{
    if(!current)return;
    setRegionMode(false);found=null;
    dropFrame();mountPreview(current);
    notify('プレビューを再読み込みしました。HTML内の操作状態をリセットしました。');
  };
  // Data may change while the tab is hidden. Cached pages are kept but marked
  // stale (every later open asks the server, which skips unchanged HTML), and
  // the visible view is refreshed on return.
  let hiddenAt=0;
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){hiddenAt=Date.now();clearTimeout(pollTimer);clearTimeout(prefetchTimer);prefetchQueue=[];previews.markStale();return;}
    if(current?.canReadComments)refresh();
    // A short switch does not reload the list, which would drop extra pages loaded with "more".
    else if(!$('library').hidden&&Date.now()-hiddenAt>=30000)library();
  });
  $('share').onclick=async()=>{
    if(!current)return;
    const url=new URL(boot.url||location.href);url.search='';url.hash='';url.searchParams.set('doc',current.documentId);url.searchParams.set('v',current.versionId);url.searchParams.set('p',current.pagePath);
    try{await navigator.clipboard.writeText(url.href);notify('URLをコピーしました。');}
    catch{$('link').value=url.href;$('share-dialog').showModal();$('link').select();}
  };
  $('versions').onclick=()=>{
    if(!current)return;
    const d=current;
    $('version-list').replaceChildren(...[...d.versions].reverse().map(v=>{
      const li=create('li');li.append(button(new Date(v.createdAt).toLocaleString('ja-JP')+(v.versionId===d.versionId?'（表示中）':''),async()=>{$('version-dialog').close();await open(d.documentId,v.versionId);if(current?.versionId===v.versionId)historyPage(current);}));return li;
    }));$('append').hidden=!d.canAppend;$('version-dialog').showModal();
  };
  const importer=createImportDialog({
    call,notify,library,documentsChanged,showSaveDialog,
    changed:()=>renderBackground(),
    async openDocument(documentId,versionId) {
      await open(documentId,versionId);
      if(current?.documentId===documentId)historyPage(current);
    },
    titleSaved(documentId,title) {
      if(current?.documentId===documentId){current.title=title;$('title').textContent=title;}
      for(const row of libraryDocuments)if(row.documentId===documentId)row.title=title;
      if(!$('library').hidden)renderLibrary();
    },
    addTitleTask:task=>titleTasks.add(task),
    isLibraryVisible:()=>!$('library').hidden
  });
  imports=importer.queue;
  $('import').onclick=()=>{if(!validating)importer.show(null);};
  $('append').onclick=()=>{$('version-dialog').close();if(!validating&&current)importer.show(current.documentId);};
  const params=boot.local?new URLSearchParams(location.search):null;
  const doc=boot.documentId||params?.get('doc');
  if(globalThis.google?.script?.history?.setChangeHandler)google.script.history.setChangeHandler(e=>{const p=e.location.parameter;if(p.doc)open(p.doc,p.v,p.p);else library();});
  else window.addEventListener('popstate',()=>{const p=new URLSearchParams(location.search);if(p.has('doc'))open(p.get('doc'),p.get('v'),p.get('p'));else library();});
  if(doc)open(doc,boot.versionId||params?.get('v'),boot.pagePath||params?.get('p'));else library();
})();
