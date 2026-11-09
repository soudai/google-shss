(() => {
  const envelope = __SHSS_CONTEXT__;
  const send = (type,data={}) => parent.postMessage({...envelope,type,...data},'*');
  let items=[], selected=null, timer, oversized=false, regionMode=false, drag=null;
  let regionBoxes=[], regionFrame=0, dragFrame=0;
  const highlights=globalThis.CSS?.highlights;
  const style=document.createElement('style');
  style.textContent='::highlight(shss-quote){background:#fff0b6;color:#382d13}::highlight(shss-focus){background:#f3be46;color:#231804}body[data-shss-region-mode] :is(img,canvas,svg,figure){touch-action:none}';
  document.head.append(style);
  const layer=document.createElement('div');
  layer.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const dragBox=document.createElement('div');
  dragBox.setAttribute('aria-label','選択中の範囲');
  dragBox.style.cssText='position:fixed;display:none;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px dashed #155ad6;outline:1px solid white;background:#4285ff22';
  const regionTarget=element=>element?.closest?.('img,canvas,svg,figure')||null;
  const keyboardTargets=new Map();
  function regionKeyboard(enabled) {
    if(enabled)for(const element of document.querySelectorAll('img,canvas,svg,figure')) {
      if(!keyboardTargets.has(element)){keyboardTargets.set(element,element.getAttribute('tabindex'));if(!element.hasAttribute('tabindex'))element.setAttribute('tabindex','0');}
    }
    else {for(const [element,old] of keyboardTargets){if(old===null)element.removeAttribute('tabindex');else element.setAttribute('tabindex',old);}keyboardTargets.clear();}
  }
  function pathFor(element) {
    const parts=[];
    for(let node=element;node&&node!==document.body;node=node.parentElement) {
      const parent=node.parentElement;if(!parent||parts.length>=20)return null;
      const peers=[...parent.children].filter(x=>x.tagName===node.tagName);
      parts.unshift(node.tagName.toLowerCase()+':nth-of-type('+(peers.indexOf(node)+1)+')');
    }
    return parts.length?'body>'+parts.join('>'):null;
  }
  function signature(element) {
    const raw=[element.tagName,element.id,element.getAttribute('data-shss-id'),element.getAttribute('src'),element.getAttribute('alt')].join('|');
    let hash=2166136261;
    for(let i=0;i<raw.length;i++)hash=Math.imul(hash^raw.charCodeAt(i),16777619);
    return (hash>>>0).toString(16);
  }
  function regionElement(anchor) {
    let matches;
    try {matches=document.querySelectorAll(anchor.path);}catch{return null;}
    const element=matches.length===1?matches[0]:null;
    return element?.tagName.toUpperCase()===anchor.tag&&signature(element)===anchor.signature?element:null;
  }
  function placeBox(node,left,top,width,height) {
    Object.assign(node.style,{left:left+'px',top:top+'px',width:width+'px',height:height+'px'});
  }
  function prepareRegions() {
    const boxes=[];
    for(const {id,anchor} of items) {
      if(anchor?.type!=='region')continue;
      const element=regionElement(anchor);
      if(!element)continue;
      const node=document.createElement('div');
      const focused=id===selected;
      node.style.cssText='position:absolute;box-sizing:border-box;border:2px solid '+(focused?'#da8b00':'#aa8a3b')+';background:'+(focused?'#f3be4655':'#fff0b633');
      boxes.push({id,element,node,rect:anchor.rect});
    }
    regionBoxes=boxes;
    layer.replaceChildren(...boxes.map(({node})=>node));
  }
  function paintRegions(focus=false) {
    const geometry=new Map();
    for(const {element} of regionBoxes) {
      if(!geometry.has(element)) {
        const bounds=element.getBoundingClientRect();
        const visible=bounds.width&&bounds.height&&getComputedStyle(element).visibility==='visible';
        geometry.set(element,visible?bounds:null);
      }
    }
    const found=[];
    for(const {id,element,node,rect} of regionBoxes) {
      const bounds=geometry.get(element);
      node.style.display=bounds?'':'none';
      if(!bounds)continue;
      placeBox(node,bounds.left+rect.x*bounds.width,bounds.top+rect.y*bounds.height,rect.w*bounds.width,rect.h*bounds.height);
      found.push(id);
      if(focus&&id===selected)element.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    }
    return found;
  }
  function scheduleRegionPaint() {
    if(!regionBoxes.length||regionFrame)return;
    regionFrame=requestAnimationFrame(()=>{
      regionFrame=0;
      paintRegions();
    });
  }
  function dragBounds(start,endX,endY,bounds) {
    const left=Math.max(bounds.left,Math.min(start.x,endX));
    const right=Math.min(bounds.right,Math.max(start.x,endX));
    const top=Math.max(bounds.top,Math.min(start.y,endY));
    const bottom=Math.min(bounds.bottom,Math.max(start.y,endY));
    return {left,top,width:Math.max(0,right-left),height:Math.max(0,bottom-top)};
  }
  function clearDrag() {
    const active=drag;
    drag=null;
    if(dragFrame)cancelAnimationFrame(dragFrame);
    dragFrame=0;
    dragBox.style.display='none';
    if(active?.element.hasPointerCapture?.(active.pointerId))active.element.releasePointerCapture(active.pointerId);
  }
  function scheduleDragPaint() {
    if(!drag||dragFrame)return;
    dragFrame=requestAnimationFrame(()=>{
      dragFrame=0;
      if(!drag||!drag.element.isConnected){clearDrag();return;}
      const rect=dragBounds(drag,drag.endX,drag.endY,drag.element.getBoundingClientRect());
      placeBox(dragBox,rect.left,rect.top,rect.width,rect.height);
      dragBox.style.display=rect.width&&rect.height?'block':'none';
    });
  }

  function model() {
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    const nodes=[], parts=[];
    let n,offset=0;
    while((n=walker.nextNode())) {
      const p=n.parentElement;
      if(!n.length||!p||p.closest('script,style,noscript,template,textarea,select,[hidden],[contenteditable]'))continue;
      const s=getComputedStyle(p);
      if(s.visibility!=='visible'||!p.getClientRects().length)continue;
      if(nodes.length>=5000||offset+n.length>200000)return null;
      nodes.push({n,start:offset,end:offset+n.length});parts.push(n.data);offset+=n.length;
    }
    return {nodes,text:parts.join('')};
  }
  function rangeFor(nodes,start,end) {
    const first=nodes.find(x=>x.start<=start&&x.end>start),last=nodes.find(x=>x.start<end&&x.end>=end);
    if(!first||!last)return null;
    const r=new Range();r.setStart(first.n,start-first.start);r.setEnd(last.n,end-last.start);return r;
  }
  function locate({text,nodes},a) {
    if(!a?.exact)return null;
    let found=-1;
    for(let at=text.indexOf(a.exact);at!==-1;at=text.indexOf(a.exact,at+1)) {
      if(a.prefix&&!text.slice(0,at).endsWith(a.prefix))continue;
      if(a.suffix&&!text.startsWith(a.suffix,at+a.exact.length))continue;
      if(found!==-1)return null;
      found=at;
    }
    return found===-1?null:rangeFor(nodes,found,found+a.exact.length);
  }
  function paint(focus=false) {
    if(!document.body)return;
    prepareRegions();
    const textItems=items.filter(item=>item.anchor?.type==='text');
    const current=textItems.length?model():{nodes:[],text:''}, rest=[], active=[], found=paintRegions(focus);
    if(!current){
      highlights?.delete('shss-quote');highlights?.delete('shss-focus');
      if(!oversized)send('blocked');
      oversized=true;
      return;
    }
    oversized=false;
    for(const {id,anchor} of textItems) {
      const range=locate(current,anchor);
      if(!range)continue;
      found.push(id);(id===selected?active:rest).push(range);
    }
    if(highlights&&typeof Highlight==='function') {
      highlights.set('shss-quote',new Highlight(...rest));
      const strong=new Highlight(...active);strong.priority=1;highlights.set('shss-focus',strong);
    }
    if(focus&&active.length) {
      const r=active[0].getBoundingClientRect();
      window.scrollTo({top:window.scrollY+r.top-innerHeight/2,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    }
    send('locations',{found});
  }
  function select() {
    if(regionMode)return;
    const selection=getSelection();
    if(!selection?.rangeCount||selection.isCollapsed)return;
    const current=model();
    if(!current)return;
    const r=selection.getRangeAt(0),{nodes,text}=current;
    let start=-1,end=-1;
    for(const x of nodes) {
      if(!r.intersectsNode(x.n))continue;
      const from=x.start+(x.n===r.startContainer?r.startOffset:0),to=x.start+(x.n===r.endContainer?r.endOffset:x.n.length);
      if(from>=to)continue;
      if(start===-1)start=from;
      end=to;
    }
    if(start<0||end-start>500)return;
    const raw=text.slice(start,end),exact=raw.trim();
    if(!exact)return;
    start+=raw.length-raw.trimStart().length;end=start+exact.length;
    send('selection',{anchor:{type:'text',exact,prefix:text.slice(Math.max(0,start-48),start),suffix:text.slice(end,end+48),position:{start,end,unit:'utf16'},textModel:'shss-visible-text-v1'}});
  }
  window.addEventListener('message',event=>{
    const p=event.data;
    if(event.source!==parent||!p||p.session!==envelope.session||p.documentId!==envelope.documentId||p.versionId!==envelope.versionId||p.pagePath!==envelope.pagePath)return;
    if(p.type==='fragment'&&typeof p.fragment==='string'&&p.fragment.length<=128){document.getElementById(p.fragment)?.scrollIntoView();return;}
    if(p.type!=='annotations'||!Array.isArray(p.items))return;
    items=p.items.slice(0,501);selected=p.selected;
    const enabled=p.regionMode===true;
    if(regionMode!==enabled){
      regionMode=enabled;
      if(!enabled)clearDrag();
      document.body.style.cursor=enabled?'crosshair':'';
      document.body.toggleAttribute('data-shss-region-mode',enabled);
      regionKeyboard(enabled);
    }
    paint(p.focus===true);
  });
  document.addEventListener('keydown',event=>{
    if(regionMode&&event.key==='Escape'){clearDrag();send('region-cancel');return;}
    if(!regionMode||!['Enter',' '].includes(event.key))return;
    const element=regionTarget(event.target),path=element&&pathFor(element);
    if(!path)return;
    event.preventDefault();event.stopImmediatePropagation();
    send('selection',{anchor:{type:'region',path,tag:element.tagName.toUpperCase(),signature:signature(element),rect:{x:.25,y:.25,w:.5,h:.5}}});
  },true);
  document.addEventListener('pointerdown',event=>{
    if(!regionMode||drag||event.button!==0||event.isPrimary===false)return;
    const element=regionTarget(event.target);
    if(!element)return;
    const bounds=element.getBoundingClientRect();
    if(bounds.width<8||bounds.height<8)return;
    event.preventDefault();event.stopImmediatePropagation();
    drag={element,pointerId:event.pointerId,x:event.clientX,y:event.clientY,endX:event.clientX,endY:event.clientY};
    try {element.setPointerCapture?.(event.pointerId);}catch{}
  },true);
  document.addEventListener('pointermove',event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    event.stopImmediatePropagation();
    drag.endX=event.clientX;drag.endY=event.clientY;
    scheduleDragPaint();
  },true);
  document.addEventListener('pointerup',event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    event.preventDefault();event.stopImmediatePropagation();
    const selection=drag;
    clearDrag();
    const {element,x,y}=selection;
    if(!element.isConnected)return;
    const bounds=element.getBoundingClientRect();
    if(bounds.width<8||bounds.height<8)return;
    const box=dragBounds(selection,event.clientX,event.clientY,bounds);
    const clicked=Math.abs(event.clientX-x)<8&&Math.abs(event.clientY-y)<8;
    if(!clicked&&(box.width<8||box.height<8))return;
    const path=pathFor(element);
    if(!path)return;
    const rect=clicked?{x:0,y:0,w:1,h:1}:{
      x:(box.left-bounds.left)/bounds.width,y:(box.top-bounds.top)/bounds.height,
      w:box.width/bounds.width,h:box.height/bounds.height
    };
    send('selection',{anchor:{type:'region',path,tag:element.tagName.toUpperCase(),signature:signature(element),rect}});
  },true);
  function cancelPointer(event) {
    if(drag&&event.pointerId===drag.pointerId)clearDrag();
  }
  document.addEventListener('pointercancel',cancelPointer,true);
  document.addEventListener('lostpointercapture',cancelPointer,true);
  window.addEventListener('blur',clearDrag);
  window.addEventListener('scroll',()=>{scheduleRegionPaint();scheduleDragPaint();},{passive:true});
  window.addEventListener('resize',()=>{scheduleRegionPaint();scheduleDragPaint();});
  window.addEventListener('securitypolicyviolation',()=>send('blocked'));
  document.addEventListener('DOMContentLoaded',()=>{
    document.addEventListener('click',event=>{
      const link=event.target.closest?.('a[data-shss-page],a[data-shss-external]');if(!link)return;
      event.preventDefault();event.stopImmediatePropagation();
      if(link.hasAttribute('data-shss-external')){
        if(event.isTrusted)send('external-link',{href:link.getAttribute('data-shss-external')});
        return;
      }
      send('page',{targetPath:link.getAttribute('data-shss-page'),fragment:link.getAttribute('data-shss-fragment')||''});
    },true);
    document.documentElement.append(layer,dragBox);
    document.addEventListener('pointerup',()=>{if(!regionMode)setTimeout(select,0);});
    document.addEventListener('keyup',e=>{if(e.shiftKey||e.key==='Shift')select();});
    new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>{if(regionMode)regionKeyboard(true);paint();},100);}).observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});
    send('ready',{highlights:!!highlights});
  },{once:true});
})();
