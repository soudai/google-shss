import {SaxesParser} from 'saxes';
import * as cssTree from 'css-tree';
import {AppError,utf8Size} from './html.mjs';

const SVG='http://www.w3.org/2000/svg',XLINK='http://www.w3.org/1999/xlink';
export const SVG_POLICY_VERSION=1;
const tags=new Set(['svg','g','defs','style','symbol','use','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','title','desc','linearGradient','radialGradient','stop','clipPath','mask']);
const attrs=new Set(['id','class','role','aria-label','viewBox','preserveAspectRatio','x','y','width','height','cx','cy','r','rx','ry','x1','y1','x2','y2','points','d','offset','transform','gradientTransform','gradientUnits','spreadMethod','maskUnits','maskContentUnits','clipPathUnits','fill','fill-rule','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','stroke-dashoffset','stroke-opacity','fill-opacity','opacity','color','display','visibility','stop-color','stop-opacity','font-size','font-family','font-weight','text-anchor','dominant-baseline','style','href','clip-path','mask']);
const cssProperties=new Set(['fill','fill-rule','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','stroke-dashoffset','stroke-opacity','fill-opacity','opacity','color','display','visibility','stop-color','stop-opacity','font-size','font-family','font-weight','text-anchor','dominant-baseline','clip-path','mask']);
const fail=(message)=>{throw new AppError('UNSAFE_SVG',message);};
const maxCost=100000,maxExpansionDepth=128;
const numberPattern=/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const pathArity={m:2,l:2,h:1,v:1,c:6,s:4,q:4,t:2,a:4,z:0};
const escapeText=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const escapeAttr=s=>escapeText(s).replace(/"/g,'&quot;');
const ref=value=>{const m=value.match(/^#([A-Za-z_][\w.:-]{0,127})$/);if(!m)fail('SVG参照は同一画像内の#idだけ使えます。');return m[1];};
function numberCheck(value) {
  if(/\b(?:NaN|Infinity)\b/i.test(value))fail('SVGに非有限の数値があります。');
  for(const m of value.matchAll(numberPattern))if(!Number.isFinite(Number(m[0]))||Math.abs(Number(m[0]))>1e8)fail('SVGの数値が範囲外です。');
}
function drawingCost({tag,attrs}) {
  if(tag==='polyline'||tag==='polygon')return Math.ceil((attrs.points?.match(numberPattern)?.length||0)/2);
  if(tag!=='path'||!attrs.d)return 0;
  let cost=0;
  for(const [,command,operands] of attrs.d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g)){
    const arity=pathArity[command.toLowerCase()];
    // Arc flags can be packed together with coordinates, so use a conservative divisor.
    const count=operands.match(numberPattern)?.length||0;
    cost+=arity?Math.max(1,Math.ceil(count/arity)):1;
  }
  return cost;
}
function css(raw,references) {
  let ast;
  try {ast=cssTree.parse(raw,{context:'stylesheet',parseValue:true,onParseError:e=>{throw e;}});}catch{fail('SVGのCSSを解析できません。');}
  cssTree.walk(ast,node=>{
    if(node.type==='Raw'||node.type==='Atrule')fail('SVGのCSS構文は対象外です。');
    if(node.type==='Declaration'&&!cssProperties.has(node.property.toLowerCase()))fail(`SVGのCSSプロパティは対象外です: ${node.property}`);
    if(node.type==='Url')references.push(ref(node.value));
    if(node.type==='Function'&&/^(?:var|env|attr|calc)$/i.test(node.name))fail('SVGのCSS関数は対象外です。');
  });
  return cssTree.generate(ast);
}
function styleAttribute(raw,references) {
  let ast;
  try {ast=cssTree.parse(raw,{context:'declarationList',parseValue:true,onParseError:e=>{throw e;}});}catch{fail('SVGのstyle属性を解析できません。');}
  cssTree.walk(ast,node=>{
    if(node.type==='Raw'||node.type==='Atrule')fail('SVGのstyle属性が不正です。');
    if(node.type==='Declaration'&&!cssProperties.has(node.property.toLowerCase()))fail(`SVGのstyle属性は対象外です: ${node.property}`);
    if(node.type==='Url')references.push(ref(node.value));
    if(node.type==='Function'&&/^(?:var|env|attr|calc)$/i.test(node.name))fail('SVGのCSS関数は対象外です。');
  });
  return cssTree.generate(ast);
}
function checkDimensions(width,height) {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width>8192||height>8192||width*height>16000000)fail('SVGの描画領域が上限を超えるか不明です。');
}
const pixelsPerUnit={px:1,in:96,cm:96/2.54,mm:96/25.4,q:96/101.6,pt:96/72,pc:16};
function dimension(value,fallback) {
  if(value===undefined||value.trim().toLowerCase()==='auto')return fallback;
  const match=value.trim().match(/^([+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(px|in|cm|mm|q|pt|pc|%)?$/i);
  if(!match)return NaN;
  const number=Number(match[1]),unit=(match[2]||'px').toLowerCase();
  if(unit==='%')return number>0&&number<=100?fallback:NaN;
  return number*pixelsPerUnit[unit];
}
function dimensions(root) {
  let width,height;
  if(root.attrs.viewBox!==undefined){
    const box=root.attrs.viewBox.trim().split(/[\s,]+/).map(Number);
    if(box.length!==4||!box.every(Number.isFinite))fail('SVGのviewBoxが不正です。');
    [, ,width,height]=box;
    checkDimensions(width,height);
  }
  checkDimensions(dimension(root.attrs.width,width),dimension(root.attrs.height,height));
}
export function sanitizeSvg(source) {
  if(typeof source!=='string'||utf8Size(source)>512*1024)fail('SVGは512 KiBまでです。');
  const parser=new SaxesParser({xmlns:true});let root=null,top=null,count=0,operations=0,closed=false;
  const ids=new Map();
  parser.on('doctype',()=>fail('SVGのDOCTYPEは使えません。'));
  parser.on('processinginstruction',()=>fail('SVGの処理命令は使えません。'));
  parser.on('error',()=>fail('SVGのXMLが不正です。'));
  parser.on('opentag',tag=>{
    if(closed||tag.uri!==SVG||!tags.has(tag.local)||!top&&tag.local!=='svg'||top&&top.depth>=64)fail(`SVG要素は対象外です: ${tag.name}`);
    if(++count>10000)fail('SVGの要素数が上限を超えています。');
    const node={tag:tag.local,attrs:{},children:[],refs:[],parent:top,depth:top?top.depth+1:1};
    for(const a of Object.values(tag.attributes)) {
      if(a.name==='xmlns'||a.name==='xmlns:xlink')continue;
      if(a.uri&&a.uri!==XLINK||a.uri===XLINK&&a.local!=='href'||!attrs.has(a.local)||/^on/i.test(a.local))fail(`SVG属性は対象外です: ${a.name}`);
      const key=a.uri===XLINK?'xlink:href':a.local;
      if(key==='href'||key==='xlink:href')node.refs.push(ref(a.value));
      else if(key==='style')a.value=styleAttribute(a.value,node.refs);
      else if(['fill','stroke','clip-path','mask','stop-color'].includes(key)){
        let ast;
        try {ast=cssTree.parse(a.value,{context:'value',onParseError:e=>{throw e;}});}catch{fail('SVGの描画属性を解析できません。');}
        cssTree.walk(ast,child=>{
          if(child.type==='Raw')fail('SVGの描画属性を解析できません。');
          if(child.type==='Url')node.refs.push(ref(child.value));
          if(child.type==='Function'&&/^(?:var|env|attr|calc)$/i.test(child.name))fail('SVGの関数は対象外です。');
        });
      }
      numberCheck(a.value);
      node.attrs[key]=a.value;
    }
    if(node.attrs.id){if(ids.has(node.attrs.id))fail('SVGのIDが重複しています。');ids.set(node.attrs.id,node);}
    node.cost=drawingCost(node);
    operations+=node.cost;
    if(operations>maxCost)fail('SVGの描画命令が上限を超えています。');
    if(top)top.children.push(node);else root=node;
    top=node;
  });
  parser.on('text',text=>{if(!top){if(text.trim())fail('SVGの外にテキストがあります。');return;}top.children.push(text);});
  parser.on('cdata',text=>{if(!top||!['style','text','tspan','title','desc'].includes(top.tag))fail('SVGのCDATAは対象外です。');top.children.push(text);});
  parser.on('closetag',()=>{top=top?.parent||null;if(!top)closed=true;});
  try {parser.write(source).close();}catch(e){if(e instanceof AppError)throw e;fail('SVGのXMLが不正です。');}
  if(!root||root.tag!=='svg'||top)fail('SVGのルートが不正です。');
  dimensions(root);
  const prepare=node=>{
    if(typeof node==='string')return;
    if(node.tag==='style'){
      if(node.children.some(child=>typeof child!=='string'))fail('SVGのstyle内に要素は置けません。');
      node.styleCss=css(node.children.join(''),node.refs);
    }
    for(const child of node.children)prepare(child);
  };
  prepare(root);
  const active=new Set(),expanded=new Map();
  const visit=node=>{
    if(active.has(node))fail('SVGの参照が循環しています。');
    if(active.size>=maxExpansionDepth)fail('SVGの参照が深すぎます。');
    if(expanded.has(node))return expanded.get(node);
    active.add(node);
    let cost=1+node.cost,depth=1;
    const add=child=>{
      const result=visit(child);
      cost+=result.cost;depth=Math.max(depth,1+result.depth);
      if(cost>maxCost)fail('SVGの参照展開が上限を超えています。');
      if(depth>maxExpansionDepth)fail('SVGの参照が深すぎます。');
    };
    for(const id of node.refs){
      const target=ids.get(id);
      if(!target)fail(`SVGの参照先がありません: #${id}`);
      add(target);
    }
    for(const child of node.children)if(typeof child!=='string')add(child);
    active.delete(node);
    const result={cost,depth};
    expanded.set(node,result);
    return result;
  };
  visit(root);
  const render=node=>{
    if(typeof node==='string')return escapeText(node);
    const attributes=Object.entries(node.attrs).map(([key,value])=>` ${key}="${escapeAttr(value)}"`).join('');
    const body=node.children.map(render).join('');
    if(node.tag==='style')return `<style${attributes}>${escapeText(node.styleCss)}</style>`;
    return `<${node.tag}${attributes}>${body}</${node.tag}>`;
  };
  const result=render(root).replace(/^<svg(?=[ >])/,`<svg xmlns="${SVG}" xmlns:xlink="${XLINK}"`);
  if(utf8Size(result)>512*1024)fail('SVGの生成物が512 KiBを超えています。');
  return result;
}
