// Turns a file chosen in the import dialog into the payload for importDocument
// or appendVersion. Work that can run in the browser runs here, so mistakes are
// reported before the upload starts and the upload is as small as possible.
import {inspectZip} from '../server/zip.mjs';
import {maxImportBytes,maxImportMiB} from '../server/limits.mjs';

export const MAX_SVG_BYTES = 512 * 1024;
const DRIVE_ID = /^[\w-]{1,128}$/;

export function fileKind(name) {
  if (/\.zip$/i.test(name)) return 'zip';
  if (/\.svg$/i.test(name)) return 'svg';
  if (/\.html?$/i.test(name)) return 'html';
  return null;
}

export const titleFromFileName = name => (name.replace(/\.(?:html?|zip|svg)$/i, '') || '新しい文書').slice(0, 160);

// Accepts a Drive file ID or a drive.google.com file URL.
export function driveId(raw) {
  const value = raw.trim();
  if (DRIVE_ID.test(value)) return value;
  let url;
  try {url = new URL(value);} catch {url = null;}
  const id = url && (url.pathname.match(/^\/file\/d\/([\w-]{1,128})(?:\/|$)/)?.[1] || url.searchParams.get('id'));
  if (url?.origin !== 'https://drive.google.com' || !id || !DRIVE_ID.test(id)) throw new Error('Google DriveのファイルURLまたはIDを指定してください。');
  return id;
}

export function toBase64(bytes) {
  let encoded = '';
  // Chunks keep String.fromCharCode below the argument count limit.
  for (let at = 0; at < bytes.length; at += 24576) encoded += btoa(String.fromCharCode(...bytes.subarray(at, at + 24576)));
  return encoded;
}

// gzip with the browser's native CompressionStream. Returns null when unavailable.
export async function gzip(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeText(bytes) {
  try {return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);}
  catch {throw new Error('UTF-8のファイルを指定してください。');}
}

// Sends text compressed when that is shorter. HTML and SVG usually shrink 4-10x.
async function textPayload(kind, bytes, text, compress) {
  const packed = await compress(bytes).catch(() => null);
  if (packed) {
    const encoded = toBase64(packed);
    if (encoded.length < text.length) return {[kind + 'Gzip']: encoded};
  }
  return {[kind]: text};
}

// Returns {kind, input, pages, startPage}. For a ZIP without an obvious start
// page, startPage is null and the caller asks the user to choose one of pages.
export async function prepareImport(file, {compress = gzip} = {}) {
  const kind = fileKind(file.name);
  if (kind === 'zip') {
    if (file.size > maxImportBytes) throw new Error('ZIPは' + maxImportMiB + ' MiBまでです。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    // The server repeats this check; running it here avoids uploading the
    // archive twice and reports problems immediately.
    const pkg = inspectZip(bytes);
    return {kind, input: {zipBase64: toBase64(bytes)}, pages: pkg.pages, startPage: pkg.startPage};
  }
  if (kind === 'svg') {
    if (file.size > MAX_SVG_BYTES) throw new Error('SVGは512 KiBまでです。');
  } else if (kind !== 'html' || file.size > maxImportBytes) {
    throw new Error(maxImportMiB + ' MiB以内のHTMLまたはZIPを指定してください。');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const input = await textPayload(kind, bytes, decodeText(bytes), compress);
  return {kind, input, pages: ['index.html'], startPage: 'index.html'};
}
