import test from 'node:test';
import assert from 'node:assert/strict';
import {isRegionAnchor,isTextAnchor,normalizeAnchor} from '../shared/anchor.mjs';

const text = {type: 'text', exact: 'abc', prefix: 'x', suffix: '', position: {start: 1, end: 4}};
const region = {type: 'region', path: 'body>div:nth-of-type(2)>img:nth-of-type(1)', tag: 'IMG', signature: 'f00', rect: {x: 0.5, y: 0.5, w: 0.5, h: 0.50000001}};

test('text anchors', () => {
  assert.equal(isTextAnchor(text), true);
  assert.equal(isTextAnchor({...text, exact: '  '}), false);
  assert.equal(isTextAnchor({...text, position: {start: 1, end: 5}}), false);
  assert.equal(isTextAnchor({...text, prefix: 'x'.repeat(121)}), false);
  assert.equal(isTextAnchor({...text, position: {start: -1, end: 2}}), false);
  assert.deepEqual(normalizeAnchor({...text, extra: 1}), {type: 'text', exact: 'abc', prefix: 'x', suffix: '', position: {start: 1, end: 4, unit: 'utf16'}, textModel: 'shss-visible-text-v1'});
});

test('region anchors', () => {
  assert.equal(isRegionAnchor(region), true);
  assert.equal(isRegionAnchor({...region, path: 'body>script'}), false);
  assert.equal(isRegionAnchor({...region, path: 'div'}), false);
  assert.equal(isRegionAnchor({...region, tag: 'VIDEO'}), false);
  assert.equal(isRegionAnchor({...region, rect: {x: 0.6, y: 0, w: 0.5, h: 1}}), false);
  assert.equal(isRegionAnchor({...region, rect: {x: 0, y: 0, w: 0, h: 1}}), false);
  assert.equal(isRegionAnchor({...region, rect: {x: 0, y: 0, w: NaN, h: 1}}), false);
  assert.deepEqual(normalizeAnchor({...region, rect: {...region.rect, z: 1}}).rect, {x: 0.5, y: 0.5, w: 0.5, h: 0.50000001});
});

test('normalizeAnchor rejects other shapes', () => {
  for (const value of [null, [], 'text', {type: 'other'}, {...text, type: 'region'}]) assert.equal(normalizeAnchor(value), null);
});
