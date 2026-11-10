// An in-memory implementation of the store interface that gas/Code.gs
// implements on Drive. Used by the tests and by the local dev server.
import {createHash, randomUUID} from 'node:crypto';
import {createService} from '../server/core.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)).digest('hex');

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
      return {manifestId: doc.manifestId, manifestCanEdit: store.permissions.canManage, manifestText: files.get(doc.manifestId).text,archived:doc.archived};
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
    // Newest first, like the Drive listing.
    listDocuments: (_cursor,{archived=false}={}) => ({ids: [...docs.keys()].reverse().filter(id=>(docs.get(id).archived??!!JSON.parse(files.get(docs.get(id).manifestId).text).archivedAt)===archived), cursor: null}),
    canImport: () => store.permissions.canImport,
    canManage: d => d.manifestCanEdit === true,
    canArchive: () => store.permissions.canManage,
    moveDocument: (d,archived) => {docs.get(d.id).archived=archived;},
    canAppend: d => d.manifestCanEdit === true,
    createDocument(title, manifestFor, sourceFileId) {
      const docId = id('d');
      const commentsFileId = put(JSON.stringify({schemaVersion: 1, documentId: docId, revision: 0, threads: [], appliedOperations: []}));
      const m = manifestFor({id: docId, manifest: {versionsFolderId: id('vf'), commentsFileId}});
      docs.set(docId, {manifestId: put(JSON.stringify(m)), sourceFileId,archived:false});
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
    discarded: [],
    discardVersion(folderId) {store.discarded.push(folderId);},
    addSource(text) {return put(text);}
  };
  return store;
}

// A service over a memory store. uuid and now default to real values; tests
// pass deterministic ones.
export function localService({store = memoryStore(), actor = () => ({id: 'user1', displayName: 'User One'}), uuid = randomUUID, now = () => new Date().toISOString(), locked = fn => fn()} = {}) {
  const run = createService({store, identity: actor, digest, uuid, now, locked});
  return {run, store};
}
