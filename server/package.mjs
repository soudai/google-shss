import {parse,serialize} from 'parse5';
import * as cssTree from 'css-tree';
import {ASSET_ATTRIBUTES,BLOCKED_TAGS,RESOURCE_ATTRIBUTES,styleText} from './html.mjs';
import {MiB,encodeBase64,fail,utf8Bytes,utf8Size} from './util.mjs';
import {sanitizeSvg} from './svg.mjs';
import {decodeBase64,utf8} from './zip.mjs';
import {validateRaster} from './image.mjs';

const renderLimits={elapsed:20000,page:8*MiB,total:32*MiB};
const attr=(node,name)=>node.attrs?.find(a=>a.name===name);
const textNode=(text,parent)=>({nodeName:'#text',value:text,parentNode:parent});
const parseCss=(text,options)=>cssTree.parse(text,{...options,onParseError:e=>{throw e;}});

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

// Validates an image data: URL. SVG is returned re-encoded after sanitizing;
// raster images are checked and left as they are. Other URLs return null.
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
    return {svg:'data:image/svg+xml;base64,'+encodeBase64(utf8Bytes(sanitizeSvg(xml)))};
  }
  validateRaster(mime,bytes);
  return {};
}

// Sanitizes every SVG data: URL in a single-file HTML document (attributes,
// style attributes and <style> elements) and validates raster data: URLs.
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
    try {ast=parseCss(raw,{context,parseValue:true,parseCustomProperty:true});}
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
      if(ASSET_ATTRIBUTES.has(a.name))a.value=normalize(a.value);
      if(a.name==='style')a.value=normalizeCss(a.value,'declarationList');
    }
    if(node.tagName==='style'){
      const raw=styleText(node);
      const css=normalizeCss(raw,'stylesheet');
      if(css!==raw)node.childNodes=[textNode(css,node)];
    }
    if(node.content)pending.push(node.content);
    for(const child of node.childNodes||[])pending.push(child);
  }
  return {html:hasSvg?serialize(doc):html,hasSvg};
}

const compareBytes=(a,b)=>{
  const len=Math.min(a.length,b.length);
  for(let i=0;i<len;i++)if(a[i]!==b[i])return a[i]-b[i];
  return a.length-b.length;
};
// A hash of the package contents that does not depend on the archive layout.
export function canonicalPackageHash(pkg,digest) {
  const sorted=[...pkg.files].map(([path,file])=>({path,mime:file.mime,size:file.bytes.length,sha256:digest(file.bytes),sortKey:utf8Bytes(path)}));
  sorted.sort((a,b)=>compareBytes(a.sortKey,b.sortKey));
  return digest(JSON.stringify({entryPagePath:pkg.startPage,files:sorted.map(({path,mime,size,sha256})=>({path,mime,size,sha256}))}));
}

const dataUrl=file=>`data:${file.mime};base64,${encodeBase64(file.mime==='image/svg+xml'?utf8Bytes(sanitizeSvg(file.text)):file.bytes)}`;

// Resolves a relative reference from the file at `base` to a file in the package.
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
  const fragment=suffix.startsWith('#')?suffix.slice(1):suffix.includes('#')?suffix.split('#')[1]:'';
  return {path,fragment,same:path===base};
}
// Resolves a reference that must point to a file of an accepted type.
function asset(raw,base,files,accept,message) {
  const ref=resolve(raw,base,files),file=files.get(ref.path);
  if(!accept(file.mime))fail('UNRESOLVED_REFERENCE',`${message}: ${ref.path}`);
  return {ref,file};
}
const isImage=mime=>mime.startsWith('image/');
const isCss=mime=>mime==='text/css';

// Inlines @import and url() references, returning self-contained CSS.
function css(text,path,files,checkTime,depth=0,stack=new Set(),context='stylesheet') {
  checkTime();
  if(depth>10||stack.has(path))fail('UNRESOLVED_REFERENCE',`CSSの循環参照: ${path}`);
  stack=new Set(stack);stack.add(path);
  let ast;
  try {ast=parseCss(text,{context,parseValue:true,parseAtrulePrelude:true});}catch{fail('UNRESOLVED_REFERENCE',`CSSを解析できません: ${path}`);}
  cssTree.walk(ast,node=>{if(node.type==='Raw')fail('UNRESOLVED_REFERENCE',`CSSの未解釈部分があります: ${path}`);});
  const imports=[];
  ast.children.forEach((node,item)=>{
    if(node.type!=='Atrule'||node.name.toLowerCase()!=='import')return;
    const children=node.prelude?.children?.toArray()||[];
    const first=children[0],url=first?.type==='Url'||first?.type==='String'?first.value:null;
    if(!url)fail('UNRESOLVED_REFERENCE',`CSSの@importを解析できません: ${path}`);
    const {ref,file}=asset(url,path,files,isCss,'CSSではありません');
    const media=children.slice(1).map(n=>cssTree.generate(n)).join(' ').trim();
    const imported=css(file.text,ref.path,files,checkTime,depth+1,stack);
    imports.push({item,css:media?`@media ${media}{${imported}}`:imported});
  });
  for(const {item,css:replacement} of imports)ast.children.replace(item,cssTree.parse(replacement).children);
  walkCssImages(ast,node=>{
    checkTime();
    if(node.value.startsWith('#'))return;
    node.value=dataUrl(asset(node.value,path,files,isImage,'CSS画像ではありません').file);
  });
  return cssTree.generate(ast);
}
// Visits url() values and the quoted URLs inside image() and image-set().
function walkCssImages(ast,visit) {
  cssTree.walk(ast,node=>{
    if(node.type==='Url')visit(node);
    if(node.type==='Function'&&/^(?:(?:-webkit-)?image-set|image)$/i.test(cssTree.ident.decode(node.name))){
      node.children.forEach(child=>{if(child.type==='String')visit(child);});
    }
  });
}
function srcset(raw,path,files) {
  return raw.split(',').map(candidate=>{
    const match=candidate.trim().match(/^(\S+)(?:\s+(\d+w|\d+(?:\.\d+)?x))?$/);
    if(!match)fail('UNRESOLVED_REFERENCE',`srcsetを解析できません: ${path}`);
    return dataUrl(asset(match[1],path,files,isImage,'画像ではありません').file)+(match[2]?' '+match[2]:'');
  }).join(', ');
}

