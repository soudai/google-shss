// Runs gas/Code.gs (with the SHSSCore bundle, as the build does) against
// in-memory fakes of the Apps Script services it uses.
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {gzipSync} from 'node:zlib';
import {build} from 'esbuild';

const root = new URL('../', import.meta.url);
const bundle = (await build({entryPoints: [new URL('server/core.mjs', root).pathname], bundle: true, write: false, format: 'iife', globalName: 'SHSSCore', target: 'es2019'})).outputFiles[0].text;
const code = readFileSync(new URL('gas/Code.gs', root), 'utf8');

const signed = bytes => Array.from(bytes, b => b > 127 ? b - 256 : b);
const unsigned = bytes => Buffer.from(Array.from(bytes, b => (b + 256) % 256));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const FOLDER = 'application/vnd.google-apps.folder';

export function gasEnvironment({domain = 'example.com', email = 'user@example.com'} = {}) {
  let nextId = 0;
  const files = new Map(), cache = new Map();
  const counts = {metadataGet: 0, metadataList: 0, writes: 0, driveAppReads: 0, fetchAll: 0, fetched: 0, cacheGet: 0, cacheGetAll: 0};
  const env = {files, counts, fetchAllFails: false, corruptDownloads: false};
  const ROOT = 'root1';
  const capabilities = {canDownload: true, canEdit: true, canModifyContent: true, canAddChildren: true};
  const put = (meta, content) => {
    const id = meta.id || 'f' + (++nextId);
    const bytes = content === undefined ? undefined : Buffer.from(content);
    files.set(id, {mimeType: FOLDER, parents: [], appProperties: {}, ...meta, id, trashed: false, version: '1', capabilities,
      ...(bytes ? {content: bytes, size: String(bytes.length), sha256Checksum: sha256(bytes)} : {})});
    return id;
  };
  put({id: ROOT, name: 'root'});
  const view = f => {const {content, ...meta} = f; return structuredClone(meta);};
  const blob = bytes => ({getBytes: () => signed(bytes), getDataAsString: () => bytes.toString('utf8'), bytes});
  const toBytes = data => typeof data === 'string' ? Buffer.from(data, 'utf8') : unsigned(data);

  const Drive = {
    About: {get: () => ({user: {permissionId: 'u1', displayName: 'User', emailAddress: email}})},
    Files: {
      get(id) {counts.metadataGet++; const f = files.get(id); if (!f) throw new Error('File not found: ' + id); return view(f);},
      // Understands the query shapes Code.gs sends: parents, names and appProperties.
      list({q}) {
        counts.metadataList++;
        const parents = [...q.matchAll(/'([\w-]+)' in parents/g)].map(m => m[1]);
        const names = [...q.matchAll(/name = '([^']+)'/g)].map(m => m[1]);
        const props = [...q.matchAll(/key='(\w+)' and value='([^']+)'/g)];
        const mime = q.match(/mimeType = '([^']+)'/)?.[1];
        const list = [...files.values()].filter(f => !f.trashed && f.parents.some(p => parents.includes(p))
          && (!names.length || names.includes(f.name)) && (!mime || f.mimeType === mime)
          && props.every(([, key, value]) => f.appProperties?.[key] === value));
        return {files: list.map(view)};
      },
      create(meta, data) {return {id: put(meta, data ? data.bytes : undefined)};},
      update(meta, id, data) {
        counts.writes++;
        const f = files.get(id);
        if (meta.appProperties) f.appProperties = {...f.appProperties, ...meta.appProperties};
        if (meta.trashed) f.trashed = true;
        if (data) {f.content = data.bytes; f.size = String(data.bytes.length); f.sha256Checksum = sha256(data.bytes);}
        f.version = String(Number(f.version) + 1);
        return {id, version: f.version};
      }
    }
  };
  const context = vm.createContext({
    console: {log() {}, warn() {}, error() {}},
    Drive,
    DriveApp: {getFileById(id) {const f = files.get(id); if (!f) throw new Error('File not found'); return {getBlob: () => {counts.driveAppReads++; return blob(f.content);}};}},
    Utilities: {
      DigestAlgorithm: {SHA_256: 'sha256'}, Charset: {UTF_8: 'utf8'},
      computeDigest: (alg, value) => signed(createHash('sha256').update(toBytes(value)).digest()),
      newBlob: data => blob(toBytes(data)),
      gzip: value => blob(gzipSync(value.bytes)),
      base64Encode: bytes => unsigned(bytes).toString('base64'),
      getUuid: () => randomUUID()
    },
    CacheService: {getUserCache: () => ({
      // Counts file reads only; the identity lookup also uses the cache.
      get: key => {if(env.cacheFails)throw new Error('cache unavailable'); if (key.startsWith('file-text:')) counts.cacheGet++; return cache.has(key) ? cache.get(key) : null;},
      getAll: keys => {if(env.cacheFails)throw new Error('cache unavailable'); counts.cacheGetAll++; return Object.fromEntries(keys.filter(k => cache.has(k)).map(k => [k, cache.get(k)]));},
      put: (key, value) => {if(env.cacheFails)throw new Error('cache unavailable'); cache.set(key, value);}
    })},
    ScriptApp: {getOAuthToken: () => 'token-1', getService: () => ({getUrl: () => 'https://example.com/exec'})},
    UrlFetchApp: {fetchAll(requests) {
      counts.fetchAll++;
      if (env.fetchAllFails) throw new Error('Exception: Request failed');
      return requests.map(({url, headers, followRedirects}) => {
        counts.fetched++;
        if (!url.startsWith('https://www.googleapis.com/drive/v3/files/') || followRedirects !== false) {
          env.unsafeRequest = true;
          throw new Error('OAuth request must stay on the Drive API');
        }
        const id = decodeURIComponent(url.match(/files\/([^?]+)\?alt=media/)[1]);
        const f = files.get(id);
        const ok = f && headers.Authorization === 'Bearer token-1';
        let bytes = ok ? f.content : Buffer.from('not found');
        if (ok && env.corruptDownloads) bytes = Buffer.concat([bytes.subarray(0, -1), Buffer.from('!')]);
        return {getResponseCode: () => env.redirectDownloads ? 302 : ok ? 200 : 404, getContent: () => signed(bytes), getContentText: () => bytes.toString('utf8')};
      });
    }},
    PropertiesService: {getScriptProperties: () => ({getProperty: key => ({SHSS_ROOT_FOLDER_ID: ROOT, SHSS_DOMAIN: domain})[key] ?? null})},
    Session: {getActiveUser: () => ({getEmail: () => email}), getEffectiveUser: () => ({getEmail: () => email})},
    LockService: {getScriptLock: () => ({tryLock: () => {env.onLock?.(); return true;}, releaseLock() {}})},
    HtmlService: {}
  });
  vm.runInContext(bundle + '\n' + code, context);
  env.rpc = (action, input) => {
    const reply = context.rpc(action, input);
    return JSON.parse(JSON.stringify(reply));
  };
  env.resetCounts = () => {for (const key of Object.keys(counts)) counts[key] = 0;};
  env.clearCache = () => cache.clear();
  return env;
}
