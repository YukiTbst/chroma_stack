/* Task C contract (strengthened per m66 review): meshPrismRect must produce an exact-occupancy,
   watertight solid with fewer faces than per-cell tiling, or return null ONLY when not smaller.
   Known-good shapes (solid block, L, regular hole, plus) MUST succeed ('rect'); null-skip is not
   acceptance. Checks: undirected edges==2, directed-edge pairing, vertex link single cycle (small),
   non-degenerate, per-pixel occupancy rasterization (missing/extra/double), capArea==A*ps^2 and
   signedVolume==A*ps^2*(z1-z0) in consistent units, non-1 pixelSize / non-0 z0, and real 4x masks.
   Run: node tests/test-m63-rect-fallback.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.earcut = require('../app/js/earcut.js');
for (const m of ['height-curve', 'color', 'optics', 'data-filaments', 'engine', 'layer-optimizer', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const X = globalThis.CS.exporter;

function areaOf(mask) { let a = 0; for (let i = 0; i < mask.length; i++) a += mask[i] ? 1 : 0; return a; }
function perimeter(mask, w, h) { const at = (x, y) => (x >= 0 && x < w && y >= 0 && y < h) ? mask[y * w + x] : 0; let p = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (!mask[y * w + x]) continue; if (!at(x, y - 1)) p++; if (!at(x, y + 1)) p++; if (!at(x - 1, y)) p++; if (!at(x + 1, y)) p++; } return p; }
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0), pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}
function inTriStrict(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  return (d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0);
}
// Rasterize top-cap triangles back to pixel centres; coverage must equal the mask exactly.
function occupancy(mask, w, h, ps, z1, positions, indices, startIdx) {
  const cov = new Uint8Array(w * h);
  const covStrict = new Uint8Array(w * h);
  const gx = i => positions[i * 3] / ps + w / 2, gy = i => h / 2 - positions[i * 3 + 1] / ps;
  for (let i = startIdx; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    if (positions[a * 3 + 2] !== z1 || positions[b * 3 + 2] !== z1 || positions[c * 3 + 2] !== z1) continue;
    const ax = gx(a), ay = gy(a), bx = gx(b), by = gy(b), cx = gx(c), cy = gy(c);
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      // inclusive for coverage (a centre on an internal edge still belongs to the cap);
      // strict-interior for overlap (centres exactly on a shared edge are not double-covered).
      if (inTri(x + 0.5, y + 0.5, ax, ay, bx, by, cx, cy)) cov[y * w + x]++;
      if (inTriStrict(x + 0.5, y + 0.5, ax, ay, bx, by, cx, cy)) covStrict[y * w + x]++;
    }
  }
  let missing = 0, extra = 0, double = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && cov[i] === 0) missing++;
    if (!mask[i] && cov[i] > 0) extra++;
    if (covStrict[i] > 1) double++;
  }
  return { missing, extra, double };
}
function check(mask, w, h, ps, z0, z1, label, requireRect, strong) {
  const A = areaOf(mask); if (!A) return null;
  const positions = [], indices = [];
  const mode = X.meshPrismRect(mask, w, h, ps, z0, z1, positions, indices);
  if (!mode) { if (requireRect) assert.fail(label + ': known-good must return rect, got null'); return { mode: null }; }
  assert.equal(mode, 'rect', label);
  assert.ok(indices.length % 3 === 0 && indices.length > 0, label + ': triangles');
  const nv = positions.length / 3;
  for (const v of positions) assert.ok(Number.isFinite(v), label + ': finite');
  for (const idx of indices) assert.ok(idx >= 0 && idx < nv, label + ': index range');
  const und = new Map(), dir = new Map(); let capArea = 0, vol = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    assert.ok(a !== b && b !== c && a !== c, label + ': non-degenerate');
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = u < v ? u + ',' + v : v + ',' + u; und.set(k, (und.get(k) || 0) + 1);
      const dk = u + '>' + v; dir.set(dk, (dir.get(dk) || 0) + 1);
    }
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    if (az === z1 && bz === z1 && cz === z1) capArea += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  for (const n of und.values()) assert.equal(n, 2, label + ': manifold edge got ' + n);
  for (const [k, n] of dir) { const [u, v] = k.split('>'); assert.equal(dir.get(v + '>' + u), n, label + ': directed pair ' + k); }
  const tol = Math.max(1e-6, A * ps * ps * 1e-9);
  assert.ok(Math.abs(capArea - A * ps * ps) < tol, label + ': capArea ' + capArea + ' == A*ps^2 ' + (A * ps * ps));
  assert.ok(Math.abs(vol - A * ps * ps * (z1 - z0)) < tol * (z1 - z0), label + ': volume units');
  const occ = occupancy(mask, w, h, ps, z1, positions, indices, 0);
  assert.equal(occ.missing, 0, label + ': missing pixels ' + occ.missing);
  assert.equal(occ.extra, 0, label + ': extra pixels ' + occ.extra);
  assert.equal(occ.double, 0, label + ': double-covered ' + occ.double);
  const faces = indices.length / 3;
  const Ttile = 4 * A + 2 * perimeter(mask, w, h);
  assert.ok(faces < Ttile, label + ': faces < tiling');
  if (strong) {
    // vertex link must be a single cycle (closed manifold surface)
    const link = new Map();
    for (let i = 0; i < indices.length; i += 3) {
      const t = [indices[i], indices[i + 1], indices[i + 2]];
      for (let k = 0; k < 3; k++) {
        const v = t[k], o1 = t[(k + 1) % 3], o2 = t[(k + 2) % 3];
        if (!link.has(v)) link.set(v, []);
        link.get(v).push([o1, o2]);
      }
    }
    for (const [v, edges] of link) {
      const adj = new Map();
      for (const [a, b] of edges) { adj.set(a, (adj.get(a) || 0) + 1); adj.set(b, (adj.get(b) || 0) + 1); }
      for (const n of adj.values()) assert.equal(n, 2, label + ': vertex link degree at ' + v);
      // single cycle: walk
      const start = edges[0][0]; let cur = start, prev = -1, count = 0;
      do { const nb = []; for (const [a, b] of edges) { if (a === cur && b !== prev) nb.push(b); if (b === cur && a !== prev) nb.push(a); } if (!nb.length) break; prev = cur; cur = nb[0]; count++; } while (cur !== start && count <= edges.length + 1);
      assert.equal(cur, start, label + ': vertex link cycle at ' + v);
      assert.equal(count, adj.size, label + ': vertex link single cycle at ' + v);
    }
  }
  return { mode, faces, Ttile, A };
}

const mk = (w, h, rows) => { const m = new Uint8Array(w * h); rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] === '1') m[y * w + x] = 1; }); return m; };
// known-good regression set: MUST succeed
const knownGood = [
  ['L', mk(3, 3, ['111', '100', '000'])],
  ['solid', mk(5, 5, ['11111', '11111', '11111', '11111', '11111'])],
  ['hole', mk(5, 5, ['11111', '10001', '10001', '10001', '11111'])],
  ['plus', mk(5, 5, ['00100', '00100', '11111', '00100', '00100'])],
  ['diag', mk(4, 4, ['1100', '1100', '0011', '0011'])]
];
for (const [name, m] of knownGood) {
  const w = Math.round(Math.sqrt(m.length)); // square masks above
  check(m, w, w, 1, 0, 1, 'known-' + name, true, true);
  check(m, w, w, 0.125, 0.5, 0.9, 'known-' + name + '-units', true, false);
}
// 511 census: categorize; successes fully checked; known-good already asserted above
let succ = 0, nulls = 0;
for (let bits = 1; bits < 512; bits++) {
  const m = new Uint8Array(9); for (let i = 0; i < 9; i++) m[i] = (bits >> i) & 1;
  const r = check(m, 3, 3, 1, 0, 1, '3x3#' + bits, false, true);
  if (r.mode) succ++; else nulls++;
}
console.log('3x3 census: rect', succ, 'null(not-smaller)', nulls);
// random masks
let seed = 987654321; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let rs = 0, rn = 0;
for (let t = 0; t < 300; t++) {
  const w = 4 + Math.floor(rnd() * 12), h = 4 + Math.floor(rnd() * 12);
  const m = new Uint8Array(w * h); for (let i = 0; i < m.length; i++) m[i] = rnd() < 0.5 ? 1 : 0;
  const r = check(m, w, h, 1, 0, 1, 'rand#' + t, false, false);
  if (r.mode) rs++; else rn++;
}
console.log('random: rect', rs, 'null', rn);
// real 4x masks (optional fixture): must now succeed with exact occupancy + fewer faces
const dir = 'app/art-masks';
if (fs.existsSync(dir + '/manifest.json')) {
  const man = JSON.parse(fs.readFileSync(dir + '/manifest.json', 'utf8'));
  let totF = 0, totT = 0, n = 0;
  for (const p of man.prisms) {
    if (p.area < 500000) continue;
    const buf = fs.readFileSync(dir + '/' + p.file);
    const m = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
    const r = check(m, man.ew, man.eh, man.pixelSize, p.z0 * man.layerHeight, p.z1 * man.layerHeight, 'real#' + p.i, true, false);
    totF += r.faces; totT += r.Ttile; n++;
  }
  const red = (totT - totF) / totT * 100;
  assert.ok(red > 50, 'real reduction >50%, got ' + red.toFixed(1));
  console.log('real organic:', n, 'faces', totF, 'vs tiling', totT, 'reduction', red.toFixed(1) + '%');
} else console.log('(real fixture absent)');
console.log('m63 passed: rect exact-occupancy + manifold + known-good succeed + unit-correct + real regression');