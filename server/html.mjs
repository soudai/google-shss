import {parse} from 'parse5';
import {maxImportBytes,maxImportMiB} from './limits.mjs';

export class AppError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export const limits = {html: maxImportBytes, json: 1024 * 1024, body: 2000, threads: 500};
export const utf8Size = text => {
  let size = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) throw new AppError('INVALID_DATA', 'UTF-8に変換できない文字があります。');
    size += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return size;
};

const blocked = new Set(['base','link','frame','frameset','iframe','object','embed','applet','portal','form','foreignobject']);
const resource = new Set(['src','href','poster','background','action','formaction','data','cite','longdesc','manifest','ping']);
const dataAsset = /^data:(?:image\/|audio\/|video\/|font\/|application\/(?:font-woff|x-font-ttf))/i;
const unsupported = what => {throw new AppError('UNSUPPORTED', `${what}は対象外です。自己完結したHTMLを指定してください。`);};
function css(text) {
  if (/@import\b/i.test(text)) unsupported('CSSの@import');
  for (const match of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (!match[2].startsWith('#') && !dataAsset.test(match[2])) unsupported('外部CSSリソース');
  }
}

export function isExternalLink(node,attr) {
  if(node.tagName!=='a'||node.namespaceURI!=='http://www.w3.org/1999/xhtml'||attr.name!=='href')return false;
  // Apps Script has no URL constructor. The viewer also parses the address before use.
  const value=attr.value.trim();
  return value.length<=2048&&!/[\x00-\x20\x7f\\]/.test(value)&&/^https:\/\/[^/?#@]+(?:[/?#]|$)/i.test(value);
}

export function checkHtml(source) {
  if (typeof source !== 'string') unsupported('HTML以外の形式（ZIPを含む）');
  if (source.length > limits.html || utf8Size(source) > limits.html) throw new AppError('TOO_LARGE', 'HTMLは'+maxImportMiB+' MiBまでです。');
  const tree = parse(source);
  const start = source.trimStart();
  if ((!start.startsWith('<!--')&&!/^<(?:!doctype\s+html\b|html[\s>]|head[\s>]|body[\s>])/i.test(start)) || source.includes('\0')) unsupported('HTML以外の形式（ZIPを含む）');
  if (start.startsWith('<!--') && !tree.childNodes.some(n=>n.nodeName==='#documentType')) unsupported('先頭にコメントがありDOCTYPEのないHTML');
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    const tag = node.tagName?.toLowerCase();
    if (blocked.has(tag)) unsupported(`<${tag}>`);
    if (tag === 'script' && node.namespaceURI === 'http://www.w3.org/2000/svg') unsupported('SVG内のscript');
    if (tag === 'meta' && node.attrs.some(a => a.name === 'http-equiv')) unsupported('meta http-equiv');
    if (tag === 'style') css(node.childNodes.map(n => n.value || '').join(''));
    for (const attr of node.attrs || []) {
      const {name,value}=attr;
      if (name === 'style') css(value);
      if (['srcset','imagesrcset','srcdoc'].includes(name)) unsupported(name);
      if (!resource.has(name) || !value.trim()) continue;
      if (isExternalLink(node,attr)) continue;
      const url = value.trim();
      if (tag === 'script' || (!url.startsWith('#') && !(['src','href','poster','background'].includes(name) && dataAsset.test(url) && tag !== 'a' && tag !== 'area'))) unsupported('外部リソースまたはリンク');
    }
    if (node.content) pending.push(node.content);
    for (const child of node.childNodes || []) pending.push(child);
  }
  return source;
}
