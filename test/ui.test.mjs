// Drives the built viewer page in jsdom against the real core service over an
// in-memory store: import, background upload, library and tab switching.
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {buildPage} from '../scripts/bundle.mjs';
import {localService} from '../scripts/memory-store.mjs';
import {html,zip} from './helpers.mjs';

const pageSource = await buildPage();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function viewer() {
  const {run} = localService();
  const calls = [];
  const state = {uploadDelay: 100};
  const api = (action, input) => new Promise(resolve => {
    calls.push({action, input});
    setTimeout(() => {
      try {resolve({ok: true, value: JSON.parse(JSON.stringify(run(action, input)))});}
      catch (e) {resolve({ok: false, error: {code: e.code || 'INTERNAL', message: e.message}});}
    }, ['importDocument', 'appendVersion'].includes(action) ? state.uploadDelay : 2);
  });
  const errors = [];
  const boot = JSON.stringify({url: 'https://example.com/exec', documentId: '', versionId: '', pagePath: ''});
  const dom = new JSDOM(pageSource.replace('/* BOOT */', () => boot), {runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/exec', beforeParse(window) {
    window.SHSS_API = api;
    window.structuredClone = structuredClone;
    window.TextDecoder = TextDecoder;
    // jsdom has no modal dialogs.
    const proto = window.HTMLDialogElement?.prototype || window.HTMLElement.prototype;
    proto.showModal = function () {this.setAttribute('open', '');};
    proto.close = function () {if (!this.hasAttribute('open')) return; this.removeAttribute('open'); this.dispatchEvent(new window.Event('close'));};
    if (!Object.getOwnPropertyDescriptor(proto, 'open')) Object.defineProperty(proto, 'open', {get() {return this.hasAttribute('open');}});
    window.addEventListener('error', e => errors.push(e.error || e.message));
    window.addEventListener('unhandledrejection', e => errors.push(e.reason));
  }});
  const {window} = dom, $ = id => window.document.getElementById(id);
  const text = id => $(id).textContent;
  const until = async (check, label, ms = 4000) => {
    for (const start = Date.now(); Date.now() - start < ms; await wait(5)) if (check()) return;
    throw new Error('timeout: ' + label);
  };
  const chooseFile = (name, content) => {
    const bytes = Buffer.from(content);
    const file = {name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)};
    Object.defineProperty($('file'), 'files', {value: [file], configurable: true});
    $('file').dispatchEvent(new window.Event('change'));
  };
  let hidden = false;
  Object.defineProperty(window.document, 'hidden', {get: () => hidden, configurable: true});
  const setHidden = value => {hidden = value; window.document.dispatchEvent(new window.Event('visibilitychange'));};
  const rpcCount = action => calls.filter(c => c.action === action).length;
  await until(() => text('documents').includes('文書がありません'), 'empty library');
  return {window, $, text, until, chooseFile, setHidden, calls, rpcCount, state, errors, close: () => window.close()};
}

test('an import continues in the background and can be opened from the notice', async () => {
  const v = await viewer();
  const {$, text, until} = v;
  $('import').click();
  v.chooseFile('Quarterly report.html', html('<p>hello world</p>'));
  await until(() => text('import-status').includes('取り込み中'), 'uploading');
  assert.equal($('name').value, 'Quarterly report');
  assert.equal(text('import-cancel'), '閉じる（取り込みは続行）');
  // A title typed during the upload is applied afterwards.
  $('name').value = 'Renamed report';
  $('name').dispatchEvent(new v.window.Event('input'));
  $('import-cancel').click();
  assert.equal($('import-dialog').open, false);
  assert.match(text('save-status'), /取り込み中…（1件）/);
  await until(() => text('notice').includes('取り込みました'), 'notice');
  await until(() => text('save-status') === '' && text('documents').includes('Renamed report'), 'title saved');
  $('notice').querySelector('button').click();
  await until(() => text('title') === 'Renamed report' && $('preview').querySelector('iframe'), 'opened');
  assert.deepEqual(v.errors, []);
  v.close();
});

