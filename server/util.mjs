// Shared primitives for the server bundle. Apps Script has no TextEncoder,
// Buffer or atob, so UTF-8 and base64 are implemented here.

export class AppError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export const fail = (code, message) => {throw new AppError(code, message);};

export const KiB = 1024;
export const MiB = 1024 * KiB;

// Decoded raster images and SVG viewports share one size budget.
export const PIXEL_LIMITS = {side: 8192, area: 16000000, frames: 100};

export function utf8Size(text) {
  let size = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) fail('INVALID_DATA', 'UTF-8に変換できない文字があります。');
    size += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return size;
}

export function utf8Bytes(text) {
  const bytes = [];
  for (const c of text) {
    const cp = c.codePointAt(0);
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | cp >> 6, 0x80 | cp & 63);
    else if (cp < 0x10000) bytes.push(0xe0 | cp >> 12, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
    else bytes.push(0xf0 | cp >> 18, 0x80 | cp >> 12 & 63, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
  }
  return Uint8Array.from(bytes);
}

// Strict decoder: rejects overlong forms, surrogates and truncated sequences.
export function decodeUtf8(bytes, code, message) {
  const invalid = () => fail(code, message);
  const parts = [];
  let chars = [];
  for (let i = 0; i < bytes.length;) {
    const a = bytes[i++];
    let cp = a, need = 0, min = 0;
    if (a >= 0xc2 && a <= 0xdf) {cp = a & 31; need = 1; min = 0x80;}
    else if (a >= 0xe0 && a <= 0xef) {cp = a & 15; need = 2; min = 0x800;}
    else if (a >= 0xf0 && a <= 0xf4) {cp = a & 7; need = 3; min = 0x10000;}
    else if (a >= 0x80) invalid();
    if (i + need > bytes.length) invalid();
    for (let j = 0; j < need; j++) {
      const b = bytes[i++];
      if ((b & 0xc0) !== 0x80) invalid();
      cp = cp << 6 | b & 63;
    }
    if (cp < min || cp > 0x10ffff || cp >= 0xd800 && cp <= 0xdfff) invalid();
    chars.push(String.fromCodePoint(cp));
    if (chars.length === 8192) {parts.push(chars.join('')); chars = [];}
  }
  return parts.join('') + chars.join('');
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeBase64(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes[i] << 16 | (bytes[i + 1] || 0) << 8 | (bytes[i + 2] || 0);
    parts.push(BASE64[n >>> 18], BASE64[n >>> 12 & 63],
      i + 1 < bytes.length ? BASE64[n >>> 6 & 63] : '=',
      i + 2 < bytes.length ? BASE64[n & 63] : '=');
  }
  return parts.join('');
}

// Accepts only canonical, padded base64 whose decoded size is at most maxBytes.
export function decodeBase64(value, maxBytes, code, message) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 + 4 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(code, message);
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(value.length / 4 * 3 - padding);
  const sextet = c => c === '=' ? 0 : BASE64.indexOf(c);
  let pos = 0;
  for (let i = 0; i < value.length; i += 4) {
    const n = sextet(value[i]) << 18 | sextet(value[i + 1]) << 12 | sextet(value[i + 2]) << 6 | sextet(value[i + 3]);
    out[pos++] = n >>> 16;
    if (pos < out.length) out[pos++] = n >>> 8 & 255;
    if (pos < out.length) out[pos++] = n & 255;
  }
  return out;
}
