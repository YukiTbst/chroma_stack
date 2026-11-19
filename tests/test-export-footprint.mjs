/* Export footprint parity: the 3MF top surface must be pixel-identical to the
   layer mask — no dilation, no sealed 1-px white gaps, no half-pixel shift.
   Run from project root: node tests/test-export-footprint.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
globalThis.earcut = require('../app/js/earcut.js');
require('../app/js/zip.js');
require('../app/js/exporter.js');
const X = globalThis.CS.exporter;

const w = 16, h = 10;
// Two black bars with a 1-px white gap at x=7, a floating pixel and a
// diagonal pinch — the shapes that used to trigger dilation / gap sealing.
const mask = new Uint8Array(w * h);
for (let y = 2; y < 8; y++) for (const x of [3, 4, 5, 6, 8, 9, 10]) mask[y * w + x] = 1;
mask[1 * w + 14] = 1;
mask[8 * w + 1] = 1;
mask[7 * w + 2] = 1; // touches (1,8) at a corner only

const positions = [], indices = [];
const mode = X.meshPrism(mask, w, h, 1, 0, 1, positions, indices);

function topCovered(px, py) {
  let hit = false;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    if (positions[a + 2] !== 1 || positions[b + 2] !== 1 || positions[c + 2] !== 1) continue;
    const ax = positions[a], ay = positions[a + 1], bx = positions[b], by = positions[b + 1], cx = positions[c], cy = positions[c + 1];
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
    const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(neg && pos)) hit = true;
  }
  return hit;
}
const center = (x, y) => [x + 0.5 - w / 2, h / 2 - (y + 0.5)];

let mismatches = 0;
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const [px, py] = center(x, y);
  if (topCovered(px, py) !== !!mask[y * w + x]) mismatches++;
}
assert.equal(mismatches, 0, `top surface matches mask exactly (mode ${mode})`);
assert.equal(topCovered(...center(7, 4)), false, '1-px white gap stays open');
assert.equal(topCovered(...center(6, 4)), true, 'bar left of gap present');
assert.equal(topCovered(...center(8, 4)), true, 'bar right of gap present');
assert.equal(topCovered(...center(2, 4)), false, 'no dilation to the left');
assert.equal(topCovered(...center(11, 4)), false, 'no dilation to the right');

// Watertight: every edge shared by exactly two triangles.
const edges = new Map();
for (let i = 0; i < indices.length; i += 3) for (let k = 0; k < 3; k++) {
  const a = indices[i + k], b = indices[i + (k + 1) % 3];
  const key = a < b ? a + ',' + b : b + ',' + a;
  edges.set(key, (edges.get(key) || 0) + 1);
}
let badEdges = 0;
for (const n of edges.values()) if (n !== 2) badEdges++;
assert.equal(badEdges, 0, 'prism is watertight');

console.log(`all export-footprint checks passed (mode ${mode}, ${indices.length / 3} triangles, gap preserved)`);

/* Fallback tiling must stay manifold even where cells touch only diagonally:
   four walls used to weld into a 4-face vertical edge there. */
const w2 = 10, h2 = 10;
const mask2 = new Uint8Array(w2 * h2);
for (let y = 1; y < 5; y++) for (let x = 1; x < 5; x++) mask2[y * w2 + x] = 1;   // block A
for (let y = 5; y < 9; y++) for (let x = 5; x < 9; x++) mask2[y * w2 + x] = 1;   // block B (diagonal touch at 4,4)
mask2[1 * w2 + 8] = 1; mask2[2 * w2 + 8] = 0;                                     // isolated-ish pixel
const p2 = [], i2 = [];
const mode2 = X.meshPrism(mask2, w2, h2, 1, 0, 1, p2, i2, true);
assert.equal(mode2, 'fallback', 'forced tiling path is exercised');
const edges2 = new Map();
for (let i = 0; i < i2.length; i += 3) for (let k = 0; k < 3; k++) {
  const a = i2[i + k], b = i2[i + (k + 1) % 3];
  const key = a < b ? a + ',' + b : b + ',' + a;
  edges2.set(key, (edges2.get(key) || 0) + 1);
}
let bad2 = 0;
for (const n of edges2.values()) if (n !== 2) bad2++;
assert.equal(bad2, 0, 'diagonal contact never creates >2-face edges in the tiling fallback');
console.log(`fallback tiling stays 2-manifold across diagonal contacts (${i2.length / 3} triangles)`);
