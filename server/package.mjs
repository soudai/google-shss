import {parse,serialize} from 'parse5';
import * as cssTree from 'css-tree';
import {AppError,utf8Size} from './html.mjs';
import {sanitizeSvg} from './svg.mjs';
import {decodeBase64,utf8} from './zip.mjs';
import {validateRaster} from './image.mjs';

const fail=(code,message)=>{throw new AppError(code,message);};
const attr=(node,name)=>node.attrs?.find(a=>a.name===name);
export function utf8Bytes(text) {
  const bytes=[];
  for(const c of text){const cp=c.codePointAt(0);if(cp<0x80)bytes.push(cp);else if(cp<0x800)bytes.push(0xc0|cp>>6,0x80|cp&63);else if(cp<0x10000)bytes.push(0xe0|cp>>12,0x80|cp>>6&63,0x80|cp&63);else bytes.push(0xf0|cp>>18,0x80|cp>>12&63,0x80|cp>>6&63,0x80|cp&63);}
  return Uint8Array.from(bytes);
}
function percentDecodedBytes(text) {
  const bytes=utf8Bytes(text);
  let end=0;
  for(let i=0;i<bytes.length;i++){
    if(bytes[i]===37&&i+2<bytes.length){
      const hex=String.fromCharCode(bytes[i+1],bytes[i+2]);
      if(/^[0-9a-f]{2}$/i.test(hex)){
        bytes[end++]=Number.parseInt(hex,16);i+=2;continue;
      }
    }
    bytes[end++]=bytes[i];
  }
  return bytes.subarray(0,end);
}

function imageData(raw) {
  const url=raw.replace(/[\t\r\n]/g,'').trim().split('#',1)[0];
  const mime=url.match(/^data:\s*(image\/(?:svg\+xml|png|jpeg|gif|webp))(?=[\s;,]|$)/i)?.[1].toLowerCase();
  if(!mime)return null;
  const isSvg=mime==='image/svg+xml';
  const code=isSvg?'UNSAFE_SVG':'UNSUPPORTED_TYPE';
  const comma=url.indexOf(',');
  if(comma<0)fail(code,'画像のdata URLが不正です。');
  const encoded=url.slice(comma+1);
  let bytes;
  try {
    if(/;\s*base64\s*$/i.test(url.slice(0,comma))){
      const value=decodeURIComponent(encoded).replace(/[\t\n\f\r ]/g,'');
      const padding=value.includes('=')?'':'='.repeat((4-value.length%4)%4);
      bytes=decodeBase64(value+padding);
    }else bytes=percentDecodedBytes(encoded);
  }catch{fail(code,'画像のdata URLを復号できません。');}
  if(isSvg){
    let xml;
    try {xml=utf8(bytes);}catch{fail(code,'SVGのdata URLを復号できません。');}
    return {svg:'data:image/svg+xml;base64,'+base64(utf8Bytes(sanitizeSvg(xml)))};
  }
  validateRaster(mime,bytes);
  return {};
}

function walkCssImages(ast,visit) {
  cssTree.walk(ast,node=>{
    if(node.type==='Url')visit(node);
    if(node.type==='Function'&&/^(?:(?:-webkit-)?image-set|image)$/i.test(cssTree.ident.decode(node.name))){
      node.children.forEach(child=>{if(child.type==='String')visit(child);});
    }
  });
}

