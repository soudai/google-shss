import test from 'node:test';
import assert from 'node:assert/strict';
import {gasEnvironment} from './gas-fakes.mjs';
import {html} from './helpers.mjs';

const ok = reply => {assert.equal(reply.ok, true, JSON.stringify(reply.error)); return reply.value;};
// Pages over the 80 KB cache limit are always read from Drive.
const big = text => html('<p>' + text + ' ' + 'x'.repeat(100000) + '</p>');

function withDocuments(count, body = n => html('<p>doc ' + n + '</p>')) {
  const env = gasEnvironment();
  const ids = [];
  for (let n = 0; n < count; n++) ids.push(ok(env.rpc('importDocument', {title: 'Doc ' + n, html: body(n)})).documentId);
  env.clearCache();
  env.resetCounts();
  return {env, ids};
}

test('the document list downloads manifests in one parallel request', () => {
  const {env} = withDocuments(5);
  const listed = ok(env.rpc('listDocuments', {}));
  assert.equal(listed.documents.length, 5);
  assert.equal(env.counts.fetchAll, 1);
  assert.equal(env.counts.fetched, 5);
  assert.equal(env.counts.driveAppReads, 0);

  // The manifests are now cached: the next list needs no download at all.
  env.resetCounts();
  assert.deepEqual(ok(env.rpc('listDocuments', {})).documents.map(d => d.title).sort(), listed.documents.map(d => d.title).sort());
  assert.equal(env.counts.fetchAll, 0);
  assert.equal(env.counts.driveAppReads, 0);
  assert.equal(env.counts.cacheGetAll, 1);
  assert.equal(env.counts.cacheGet, 0);
});

test('opening a document downloads the page and comments together', () => {
  const {env, ids} = withDocuments(1, () => big('page'));
  const doc = ok(env.rpc('getDocument', {documentId: ids[0]}));
  assert.match(doc.html, /page x/);
  assert.deepEqual(doc.comments.threads, []);
  assert.equal(env.counts.fetchAll, 1);
  assert.equal(env.counts.fetched, 2);
  assert.equal(env.counts.driveAppReads, 1, 'only the manifest is read on its own');

  // With the page cached in the browser, only the comments are read.
  env.resetCounts();
  assert.equal(ok(env.rpc('getDocument', {documentId: ids[0], cachedPageHash: doc.pageHash})).htmlUnchanged, true);
  assert.equal(env.counts.fetchAll, 0);
});

test('falls back to one-by-one reads when parallel download fails', () => {
  const {env, ids} = withDocuments(3);
  env.fetchAllFails = true;
  assert.equal(ok(env.rpc('listDocuments', {})).documents.length, 3);
  assert.equal(env.counts.fetchAll, 1);
  assert.equal(env.counts.driveAppReads, 3);
  env.clearCache();
  const doc = ok(env.rpc('getDocument', {documentId: ids[0]}));
  assert.match(doc.html, /doc 0/);
});

test('downloads that do not match the Drive checksum are not used', () => {
  const {env, ids} = withDocuments(1, () => big('checked'));
  env.corruptDownloads = true;
  const doc = ok(env.rpc('getDocument', {documentId: ids[0]}));
  assert.match(doc.html, /checked x/);
  assert.equal(env.counts.fetchAll, 1);
  assert.equal(env.counts.driveAppReads, 3, 'manifest, page and comments read again from Drive');
});

test('a page changed in Drive is still detected', () => {
  const {env, ids} = withDocuments(1, () => big('original'));
  const page = [...env.files.values()].find(f => f.name === 'index.html' && f.content?.includes('original'));
  // Changed content with a matching checksum, as if edited directly in Drive.
  const doc = ok(env.rpc('getDocument', {documentId: ids[0]}));
  page.content = Buffer.from(doc.html.replace('original', 'tampered'));
  page.size = String(page.content.length);
  page.sha256Checksum = (await_hash(page.content));
  env.clearCache();
  const reply = env.rpc('getDocument', {documentId: ids[0]});
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'VERSION_MISMATCH');
});

test('comments still work through the Drive store', () => {
  const {env, ids} = withDocuments(1);
  const doc = ok(env.rpc('getDocument', {documentId: ids[0]}));
  const saved = ok(env.rpc('submitOperation', {operationId: 'op1', documentId: doc.documentId, versionId: doc.versionId, sourceHash: doc.sourceHash, type: 'add',
    payload: {anchor: {type: 'text', exact: 'doc', prefix: '', suffix: '', position: {start: 0, end: 3}}, body: 'hello'}}));
  assert.equal(saved.comments.threads[0].messages[0].body, 'hello');
  assert.equal(ok(env.rpc('getDocument', {documentId: ids[0]})).comments.threads.length, 1);
});

import {createHash} from 'node:crypto';
function await_hash(bytes) {return createHash('sha256').update(bytes).digest('hex');}
