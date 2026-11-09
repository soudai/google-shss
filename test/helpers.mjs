import {gzipSync} from 'node:zlib';
import {zipSync,strToU8} from 'fflate';
import {digest,localService,memoryStore} from '../scripts/memory-store.mjs';
export {digest,memoryStore};

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

// A service over a memory store with deterministic IDs and clock. The first
// argument is kept so tests read like the production wiring.
export function service(createService, options = {}) {
  const store = options.store || memoryStore(options);
  let uuid = 0, clock = Date.parse('2026-01-01T00:00:00Z');
  const actor = {id: 'user1', displayName: 'User One'};
  const {run} = localService({
    store,
    actor: () => options.actor ? options.actor() : actor,
    uuid: () => `id${++uuid}`,
    now: () => new Date(clock += 1000).toISOString()
  });
  return {run, store, actor};
}