test('closing and reopening the import dialog preserves an edited title', async t => {
  const v = await viewer();
  t.after(v.close);
  const {$, text, until} = v;
  $('import').click();
  v.chooseFile('old.html', html('<p>Title update</p>'));
  await until(() => text('import-submit') === '文書を開く', 'imported');
  $('name').value = 'Latest title';
  $('name').dispatchEvent(new v.window.Event('input'));
  $('import-cancel').click();
  $('import').click();
  await until(() => text('save-status') === '' && text('documents').includes('Latest title'), 'title saved');
  assert.equal(v.rpcCount('importDocument'), 1);
  assert.deepEqual(v.errors, []);
});

test('a ZIP is checked in the browser and uploaded once', async () => {
  const v = await viewer();
  const {$, text, until} = v;
  $('import').click();
  v.chooseFile('site.zip', zip({'a.html': html('<p>a</p>'), 'b.html': html('<p>b</p>')}));
  await until(() => !$('start-page-field').hidden, 'start page choice');
  assert.equal(v.calls.length, 1, 'only the initial list request');
  $('start-page').value = 'b.html';
  $('start-page').dispatchEvent(new v.window.Event('change'));
  await until(() => text('import-submit') === '文書を開く', 'done in dialog');
  assert.equal(v.rpcCount('inspectPackage'), 0);
  assert.equal(v.rpcCount('importDocument'), 1);
  $('import-submit').click();
  await until(() => $('pages').value === 'b.html', 'opened at start page');

  $('import').click();
  v.chooseFile('broken.zip', 'not a zip');
  await until(() => text('import-error').length > 0, 'error before upload');
  assert.equal(v.rpcCount('importDocument'), 1);
  assert.equal($('file').disabled, false);
  assert.deepEqual(v.errors, []);
  v.close();
});

test('a rejected import offers a retry', async () => {
  const v = await viewer();
  const {$, text, until} = v;
  $('import').click();
  v.chooseFile('x.html', html('<iframe></iframe>'));
  await until(() => text('import-error').includes('iframe'), 'server rejection');
  assert.equal(text('import-submit'), '再試行');
  $('import-cancel').click();
  assert.deepEqual(v.errors, []);
  v.close();
});

test('the library and previews stay cached across tab switches', async () => {
  const v = await viewer();
  const {$, text, until} = v;
  $('import').click();
  v.chooseFile('doc.html', html('<p>cached</p>'));
  await until(() => text('import-submit') === '文書を開く', 'imported');
  $('import-submit').click();
  await until(() => $('preview').querySelector('iframe') && text('load-status') === '', 'opened');

  // The import cleared the cached list, so the first return loads it.
  $('home').click();
  await until(() => text('documents').includes('doc'), 'list loaded');
  $('documents').querySelector('button').click();
  await until(() => $('preview').querySelector('iframe') && text('load-status') === '', 'opened again');
  // Back to the list again: the last list shows at once while it refreshes.
  $('home').click();
  assert.match(text('documents'), /doc/);
  assert.equal(text('load-status'), '更新中…');
  await until(() => text('load-status') === '', 'refreshed');

  // Opening the import dialog does not drop the cached preview.
  $('import').click();
  $('import-cancel').click();
  v.setHidden(true);
  v.setHidden(false);
  const before = v.calls.length;
  $('documents').querySelector('button').click();
  await until(() => $('preview').querySelector('iframe') && text('load-status') === '', 'reopened');
  assert.equal($('preview').dataset.source, 'prefetched');
  const reopen = v.calls.slice(before).find(c => c.action === 'getDocument').input;
  assert.ok(reopen.cachedPageHash, 'revalidated with the cached page hash');
  assert.deepEqual(v.errors, []);
  v.close();
});
