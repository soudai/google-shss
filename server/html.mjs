import {parse} from 'parse5';
import {AppError,MiB,utf8Size} from './util.mjs';

export const limits = {html: 2 * MiB, json: MiB, body: 2000, threads: 500};

// Elements that can navigate, embed other documents or submit data. Single-file
// HTML additionally rejects <link>; ZIP packages inline stylesheet links instead.
export const BLOCKED_TAGS = new Set(['base','frame','frameset','iframe','object','embed','applet','portal','form','foreignobject']);
// Attributes that load or point to another resource.
export const RESOURCE_ATTRIBUTES = new Set(['src','href','poster','background','action','formaction','data','cite','longdesc','manifest','ping']);
// Resource attributes that may carry an inline data: image.
export const ASSET_ATTRIBUTES = new Set(['src','href','poster','background']);

const dataAsset = /^data:(?:image\/|audio\/|video\/|font\/|application\/(?:font-woff|x-font-ttf))/i;
const unsupported = what => {throw new AppError('UNSUPPORTED', `${what}は対象外です。自己完結したHTMLを指定してください。`);};
const notHtml = () => unsupported('HTML以外の形式（ZIPを含む）');

export const styleText = node => node.childNodes.map(n => n.value || '').join('');

function css(text) {
  if (/@import\b/i.test(text)) unsupported('CSSの@import');
  for (const match of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (!match[2].startsWith('#') && !dataAsset.test(match[2])) unsupported('外部CSSリソース');
  }
}

function checkUrl(tag, name, value) {
  const url = value.trim();
  if (!url) return;
  const inlineAsset = ASSET_ATTRIBUTES.has(name) && dataAsset.test(url) && tag !== 'a' && tag !== 'area';
  if (tag === 'script' || (!url.startsWith('#') && !inlineAsset)) unsupported('外部リソースまたはリンク');
}

function checkElement(node) {
  const tag = node.tagName?.toLowerCase();
  if (BLOCKED_TAGS.has(tag) || tag === 'link') unsupported(`<${tag}>`);
  if (tag === 'script' && node.namespaceURI === 'http://www.w3.org/2000/svg') unsupported('SVG内のscript');
  if (tag === 'meta' && node.attrs.some(a => a.name === 'http-equiv')) unsupported('meta http-equiv');
  if (tag === 'style') css(styleText(node));
  for (const {name, value} of node.attrs || []) {
    if (name === 'style') css(value);
    if (['srcset','imagesrcset','srcdoc'].includes(name)) unsupported(name);
    if (RESOURCE_ATTRIBUTES.has(name)) checkUrl(tag, name, value);
  }
}

// Checks that a single HTML file is self-contained: no external loads, links or
// embedded documents. Returns the source unchanged.
export function checkHtml(source) {
  if (typeof source !== 'string') notHtml();
  if (source.length > limits.html || utf8Size(source) > limits.html) throw new AppError('TOO_LARGE', 'HTMLは2 MiBまでです。');
  const tree = parse(source);
  const start = source.trimStart();
  const startsWithComment = start.startsWith('<!--');
  if ((!startsWithComment && !/^<(?:!doctype\s+html\b|html[\s>]|head[\s>]|body[\s>])/i.test(start)) || source.includes('\0')) notHtml();
  if (startsWithComment && !tree.childNodes.some(n => n.nodeName === '#documentType')) unsupported('先頭にコメントがありDOCTYPEのないHTML');
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    checkElement(node);
    if (node.content) pending.push(node.content);
    for (const child of node.childNodes || []) pending.push(child);
  }
  return source;
}
