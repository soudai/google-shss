// Comment anchor rules shared by the browser client (web/app.js) and the
// server (server/core.mjs). The server is authoritative; the client uses the
// same checks to ignore selections the server would reject.

export const ANCHOR_LIMITS = {exact: 500, context: 120, offset: 2 * 1024 * 1024, path: 500, signature: 128};
export const REGION_TAGS = ['IMG', 'SVG', 'CANVAS', 'FIGURE'];
// Region paths are produced by pathFor() in web/bridge.js.
const REGION_PATH = /^body(?:>[a-z][a-z0-9-]*:nth-of-type\([1-9][0-9]*\)){1,20}$/i;

const plain = x => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x, max, min = 1) => typeof x === 'string' && x.length >= min && x.length <= max;
const offset = x => Number.isSafeInteger(x) && x >= 0;
const fraction = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
// Allows for floating-point error in rectangles computed from client geometry.
const MAX_EXTENT = 1.00001;

export function isTextAnchor(a) {
  return plain(a) && a.type === 'text' && str(a.exact, ANCHOR_LIMITS.exact) && !!a.exact.trim()
    && str(a.prefix, ANCHOR_LIMITS.context, 0) && str(a.suffix, ANCHOR_LIMITS.context, 0)
    && plain(a.position) && offset(a.position.start) && offset(a.position.end)
    && a.position.end - a.position.start === a.exact.length && a.position.end <= ANCHOR_LIMITS.offset;
}

export function isRegionAnchor(a) {
  if (!plain(a) || a.type !== 'region') return false;
  const r = a.rect;
  return str(a.path, ANCHOR_LIMITS.path) && REGION_PATH.test(a.path) && REGION_TAGS.includes(a.tag)
    && str(a.signature, ANCHOR_LIMITS.signature, 0) && plain(r) && [r.x, r.y, r.w, r.h].every(fraction)
    && r.w > 0 && r.h > 0 && r.x + r.w <= MAX_EXTENT && r.y + r.h <= MAX_EXTENT;
}

// Returns a copy holding only the stored fields, or null when the anchor is invalid.
export function normalizeAnchor(a) {
  if (isRegionAnchor(a)) {
    const {x, y, w, h} = a.rect;
    return {type: 'region', path: a.path, tag: a.tag, signature: a.signature, rect: {x, y, w, h}};
  }
  if (isTextAnchor(a)) {
    return {type: 'text', exact: a.exact, prefix: a.prefix, suffix: a.suffix, position: {start: a.position.start, end: a.position.end, unit: 'utf16'}, textModel: 'shss-visible-text-v1'};
  }
  return null;
}
