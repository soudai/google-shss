import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createService,AppError} from '../server/core.mjs';
import {gunzipText} from '../server/gzip.mjs';
import {maxImportBytes} from '../server/limits.mjs';
import {digest,gzipBase64,html,service} from './helpers.mjs';

const fails = (fn, code) => assert.throws(fn, e => e instanceof AppError && e.code === code, code);
const tooLarge = () => {throw new AppError('TOO_LARGE', 'too large');};

test('gunzipText inflates UTF-8 text', () => {
  assert.equal(gunzipText(gzipBase64('日本語 text'), 1000, tooLarge), '日本語 text');
  // Empty output is valid gzip.
  assert.equal(gunzipText(gzipBase64(''), 1000, tooLarge), '');
});

test('gunzipText bounds the inflated size and rejects bad input', () => {
  // About 1 KiB that inflates to 1 MiB: stopped at the limit.
  const bomb = gzipSync(Buffer.alloc(1024 * 1024)).toString('base64');
  fails(() => gunzipText(bomb, 64 * 1024, tooLarge), 'TOO_LARGE');
  fails(() => gunzipText('not base64!', 1000, tooLarge), 'INVALID_DATA');
  fails(() => gunzipText(Buffer.from('plain').toString('base64'), 1000, tooLarge), 'INVALID_DATA');
  const truncated = gzipSync(Buffer.from('x'.repeat(5000)));
  fails(() => gunzipText(truncated.subarray(0, truncated.length - 8).toString('base64'), 10000, tooLarge), 'INVALID_DATA');
  fails(() => gunzipText(gzipSync(Buffer.from([0xff, 0xfe])).toString('base64'), 1000, tooLarge), 'INVALID_DATA');
});

test('htmlGzip imports the same document as html', () => {
  const plain = service(createService), packed = service(createService);
  const source = html('<p>圧縮して送る</p>');
  const a = plain.run('getDocument', {documentId: plain.run('importDocument', {title: 'T', html: source}).documentId});
  const b = packed.run('getDocument', {documentId: packed.run('importDocument', {title: 'T', htmlGzip: gzipBase64(source)}).documentId});
  assert.equal(b.html, a.html);
  assert.equal(b.sourceHash, a.sourceHash);
});

test('svgGzip imports SVG and keeps the SVG size limit', () => {
  const {run} = service(createService);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
  const {documentId} = run('importDocument', {title: 'S', svgGzip: gzipBase64(svg)});
  assert.match(run('getDocument', {documentId}).html, /data:image\/svg\+xml;base64,/);
  fails(() => run('importDocument', {title: 'S', svgGzip: gzipBase64(svg.replace('</svg>', ' '.repeat(600 * 1024) + '</svg>'))}), 'UNSAFE_SVG');
  fails(() => run('importDocument', {title: 'S', svgGzip: gzipBase64('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')}), 'UNSAFE_SVG');
});

test('compressed HTML larger than the import limit is rejected', () => {
  const {run} = service(createService);
  fails(() => run('importDocument', {title: 'Big', htmlGzip: gzipBase64(html('x'.repeat(maxImportBytes)))}), 'TOO_LARGE');
});

test('exactly one source is accepted', () => {
  const {run} = service(createService);
  const source = html('<p>x</p>');
  fails(() => run('importDocument', {title: 'T', html: source, htmlGzip: gzipBase64(source)}), 'INVALID_DATA');
  fails(() => run('importDocument', {title: 'T', svgGzip: gzipBase64('<svg/>'), zipBase64: 'AAAA'}), 'INVALID_DATA');
  fails(() => run('importDocument', {title: 'T', htmlGzip: 42}), 'INVALID_DATA');
  fails(() => run('importDocument', {title: 'T', sourceFileId: 'bad id'}), 'INVALID_DATA');
});

test('large pages are verified with the hash the store returns', () => {
  const {run, store} = service(createService);
  const big = html('<p>' + 'x'.repeat(200000) + '</p>');
  const {documentId} = run('importDocument', {title: 'Big', html: big});
  const doc = run('getDocument', {documentId});
  assert.equal(doc.html, big);
  // The store reported a different byte hash: the page was changed in Drive.
  const manifest = JSON.parse(store.files.get(store.docs.get(documentId).manifestId).text);
  const file = store.files.get(manifest.versions[0].htmlFileId);
  const readHtml = store.readHtml;
  store.readHtml = f => ({text: f.text, sha256: digest(f.text + 'changed')});
  fails(() => run('getDocument', {documentId}), 'VERSION_MISMATCH');
  store.readHtml = readHtml;
  // With a matching checksum and a cached copy, the page is not read at all.
  const before = store.htmlReads;
  assert.equal(run('getDocument', {documentId, cachedPageHash: file.sha256Checksum}).htmlUnchanged, true);
  assert.equal(store.htmlReads, before);
});
