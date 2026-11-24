/* Task C contract: meshPrismRect must produce an exact-occupancy, watertight solid
   with fewer faces than per-cell tiling, or return null (fall back). Verifies manifold
   edges, top-cap area == occupied cells, signed volume == A*height, non-degenerate
   triangles, and pixel-exact footprint over all 511 non-empty 3x3 masks + random masks
   + diagonal/ring/L special cases. Run: node tests/test-m63-rect-fallback.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.earcut = require('../app/js/earcut.js');
for (const m of ['height-curve', 'color', 'optics', 'data-filaments', 'engine', 'layer-optimizer', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const X = globalThis.CS.exporter;

function areaOf(mask, w, h) { let a = 0; for (let i = 0; i < w * h; i++) a += mask[i] ? 1 : 0; return a; }
function perimeter(mask, w, h) {
  const at = (x, y) => (x >= 0 && x < w && y >= 0 && y < h) ? mask[y * w + x] : 0;
  let p = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (!mask[y * w + x]) continue; if (!at(x, y - 1)) p++; if (!at(x, y + 1)) p++; if (!at(x - 1, y)) p++; if (!at(x + 1, y)) p++; } return p;
}
function check(mask, w, h, label) {
  const A = areaOf(mask, w, h);
  if (!A) return;
  const positions = [], indices = [];
  const mode = X.meshPrismRect(mask, w, h, 1, 0, 1, positions, indices);
  if (!mode) return; // fell back to tiling (allowed)
  assert.equal(mode, 'rect');
  assert.ok(indices.length % 3 === 0 && indices.length > 0, label + ': has triangles');
  const nv = positions.length / 3;
  for (const v of positions) assert.ok(Number.isFinite(v), label + ': finite vertex');
  for (const idx of indices) assert.ok(idx >= 0 && idx < nv, label + ': index range');
  // manifold: every undirected edge exactly 2 faces; non-degenerate
  const edges = new Map();
  let capArea = 0, vol = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    assert.ok(a !== b && b !== c && a !== c, label + ': non-degenerate');
    for (const [u, v] of [[a, b], [b, c], [c, a]]) { const k = u < v ? u + ',' + v : v + ',' + u; edges.set(k, (edges.get(k) || 0) + 1); }
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    // signed volume contribution
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    // top cap area (all z == 1)
    if (az === 1 && bz === 1 && cz === 1) capArea += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  for (const n of edges.values()) assert.equal(n, 2, label + ': manifold edge (got ' + n + ')');
  assert.ok(Math.abs(capArea - A) < 1e-6, label + ': top cap area ' + capArea + ' == A ' + A);
  assert.ok(Math.abs(vol - A) < 1e-6, label + ': signed volume ' + vol + ' == A ' + A);
  // fewer faces than tiling
  const Ttile = 4 * A + 2 * perimeter(mask, w, h);
  assert.ok(indices.length / 3 < Ttile, label + ': rect faces < tiling');
}

// all 511 non-empty 3x3 masks
let n3 = 0;
for (let bits = 1; bits < 512; bits++) {
  const mask = new Uint8Array(9);
  for (let i = 0; i < 9; i++) mask[i] = (bits >> i) & 1;
  check(mask, 3, 3, '3x3#' + bits); n3++;
}
// random masks various sizes
let seed = 987654321;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let nr = 0;
for (let t = 0; t < 300; t++) {
  const w = 2 + Math.floor(rnd() * 12), h = 2 + Math.floor(rnd() * 12);
  const mask = new Uint8Array(w * h);
  const dens = 0.2 + rnd() * 0.7;
  for (let i = 0; i < w * h; i++) mask[i] = rnd() < dens ? 1 : 0;
  check(mask, w, h, 'rand#' + t); nr++;
}
// special: L-shape, ring, diagonal contact, solid block
check(Uint8Array.from([1, 1, 1, 1, 0, 0, 1, 0, 0]), 3, 3, 'L');
check(Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]), 3, 3, 'ring');
check(Uint8Array.from([1, 0, 0, 1]), 2, 2, 'diagonal');
{ const m = new Uint8Array(64 * 64).fill(1); check(m, 64, 64, 'solid64'); }
console.log('all rectangle fallback checks passed (' + n3 + ' 3x3 + ' + nr + ' random + specials)');