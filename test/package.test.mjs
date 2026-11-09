import test from 'node:test';
import assert from 'node:assert/strict';
import {strToU8} from 'fflate';
import {inspectZip,decodeBase64,utf8} from '../server/zip.mjs';
import {renderPackage,canonicalPackageHash,sanitizeHtmlImages} from '../server/package.mjs';
import {encodeBase64,utf8Bytes} from '../server/util.mjs';
import {digest,html,png,zip,zipBase64} from './helpers.mjs';

const fails = (fn, code) => assert.throws(fn, e => e.code === code);

test('utf8 helpers round-trip', () => {
  const text = 'aé日😀';
  assert.deepEqual([...utf8Bytes(text)], [...Buffer.from(text, 'utf8')]);
  assert.equal(utf8(Buffer.from(text, 'utf8')), text);
  fails(() => utf8(Uint8Array.from([0xc0, 0x80])), 'INVALID_ARCHIVE');
  assert.deepEqual([...decodeBase64(Buffer.from('hello!').toString('base64'))], [...Buffer.from('hello!')]);
  fails(() => decodeBase64('abc'), 'INVALID_ARCHIVE');
  for (const sample of ['', 'a', 'ab', 'abc', 'abcd', '日本語😀']) {
    const bytes = Buffer.from(sample, 'utf8');
    assert.equal(encodeBase64(bytes), bytes.toString('base64'));
    assert.deepEqual([...decodeBase64(bytes.toString('base64'))], [...bytes]);
  }
});

test('inspectZip reads pages and picks the start page', () => {
  const pkg = inspectZip(zipBase64({'index.html': html('a'), 'b/two.htm': html('b'), 'style.css': 'p{}', '__MACOSX/x.js': '1'}));
  assert.deepEqual(pkg.pages.sort(), ['b/two.htm', 'index.html']);
  assert.equal(pkg.startPage, 'index.html');
  assert.equal(pkg.files.get('style.css').mime, 'text/css');
  assert.equal(pkg.files.has('__MACOSX/x.js'), false);
  assert.equal(inspectZip(zip({'a.html': html('a'), 'b.html': html('b')})).startPage, null);
  assert.equal(inspectZip(zip({'only.html': html('a')})).startPage, 'only.html');
});

test('inspectZip rejects unsafe archives', () => {
  fails(() => inspectZip(zip({'index.html': html(''), 'run.exe': 'x'})), 'UNSUPPORTED_TYPE');
  fails(() => inspectZip(zip({'../index.html': html('')})), 'UNSAFE_PATH');
  fails(() => inspectZip(zip({'a.css': 'p{}'})), 'LIMIT_EXCEEDED');
  fails(() => inspectZip(zip({'index.html': html(''), 'img.png': strToU8('not a png')})), 'UNSUPPORTED_TYPE');
  const corrupt = zip({'index.html': html('x')});
  corrupt[corrupt.length - 6] ^= 1;
  assert.throws(() => inspectZip(corrupt), e => ['INVALID_ARCHIVE', 'LIMIT_EXCEEDED'].includes(e.code));
  fails(() => inspectZip(new Uint8Array(10)), 'INVALID_ARCHIVE');
});

test('renderPackage inlines assets and rewrites page links', () => {
  const pkg = inspectZip(zip({
    'index.html': html('<link rel="stylesheet" href="css/a.css"><img src="img/p.png"><script src="app.js"></script><a href="sub/page.html#top">next</a><a href="#here">here</a>'),
    'sub/page.html': html('<a href="../index.html">back</a>'),
    'css/a.css': '@import "b.css" screen; p{background:url(../img/p.png)}',
    'css/b.css': 'h1{color:red}',
    'img/p.png': png(),
    'app.js': 'console.log(1)'
  }));
  const rendered = renderPackage(pkg);
  const index = rendered.get('index.html');
  assert.match(index, /<style>@media screen\{h1\{color:red\}\}p\{background:url\(data:image\/png;base64,/);
  assert.match(index, /<img src="data:image\/png;base64,/);
  assert.match(index, /<script src="data:text\/javascript;base64,Y29uc29sZS5sb2coMSk="><\/script>/);
  assert.match(index, /<a href="#" data-shss-page="sub\/page.html" data-shss-fragment="top">next<\/a>/);
  assert.match(index, /<a href="#here">here<\/a>/);
  assert.match(rendered.get('sub/page.html'), /data-shss-page="index.html" data-shss-fragment=""/);
});

test('renderPackage rejects unresolved and unsupported references', () => {
  const render = files => renderPackage(inspectZip(zip(files)));
  fails(() => render({'index.html': html('<img src="missing.png">')}), 'UNRESOLVED_REFERENCE');
  fails(() => render({'index.html': html('<img src="https://x/y.png">')}), 'UNRESOLVED_REFERENCE');
  fails(() => render({'index.html': html('<img src="../../x.png">')}), 'UNRESOLVED_REFERENCE');
  fails(() => render({'index.html': html('<iframe></iframe>')}), 'UNSUPPORTED_TYPE');
  fails(() => render({'index.html': html('<script type="module"></script>')}), 'UNSUPPORTED_TYPE');
  fails(() => render({'index.html': html('<link rel="icon" href="a.css">'), 'a.css': ''}), 'UNSUPPORTED_TYPE');
  fails(() => render({'index.html': html('<link rel="stylesheet" href="a.css">'), 'a.css': '@import "a.css";'}), 'UNRESOLVED_REFERENCE');
  fails(() => render({'index.html': html('<video src="a.png"></video>'), 'a.png': png()}), 'UNRESOLVED_REFERENCE');
});

test('canonicalPackageHash ignores archive order', () => {
  const a = inspectZip(zip({'index.html': html('a'), 'b.css': 'p{}'}));
  const b = inspectZip(zip({'b.css': 'p{}', 'index.html': html('a')}));
  assert.equal(canonicalPackageHash(a, digest), canonicalPackageHash(b, digest));
  assert.match(canonicalPackageHash(a, digest), /^[0-9a-f]{64}$/);
});

test('sanitizeHtmlImages rewrites SVG data URLs', () => {
  const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
  const result = sanitizeHtmlImages(html(`<img src="data:image/svg+xml,${svg}"><p style="background:url('data:image/svg+xml,${svg}')">x</p>`));
  assert.equal(result.hasSvg, true);
  assert.equal((result.html.match(/data:image\/svg\+xml;base64,/g) || []).length, 2);
  const plain = html('<p>no images</p>');
  assert.deepEqual(sanitizeHtmlImages(plain), {html: plain, hasSvg: false});
  fails(() => sanitizeHtmlImages(html(`<img src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')}">`)), 'UNSAFE_SVG');
});
