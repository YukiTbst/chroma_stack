/* m47 F-OUTLINE-01: the export mesh repair must NOT dilate the material mask.
   meshPrismLegacy's non-manifold fallback grew the whole mask by 1px when px>20000,
   thickening thin lines inside the same material (1px->3px) and overlapping neighbours.
   Contract: exported geometry footprint == mask, thin lines stay pixel-identical, watertight.
   Run: node tests/test-m47-outline-dilation.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.earcut = require('../app/js/earcut.js');
for (const m of ['color', 'optics', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const X = globalThis.CS.exporter;

const w = 260, h = 220, ps = 0.1;
// Deterministic jagged large block (>20000px) that defeats march + legacy earcut
// (non-manifold pinch), plus an isolated 1px vertical line at x=210.
let s = 10; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
const mask = new Uint8Array(w * h);
for (let y = 10; y < 170; y++) for (let x = 10; x < 170; x++) {
  const edge = (x < 14 || x > 165 || y < 14 || y > 165);
  mask[y * w + x] = edge ? (rnd() < 0.5 ? 1 : 0) : 1;
}
for (let y = 20; y < 120; y++) mask[y * w + 210] = 1;
let px = 0; for (const v of mask) px += v;
assert.ok(px > 20000, 'fixture mask exceeds the dilation area threshold');

const pos = [], idx = [];
X.meshPrism(mask, w, h, ps, 0, 0.08, pos, idx, false, 0);
assert.ok(idx.length > 0, 'mesh generated');

// The isolated 1px line (grid x=210) must stay exactly 1px wide in the geometry.
let minX = Infinity, maxX = -Infinity, cnt = 0;
for (let i = 0; i < pos.length; i += 3) {
  const gx = pos[i] / ps + w / 2;
  if (gx > 200) { minX = Math.min(minX, gx); maxX = Math.max(maxX, gx); cnt++; }
}
assert.ok(cnt > 0, 'line region has geometry');
assert.ok(Math.abs((maxX - minX) - 1) < 1e-6, `1px line must stay 1px wide in export (got ${(maxX - minX).toFixed(2)}px)`);
assert.ok(Math.abs(minX - 210) < 1e-6 && Math.abs(maxX - 211) < 1e-6, `line footprint must be exactly grid x=210..211 (got ${minX.toFixed(2)}..${maxX.toFixed(2)})`);

// Watertight: every edge shared by exactly two triangles.
const edges = new Map();
for (let i = 0; i < idx.length; i += 3) {
  const t = [idx[i], idx[i + 1], idx[i + 2]];
  for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3]; const key = a < b ? a + ',' + b : b + ',' + a; edges.set(key, (edges.get(key) || 0) + 1); }
}
let bad = 0; for (const n of edges.values()) if (n !== 2) bad++;
assert.equal(bad, 0, `export prism must be watertight (non-2-manifold edges: ${bad})`);
console.log(`F-OUTLINE-01 passed: 1px line stays 1px (x=${minX}..${maxX}), watertight, px=${px}, tris=${idx.length / 3}`);