// Tags whose references renderPackage rewrites; references on any other tag are rejected.
const REWRITTEN_TAGS=new Set(['script','link','img','a']);

// Builds one self-contained HTML document per page: scripts, stylesheets and
// images become data: URLs, and links between pages become data-shss-page
// attributes that the preview bridge turns into navigation messages.
export function renderPackage(pkg,started=Date.now()) {
  const {files,pages}=pkg,rendered=new Map();let total=0;
  const checkTime=()=>{if(Date.now()-started>renderLimits.elapsed)fail('PROCESSING_TIMEOUT','表示用HTMLの生成が20秒を超えました。');};
  for(const page of pages) {
    checkTime();
    const source=files.get(page);
    if(!source||source.mime!=='text/html')fail('UNSUPPORTED_TYPE',`HTMLではありません: ${page}`);
    const elements=new Map(Object.entries({
      script(node) {
        if(attr(node,'type')?.value==='module'||attr(node,'nomodule'))fail('UNSUPPORTED_TYPE',`ES Moduleは対象外です: ${page}`);
        const src=attr(node,'src');
        if(!src)return;
        if(attr(node,'integrity'))fail('UNSUPPORTED_TYPE',`SRI付きscriptは対象外です: ${page}`);
        src.value=dataUrl(asset(src.value,page,files,mime=>mime==='text/javascript','JavaScriptではありません').file);
        node.attrs=node.attrs.filter(a=>a.name!=='crossorigin');
      },
      link(node) {
        if(attr(node,'rel')?.value.toLowerCase()!=='stylesheet')fail('UNSUPPORTED_TYPE',`stylesheet以外のlinkは対象外です: ${page}`);
        const href=attr(node,'href');
        if(!href)fail('UNRESOLVED_REFERENCE',`CSSのhrefがありません: ${page}`);
        const {ref,file}=asset(href.value,page,files,isCss,'CSSではありません');
        node.tagName='style';node.nodeName='style';
        node.attrs=node.attrs.filter(a=>a.name==='media');
        node.childNodes=[textNode(css(file.text,ref.path,files,checkTime),node)];
      },
      style(node) {
        node.childNodes=[textNode(css(styleText(node),page,files,checkTime),node)];
      }
    }));
    const attribute=(tag,node,a)=>{
      if(a.name==='srcdoc')fail('UNSUPPORTED_TYPE',`srcdocは使えません: ${page}`);
      if(a.name==='style')a.value=css(a.value,page,files,checkTime,0,new Set(),'declarationList');
      if(['srcset','imagesrcset'].includes(a.name))a.value=srcset(a.value,page,files);
      if(tag==='img'&&a.name==='src')a.value=dataUrl(asset(a.value,page,files,isImage,'画像ではありません').file);
      if(tag==='a'&&a.name==='href'){
        const ref=resolve(a.value,page,files,{page:true});
        if(!pages.includes(ref.path))fail('UNRESOLVED_REFERENCE',`HTMLページではありません: ${ref.path}`);
        if(ref.same&&ref.fragment)a.value='#'+ref.fragment;
        else {a.value='#';node.attrs.push({name:'data-shss-page',value:ref.path},{name:'data-shss-fragment',value:ref.fragment});}
      }
      if(RESOURCE_ATTRIBUTES.has(a.name)&&!REWRITTEN_TAGS.has(tag))fail('UNRESOLVED_REFERENCE',`未対応の参照: ${tag}[${a.name}]`);
    };
    const visit=node=>{
      checkTime();
      const tag=node.tagName?.toLowerCase();
      if(BLOCKED_TAGS.has(tag))fail('UNSUPPORTED_TYPE',`<${tag}>は使えません: ${page}`);
      if(tag==='meta'&&attr(node,'http-equiv'))fail('UNSUPPORTED_TYPE',`meta http-equivは使えません: ${page}`);
      elements.get(tag)?.(node);
      for(const a of node.attrs||[])attribute(tag,node,a);
      for(const child of node.childNodes||[])visit(child);
      if(node.content)visit(node.content);
    };
    const doc=parse(source.text);
    visit(doc);
    const html=serialize(doc),size=utf8Size(html);
    if(size>renderLimits.page)fail('LIMIT_EXCEEDED',`表示用HTMLが8 MiBを超えます: ${page}`);
    total+=size;
    if(total>renderLimits.total)fail('LIMIT_EXCEEDED','表示用HTMLの合計が32 MiBを超えます。');
    rendered.set(page,html);
  }
  return rendered;
}
