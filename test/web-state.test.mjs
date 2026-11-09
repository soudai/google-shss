import test from 'node:test';
import assert from 'node:assert/strict';
import {PreviewCache,optimisticComments} from '../web/fast-state.mjs';
import {CommentOutbox,TitleTask,pageKey} from '../web/background.mjs';

const doc = (extra = {}) => ({documentId: 'd', versionId: 'v', pagePath: 'index.html', pageHash: 'h', html: '<p>x</p>', comments: {threads: []}, ...extra});

test('PreviewCache reuses HTML when the server reports it unchanged', async () => {
  const calls = [];
  const cache = new PreviewCache(async input => {
    calls.push(input);
    return calls.length === 1 ? doc() : {...doc(), html: undefined, htmlUnchanged: true};
  });
  await cache.request({documentId: 'd'});
  assert.equal(cache.peek({documentId: 'd'}).html, '<p>x</p>');
  const second = await cache.request({documentId: 'd'});
  assert.equal(calls[1].cachedPageHash, 'h');
  assert.equal(second.html, '<p>x</p>');
  assert.equal(second.htmlUnchanged, undefined);
});

test('PreviewCache expires, evicts and hides stale comments', () => {
  let now = 0;
  const cache = new PreviewCache(null, {now: () => now, maxEntries: 2});
  for (const versionId of ['a', 'b', 'c']) cache.remember({documentId: 'd', versionId}, doc({versionId}));
  assert.equal(cache.peek({documentId: 'd', versionId: 'a'}), null);
  assert.ok(cache.peek({documentId: 'd', versionId: 'c'}).comments);
  now = 31000;
  assert.equal(cache.peek({documentId: 'd', versionId: 'c'}).comments, null);
  now = 301000;
  assert.equal(cache.peek({documentId: 'd', versionId: 'c'}), null);
});

test('optimisticComments applies pending operations', () => {
  const base = [{id: 't1', status: 'open', messages: [{id: 'm1', operationId: 'o1', body: 'a'}]}];
  const added = optimisticComments(base, {type: 'add', operationId: 'o2', payload: {anchor: {}, body: ' hi '}});
  assert.equal(added.threadId, 'pending-o2');
  assert.equal(added.threads[1].messages[0].body, 'hi');
  assert.equal(base.length, 1);
  assert.equal(optimisticComments(base, {type: 'reply', operationId: 'o3', payload: {threadId: 't1', body: 'b'}}).threads[0].messages.length, 2);
  assert.equal(optimisticComments(base, {type: 'hide', operationId: 'o4', payload: {threadId: 't1'}}).threads[0].status, 'hidden');
  assert.deepEqual(optimisticComments(base, {type: 'delete', operationId: 'o5', payload: {threadId: 't1', messageId: 'm1'}}).threads, []);
  assert.equal(optimisticComments(base, {type: 'reply', operationId: 'o1', payload: {threadId: 't1', body: 'a'}}).threads[0].messages.length, 1);
});

test('CommentOutbox serializes, deduplicates and retries', async () => {
  const sent = [];
  let fail = true;
  const outbox = new CommentOutbox(async request => {
    sent.push(request.operationId);
    if (fail) throw Object.assign(new Error('nope'), {code: 'INTERNAL'});
    return {status: 'applied', operationId: request.operationId, comments: {revision: 1, threads: []}};
  });
  const request = {documentId: 'd', versionId: 'v', sourceHash: 's', type: 'add', payload: {body: 'x'}, operationId: 'o1'};
  const entry = outbox.enqueue(request, {});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(entry.state, 'failed');
  assert.equal(outbox.errors(request).length, 1);
  fail = false;
  assert.equal(outbox.enqueue({...request, operationId: 'o2'}, {}), entry);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(sent, ['o1', 'o1']);
  assert.equal(outbox.entries.length, 0);
  assert.equal(outbox.snapshots.get(pageKey(request)).result.revision, 1);
  assert.equal(outbox.prefer(request, {revision: 0, canWrite: true, threads: []}).revision, 1);
});

test('TitleTask coalesces renames', async () => {
  const renames = [];
  const task = new TitleTask(async input => {renames.push(input.title);}, {documentId: 'd', title: 'a'});
  assert.equal(task.pending, false);
  task.setTitle('b');
  const flushing = task.flush();
  task.setTitle('c');
  await flushing;
  assert.deepEqual(renames, ['b', 'c']);
  assert.equal(task.pending, false);
});
