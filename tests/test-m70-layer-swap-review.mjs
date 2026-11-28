/* R1 review counterexample regressions (06c171c review P1/P2). Each was a real reported
   failure; now must pass. Run: node tests/test-m70-layer-swap-review.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.earcut = require('../app/js/earcut.js');
for (const m of ['color', 'optics', 'height-curve', 'data-filaments', 'engine', 'layer-swap', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const C = globalThis.CS.color, O = globalThis.CS.optics, E = globalThis.CS.engine, LS = globalThis.CS.layerSwap, X = globalThis.CS.exporter, Z = globalThis.CS.zip;
const db = (globalThis.CS.FILAMENT_DB && CS.FILAMENT_DB.filaments) || [];
const pick = n => db.find(f => f.brand === 'BambuLab Basic' && f.material === 'PLA' && f.name === n);
const palette = ['Black', 'Jade White', 'Red', 'Yellow', 'Blue'].map(pick).filter(Boolean).map(f => ({ id: f.id, name: f.name, hex: f.hex, td: f.td, tdR: f.td, tdG: f.td, tdB: f.td }));
const img = (w, h, fn) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y); d.set([r, g, b, 255], (y * w + x) * 4); } return { width: w, height: h, data: d }; };
const base = { palette, firstLayerMm: 0.2, layerMm: 0.08, boundary: { linearRgb: { r: 1, g: 1, b: 1 } }, widthMm: 100, seed: 5 };
const segs = [{ materialId: palette[0].id, layerCount: 2 }, { materialId: palette[1].id, layerCount: 3 }, { materialId: palette[2].id, layerCount: 2 }, { materialId: palette[1].id, layerCount: 2 }];

// P1-01: changing per-channel TD MUST change layerSwap prefixes (shared effective params).
{
  const image = img(16, 12, (x, y) => [120 + x * 4, 90, 90]);
  const pA = LS.buildPlan(image, { ...base, segments: segs });
  const pal2 = palette.map(p => ({ ...p, tdR: p.tdR * 1.6 }));
  const pB = LS.buildPlan(image, { ...base, palette: pal2, segments: segs });
  const d = C.deltaE2000(pA.prefixPrediction[5].lab, pB.prefixPrediction[5].lab);
  assert.ok(d > 1, 'P1-01 per-channel TD changes prefix, dE=' + d.toFixed(2));
  assert.notEqual(pA.effectiveParamsHash, pB.effectiveParamsHash, 'effectiveParamsHash tracks params');
  // opticalModel applied (shared entry): a model overriding hd must change prefixes.
  const model = { modelId: 'm1', params: { [palette[2].id]: { state: ['estimated', 'estimated', 'estimated'], opaque: [0.8, 0.1, 0.1], logHd: [Math.log(0.5), Math.log(2), Math.log(2)] } } };
  const pC = LS.buildPlan(image, { ...base, segments: segs, opticalModel: model });
  assert.ok(C.deltaE2000(pA.prefixPrediction[7].lab, pC.prefixPrediction[7].lab) > 1, 'P1-01 opticalModel changes prefix');
  assert.equal(pC.modelRef, 'm1', 'modelRef recorded');
}
// P1-02: preview equals labToRgb01(P[H]) * 255 (single sRGB encode), 3-channel check.
{
  const image = img(8, 8, () => [203, 154, 155]);
  const p = LS.buildPlan(image, { ...base, segments: segs });
  for (let i = 0; i < 64; i += 7) {
    const want = C.labToRgb01(p.prefixPrediction[p.topLayer[i]].lab);
    assert.ok(Math.abs(p.preview[i * 4] - Math.round(want.r * 255)) <= 1, 'P1-02 R channel');
    assert.ok(Math.abs(p.preview[i * 4 + 1] - Math.round(want.g * 255)) <= 1, 'P1-02 G channel');
    assert.ok(Math.abs(p.preview[i * 4 + 2] - Math.round(want.b * 255)) <= 1, 'P1-02 B channel');
  }
}
// P1-03: NO project_settings.config (it remaps all parts to filament 1); the first-layer /
// repeat-height contract lives in chromastack.json (layerZMm) instead.
{
  const image = img(16, 12, (x, y) => [x * 12 % 255, 80, 80]);
  const p = LS.buildPlan(image, { ...base, segments: segs });
  const out = X.build3MFBytes(p);
  assert.ok(!out.files.some(f => f.name === 'Metadata/project_settings.config'), 'no project_settings (would remap to filament 1)');
  const meta = JSON.parse(typeof out.files.find(f => f.name === 'Metadata/chromastack.json').data === 'string' ? out.files.find(f => f.name === 'Metadata/chromastack.json').data : Buffer.from(out.files.find(f => f.name === 'Metadata/chromastack.json').data).toString('utf8'));
  assert.equal(meta.printStrategy, 'layerSwap', 'P1-04 metadata strategy');
  assert.ok(Array.isArray(meta.layerZMm) && Math.abs(meta.layerZMm[1] - 0.2) < 1e-9, 'metadata layerZMm first layer 0.2');
  assert.ok(Array.isArray(meta.changeList), 'metadata changeList');
}
// P1-04: planSummary works for layerSwap (no families crash).
{
  const image = img(8, 8, () => [200, 90, 90]);
  const p = LS.buildPlan(image, { ...base, segments: segs });
  const s = X.planSummary(p);
  assert.equal(s.printStrategy, 'layerSwap');
  assert.ok(Array.isArray(s.segments) && Array.isArray(s.changeList), 'planSummary layerSwap contract');
}
// P2-02: hard anchors intersect order-independently; conflicting fixedHeight reported.
{
  const image = img(8, 8, () => [200, 90, 90]);
  const region = { x0: 0, y0: 0, x1: 8, y1: 8 };
  const a4 = { type: 'fixedHeight', region, value: 4 }, a7 = { type: 'fixedHeight', region, value: 7 };
  const p1 = LS.buildPlan(image, { ...base, segments: segs, anchors: [a4, a7] });
  const p2 = LS.buildPlan(image, { ...base, segments: segs, anchors: [a7, a4] });
  assert.ok(p1.conflicts.length > 0 && p2.conflicts.length > 0, 'conflicting fixedHeight reported both orders');
  assert.equal(p1.conflicts.length, p2.conflicts.length, 'order-independent conflict count');
}
// P2-01: F-05 with fixTopLayer keeps same conditions; best not worse than baseline under fix.
{
  const image = img(16, 12, (x, y) => [x * 12 % 255, 80, 80]);
  const p = LS.buildPlan(image, { ...base, segments: segs });
  const opt = LS.optimizeSegmentLengths(image, p, { fixTopLayer: p.topLayer, maxTrials: 8 });
  assert.ok(opt.best.metrics.meanDE <= opt.baseline.metrics.meanDE + 1e-9, 'P2-01 best<=baseline under same fix');
  // applying best segments with the SAME fixTopLayer reproduces best metrics.
  const applied = LS.buildPlan(image, { ...base, segments: opt.best.segments, fixTopLayer: p.topLayer });
  assert.ok(Math.abs(applied.fitMetrics.meanDE - opt.best.metrics.meanDE) < 1e-6, 'P2-01 application matches candidate score');
}
// P2-04: adjacent same-material segments are not a swap; minLayers>total reported.
{
  const image = img(8, 8, () => [200, 90, 90]);
  const same = [{ materialId: palette[0].id, layerCount: 2 }, { materialId: palette[0].id, layerCount: 2 }, { materialId: palette[1].id, layerCount: 2 }];
  const p = LS.buildPlan(image, { ...base, segments: same });
  const cl = LS.changeList(p);
  assert.equal(cl.filter(e => e.kind === 'change').length, 1, 'adjacent same-material not a swap');
  const bad = LS.buildPlan(image, { ...base, segments: [{ materialId: palette[0].id, layerCount: 1 }], minLayers: 6 });
  assert.ok(bad.conflicts.some(c => /minLayers exceeds/.test(c.reason)), 'minLayers>total reported');
}
// P1-06: AIR pixels excluded from preview alpha + metrics.
{
  const image = img(8, 8, () => [200, 90, 90]);
  const pm = new Uint8Array(64).fill(1); pm[0] = 0; pm[1] = 0;
  const p = LS.buildPlan(image, { ...base, segments: segs, printMask: pm });
  assert.equal(p.preview[0 * 4 + 3], 0, 'AIR transparent');
  assert.equal(p.preview[2 * 4 + 3], 255, 'printed opaque');
  assert.equal(p.fitMetrics.printedPixels, 62, 'AIR excluded from stats');
}
console.log('m70 passed: review counterexamples P1-01/02/03/04/06 + P2-01/02/04 regressions');