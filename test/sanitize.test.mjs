import test from 'node:test';
import assert from 'node:assert/strict';
import {checkHtml} from '../server/html.mjs';
import {AppError,utf8Size} from '../server/util.mjs';
import {maxImportBytes} from '../server/limits.mjs';
import {sanitizeSvg} from '../server/svg.mjs';
import {validateRaster} from '../server/image.mjs';
import {html,png} from './helpers.mjs';

const rejects = (fn, code) => assert.throws(fn, e => e instanceof AppError && e.code === code);
const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`;

test('utf8Size counts UTF-8 bytes and rejects lone surrogates', () => {
  assert.equal(utf8Size('aé日😀'), 1 + 2 + 3 + 4);
  rejects(() => utf8Size('\ud800'), 'INVALID_DATA');
});

test('checkHtml accepts self-contained HTML', () => {
  const source = html('<p style="color:red">hi</p><img src="data:image/png;base64,AAAA"><a href="#x">x</a>');
  assert.equal(checkHtml(source), source);
  assert.equal(checkHtml('<!-- c --><!doctype html><p>x</p>').length > 0, true);
});

test('checkHtml rejects external resources and unsafe elements', () => {
  for (const body of [
    '<iframe></iframe>', '<object></object>', '<form></form>', '<base href="/">',
    '<img src="https://example.com/a.png">', '<a href="http://example.com">x</a>',
    '<script src="data:text/javascript,1"></script>', '<img srcset="a.png 1x">',
    '<style>@import "x.css";</style>', '<p style="background:url(https://x/y.png)">x</p>',
    '<meta http-equiv="refresh" content="0">', '<svg><script>1</script></svg>',
    '<a href="data:image/png;base64,AAAA">x</a>'
  ]) rejects(() => checkHtml(html(body)), 'UNSUPPORTED');
  rejects(() => checkHtml('PK\u0003\u0004'), 'UNSUPPORTED');
  rejects(() => checkHtml('<!-- c --><p>x</p>'), 'UNSUPPORTED');
  rejects(() => checkHtml(42), 'UNSUPPORTED');
  rejects(() => checkHtml(html('x'.repeat(maxImportBytes))), 'TOO_LARGE');
  assert.equal(checkHtml(html('x'.repeat(3 * 1024 * 1024))).length > 3 * 1024 * 1024, true);
});

test('checkHtml allows https links only', () => {
  checkHtml(html('<a href="https://example.com/a?b#c">ok</a><a href=" https://example.com ">ok</a>'));
  for (const href of ['http://example.com', 'https://user@example.com', 'https://', 'javascript:alert(1)', '//example.com', 'https://exa mple.com'])
    rejects(() => checkHtml(html(`<a href="${href}">x</a>`)), 'UNSUPPORTED');
  rejects(() => checkHtml(html('<img src="https://example.com/a.png">')), 'UNSUPPORTED');
});

test('sanitizeSvg normalizes a safe SVG', () => {
  assert.equal(
    sanitizeSvg(svg('<style>rect{fill:red}</style><rect id="r" width="5" height="5" style="stroke:blue"/><use href="#r"/>')),
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><style>rect{fill:red}</style><rect id="r" width="5" height="5" style="stroke:blue"></rect><use href="#r"></use></svg>'
  );
});

test('sanitizeSvg rejects active or external content', () => {
  for (const source of [
    svg('<script>alert(1)</script>'), svg('<rect onclick="x()"/>'), svg('<use href="https://x/y.svg#a"/>'),
    svg('<foreignObject/>'), svg('<rect style="background:url(#a)"/>'), svg('<rect fill="var(--x)"/>'),
    svg('<style>@import url(#a);</style>'), svg('<g id="a"><use href="#a"/></g>'), svg('<use href="#missing"/>'),
    svg('<rect id="a"/><rect id="a"/>'), svg('<rect width="Infinity"/>'),
    '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 99999 99999"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"/>', '<html/>', 'not xml'
  ]) assert.throws(() => sanitizeSvg(source), e => e.code === 'UNSAFE_SVG', source);
});

test('validateRaster checks image headers and dimensions', () => {
  assert.equal(validateRaster('image/png', png()).length > 0, true);
  rejects(() => validateRaster('image/png', png(9000, 1)), 'LIMIT_EXCEEDED');
  rejects(() => validateRaster('image/jpeg', png()), 'UNSUPPORTED_TYPE');
  rejects(() => validateRaster('image/bmp', png()), 'UNSUPPORTED_TYPE');
});
