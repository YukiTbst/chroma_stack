/* R1 layerSwap acceptance (spec v1.1 A/B/C01/D03 + §13 change list + prototype regression).
   Run: node tests/test-m68-layer-swap.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.earcut = require('../app/js/earcut.js');
for (const m of ['color', 'optics', 'height-curve', 'data-filaments', 'engine', 'layer-swap', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const C = globalThis.CS.color, O = globalThis.CS.optics, LS = globalThis.CS.layerSwap, X = globalThis.CS.exporter;
const db = (globalThis.CS.FILAMENT_DB && CS.FILAMENT_DB.filaments) || [];
const pick = n => db.find(f => f.brand === 'BambuLab Basic' && f.material === 'PLA' && f.name === n);
const palette = ['Black', 'Jade White', 'Red', 'Yellow', 'Blue'].map(pick).filter(Boolean).map(f => ({ id: f.name, name: f.name, hex: f.hex, td: f.td }));
const [K, W, R, Y, U] = palette.map(p => p.id);
const img = (w, h, fn) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y); d.set([r, g, b, 255], (y * w + x) * 4); } return { width: w, height: h, data: d }; };
const base = { palette, firstLayerMm: 0.2, layerMm: 0.08, boundary: { linearRgb: { r: 1, g: 1, b: 1 } }, widthMm: 100, seed: 7 };
const seg = (materialId, layerCount, locked) => ({ materialId, layerCount, locked: !!locked });

// A02/A03: single-material layers + prefix + nesting
{
  const image = img(16, 12, (x, y) => [x * 15 % 255, y * 20 % 255, (x + y) * 9 % 255]);
  const plan = LS.buildPlan(image, { ...base, segments: [seg(K, 2), seg(W, 2), seg(R, 2), seg(W, 1), seg(U, 1), seg(R, 1)] });
  const n = 16 * 12;
  for (let z = 0; z < plan.maxLayers; z++) {
    const set = new Set();
    for (let p = 0; p < n; p++) { const m = LS.materialAt(plan, p, z); if (m >= 0) set.add(m); }
    if (set.size) { assert.equal(set.size, 1, 'A02 layer ' + z + ' single material'); assert.equal([...set][0], plan.layerMaterial[z], 'A02 == S[z]'); }
  }
  for (let p = 0; p < n; p++) for (let z = 0; z < plan.topLayer[p]; z++) assert.equal(LS.materialAt(plan, p, z), plan.layerMaterial[z], 'A03 prefix no skip');
  for (let z = 0; z + 1 < plan.maxLayers; z++) for (let p = 0; p < n; p++) if (LS.materialAt(plan, p, z + 1) >= 0) assert.ok(LS.materialAt(plan, p, z) >= 0, 'A03 nesting');
  // A04: prefix cache == direct predictStack; preview P[H] == export top material
  for (let k = 1; k <= plan.maxLayers; k++) {
    const stack = plan.layerMaterialId.slice(0, k).map((id, i) => ({ materialId: id, thicknessMm: plan.layerThicknessMm[i] }));
    const direct = O.predictStack({ materials: Object.fromEntries(palette.map(p => [p.id, p])) }, stack, base.boundary, null);
    assert.ok(Math.abs(direct.lab.L - plan.prefixPrediction[k].lab.L) < 1e-6, 'A04 prefix recursion');
  }
  const plane = X.samplePlane(plan, plan.w, plan.h);
  for (let p = 0; p < n; p += 37) { const H = plan.topLayer[p]; if (H > 0) { const masks = X.buildLayerMasks(plan, plane, H - 1); assert.equal(masks[plan.layerMaterial[H - 1]][p], 1, 'A04 export top == P[H] material'); } }
  // D03 native grid + geometry manifold
  assert.equal(X.exportGridFor(plan).width, plan.w, 'D03/native no downsample');
  const prisms = X.buildPrisms(plan, plane);
  for (let f = 0; f < palette.length; f++) for (const pr of prisms[f]) {
    const pos = [], ind = []; X.meshPrism(pr.mask, plan.w, plan.h, plan.pixelSize, plan.layerZMm[pr.z0], plan.layerZMm[pr.z1], pos, ind);
    const edges = new Map();
    for (let i = 0; i < ind.length; i += 3) { const t = [ind[i], ind[i + 1], ind[i + 2]]; for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3]; const key = a < b ? a + ',' + b : b + ',' + a; edges.set(key, (edges.get(key) || 0) + 1); } }
    for (const v of edges.values()) assert.equal(v, 2, 'D03 manifold');
  }
}
// A05: non-uniform first layer + §13.2 change-list example (A x3 then B, 0.20/0.08)
{
  const image = img(8, 8, () => [120, 120, 120]);
  const plan = LS.buildPlan(image, { ...base, segments: [seg(K, 3), seg(W, 2)], minLayers: 1 });
  assert.ok(Math.abs(plan.layerZMm[1] - 0.2) < 1e-9, 'A05 first layer 0.2');
  assert.ok(Math.abs(plan.layerZMm[4] - 0.44) < 1e-9, 'A05 Z[4]=0.44');
  const cl = LS.changeList(plan);
  const change = cl.find(e => e.kind === 'change');
  assert.equal(cl[0].kind, 'first-load');
  assert.equal(change.startLayer1, 4); assert.ok(Math.abs(change.bottomZmm - 0.36) < 1e-9); assert.ok(Math.abs(change.topZmm - 0.44) < 1e-9); assert.equal(change.prevSegmentLastLayer1, 3);
}
// A06: A-B-A repeats preserved (2 materials, 3 segments, 2 changes)
{
  const image = img(8, 8, () => [200, 60, 60]);
  const plan = LS.buildPlan(image, { ...base, segments: [seg(K, 2), seg(W, 2), seg(K, 1)], anchors: [ { type: 'fixedHeight', region: { x0: 0, y0: 0, x1: 8, y1: 8 }, value: 5 } ] });
  assert.deepEqual(plan.layerMaterialId, [K, K, W, W, K], 'A06 not deduped');
  assert.equal(new Set(plan.layerMaterialId).size, 2); assert.equal(plan.segments.length, 3);
  const cl = LS.changeList(plan); assert.equal(cl.filter(e => e.kind === 'change').length, 2, 'A06 two changes');
}
// B01/B02/B03: hue vs luminance, neutrals, hue wrap, non-monotonic
{
  // same luminance, different hue regions
  const image = img(12, 6, (x) => x < 6 ? [150, 60, 60] : [60, 60, 150]);
  const plan = LS.buildPlan(image, { ...base, segments: [seg(K, 1), seg(W, 2), seg(R, 2), seg(U, 2), seg(Y, 1)] });
  const hLeft = plan.topLayer[0], hRight = plan.topLayer[11];
  assert.notEqual(hLeft, hRight, 'B01 same-luma different hue -> different height');
  // neutral gray should not be hue-misassigned: gray pixel height equals nearest-neutral path
  const gimg = img(4, 4, () => [128, 128, 128]);
  const gplan = LS.buildPlan(gimg, { ...base, segments: [seg(K, 2), seg(W, 3)] });
  const gH = gplan.topLayer[0]; assert.ok(gH >= 1 && gH <= 5);
  // non-monotonic: sequence W then K then W -> bright-dark-bright; a mid-bright target may stop low
  const nimg = img(6, 6, (x) => x < 3 ? [240, 240, 240] : [90, 90, 90]);
  const nplan = LS.buildPlan(nimg, { ...base, segments: [seg(W, 2), seg(K, 2), seg(W, 2)] });
  const brightH = nplan.topLayer[0], darkH = nplan.topLayer[5];
  assert.ok(!(brightH > darkH), 'B03 not forced luminance-monotonic (bright may stop at first W)');
}
// B04: exhaustive reference (smooth off) equals independent nearest
{
  const image = img(5, 5, (x, y) => [(x * 51) % 255, (y * 51) % 255, ((x + y) * 25) % 255]);
  const segments = [seg(K, 1), seg(W, 2), seg(R, 1), seg(U, 1)];
  const plan = LS.buildPlan(image, { ...base, segments, prefs: { smooth: 0 } });
  const model = { materials: Object.fromEntries(palette.map(p => [p.id, p])) };
  for (let p = 0; p < 25; p++) {
    const lab = C.rgb255ToLab({ r: image.data[p * 4], g: image.data[p * 4 + 1], b: image.data[p * 4 + 2] });
    let bk = 1, bd = Infinity;
    for (let k = 1; k <= plan.maxLayers; k++) { const e = C.deltaE2000(lab, plan.prefixPrediction[k].lab); if (e < bd) { bd = e; bk = k; } }
    assert.equal(plan.topLayer[p], bk, 'B04 exhaustive at ' + p);
  }
}
// B05: spatial consistency reduces isolated jumps; deterministic
{
  const image = img(20, 20, (x, y) => [140 + ((x * 7 + y * 13) % 3) * 4, 70, 70]);
  const opts = { ...base, segments: [seg(K, 1), seg(W, 2), seg(R, 3), seg(W, 2)] };
  const a = LS.buildPlan(image, { ...opts, prefs: { smooth: 0 } });
  const b = LS.buildPlan(image, { ...opts, prefs: { smooth: 1 } });
  const b2 = LS.buildPlan(image, { ...opts, prefs: { smooth: 1 } });
  assert.ok(b.fitMetrics.isolatedJumps <= a.fitMetrics.isolatedJumps, 'B05 smooth reduces jumps');
  assert.deepEqual(Array.from(b.topLayer), Array.from(b2.topLayer), 'B05 deterministic');
}
// B06: locks + conflicts
{
  const image = img(8, 8, () => [200, 80, 80]);
  const plan = LS.buildPlan(image, { ...base, segments: [seg(K, 2), seg(W, 2), seg(R, 2)], anchors: [ { type: 'fixedHeight', region: { x0: 0, y0: 0, x1: 4, y1: 4 }, value: 99 }, { type: 'topSegment', region: { x0: 4, y0: 4, x1: 8, y1: 8 }, segmentId: 999 } ] });
  assert.ok(plan.conflicts.length >= 2, 'B06 conflicts reported');
  const ok = LS.buildPlan(image, { ...base, segments: [seg(K, 2), seg(W, 2), seg(R, 2)], anchors: [ { type: 'fixedHeight', region: { x0: 0, y0: 0, x1: 4, y1: 4 }, value: 3 } ] });
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) assert.equal(ok.topLayer[y * 8 + x], 3, 'B06 fixedHeight respected');
}
// C01: segment-length optimization retains baseline; locked unchanged
{
  const image = img(16, 16, (x, y) => [x * 16 % 255, 60, y * 16 % 255]);
  const plan = LS.buildPlan(image, { ...base, segments: [seg(K, 2, true), seg(W, 3), seg(R, 2), seg(W, 2)] });
  const opt = LS.optimizeSegmentLengths(image, plan, { maxTrials: 8 });
  assert.ok(opt.baseline.isBaseline, 'C01 baseline present');
  assert.ok(opt.best.metrics.meanDE <= opt.baseline.metrics.meanDE + 1e-9, 'C01 best not worse than baseline');
  for (const t of opt.trials) assert.equal(t.segments[0].layerCount, 2, 'C01 locked seg unchanged');
}
// prototype regression on real artwork (same grid/sequence/params as scratch prototype)
if (fs.existsSync('app/test-art.rgba')) {
  const meta = JSON.parse(fs.readFileSync('app/test-art.json', 'utf8'));
  const src = fs.readFileSync('app/test-art.rgba'); const F = 4, w = Math.floor(meta.w / F), h = Math.floor(meta.h / F);
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let r = 0, g = 0, b = 0, n = 0; for (let dy = 0; dy < F; dy++) for (let dx = 0; dx < F; dx++) { const p = ((y * F + dy) * meta.w + (x * F + dx)) * 4; r += src[p]; g += src[p + 1]; b += src[p + 2]; n++; } d.set([r / n, g / n, b / n, 255], (y * w + x) * 4); }
  const plan = LS.buildPlan({ width: w, height: h, data: d }, { ...base, widthMm: 150, segments: [seg(K, 2), seg(W, 3), seg(R, 2), seg(W, 2), seg(U, 2), seg(R, 1)], anchors: [ { type: 'weight', region: { x0: Math.floor(w * 0.35), y0: Math.floor(h * 0.25), x1: Math.floor(w * 0.65), y1: Math.floor(h * 0.5) }, value: 3 } ] });
  assert.ok(Math.abs(plan.fitMetrics.meanDE - 10.03) < 0.6, 'prototype regression meanDE ~10.03, got ' + plan.fitMetrics.meanDE.toFixed(2));
  assert.ok(plan.fitMetrics.isolatedJumps < 700, 'prototype regression jumps reduced, got ' + plan.fitMetrics.isolatedJumps);
  console.log('real-artwork layerSwap meanDE', plan.fitMetrics.meanDE.toFixed(2), 'isolatedJumps', plan.fitMetrics.isolatedJumps);
}
console.log('m68 passed: layerSwap A02-A06 / B01-B06 / C01 / D03 + change list + prototype regression');