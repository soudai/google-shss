import test from 'node:test';
import assert from 'node:assert/strict';
import {createService,validateComments,AppError,SVG_POLICY_VERSION} from '../server/core.mjs';
import {digest,html,png,service,zipBase64} from './helpers.mjs';

const fails = (fn, code) => assert.throws(fn, e => e instanceof AppError && e.code === code, code);
const textAnchor = (exact = 'hello') => ({type: 'text', exact, prefix: '', suffix: '', position: {start: 0, end: exact.length}});

function importHtml(run, body = '<p>hello</p>') {
  return run('importDocument', {title: ' Doc ', html: html(body)});
}

function submit(run, doc, type, payload, extra = {}) {
  return run('submitOperation', {operationId: `op-${type}-${Math.random().toString(36).slice(2)}`, documentId: doc.documentId, versionId: doc.versionId, sourceHash: doc.sourceHash, type, payload, ...extra});
}

test('rejects unauthenticated callers and unknown actions', () => {
  const {run} = service(createService, {actor: () => null});
  fails(() => run('listDocuments'), 'UNAUTHENTICATED');
  const ok = service(createService).run;
  fails(() => ok('constructor'), 'INVALID_DATA');
  fails(() => ok('listDocuments', []), 'INVALID_DATA');
});

test('imports HTML and reads it back', () => {
  const {run} = service(createService);
  const created = importHtml(run);
  const doc = run('getDocument', {documentId: created.documentId});
  assert.equal(doc.title, 'Doc');
  assert.equal(doc.versionId, created.versionId);
  assert.equal(doc.html, html('<p>hello</p>'));
  assert.equal(doc.pageHash, digest(doc.html));
  assert.deepEqual(doc.pages, ['index.html']);
  assert.equal(doc.canWriteComments, true);
  assert.deepEqual(doc.comments.threads, []);

  const cached = run('getDocument', {documentId: created.documentId, cachedPageHash: doc.pageHash});
  assert.equal(cached.htmlUnchanged, true);
  assert.equal(cached.html, undefined);

  const listed = run('listDocuments', {});
  assert.deepEqual(listed.documents.map(d => d.title), ['Doc']);
  assert.equal(listed.canImport, true);
});

test('validates import input and permissions', () => {
  const {run, store} = service(createService);
  fails(() => run('importDocument', {title: ' ', html: html('')}), 'INVALID_DATA');
  fails(() => run('importDocument', {title: 'x'}), 'INVALID_DATA');
  fails(() => run('importDocument', {title: 'x', html: html('<iframe></iframe>')}), 'UNSUPPORTED');
  store.permissions.canImport = false;
  fails(() => importHtml(run), 'FORBIDDEN');
});

test('detects tampered HTML', () => {
  const {run, store} = service(createService);
  const created = importHtml(run);
  const manifest = JSON.parse(store.files.get(store.docs.get(created.documentId).manifestId).text);
  const file = store.files.get(manifest.versions[0].htmlFileId);
  file.text += '<!-- changed -->';
  file.sha256Checksum = undefined;
  fails(() => run('getDocument', {documentId: created.documentId}), 'VERSION_MISMATCH');
});

test('comment lifecycle: add, reply, hide, restore, delete', () => {
  const {run} = service(createService);
  const doc = run('getDocument', {documentId: importHtml(run).documentId});

  const added = submit(run, doc, 'add', {anchor: textAnchor(), body: '  first  '});
  assert.equal(added.status, 'applied');
  const [thread] = added.comments.threads;
  assert.equal(thread.messages[0].body, 'first');
  assert.equal(thread.messages[0].canDelete, true);
  assert.equal(thread.anchor.textModel, 'shss-visible-text-v1');

  const replied = submit(run, doc, 'reply', {threadId: added.threadId, body: 'second'});
  assert.equal(replied.comments.threads[0].messages.length, 2);

  fails(() => submit(run, doc, 'hide', {threadId: added.threadId, expectedThreadRevision: 1}), 'CONFLICT');
  const hidden = submit(run, doc, 'hide', {threadId: added.threadId, expectedThreadRevision: 2});
  assert.equal(hidden.comments.threads[0].status, 'hidden');
  fails(() => submit(run, doc, 'reply', {threadId: added.threadId, body: 'x'}), 'CONFLICT');
  const restored = submit(run, doc, 'restore', {threadId: added.threadId, expectedThreadRevision: 3});
  assert.equal(restored.comments.threads[0].status, 'open');

  const messageId = restored.comments.threads[0].messages[1].id;
  const deleted = submit(run, doc, 'delete', {threadId: added.threadId, messageId});
  assert.equal(deleted.comments.threads[0].messages.length, 1);
  fails(() => submit(run, doc, 'delete', {threadId: added.threadId, messageId}), 'NOT_FOUND');

  const comments = run('getComments', {documentId: doc.documentId});
  assert.equal(comments.revision, 5);
  assert.deepEqual(run('getComments', {documentId: doc.documentId, versionToken: comments.versionToken, canWrite: true}), {unchanged: true});
});

