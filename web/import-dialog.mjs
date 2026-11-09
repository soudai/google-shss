// The import dialog (#import-dialog in web/index.html). The file is read and
// checked here, then handed to a background queue: the dialog may close while
// the upload continues, and the app is told when it finishes.
import {$} from './dom.mjs';
import {TitleTask} from './background.mjs';
import {ImportQueue} from './import-queue.mjs';
import {driveId,prepareImport,titleFromFileName} from './import-source.mjs';

const PHASE_TEXT = {
  reading: 'ファイルを確認中…',
  choose: '開始ページを選ぶと取り込みを続けます。',
  queued: '取り込みの順番を待っています。ダイアログを閉じても続行します。',
  uploading: '取り込み中… タイトルを入力できます。ダイアログを閉じても続行します。'
};
export const UNKNOWN_IMPORT = '取り込み結果を確認できません。重複を避けるため、文書一覧を確認してください。';

// app provides what the dialog needs from the rest of the viewer:
//   call(action, input)          RPC
//   notify(text, action?)        bottom notice, action = {label, run}
//   openDocument(id, versionId)  open a document and record it in history
//   library()                    show the document list
//   documentsChanged()           drop cached previews and lists
//   titleSaved(id, title)        a new title was saved
//   addTitleTask(task)           track a title save in the save status
//   changed()                    background state changed (save status)
//   showSaveDialog()             open the save status dialog
//   isLibraryVisible()
export function createImportDialog(app) {
  const dialog = $('import-dialog');
  let session = null, titleTimer, sourceCursor = null;

  const queue = new ImportQueue(job => app.call(job.target ? 'appendVersion' : 'importDocument', {
    ...job.input, ...(job.target ? {documentId: job.target} : {title: job.title})
  }), {changed: () => {app.changed(); render();}, finished});

  function show(target = null) {
    app.documentsChanged();
    clearTimeout(titleTimer);
    session = {target, phase: 'idle', prepared: null, job: null, autoTitle: ''};
    $('import-form').reset();
    $('start-page-field').hidden = true;
    $('import-error').textContent = '';
    $('name-field').hidden = !!target;
    $('name').required = false;
    sourceCursor = null;
    $('source-list').replaceChildren();
    $('source-list').hidden = true;
    $('source-more').hidden = true;
    $('import-title').textContent = target ? '新版を取り込む' : 'HTMLを取り込む';
    render();
    dialog.showModal();
  }

  function statusText() {
    const job = session.job, task = job?.titleTask;
    if (job?.state === 'done') return task?.error ? 'ファイルの取り込みは完了しました。タイトルは未保存です。タイトルの保存だけを再試行できます。'
      : task?.pending ? '取り込み完了。タイトルを保存中です。' : '取り込みが完了しました。';
    if (job?.state === 'failed') return '';
    return PHASE_TEXT[job?.state || session.phase] || '';
  }
  function render() {
    if (!session) return;
    const job = session.job, reading = session.phase === 'reading';
    const uploading = job && (job.state === 'queued' || job.state === 'uploading');
    for (const id of ['file', 'drive', 'source-load', 'source-list', 'source-more', 'start-page']) $(id).disabled = reading || !!job;
    $('import-title-retry').hidden = !job?.titleTask?.error;
    $('import-status').textContent = statusText();
    if (job?.state === 'failed') $('import-error').textContent = job.unknown ? UNKNOWN_IMPORT : job.error.message;
    $('import-submit').textContent = job?.state === 'done' ? '文書を開く' : job?.unknown ? '一覧を確認' : job?.state === 'failed' ? '再試行' : uploading ? '取り込み中…' : '取り込む';
    $('import-submit').disabled = reading || !!uploading;
    $('import-cancel').textContent = uploading ? '閉じる（取り込みは続行）' : job ? '閉じる' : 'キャンセル';
  }

  async function openImported(job) {
    // Opening the document need not wait for its title update.
    if (job.titleTask?.pending) void job.titleTask.flush();
    if (dialog.open) dialog.close();
    await app.openDocument(job.result.documentId, job.result.versionId);
  }
  function startTitleTask(job) {
    const {documentId} = job.result;
    const task = new TitleTask(input => app.call('manageDocument', input), {
      documentId, title: job.title,
      changed: () => {app.changed(); if (session?.job === job) render();},
      saved: title => {app.documentsChanged(); app.titleSaved(documentId, title);}
    });
    job.titleTask = task;
    app.addTitleTask(task);
    task.setTitle(job.desiredTitle);
    void task.flush();
  }
  function finished(job) {
    const inDialog = session?.job === job && dialog.open;
    if (job.state === 'done') {
      app.documentsChanged();
      if (!job.target) startTitleTask(job);
      queue.dismiss(job);
      if (!inDialog) {
        if (app.isLibraryVisible()) app.library();
        app.notify('「' + job.label + '」を取り込みました。', {label: '開く', run: () => openImported(job)});
      }
    } else if (!inDialog) {
      app.notify('「' + job.label + '」を取り込めませんでした。', {label: '保存状況', run: app.showSaveDialog});
    }
    render();
  }

  async function prepare(current) {
    if (current.prepared) return current.prepared;
    const file = $('file').files[0], link = $('drive').value.trim();
    if (!!file === !!link) throw new Error('ファイルまたはDrive URLの一方を指定してください。');
    current.phase = 'reading';
    render();
    const prepared = file ? await prepareImport(file) : {input: {sourceFileId: driveId(link)}, startPage: 'index.html'};
    prepared.label = file?.name || 'Driveのファイル';
    return prepared;
  }
  async function submit() {
    const current = session;
    if (!current) return;
    const job = current.job;
    if (job?.state === 'done') return openImported(job);
    if (job?.unknown) {dialog.close(); return app.library();}
    if (job?.state === 'failed') {$('import-error').textContent = ''; queue.retry(job); return;}
    if (job) return;
    $('import-error').textContent = '';
    try {
      const prepared = await prepare(current);
      if (session !== current) return;
      let input = prepared.input;
      if (!prepared.startPage) {
        const startPage = $('start-page').value;
        if (!startPage) {
          current.prepared = prepared;
          current.phase = 'choose';
          $('start-page').replaceChildren(new Option('開始ページを選択', ''), ...prepared.pages.map(path => new Option(path, path)));
          $('start-page-field').hidden = false;
          return;
        }
        input = {...input, startPage};
      }
      const title = $('name').value.trim() || (current.target ? '' : 'Driveから取り込み');
      current.prepared = null;
      current.phase = 'sent';
      current.job = queue.enqueue({label: current.target ? prepared.label : title, target: current.target, title, input});
    } catch (error) {
      current.phase = 'idle';
      $('import-error').textContent = error.message;
    } finally {
      if (session === current) render();
    }
  }

  async function loadSources(more = false) {
    $('source-load').disabled = true;
    $('source-more').disabled = true;
    try {
      const page = await app.call('listSources', more && sourceCursor ? {cursor: sourceCursor} : {});
      if (!more) $('source-list').replaceChildren(new Option('HTMLを選択', ''));
      for (const file of page.files) $('source-list').add(new Option(file.name, file.id));
      sourceCursor = page.cursor;
      $('source-list').hidden = false;
      $('source-more').hidden = !sourceCursor;
    } catch (e) {$('import-error').textContent = e.message;}
    finally {render();}
  }

  $('source-load').onclick = () => loadSources();
  $('source-more').onclick = () => loadSources(true);
  $('source-list').onchange = () => {if ($('source-list').value) {$('drive').value = $('source-list').value; $('file').value = '';}};
  // Closing never cancels an upload that has started; it continues in the background.
  $('import-cancel').onclick = () => {
    const job = session?.job;
    dialog.close();
    if (job && (job.state === 'queued' || job.state === 'uploading')) app.notify('取り込みをバックグラウンドで続けます。完了するとお知らせします。');
  };
  dialog.addEventListener('close', () => {
    // A file still being read is abandoned; nothing was sent yet.
    if (session && !session.job) session = null;
  });
  $('file').addEventListener('change', () => {
    const file = $('file').files[0];
    if (!session || session.job || !file) return;
    session.prepared = null;
    $('drive').value = '';
    $('start-page-field').hidden = true;
    $('start-page').replaceChildren();
    const autoTitle = titleFromFileName(file.name);
    if (!$('name').value.trim() || $('name').value === session.autoTitle) $('name').value = autoTitle;
    session.autoTitle = autoTitle;
    void submit();
  });
  $('name').addEventListener('input', () => {
    const job = session?.job;
    if (!job || job.target) return;
    const title = $('name').value.trim() || job.title;
    if (!job.titleTask) {queue.setTitle(job, title); return;}
    job.titleTask.setTitle(title);
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => job.titleTask.flush(), 400);
  });
  $('import-title-retry').onclick = () => session?.job?.titleTask?.flush();
  $('start-page').addEventListener('change', () => {if (session?.prepared && $('start-page').value) void submit();});
  $('import-form').addEventListener('submit', e => {e.preventDefault(); void submit();});

  return {show, queue};
}
