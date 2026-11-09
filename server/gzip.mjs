import {Gunzip} from 'fflate';
import {AppError,crc32Final,crc32Update,decodeBase64,decodeUtf8,fail,readU32LE} from './util.mjs';

const CHUNK = 64 * 1024;

// Decodes base64 gzip data from the browser (CompressionStream) into UTF-8 text.
// Output is limited while inflating, so a small payload cannot expand without bound.
export function gunzipText(base64, maxBytes, tooLarge) {
  const compressed = decodeBase64(base64, maxBytes, 'INVALID_DATA', '圧縮データが不正です。');
  const chunks = [];
  let length = 0, ended = false;
  const stream = new Gunzip((chunk, final) => {
    length += chunk.length;
    if (length > maxBytes) tooLarge();
    chunks.push(chunk);
    if (final) ended = true;
  });
  try {
    for (let at = 0; at < compressed.length; at += CHUNK) {
      const end = Math.min(at + CHUNK, compressed.length);
      stream.push(compressed.subarray(at, end), end === compressed.length);
    }
    if (!compressed.length) stream.push(new Uint8Array(0), true);
  } catch (e) {
    if (e instanceof AppError) throw e;
    fail('INVALID_DATA', '圧縮データを展開できません。');
  }
  if (!ended) fail('INVALID_DATA', '圧縮データを展開できません。');
  const bytes = new Uint8Array(length);
  let pos = 0;
  for (const chunk of chunks) {bytes.set(chunk, pos); pos += chunk.length;}
  // fflate does not check the trailer, so a truncated upload would pass unnoticed.
  // A single gzip member ends with the CRC-32 and size of its content.
  const end = compressed.length;
  if (end < 18 || readU32LE(compressed, end - 8) !== crc32Final(crc32Update(0xffffffff, bytes)) || readU32LE(compressed, end - 4) !== length >>> 0)
    fail('INVALID_DATA', '圧縮データが壊れています。');
  return decodeUtf8(bytes, 'INVALID_DATA', 'UTF-8のファイルを指定してください。');
}