test('operations are idempotent and bound to the actor', () => {
  let actor = {id: 'user1', displayName: 'One'};
  const {run} = service(createService, {actor: () => actor});
  const doc = run('getDocument', {documentId: importHtml(run).documentId});
  const request = {operationId: 'same', documentId: doc.documentId, versionId: doc.versionId, sourceHash: doc.sourceHash, type: 'add', payload: {anchor: textAnchor(), body: 'x'}};
  const first = run('submitOperation', request);
  const second = run('submitOperation', request);
  assert.equal(second.revision, first.revision);
  assert.equal(second.comments.threads.length, 1);
  fails(() => run('submitOperation', {...request, payload: {...request.payload, body: 'y'}}), 'INVALID_DATA');
  actor = {id: 'user2', displayName: 'Two'};
  fails(() => run('submitOperation', request), 'INVALID_DATA');
  const messageId = first.comments.threads[0].messages[0].id;
  fails(() => submit(run, doc, 'delete', {threadId: first.threadId, messageId}), 'FORBIDDEN');
});

test('rejects invalid operations and read-only writers', () => {
  const {run, store} = service(createService);
  const doc = run('getDocument', {documentId: importHtml(run).documentId});
  fails(() => submit(run, doc, 'add', {anchor: {...textAnchor(), position: {start: 0, end: 1}}, body: 'x'}), 'INVALID_DATA');
  fails(() => submit(run, doc, 'add', {anchor: textAnchor(), body: '   '}), 'INVALID_DATA');
  fails(() => submit(run, doc, 'edit', {threadId: 'x'}), 'INVALID_DATA');
  fails(() => submit(run, doc, 'add', {anchor: {type: 'region', path: 'body>script', tag: 'IMG', signature: '', rect: {x: 0, y: 0, w: 1, h: 1}}, body: 'x'}), 'INVALID_DATA');
  fails(() => submit(run, {...doc, sourceHash: 'f'.repeat(64)}, 'add', {anchor: textAnchor(), body: 'x'}), 'VERSION_MISMATCH');
  const region = submit(run, doc, 'add', {anchor: {type: 'region', path: 'body>img:nth-of-type(1)', tag: 'IMG', signature: 'abc', rect: {x: 0, y: 0, w: 1, h: 1}}, body: 'x'});
  assert.equal(region.comments.threads[0].anchor.type, 'region');
  store.permissions.canEditComments = false;
  fails(() => submit(run, doc, 'add', {anchor: textAnchor(), body: 'x'}), 'FORBIDDEN');
});

test('versions: append, reimport from Drive source, and isolate comments', () => {
  const {run, store} = service(createService);
  const sourceFileId = store.addSource(html('<p>v1</p>'));
  const first = run('importDocument', {title: 'Drive', sourceFileId});
  assert.deepEqual(run('importDocument', {title: 'Drive', sourceFileId}), first);
  store.files.get(sourceFileId).text = html('<p>v2</p>');
  const second = run('importDocument', {title: 'Drive', sourceFileId});
  assert.equal(second.documentId, first.documentId);
  assert.notEqual(second.versionId, first.versionId);

  const v1 = run('getDocument', {documentId: first.documentId, versionId: first.versionId});
  submit(run, v1, 'add', {anchor: textAnchor('v1'), body: 'x'});
  const v2 = run('getDocument', {documentId: first.documentId});
  assert.equal(v2.versionId, second.versionId);
  assert.equal(v2.versions.length, 2);
  assert.deepEqual(v2.comments.threads, []);

  const third = run('appendVersion', {documentId: first.documentId, html: html('<p>v3</p>')});
  assert.equal(run('getDocument', {documentId: first.documentId}).versionId, third.versionId);
  fails(() => run('getDocument', {documentId: first.documentId, versionId: 'nope'}), 'NOT_FOUND');
});

