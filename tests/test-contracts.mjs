/* Remaining contract checks: derived heights/colours (T07), native
   preview/export materials (T08), AA edges stay neutral (T12), resolution
   invariance of a physical detail (T14), determinism (T15).
   Run: node tests/test-contracts.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
globalThis.earcut = require('../app/js/earcut.js');
require('../app/js/engine.js');
require('../app/js/exporter.js');
require('../app/js/zip.js');
const C = globalThis.CS.color, E = globalThis.CS.engine, X = globalThis.CS.exporter;

const palette = [
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 },
  { name: 'Yellow', hex: '#fce300', td: 6 },
  { name: 'Blue', hex: '#00358e', td: 4 }
];
const base = {
  engine: 'td', palette, widthMm: 100, flatTopMm: 1.6, reliefMm: 0.16,
  variableHeight: true, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1,
  stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.6,
  smoothMm: 0, lineWidthMm: 0.42, smoothLevel: 0, mergeDeltaE: 4,
  heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false,
  lineProtect: 'auto', families: 24, backgroundMode: 'off'
};
function chart(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = x / (w - 1);
    data.set([Math.round(30 + 200 * t), Math.round(60 + 120 * (1 - t)), Math.round(180 - 80 * t), 255], (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}
const plan = E.buildPlan(chart(160, 100), base);

/* T07: heights and colours derive from the same recipe. */
let maxLen = 0;
for (const f of plan.families) {
  if (!f.pixelCount) continue;
  assert.equal(f.topLayer, plan.gradStartLayer + f.recipe.length, 'top layer follows the recipe');
  assert.ok(Math.abs(f.topMm - f.topLayer * plan.layerHeight) < 1e-9, 'top mm follows layer height');
  assert.ok(f.recipe.length <= plan.maxGradLayers, 'recipe stays inside the budget');
  maxLen = Math.max(maxLen, f.recipe.length);
  const lin = E.compositeLinear(plan.foundation.lin, f.recipe, plan.palette, plan.layerHeight);
  const hex = C.linearToHex(lin);
  assert.ok(C.deltaE2000(C.hexToLab(hex), C.hexToLab(f.predictedHex)) < 0.2,
    'predicted colour equals a fresh composite of the same recipe');
}
assert.equal(plan.actualGradTopLayer, plan.gradStartLayer + maxLen, 'actual top follows the longest recipe');
assert.equal(plan.gradTopLayer, plan.actualGradTopLayer, 'reported top is the actual top');
assert.ok(plan.gradTopLayer <= plan.gradStartLayer + plan.maxGradLayers, 'height never exceeds the budget');

/* T08: native preview/export materials are the same. */
const plane = X.samplePlane(plan, plan.w, plan.h);
const zs = [...new Set([0, plan.flatBaseLayers || 0, plan.flatLayers - 1, plan.gradStartLayer, plan.actualGradTopLayer - 1].filter(z => z >= 0 && z < plan.maxLayers))];
for (const z of zs) {
  const masks = X.buildLayerMasks(plan, plane, z);
  for (let y = 0; y < plan.h; y += 7) {
    for (let x = 0; x < plan.w; x += 7) {
      const want = E.filamentAt(plan, x, y, z);
      let got = -1;
      for (let fi = 0; fi < masks.length; fi++) if (masks[fi][y * plan.w + x]) { got = fi; break; }
      assert.equal(got, want, `native material mismatch at ${x},${y},z=${z}`);
    }
  }
}

/* T12: neutral AA edges never become chromatic recipes. */
const w2 = 200, h2 = 120;
const edge = new Uint8ClampedArray(w2 * h2 * 4);
for (let i = 0; i < w2 * h2; i++) edge.set([255, 255, 255, 255], i * 4);
for (let y = 20; y < 100; y++) {
  for (let x = 40; x < 100; x++) edge.set([8, 8, 10, 255], (y * w2 + x) * 4);
  edge.set([128, 128, 128, 255], (y * w2 + 100) * 4);
}
const edgePlan = E.buildPlan({ width: w2, height: h2, data: edge }, { ...base, widthMm: 60, lineProtect: 'auto' });
for (const f of edgePlan.families) {
  if (!f.pixelCount || Math.hypot(f.targetLab.a, f.targetLab.b) >= 8) continue;
  const chromatic = f.recipe.filter(i => Math.hypot(edgePlan.palette[i].lab.a, edgePlan.palette[i].lab.b) >= 8).length;
  assert.equal(chromatic, 0, 'near-neutral AA edge uses neutral recipe');
}

/* T14: the same 2 mm physical detail survives at two sampling densities. */
function detailChart(w) {
  const h = Math.round(w * 0.6);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([255, 255, 255, 255], i * 4);
  const px = w / 100; // 100 mm wide
  const d = Math.max(3, Math.round(2 * px));
  const x0 = Math.round(40 * px), y0 = Math.round(30 * px);
  for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + d; x++) data.set([200, 40, 56, 255], (y * w + x) * 4);
  return { width: w, height: h, data, cx: x0 + (d >> 1), cy: y0 + (d >> 1) };
}
const target = C.hexToLab('#c82838');
for (const w of [480, 960]) {
  const img = detailChart(w);
  const p = E.buildPlan({ width: img.width, height: img.height, data: img.data }, { ...base, minFlatPercent: 0.02 });
  const i = img.cy * p.w + img.cx;
  const de = C.deltaE2000(target, p.predicted[i].lab);
  console.log('resolution', w, 'pixel', p.pixelSize.toFixed(3), 'flat', p.flatMask[i], 'ΔE', de.toFixed(2));
  assert.equal(p.flatMask[i], 0, 'physical detail is not flattened away at any sampling');
  assert.ok(de < 8, 'physical detail keeps its colour at both resolutions');
}

/* T15: identical input produces identical plans. */
const img = chart(120, 80);
const p1 = E.buildPlan(img, base);
const p2 = E.buildPlan(img, base);
assert.equal(p1.families.length, p2.families.length);
for (let i = 0; i < p1.families.length; i++) {
  assert.deepEqual(p1.families[i].recipe, p2.families[i].recipe, 'recipes are deterministic');
}
for (let i = 0; i < p1.w * p1.h; i++) {
  if (p1.predicted[i].hex !== p2.predicted[i].hex) assert.fail('predicted colour differs at ' + i);
}
assert.equal(p1.regionCount, p2.regionCount);
assert.equal(p1.diagnostics.printAudit.belowMinIslands, p2.diagnostics.printAudit.belowMinIslands);
assert.equal(p1.stats.p90, p2.stats.p90);
console.log('all contract checks passed');