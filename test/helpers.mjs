import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {zipSync,strToU8} from 'fflate';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)).digest('hex');

export const html = body => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;

export function png(width = 2, height = 2) {
  const u32 = n => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
  const chunk = (type, data) => [...u32(data.length), ...Buffer.from(type, 'latin1'), ...data, 0, 0, 0, 0];
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...u32(width), ...u32(height), 8, 6, 0, 0, 0]), ...chunk('IEND', [])]);
}

export function zip(files) {
  const entries = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, typeof content === 'string' ? strToU8(content) : content]));
  return zipSync(entries, {level: 6});
}

export const zipBase64 = files => Buffer.from(zip(files)).toString('base64');

export const gzipBase64 = text => gzipSync(Buffer.from(text, 'utf8')).toString('base64');

// In-memory implementation of the store interface that gas/Code.gs implements on Drive.
export function memoryStore({canImport = true, canEditComments = true, canManage = true} = {}) {
  let next = 0;
  const id = prefix => `${prefix}${++next}`;
  const docs = new Map(), files = new Map();
  const put = (text, extra = {}) => {
    const fileId = id('f');
    files.set(fileId, {id: fileId, text, version: 1, sha256Checksum: digest(text), ...extra});
    return fileId;
  };
  const store = {
    docs, files,
    permissions: {canImport, canEditComments, canManage},
    findDocument(docId) {
      const doc = docs.get(docId);
      if (!doc) return null;
      return {manifestId: doc.manifestId, manifestCanEdit: store.permissions.canManage, manifestText: files.get(doc.manifestId).text};
    },
    htmlFile(docId, versionsId, version) {return files.get(version.htmlFileId);},
    pageFile(docId, versionsId, version, page) {return files.get(page.htmlFileId);},
    // Like gas/Code.gs: small pages come back as text, large ones with the hash of their bytes.
    readHtml(file) {
      store.htmlReads = (store.htmlReads || 0) + 1;
      return file.text.length <= 80000 ? file.text : {text: file.text, sha256: digest(file.text)};
    },
    commentsFile(docId, fileId) {
      const meta = files.get(fileId);
      return meta ? {id: fileId, canEdit: store.permissions.canEditComments, meta} : null;
    },
    readComments: file => files.get(file.id).text,
    writeComments(file, text) {
      const f = files.get(file.id);
      f.text = text;
      f.version++;
      return f.version;
    },
    readSource(fileId) {
      const f = files.get(fileId);
      return {text: f.text, version: String(f.version)};
    },
    listSources: () => ({files: [], cursor: null}),
    findImportedSource: sourceFileId => [...docs].find(([, doc]) => doc.sourceFileId === sourceFileId)?.[0] || null,
    listDocuments: () => ({ids: [...docs.keys()], cursor: null}),
    canImport: () => store.permissions.canImport,
    canManage: d => d.manifestCanEdit === true,
    canAppend: d => d.manifestCanEdit === true,
    createDocument(title, manifestFor, sourceFileId) {
      const docId = id('d');
      const commentsFileId = put(JSON.stringify({schemaVersion: 1, documentId: docId, revision: 0, threads: [], appliedOperations: []}));
      const m = manifestFor({id: docId, manifest: {versionsFolderId: id('vf'), commentsFileId}});
      docs.set(docId, {manifestId: put(JSON.stringify(m)), sourceFileId});
      return {documentId: docId, versionId: m.latestVersionId};
    },
    createVersion(parent, versionId, text) {
      return {versionId, folderId: id('v'), htmlFileId: put(text)};
    },
    createPackageVersion(parent, versionId, pkg, rendered, hash) {
      const folderId = id('v');
      const packageFiles = [...pkg.files].map(([path, file]) => ({path, fileId: id('s'), mime: file.mime, size: file.bytes.length, sourceHash: hash(file.bytes)}));
      const pages = pkg.pages.map(path => {
        const text = rendered.get(path);
        return {path, htmlFileId: put(text), sourceHash: hash(text)};
      });
      return {versionId, folderId, startPage: pkg.startPage, files: packageFiles, pages,
        ...(packageFiles.some(f => f.mime === 'image/svg+xml') ? {svgPolicyVersion: 1} : {})};
    },
    writeManifest(d, m) {
      files.get(d.manifestId).text = JSON.stringify(m);
    },
    addSource(text) {return put(text);}
  };
  return store;
}

export function service(createService, options = {}) {
  const store = options.store || memoryStore(options);
  let uuid = 0, clock = Date.parse('2026-01-01T00:00:00Z');
  const actor = {id: 'user1', displayName: 'User One'};
  const run = createService({
    store,
    identity: () => options.actor ? options.actor() : actor,
    digest,
    uuid: () => `id${++uuid}`,
    now: () => new Date(clock += 1000).toISOString(),
    locked: fn => fn()
  });
  return {run, store, actor};
}
