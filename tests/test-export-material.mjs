/* P5: export consumes the single material source (filamentAt / regionRecipes).
   E01: native export layer masks equal filamentAt per pixel per Z. E02: coordinated
   adjacent regions sharing a material at a Z form ONE connected occupancy (not cut
   by family labels). E03: resampling reports an ExportPlan change stat.
   Run: node tests/test-export-material.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/data-filaments.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
require('../app/js/layer-optimizer.js');
require('../app/js/zip.js');
require('../app/js/exporter.js');
const E = globalThis.CS.engine, X = globalThis.CS.exporter;

const palette = E.buildUserPalette([
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 },
  { name: 'Blue', hex: '#00358e', td: 4 }
]);
function img(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([255, 255, 255, 255], i * 4);
  for (let y = 15; y < 60; y++) for (let x = 10; x < 50; x++) data.set([180, 40, 40, 255], (y * w + x) * 4);
  for (let y = 15; y < 60; y++) for (let x = 55; x < 95; x++) data.set([170, 60, 30, 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}
const base = { engine: 'td', palette, widthMm: 40, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08, gradLayers: 5, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1, smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false, lineProtect: 'off', families: 24, backgroundMode: 'off' };
const plan = await E.buildPlan(img(100, 70), { ...base, equalHeight: true, layerCoordination: true, qualityPolicy: 'continuity' });
const plane = X.samplePlane(plan, plan.w, plan.h);
// E01: native masks == filamentAt
for (let z = 0; z < plan.commonTopLayer; z++) {
  const masks = X.buildLayerMasks(plan, plane, z);
  for (let i = 0; i < plan.n; i++) {
    const x = i % plan.w, y = (i / plan.w) | 0;
    const fa = E.filamentAt(plan, x, y, z);
    let cnt = 0, got = -1;
    for (let m = 0; m < palette.length; m++) if (masks[m][i]) { cnt++; got = m; }
    if (fa < 0) assert.equal(cnt, 0, `AIR at ${x},${y},${z}`);
    else { assert.equal(cnt, 1, `single material at ${x},${y},${z}`); assert.equal(got, fa, `mask==filamentAt at ${x},${y},${z}`); }
  }
}
console.log('E01 native export masks == filamentAt passed');
// E02: two adjacent regions overridden to the same material merge into one occupancy
const p2 = { w: 4, h: 1, n: 4, palette, printMask: new Uint8Array(4).fill(1), flatMask: new Uint8Array(4), flatFilament: new Uint16Array(4), familyId: Int16Array.from([0, 0, 1, 1]), gradStartLayer: 0, flatBaseLayers: 0, flatLayers: 1, foundationIndex: 1, families: [{ recipe: [0] }, { recipe: [2] }], regionOf: Int32Array.from([0, 0, 1, 1]), regionRecipes: { 0: [2], 1: [2] } };
const pl2 = { ew: 4, eh: 1, flatMask: p2.flatMask, flatFilament: p2.flatFilament, familyId: p2.familyId, printMask: p2.printMask, regionOf: p2.regionOf, regionRecipes: p2.regionRecipes };
const m2 = X.buildLayerMasks(p2, pl2, 0);
assert.equal(m2[2].reduce((a, b) => a + b, 0), 4, 'both adjacent regions use material 2 at z0');
assert.equal(m2[0].reduce((a, b) => a + b, 0), 0, 'family labels must not leak into export');
const loops = X.traceLoops(m2[2], 4, 1);
assert.equal(loops.length, 1, 'adjacent same-material occupancy is one connected loop, not cut by family');
console.log('E02 same-material merge passed');
// E03: downsampled ExportPlan reports change stats
const coarse = X.samplePlane(plan, 50, 35);
assert.ok(coarse.changeStats && typeof coarse.changeStats.changedPercent === 'number', 'ExportPlan change stat present');
console.log('E03 ExportPlan change stats passed', JSON.stringify(coarse.changeStats));
console.log('all P5 export-material checks passed');