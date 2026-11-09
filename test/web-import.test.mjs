import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {driveId,fileKind,gzip,prepareImport,titleFromFileName,toBase64} from '../web/import-source.mjs';
import {ImportQueue} from '../web/import-queue.mjs';
import {createCaller} from '../web/rpc.mjs';
import {html,png,zip} from './helpers.mjs';

// The parts of File that prepareImport uses.
const file = (name, content) => {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  return {name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)};
};
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('file names map to kinds and titles', () => {
  assert.equal(fileKind('a.HTM'), 'html');
  assert.equal(fileKind('a.zip'), 'zip');
  assert.equal(fileKind('a.svg'), 'svg');
  assert.equal(fileKind('a.pdf'), null);
  assert.equal(titleFromFileName('Report.html'), 'Report');
  assert.equal(titleFromFileName('.html'), '新しい文書');
});

test('driveId accepts IDs and Drive URLs only', () => {
  assert.equal(driveId(' abc_123 '), 'abc_123');
  assert.equal(driveId('https://drive.google.com/file/d/abc-1/view'), 'abc-1');
  assert.equal(driveId('https://drive.google.com/open?id=xyz'), 'xyz');
  for (const bad of ['https://example.com/file/d/abc', 'not a url', 'https://drive.google.com/'])
    assert.throws(() => driveId(bad), /Google Drive/);
});

test('toBase64 and gzip produce standard encodings', async () => {
  const bytes = new Uint8Array(100000).map((_, i) => i % 251);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
  const packed = await gzip(Buffer.from('hello hello hello'));
  assert.equal(gunzipSync(packed).toString(), 'hello hello hello');
});

test('HTML is sent compressed when that is shorter', async () => {
  const source = html('<p>' + 'repeated text '.repeat(500) + '</p>');
  const prepared = await prepareImport(file('a.html', source));
  assert.deepEqual(Object.keys(prepared.input), ['htmlGzip']);
  assert.equal(gunzipSync(Buffer.from(prepared.input.htmlGzip, 'base64')).toString(), source);
  assert.equal(prepared.startPage, 'index.html');
  // Without CompressionStream, or when compression does not help, the text is sent as is.
  assert.deepEqual((await prepareImport(file('a.html', source), {compress: async () => null})).input, {html: source});
  assert.deepEqual(Object.keys((await prepareImport(file('a.svg', '<svg/>'))).input), ['svg']);
});

test('prepareImport rejects bad files before uploading', async () => {
  await assert.rejects(prepareImport(file('a.pdf', 'x')), /HTMLまたはZIP/);
  await assert.rejects(prepareImport(file('a.html', Buffer.from([0xff, 0xfe, 0x00]))), /UTF-8/);
  await assert.rejects(prepareImport({...file('a.svg', ''), size: 600 * 1024}), /512 KiB/);
  await assert.rejects(prepareImport(file('a.zip', zip({'index.html': html(''), 'run.exe': 'x'}))), e => e.code === 'UNSUPPORTED_TYPE');
});

test('ZIP files are inspected in the browser', async () => {
  const auto = await prepareImport(file('site.zip', zip({'index.html': html(''), 'b.html': html(''), 'p.png': png()})));
  assert.equal(auto.startPage, 'index.html');
  assert.deepEqual(auto.pages.sort(), ['b.html', 'index.html']);
  assert.ok(auto.input.zipBase64.length > 0);
  const choose = await prepareImport(file('site.zip', zip({'a.html': html(''), 'b.html': html('')})));
  assert.equal(choose.startPage, null);
});

test('ImportQueue uploads one job at a time and applies the latest title', async () => {
  const sent = [];
  let release;
  const queue = new ImportQueue(job => {
    sent.push(job.title);
    return new Promise(resolve => {release = () => resolve({documentId: 'd' + sent.length, versionId: 'v'});});
  });
  const first = queue.enqueue({label: 'a', title: 'A', input: {html: 'x'}});
  const second = queue.enqueue({label: 'b', title: 'B', input: {html: 'y'}});
  assert.equal(first.state, 'uploading');
  assert.equal(second.state, 'queued');
  assert.equal(queue.busy, true);
  queue.setTitle(first, 'A2');
  queue.setTitle(second, '');
  release();
  await settle();
  assert.equal(first.state, 'done');
  assert.equal(first.desiredTitle, 'A2');
  assert.equal(first.input, null);
  assert.equal(second.state, 'uploading');
  assert.equal(second.desiredTitle, 'B');
  release();
  await settle();
  assert.deepEqual(sent, ['A', 'B']);
  assert.equal(queue.busy, false);
});

test('ImportQueue retries known failures but never resends unknown outcomes', async () => {
  let attempt = 0;
  const finished = [];
  const queue = new ImportQueue(async () => {
    attempt++;
    if (attempt === 1) throw Object.assign(new Error('busy'), {code: 'BUSY'});
    if (attempt === 2) return {documentId: 'd', versionId: 'v'};
    throw new Error('network');
  }, {finished: job => finished.push(job.state)});
  const job = queue.enqueue({label: 'a', title: 'A', input: {}});
  await settle();
  assert.equal(job.state, 'failed');
  assert.equal(job.unknown, false);
  queue.retry(job);
  await settle();
  assert.equal(job.state, 'done');
  queue.dismiss(job);
  assert.deepEqual(queue.jobs, []);

  const lost = queue.enqueue({label: 'b', title: 'B', input: {}});
  await settle();
  assert.equal(lost.unknown, true);
  queue.retry(lost);
  assert.equal(lost.state, 'failed');
  assert.equal(attempt, 3);
  assert.deepEqual(finished, ['failed', 'done', 'failed']);
});

test('createCaller maps replies to values and errors', async () => {
  const call = createCaller(async (action, input) => action === 'ok' ? {ok: true, value: input} : action === 'fail' ? {ok: false, error: {code: 'BUSY', message: 'm', retryable: true}} : Promise.reject(new Error('x')));
  assert.deepEqual(await call('ok', {a: 1}), {a: 1});
  await assert.rejects(call('fail'), e => e.code === 'BUSY' && e.retryable === true && e.message === 'm');
  await assert.rejects(call('lost'), e => e.code === undefined && /通信/.test(e.message));
});
