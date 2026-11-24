/* E1 contract (export review): the loop-containment bounding-box prefilter must not
   change geometry. (1) A point outside a loop's bbox can never be inside the loop, so
   rejecting it before pointInLoop is safe. (2) Complex multi-hole/island masks still
   mesh into watertight solids with valid indices. Run: node tests/test-m60-mesh-bbox.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.earcut = require('../app/js/earcut.js');
for (const m of ['height-curve', 'color', 'optics', 'data-filaments', 'engine', 'layer-optimizer', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const X = globalThis.CS.exporter;

/* (1) bbox prefilter safety: outside-bbox => pointInLoop false, over many polygons. */
function bbox(pts) { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (const p of pts) { if (p.x < a) a = p.x; if (p.x > b) b = p.x; if (p.y < c) c = p.y; if (p.y > d) d = p.y; } return { a, b, c, d }; }
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let checked = 0, rejected = 0;
for (let t = 0; t < 400; t++) {
  const n = 3 + Math.floor(rnd() * 8);
  const cx = rnd() * 100, cy = rnd() * 100, r = 5 + rnd() * 30;
  const pts = [];
  for (let i = 0; i < n; i++) { const ang = (i / n) * Math.PI * 2; pts.push({ x: cx + Math.cos(ang) * r * (0.6 + rnd() * 0.4), y: cy + Math.sin(ang) * r * (0.6 + rnd() * 0.4) }); }
  const bb = bbox(pts);
  for (let k = 0; k < 20; k++) {
    const p = { x: cx + (rnd() - 0.5) * r * 4, y: cy + (rnd() - 0.5) * r * 4 };
    const inside = X.pointInLoop(p, { pts });
    const inBox = p.x >= bb.a && p.x <= bb.b && p.y >= bb.c && p.y <= bb.d;
    if (!inBox) { assert.equal(inside, false, 'point outside bbox must be outside loop'); rejected++; }
    checked++;
  }
}
assert.ok(checked > 1000 && rejected > 100, 'exercised enough outside-bbox rejections');

/* (2) complex mask: outer block + hole + island-in-hole + separate blob -> watertight. */
const w = 60, h = 60;
const mask = new Uint8Array(w * h);
const set = (x, y) => { if (x >= 0 && y >= 0 && x < w && y < h) mask[y * w + x] = 1; };
for (let y = 10; y < 50; y++) for (let x = 10; x < 50; x++) set(x, y);        // outer block
for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) mask[y * w + x] = 0; // hole
for (let y = 26; y < 34; y++) for (let x = 26; x < 34; x++) set(x, y);        // island in hole
for (let y = 5; y < 9; y++) for (let x = 5; x < 9; x++) set(x, y);            // separate blob
const positions = [], indices = [];
X.meshPrism(mask, w, h, 0.2, 0, 0.4, positions, indices);
assert.ok(indices.length > 0 && indices.length % 3 === 0, 'mesh has triangles');
for (const v of positions) assert.ok(Number.isFinite(v), 'finite vertex');
const nv = positions.length / 3;
for (const idx of indices) assert.ok(idx >= 0 && idx < nv, 'index in range');
// watertight: every undirected edge shared by exactly two triangles
const edges = new Map();
for (let i = 0; i < indices.length; i += 3) {
  const a = indices[i], b = indices[i + 1], c = indices[i + 2];
  assert.ok(a !== b && b !== c && a !== c, 'non-degenerate triangle');
  for (const [u, v] of [[a, b], [b, c], [c, a]]) { const key = u < v ? u + ',' + v : v + ',' + u; edges.set(key, (edges.get(key) || 0) + 1); }
}
let bad = 0; for (const c of edges.values()) if (c !== 2) bad++;
assert.equal(bad, 0, 'watertight (every edge shared by 2 triangles), got ' + bad + ' bad edges');
console.log('all mesh bbox checks passed (' + checked + ' point tests, ' + (indices.length / 3) + ' triangles, watertight)');