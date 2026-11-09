import {PreviewCache,optimisticComments} from './fast-state.mjs';
import {CommentOutbox,TitleTask,pageKey} from './background.mjs';
(() => {
  const $=id=>document.getElementById(id);
  const boot=window.SHSS_BOOT;
  const bridge=window.SHSS_BRIDGE;
  delete window.SHSS_BOOT;delete window.SHSS_BRIDGE;
  const api=window.SHSS_API||((action,input)=>new Promise((resolve,reject)=>{
    google.script.run.withSuccessHandler(resolve).withFailureHandler(()=>reject(new Error('通信に失敗しました。再試行してください。'))).rpc(action,input);
  }));
  async function call(action,input={}) {
    let reply;
    try {reply=await api(action,input);}catch{throw new Error('通信に失敗しました。再試行してください。');}
    if(!reply?.ok)throw Object.assign(new Error(reply?.error?.message||'通信に失敗しました。'),reply?.error);
    return reply.value;
  }
  let current=null,frame=null,context=null,frameReady=false,found=null,threads=[],confirmedThreads=[],selected=null,draft=null,filter='open',cursor=null;
  let generation=0,commentRequest=0,previewTimer,noticeTimer,pollTimer,append=false,importing=false,refreshing=false,revision=null,commentVersion=null,commentEpoch=null,pollDelay=15000,sourceCursor=null,regionMode=false;
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
    if(prefetchBusy||outbox.running||importing||document.hidden||!prefetchQueue.length)return;
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
  function renderBackground() {
    const failures=outbox.entries.filter(e=>e.state==='failed').length+[...titleTasks].filter(t=>t.pending&&t.error).length;
    const active=outbox.entries.filter(e=>e.state!=='failed').length+[...titleTasks].filter(t=>t.pending&&!t.error).length;
    $('save-status').textContent=failures?'未保存 '+failures+'件':active?'保存中…（'+active+'件）':'';
    $('save-details').hidden=!outbox.entries.length&&![...titleTasks].some(t=>t.pending);
    if(!$('save-dialog').open)return;
    const rows=outbox.entries.map(entry=>{
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
    });
    for(const task of titleTasks)if(task.pending){
      const li=create('li');li.append(create('strong','タイトル: '+task.desired),create('p',task.error?.message||'タイトルを保存中…'));
      if(task.error)li.append(button('タイトルを再試行',()=>task.flush()));
      rows.push(li);
    }
    $('save-list').replaceChildren(...(rows.length?rows:[create('li','すべて保存しました。')]));
  }
  window.addEventListener('beforeunload',event=>{
    if(outbox.entries.length||importing||[...titleTasks].some(t=>t.pending)){event.preventDefault();event.returnValue='';}
  });
  let messageWindow=0,messageCount=0;
  const replyDrafts=new Map();
  const pageDrafts=new Map();
  const draftKey=d=>`${d.documentId}:${d.versionId}:${d.pagePath||'index.html'}`;
  const create=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
  const button=(text,action,disabled=false)=>{const b=create('button',text);b.type='button';b.disabled=disabled;b.addEventListener('click',action);return b;};
  function notify(text) {
    $('notice').textContent=text;$('notice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('notice').hidden=true,3800);
  }
  function panel(open) {$('comments').hidden=!open;$('toggle').setAttribute('aria-expanded',String(open));}
  function bar(view,canImport=false) {
    for(const id of ['versions','share','toggle','preview-reload','region-toggle'])$(id).hidden=!view;
    if(!view)$('pages').hidden=true;
    $('import').hidden=!canImport;
  }
  function dropFrame() {frame?.remove();frame=null;context=null;frameReady=false;messageWindow=0;messageCount=0;clearTimeout(previewTimer);}
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
      const link=button(d.title,async()=>{await open(d.documentId,d.latestVersionId);if(current?.documentId===d.documentId)historyPage(current);});
      const warm=()=>queuePreviews([{documentId:d.documentId,versionId:d.latestVersionId}]);
      link.addEventListener('pointerenter',warm);link.addEventListener('focus',warm);
      li.append(link);
      if(d.canManage) {
        li.append(button('名前を変更',()=>{
          manageId=d.documentId;$('manage-name').value=d.title;$('manage-dialog').showModal();
        }));
        li.append(button(archiveView?'戻す':'アーカイブ',async()=>{
          try {
            await call('manageDocument',{documentId:d.documentId,type:archiveView?'restore':'archive'});previews.clear();
            library();
          }catch(e){notify(e.message);}
        }));
      }
      return li;
    }));
    if(!rows.length&&!cursor)$('documents').append(create('li',query?'一致する文書はありません。':'文書がありません。'));
    queuePreviews(rows.slice(0,2).map(d=>({documentId:d.documentId,versionId:d.latestVersionId})));
  }
  async function library(more=false) {
    if(importing)return;
    const ticket=++generation;
    if(!more){clean();$('library').hidden=false;$('viewer').hidden=true;$('title').textContent='';bar(false);cursor=null;libraryDocuments=[];}
    $('more').disabled=true;
    try {
      const page=await call('listDocuments',{...(cursor?{cursor}:{}),archived:archiveView});
      if(ticket!==generation)return;
      cursor=page.cursor;bar(false,page.canImport);$('more').hidden=!cursor;
      libraryDocuments.push(...page.documents);renderLibrary();
    }catch(e){if(ticket===generation)notify(e.message);}
    finally {if(ticket===generation)$('more').disabled=false;}
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
  async function open(documentId,versionId,pagePath,fragment='') {
    if(importing)return;
    if(current){if(draft)pageDrafts.set(draftKey(current),{draft,body:$('body').value});else pageDrafts.delete(draftKey(current));}
    const input={documentId,...(versionId?{versionId}:{}),...(pagePath?{pagePath}:{})};
    const cached=previews.peek(input),ticket=++generation;openingAt=performance.now();$('preview').dataset.displayMs='';$('preview').dataset.source=cached?'prefetched':'network';clean();bar(false);$('library').hidden=true;$('viewer').hidden=false;
    $('preview').textContent='読み込み中…';$('title').textContent='';
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
  const validAnchor=a=>a&&a.type==='text'&&typeof a.exact==='string'&&a.exact.trim()&&a.exact.length<=500&&typeof a.prefix==='string'&&a.prefix.length<=120&&typeof a.suffix==='string'&&a.suffix.length<=120&&Number.isSafeInteger(a.position?.start)&&a.position.start>=0&&a.position.end===a.position.start+a.exact.length&&a.position.end<=2*1024*1024;
  const validRegion=a=>a?.type==='region'&&typeof a.path==='string'&&a.path.length<=500&&typeof a.signature==='string'&&a.signature.length<=128&&['IMG','SVG','CANVAS','FIGURE'].includes(a.tag)&&[a.rect?.x,a.rect?.y,a.rect?.w,a.rect?.h].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1)&&a.rect.w>0&&a.rect.h>0&&a.rect.x+a.rect.w<=1.00001&&a.rect.y+a.rect.h<=1.00001;
  window.addEventListener('message',e=>{
    const p=e.data;
    if(!frame||e.source!==frame.contentWindow||e.origin!=='null'||!p||p.shss!==1||p.session!==context.session||p.documentId!==context.documentId||p.versionId!==context.versionId||p.pagePath!==context.pagePath)return;
    const now=Date.now();
    if(now-messageWindow>=1000){messageWindow=now;messageCount=0;}
    if(++messageCount>30)return;
    try {if(JSON.stringify(p).length>64*1024)return;}catch{return;}
    if(p.type==='ready'&&!frameReady){frameReady=true;clearTimeout(previewTimer);if(!p.highlights)notify('このブラウザでは引用を強調できません。');render();sync();}
    if(!frameReady)return;
    if(p.type==='page'&&typeof p.targetPath==='string'&&current.pages.includes(p.targetPath)&&typeof p.fragment==='string'&&p.fragment.length<=128){navigatePage(p.targetPath,p.fragment);return;}
    if(p.type==='region-cancel'){setRegionMode(false);sync();return;}
    if(p.type==='blocked')$('comment-status').textContent='HTML内の外部読み込みをブロックしました。';
    if(p.type==='locations'&&Array.isArray(p.found)&&p.found.length<=501){found=new Set(p.found.filter(id=>typeof id==='string'&&id.length<=128));updateLocations();}
    if(p.type!=='selection'||!(validAnchor(p.anchor)||(regionMode&&validRegion(p.anchor)))||(!current.canWriteComments&&!current.canPrepareComment))return;
    if(draft&&$('body').value.trim()){panel(true);return;}
    const a=p.anchor;draft=a.type==='region'?{type:'region',path:a.path,tag:a.tag,signature:a.signature,rect:{...a.rect}}:{type:'text',exact:a.exact,prefix:a.prefix,suffix:a.suffix,position:{start:a.position.start,end:a.position.end}};
    if(regionMode)setRegionMode(false);
    selected='draft';panel(true);renderComposer();sync();if(a.type==='region')$('body').focus();
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
  $('save-details').onclick=()=>{$('save-dialog').showModal();renderBackground();};
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
  $('reload').onclick=()=>refresh();$('home').onclick=()=>{if(importing)return;library();if(globalThis.google?.script?.history?.push)google.script.history.push({}, {},'');else history.pushState({},'',location.pathname);};$('more').onclick=()=>library(true);
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
      previews.clear();$('manage-dialog').close();library();
    }catch(error){notify(error.message);}
  };
  $('preview-reload').onclick=()=>{
    if(!current)return;
    setRegionMode(false);found=null;
    dropFrame();mountPreview(current);
    notify('プレビューを再読み込みしました。HTML内の操作状態をリセットしました。');
  };
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){clearTimeout(pollTimer);clearTimeout(prefetchTimer);prefetchQueue=[];previews.clear();}
    else if(current?.canReadComments)refresh();
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
  let importSession=null,importTarget=null,titleTimer,lastAutoTitle='';
  function importDialog(isAppend) {
    if(importing||validating)return;
    previews.clear();append=isAppend;importTarget=isAppend?current.documentId:null;importSession=null;lastAutoTitle='';clearTimeout(titleTimer);$('import-form').reset();$('start-page-field').hidden=true;$('import-error').textContent='';$('name-field').hidden=append;$('name').required=false;$('import-title-retry').hidden=true;$('import-status').textContent='';$('import-submit').textContent='取り込む';
    sourceCursor=null;$('source-list').replaceChildren();$('source-list').hidden=true;$('source-more').hidden=true;
    $('import-title').textContent=append?'新版を取り込む':'HTMLを取り込む';$('import-dialog').showModal();
  }
  async function loadSources(more=false) {
    $('source-load').disabled=true;$('source-more').disabled=true;
    try {
      const page=await call('listSources',more&&sourceCursor?{cursor:sourceCursor}:{});
      if(!more)$('source-list').replaceChildren(new Option('HTMLを選択',''));
      for(const file of page.files)$('source-list').add(new Option(file.name,file.id));
      sourceCursor=page.cursor;$('source-list').hidden=false;$('source-more').hidden=!sourceCursor;
    }catch(e){$('import-error').textContent=e.message;}
    finally{$('source-load').disabled=false;$('source-more').disabled=false;}
  }
  $('source-load').onclick=()=>loadSources();
  $('source-more').onclick=()=>loadSources(true);
  $('source-list').onchange=()=>{if($('source-list').value){$('drive').value=$('source-list').value;$('file').value='';}};
  $('import').onclick=()=>importDialog(false);$('append').onclick=()=>{$('version-dialog').close();importDialog(true);};
  $('import-cancel').onclick=()=>{if(!importing){$('import-dialog').close();if(importSession?.result&&!$('library').hidden)library();}};
  $('import-dialog').addEventListener('cancel',e=>{if(importing)e.preventDefault();});
  $('file').addEventListener('change',()=>{
    if(importing||!$('file').files[0])return;
    importSession=null;$('drive').value='';$('start-page-field').hidden=true;$('start-page').replaceChildren();
    const autoTitle=($('file').files[0].name.replace(/\.(?:html?|zip|svg)$/i,'')||'新しい文書').slice(0,160);
    if(!$('name').value.trim()||$('name').value===lastAutoTitle)$('name').value=autoTitle;
    lastAutoTitle=autoTitle;
    void beginImport();
  });
  $('name').addEventListener('input',()=>{
    const session=importSession;if(!session?.result||append)return;
    session.titleTask.setTitle($('name').value.trim()||session.initialTitle);
    clearTimeout(titleTimer);titleTimer=setTimeout(()=>session.titleTask.flush(),400);
  });
  $('import-title-retry').onclick=()=>importSession?.titleTask?.flush();
  $('start-page').addEventListener('change',()=>{
    if(importSession?.prepared&&$('start-page').value)void beginImport();
  });
  function driveId(raw) {
    if(/^[\w-]{1,128}$/.test(raw))return raw;
    const url=new URL(raw);const id=url.pathname.match(/^\/file\/d\/([\w-]{1,128})(?:\/|$)/)?.[1]||url.searchParams.get('id');
    if(url.origin!=='https://drive.google.com'||!id||!(/^[\w-]{1,128}$/.test(id)))throw new Error('Google DriveのファイルURLまたはIDを指定してください。');
    return id;
  }
  function importStatus() {
    const session=importSession;if(!session)return;
    $('import-title-retry').hidden=!session.titleTask?.error;
    $('import-status').textContent=session.result?
      session.titleTask?.error?'ファイルの取り込みは完了しました。タイトルは未保存です。タイトルの保存だけを再試行できます。':
      session.titleTask?.pending?'取り込み完了。タイトルを保存中です。':'取り込みが完了しました。':
      session.phase==='choose'?'開始ページを選ぶと取り込みを続けます。':
      session.phase==='reading'?'ファイルを読み込み中…':
      session.phase==='inspect'?'ZIPを確認中… タイトルを入力できます。':
      session.phase==='upload'?'取り込み中… タイトルを入力できます。':'';
    $('import-submit').textContent=session.result?'文書を開く':session.unknown?'一覧を確認':'取り込む';
  }
  function importControls(busy) {
    importing=busy;$('import-cancel').textContent=importSession?.sent?'閉じる':'キャンセル';
    for(const id of ['file','drive','source-load','source-list','source-more','start-page','import-submit','import-cancel'])$(id).disabled=busy;
    importStatus();
  }
  async function openImported(session) {
    // Opening the document need not wait for its title update.
    if(session.titleTask?.pending)void session.titleTask.flush();
    $('import-dialog').close();
    await open(session.result.documentId,session.result.versionId);
    if(current?.documentId===session.result.documentId)historyPage(current);
  }
  async function beginImport() {
    if(importing)return;
    if(importSession?.result){await openImported(importSession);return;}
    if(importSession?.unknown){$('import-dialog').close();await library();return;}
    const file=$('file').files[0],link=$('drive').value.trim();
    if(!!file===!!link){$('import-error').textContent='ファイルまたはDrive URLの一方を指定してください。';return;}
    const session=importSession||={target:importTarget,initialTitle:$('name').value.trim()||'Driveから取り込み',phase:'reading',prepared:null,result:null,sent:false};
    importControls(true);$('import-error').textContent='';
    try {
      let input=session.prepared;
      if(!input) {
        input={};
        if(file){
          if(/\.zip$/i.test(file.name)){
            if(file.size>5*1024*1024)throw new Error('ZIPは5 MiBまでです。');
            const bytes=new Uint8Array(await file.arrayBuffer());let encoded='';
            for(let at=0;at<bytes.length;at+=24576)encoded+=btoa(String.fromCharCode(...bytes.subarray(at,at+24576)));
            input.zipBase64=encoded;session.phase='inspect';importStatus();
            const inspection=await call('inspectPackage',{zipBase64:encoded,...(session.target?{documentId:session.target}:{})});
            if(!inspection.startPage){
              session.prepared=input;session.phase='choose';
              $('start-page').replaceChildren(new Option('開始ページを選択',''),...inspection.pages.map(path=>new Option(path,path)));
              $('start-page-field').hidden=false;return;
            }
            input.startPage=inspection.startPage;
          }else if(/\.svg$/i.test(file.name)){
            if(file.size>512*1024)throw new Error('SVGは512 KiBまでです。');
            input.svg=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await file.arrayBuffer());
          }else{
            if(!/\.html?$/i.test(file.name)||file.size>2*1024*1024)throw new Error('2 MiB以内のHTMLまたは5 MiB以内のZIPを指定してください。');
            input.html=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await file.arrayBuffer());
          }
        }else input.sourceFileId=driveId(link);
      }else{
        if(!$('start-page').value){session.phase='choose';return;}
        input={...input,startPage:$('start-page').value};
      }
      session.phase='upload';importStatus();session.sent=true;
      session.result=await call(session.target?'appendVersion':'importDocument',{
        ...input,...(session.target?{documentId:session.target}:{title:session.initialTitle})
      });
      session.prepared=null;session.phase='ready';
      if(!session.target){
        const task=new TitleTask(input=>call('manageDocument',input),{
          documentId:session.result.documentId,title:session.initialTitle,
          changed:()=>{renderBackground();if(importSession===session)importStatus();},
          saved:title=>{
            previews.clear();
            if(current?.documentId===session.result.documentId){current.title=title;$('title').textContent=title;}
            for(const row of libraryDocuments)if(row.documentId===session.result.documentId)row.title=title;
            if(!$('library').hidden)renderLibrary();
          }
        });
        session.titleTask=task;titleTasks.add(task);
        task.setTitle($('name').value.trim()||session.initialTitle);void task.flush();
      }
    }catch(error){
      session.phase='error';session.unknown=session.sent&&(!error.code||error.code==='INTERNAL');
      $('import-error').textContent=session.unknown?'取り込み結果を確認できません。重複を避けるため、文書一覧を確認してください。':error.message;
    }finally{importControls(false);}
  }
  $('import-form').addEventListener('submit',e=>{e.preventDefault();void beginImport();});
  const params=boot.local?new URLSearchParams(location.search):null;
  const doc=boot.documentId||params?.get('doc');
  if(globalThis.google?.script?.history?.setChangeHandler)google.script.history.setChangeHandler(e=>{const p=e.location.parameter;if(p.doc)open(p.doc,p.v,p.p);else library();});
  else window.addEventListener('popstate',()=>{const p=new URLSearchParams(location.search);if(p.has('doc'))open(p.get('doc'),p.get('v'),p.get('p'));else library();});
  if(doc)open(doc,boot.versionId||params?.get('v'),boot.pagePath||params?.get('p'));else library();
})();