export function sanitizeHtmlImages(html) {
  const doc=parse(html);
  let hasSvg=false;
  const normalize=raw=>{
    const image=imageData(raw);
    if(!image?.svg)return raw;
    hasSvg=true;
    return image.svg;
  };
  const normalizeCss=(raw,context)=>{
    if(!/data:|\\/i.test(raw.replace(/[\t\r\n]/g,'')))return raw;
    let ast;
    try {ast=cssTree.parse(raw,{context,parseValue:true,parseCustomProperty:true,onParseError:e=>{throw e;}});}
    catch{fail('UNSAFE_SVG','画像のdata URLを含むCSSを解析できません。');}
    let changed=false;
    cssTree.walk(ast,node=>{
      // A quoted URL can also reach image-set() through a CSS variable.
      if(node.type!=='Url'&&node.type!=='String')return;
      const value=normalize(node.value);
      if(value!==node.value){node.value=value;changed=true;}
    });
    return changed?cssTree.generate(ast):raw;
  };
  const pending=[doc];
  while(pending.length){
    const node=pending.pop();
    for(const a of node.attrs||[]){
      if(['src','href','poster','background'].includes(a.name))a.value=normalize(a.value);
      if(a.name==='style')a.value=normalizeCss(a.value,'declarationList');
    }
    if(node.tagName==='style'){
      const raw=node.childNodes.map(n=>n.value||'').join('');
      const css=normalizeCss(raw,'stylesheet');
      if(css!==raw)node.childNodes=[textNode(css,node)];
    }
    if(node.content)pending.push(node.content);
    for(const child of node.childNodes||[])pending.push(child);
  }
  return {html:hasSvg?serialize(doc):html,hasSvg};
}
export function canonicalPackageHash(pkg,digest) {
  const sorted=[...pkg.files].map(([path,file])=>({path,mime:file.mime,size:file.bytes.length,sha256:digest(file.bytes),sortKey:utf8Bytes(path)}));
  sorted.sort((a,b)=>{const len=Math.min(a.sortKey.length,b.sortKey.length);for(let i=0;i<len;i++)if(a.sortKey[i]!==b.sortKey[i])return a.sortKey[i]-b.sortKey[i];return a.sortKey.length-b.sortKey.length;});
  return digest(JSON.stringify({entryPagePath:pkg.startPage,files:sorted.map(({path,mime,size,sha256})=>({path,mime,size,sha256}))}));
}
const dataUrl=file=>`data:${file.mime};base64,${base64(file.mime==='image/svg+xml'?utf8Bytes(sanitizeSvg(file.text)):file.bytes)}`;
function base64(bytes) {
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',parts=[];
  for(let i=0;i<bytes.length;i+=3){const n=bytes[i]<<16|(bytes[i+1]||0)<<8|(bytes[i+2]||0);parts.push(chars[n>>>18],chars[n>>>12&63],i+1<bytes.length?chars[n>>>6&63]:'=',i+2<bytes.length?chars[n&63]:'=');}
  return parts.join('');
}
function resolve(raw,base,files,{page=false}={}) {
  if(typeof raw!=='string'||!raw||/^\s*\/\//.test(raw)||/^[a-z][\w+.-]*:/i.test(raw)||/[\x00-\x1f\\]/.test(raw))fail('UNRESOLVED_REFERENCE',`外部または不正な参照: ${raw}`);
  if(raw.startsWith('#'))return {path:base,fragment:raw.slice(1),same:true};
  const cut=raw.search(/[?#]/),part=cut<0?raw:raw.slice(0,cut),suffix=cut<0?'':raw.slice(cut);
  if(page&&suffix.startsWith('?'))fail('UNRESOLVED_REFERENCE',`ページのqueryは対象外です: ${raw}`);
  let decoded;
  try {decoded=decodeURIComponent(part).normalize('NFC');}catch{fail('UNRESOLVED_REFERENCE',`URLエンコードが不正です: ${raw}`);}
  if(!decoded||/[\x00-\x1f\\]/.test(decoded))fail('UNRESOLVED_REFERENCE',`不正なパス: ${raw}`);
  const parts=decoded.startsWith('/')?[]:base.split('/').slice(0,-1);
  for(const segment of decoded.split('/')){
    if(!segment||segment==='.')continue;
    if(segment==='..'){if(!parts.length)fail('UNRESOLVED_REFERENCE',`パッケージ外への参照: ${raw}`);parts.pop();}
    else parts.push(segment);
  }
  const path=parts.join('/');
  if(!files.has(path))fail('UNRESOLVED_REFERENCE',`ZIP内の ${path} が見つかりません。`);
  return {path,fragment:suffix.startsWith('#')?suffix.slice(1):suffix.includes('#')?suffix.split('#')[1]:'',same:path===base};
}
function css(text,path,files,checkTime,depth=0,stack=new Set(),context='stylesheet') {
  checkTime();
  if(depth>10||stack.has(path))fail('UNRESOLVED_REFERENCE',`CSSの循環参照: ${path}`);
  stack=new Set(stack);stack.add(path);
  let ast;
  try {ast=cssTree.parse(text,{context,parseValue:true,parseAtrulePrelude:true,onParseError:e=>{throw e;}});}catch{fail('UNRESOLVED_REFERENCE',`CSSを解析できません: ${path}`);}
  cssTree.walk(ast,node=>{if(node.type==='Raw')fail('UNRESOLVED_REFERENCE',`CSSの未解釈部分があります: ${path}`);});
  const imports=[];
  ast.children.forEach((node,item)=>{
    if(node.type!=='Atrule'||node.name.toLowerCase()!=='import')return;
    const children=node.prelude?.children?.toArray()||[];
    const first=children[0],url=first?.type==='Url'?first.value:first?.type==='String'?first.value:null;
    if(!url)fail('UNRESOLVED_REFERENCE',`CSSの@importを解析できません: ${path}`);
    const ref=resolve(url,path,files),file=files.get(ref.path);
    if(file.mime!=='text/css')fail('UNRESOLVED_REFERENCE',`CSSではありません: ${ref.path}`);
    const media=children.slice(1).map(n=>cssTree.generate(n)).join(' ').trim();
    const imported=css(file.text,ref.path,files,checkTime,depth+1,stack);
    imports.push({item,css:media?`@media ${media}{${imported}}`:imported});
  });
  for(const {item,css:replacement} of imports)ast.children.replace(item,cssTree.parse(replacement).children);
  walkCssImages(ast,node=>{
    checkTime();
    if(node.value.startsWith('#'))return;
    const ref=resolve(node.value,path,files),file=files.get(ref.path);
    if(!file.mime.startsWith('image/'))fail('UNRESOLVED_REFERENCE',`CSS画像ではありません: ${ref.path}`);
    node.value=dataUrl(file);
  });
  return cssTree.generate(ast);
}
function srcset(raw,path,files) {
  return raw.split(',').map(candidate=>{
    const match=candidate.trim().match(/^(\S+)(?:\s+(\d+w|\d+(?:\.\d+)?x))?$/);
    if(!match)fail('UNRESOLVED_REFERENCE',`srcsetを解析できません: ${path}`);
    const ref=resolve(match[1],path,files),file=files.get(ref.path);
    if(!file.mime.startsWith('image/'))fail('UNRESOLVED_REFERENCE',`画像ではありません: ${ref.path}`);
    return dataUrl(file)+(match[2]?' '+match[2]:'');
  }).join(', ');
}
function textNode(text,parent){return {nodeName:'#text',value:text,parentNode:parent};}
export function renderPackage(pkg,started=Date.now()) {
  const {files,pages}=pkg,rendered=new Map();let total=0;
  const checkTime=()=>{if(Date.now()-started>20000)fail('PROCESSING_TIMEOUT','表示用HTMLの生成が20秒を超えました。');};
  for(const page of pages) {
    checkTime();
    const source=files.get(page);
    if(!source||source.mime!=='text/html')fail('UNSUPPORTED_TYPE',`HTMLではありません: ${page}`);
    const doc=parse(source.text);
    const visit=node=>{
      checkTime();
      const tag=node.tagName?.toLowerCase();
      if(['iframe','frame','frameset','object','embed','base','form','portal','applet','foreignobject'].includes(tag))fail('UNSUPPORTED_TYPE',`<${tag}>は使えません: ${page}`);
      if(tag==='meta'&&attr(node,'http-equiv'))fail('UNSUPPORTED_TYPE',`meta http-equivは使えません: ${page}`);
      if(tag==='script') {
        if(attr(node,'type')?.value==='module'||attr(node,'nomodule'))fail('UNSUPPORTED_TYPE',`ES Moduleは対象外です: ${page}`);
        const src=attr(node,'src');
        if(src){if(attr(node,'integrity'))fail('UNSUPPORTED_TYPE',`SRI付きscriptは対象外です: ${page}`);const ref=resolve(src.value,page,files),file=files.get(ref.path);if(file.mime!=='text/javascript')fail('UNRESOLVED_REFERENCE',`JavaScriptではありません: ${ref.path}`);src.value=dataUrl(file);node.attrs=node.attrs.filter(a=>a.name!=='crossorigin');}
      }
      if(tag==='link') {
        if(attr(node,'rel')?.value.toLowerCase()!=='stylesheet')fail('UNSUPPORTED_TYPE',`stylesheet以外のlinkは対象外です: ${page}`);
        const href=attr(node,'href');if(!href)fail('UNRESOLVED_REFERENCE',`CSSのhrefがありません: ${page}`);
        const ref=resolve(href.value,page,files),file=files.get(ref.path);if(file.mime!=='text/css')fail('UNRESOLVED_REFERENCE',`CSSではありません: ${ref.path}`);
        node.tagName='style';node.nodeName='style';node.attrs=node.attrs.filter(a=>a.name==='media');node.childNodes=[textNode(css(file.text,ref.path,files,checkTime),node)];
      }
      if(tag==='style')node.childNodes=[textNode(css(node.childNodes.map(n=>n.value||'').join(''),page,files,checkTime),node)];
      for(const a of node.attrs||[]) {
        if(a.name==='srcdoc')fail('UNSUPPORTED_TYPE',`srcdocは使えません: ${page}`);
        if(a.name==='style')a.value=css(a.value,page,files,checkTime,0,new Set(),'declarationList');
        if(['srcset','imagesrcset'].includes(a.name))a.value=srcset(a.value,page,files);
        if(tag==='img'&&a.name==='src'){const ref=resolve(a.value,page,files),file=files.get(ref.path);if(!file.mime.startsWith('image/'))fail('UNRESOLVED_REFERENCE',`画像ではありません: ${ref.path}`);a.value=dataUrl(file);}
        if(tag==='a'&&a.name==='href'){
          const ref=resolve(a.value,page,files,{page:true});
          if(!pages.includes(ref.path))fail('UNRESOLVED_REFERENCE',`HTMLページではありません: ${ref.path}`);
          if(ref.same&&ref.fragment)a.value='#'+ref.fragment;
          else {a.value='#';node.attrs.push({name:'data-shss-page',value:ref.path},{name:'data-shss-fragment',value:ref.fragment});}
        }
        if(['src','href','poster','background','action','formaction','data','cite','longdesc','manifest','ping'].includes(a.name)&&!['script','link','img','a'].includes(tag))fail('UNRESOLVED_REFERENCE',`未対応の参照: ${tag}[${a.name}]`);
      }
      for(const child of node.childNodes||[])visit(child);
      if(node.content)visit(node.content);
    };
    visit(doc);
    const html=serialize(doc);const size=utf8Size(html);if(size>8*1024*1024)fail('LIMIT_EXCEEDED',`表示用HTMLが8 MiBを超えます: ${page}`);
    total+=size;if(total>32*1024*1024)fail('LIMIT_EXCEEDED','表示用HTMLの合計が32 MiBを超えます。');
    rendered.set(page,html);
  }
  return rendered;
}