test('imports ZIP packages with multiple pages', () => {
  const {run} = service(createService);
  const zipped = zipBase64({'index.html': html('<a href="two.html">two</a>'), 'two.html': html('<img src="p.png">'), 'p.png': png()});
  assert.deepEqual(run('inspectPackage', {zipBase64: zipped}), {pages: ['index.html', 'two.html'], startPage: 'index.html'});
  const created = run('importDocument', {title: 'Zip', zipBase64: zipped});
  const doc = run('getDocument', {documentId: created.documentId});
  assert.deepEqual(doc.pages, ['index.html', 'two.html']);
  assert.match(doc.packageHash, /^[0-9a-f]{64}$/);
  const two = run('getDocument', {documentId: created.documentId, pagePath: 'two.html'});
  assert.match(two.html, /data:image\/png;base64,/);
  fails(() => run('getDocument', {documentId: created.documentId, pagePath: 'missing.html'}), 'NOT_FOUND');

  const added = submit(run, two, 'add', {anchor: textAnchor(), body: 'page two'}, {pagePath: 'two.html'});
  assert.equal(added.comments.threads[0].pagePath, 'two.html');
  assert.deepEqual(run('getDocument', {documentId: created.documentId}).comments.threads, []);

  const ambiguous = zipBase64({'a.html': html('a'), 'b.html': html('b')});
  fails(() => run('importDocument', {title: 'Zip', zipBase64: ambiguous}), 'INVALID_ARCHIVE');
  const chosen = run('importDocument', {title: 'Zip', zipBase64: ambiguous, startPage: 'b.html'});
  assert.equal(run('getDocument', {documentId: chosen.documentId}).pagePath, 'b.html');
});

test('imports standalone SVG with the current SVG policy', () => {
  const {run, store} = service(createService);
  const created = run('importDocument', {title: 'Svg', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'});
  const doc = run('getDocument', {documentId: created.documentId});
  assert.match(doc.html, /<img src="data:image\/svg\+xml;base64,/);
  const manifest = JSON.parse(store.files.get(store.docs.get(created.documentId).manifestId).text);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.versions[0].svgPolicyVersion, SVG_POLICY_VERSION);
  fails(() => run('importDocument', {title: 'Svg', svg: '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'}), 'UNSAFE_SVG');
  fails(() => run('importDocument', {title: 'Svg', svg: '<svg/>', html: html('')}), 'INVALID_DATA');
});

test('manageDocument renames, archives and restores', () => {
  const {run, store} = service(createService);
  const {documentId} = importHtml(run);
  assert.deepEqual(run('manageDocument', {documentId, type: 'rename', title: ' New '}), {documentId, title: 'New', archived: false});
  assert.equal(run('manageDocument', {documentId, type: 'archive'}).archived, true);
  assert.deepEqual(run('listDocuments', {}).documents, []);
  assert.equal(run('listDocuments', {archived: true}).documents.length, 1);
  assert.equal(run('manageDocument', {documentId, type: 'restore'}).archived, false);
  fails(() => run('manageDocument', {documentId, type: 'delete'}), 'INVALID_DATA');
  store.permissions.canManage = false;
  fails(() => run('manageDocument', {documentId, type: 'archive'}), 'FORBIDDEN');
});

test('validateComments rejects malformed state', () => {
  const ok = {schemaVersion: 1, documentId: 'd1', revision: 0, threads: [], appliedOperations: []};
  assert.equal(validateComments(ok, 'd1'), ok);
  fails(() => validateComments({...ok, documentId: 'other'}, 'd1'), 'INVALID_DATA');
  fails(() => validateComments({...ok, revision: -1}, 'd1'), 'INVALID_DATA');
  fails(() => validateComments({...ok, epoch: 'bad epoch'}, 'd1'), 'INVALID_DATA');
});
