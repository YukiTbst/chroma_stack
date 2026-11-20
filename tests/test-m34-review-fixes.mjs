/* m34 re-review fixes regression: F01 load order + worker list + lazy dependency;
   F02 saved calibrationV2 model enters production buildPlan; F04 equal-height
   envelope/support columns export solid to common top; F06 coordination reverts
   per-region, not all-or-nothing. Run: node tests/test-m34-review-fixes.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/data-filaments.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
require('../app/js/zip.js');
require('../app/js/exporter.js');
require('../app/js/layer-optimizer.js');
const C = globalThis.CS.color, E = globalThis.CS.engine, X = globalThis.CS.exporter, LO = globalThis.CS.layerOptimizer;

// F01: index.html must load calibration-data BEFORE calibration-joint.
const html = fs.readFileSync(path.join(root, 'app/index.html'), 'utf8');
const iData = html.indexOf('js/calibration-data.js'), iJoint = html.indexOf('js/calibration-joint.js');
assert.ok(iData >= 0 && iJoint >= 0 && iData < iJoint, 'calibration-data loads before calibration-joint');
const worker = fs.readFileSync(path.join(root, 'app/js/compute-worker.js'), 'utf8');
assert.ok(worker.includes('layer-optimizer.js'), 'worker loads layer-optimizer');
// F01 lazy dependency: joint loaded BEFORE calibration-data must still work once loaded.
{
  const savedCS = globalThis.CS;
  delete globalThis.CS;
  const r2 = createRequire(import.meta.url);
  for (const m of ['color', 'optics', 'batch-calibration', 'matrix-calibration', 'zip', 'calibration-joint']) { const p = r2.resolve('../app/js/' + m + '.js'); delete r2.cache[p]; r2(p); }
  const J = globalThis.CS.calibrationJoint;
  const r3 = createRequire(import.meta.url); const p = r3.resolve('../app/js/calibration-data.js'); delete r3.cache[p]; r3(p);
  const man = J.buildComboManifest([{ id: 'k', name: 'K', hex: '#000000' }, { id: 'w', name: 'W', hex: '#ffffff' }], { layerHeight: 0.08 });
  assert.ok(man.manifestHash, 'joint resolves calibrationData lazily after late load');
  globalThis.CS = savedCS;
}

const palette = E.buildUserPalette([
  { id: 'k', name: 'Black', hex: '#000000', td: 0.6 },
  { id: 'w', name: 'Jade White', hex: '#ffffff', td: 5 },
  { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }
]);
function img(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([255, 255, 255, 255], i * 4);
  for (let y = 10; y < 50; y++) for (let x = 10; x < 50; x++) d.set([192, 13, 30, 255], (y * w + x) * 4);
  return { width: w, height: h, data: d };
}
const base = { engine: 'td', palette, widthMm: 40, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08, gradLayers: 5, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1, smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false, lineProtect: 'off', families: 16, backgroundMode: 'off' };

// F02: opticalModel overrides palette TD/opaque in production buildPlan.
{
  const model = { params: { k: { logHd: [Math.log(0.05), Math.log(0.05), Math.log(0.05)], opaque: [0.02, 0.02, 0.02] }, w: { logHd: [Math.log(1), Math.log(1), Math.log(1)], opaque: [1, 1, 1] }, r: { logHd: [Math.log(0.4), Math.log(0.1), Math.log(0.1)], opaque: [0.7, 0.05, 0.05] } } };
  const plan = E.buildPlan(img(80, 60), { ...base, opticalModel: model });
  const pk = plan.palette.find(p => p.id === 'k');
  assert.ok(Math.abs(pk.hdR - 0.05) < 1e-6, 'model hdR applied to production palette');
  assert.ok(pk.fromModel, 'palette flagged fromModel');
}

// F04: equal-height + envelope support columns export solid to common top.
{
  const plan = E.buildPlan(img(80, 60), { ...base, equalHeight: true, backgroundMode: 'auto', backgroundColor: '#ffffff', backgroundTolerance: 8, backgroundEnvelope: true });
  const plane = X.samplePlane(plan, plan.w, plan.h);
  const top = plan.commonTopLayer;
  let supportChecked = 0;
  for (let i = 0; i < plan.n; i++) {
    if (!plan.printMask[i] || plan.flatMask[i] || plan.familyId[i] >= 0) continue;
    const x = i % plan.w, y = (i / plan.w) | 0;
    const masks = X.buildLayerMasks(plan, plane, top - 1);
    const fi = E.filamentAt(plan, x, y, top - 1);
    let got = -1, cnt = 0;
    for (let m = 0; m < plan.palette.length; m++) if (masks[m][i]) { cnt++; got = m; }
    assert.equal(cnt, 1, 'support column solid at top-1');
    assert.equal(got, fi, 'export mask == filamentAt for support column');
    supportChecked++;
    if (supportChecked > 5) break;
  }
  assert.ok(supportChecked > 0, 'envelope support columns exercised');
}

// F06: coordination keeps good moves when another region has no feasible candidate.
{
  const model = { materials: { a: { lin: { r: 0.7, g: 0.05, b: 0.05 }, hdR: 0.4, hdG: 0.1, hdB: 0.1 }, b: { lin: { r: 0.05, g: 0.3, b: 0.6 }, hdR: 0.1, hdG: 0.4, hdB: 0.6 } } };
  const labA = C.hexToLab('#b03030'), labB = C.hexToLab('#205090');
  const regions = [
    { id: 0, lab: labA, area: 10, locked: false, stack: ['a', 'a', 'a', 'a', 'a'], candidates: [['a', 'a', 'a', 'a', 'a'], ['b', 'a', 'a', 'a', 'a']], edges: [{ to: 1, sharedMm: 5 }] },
    { id: 1, lab: labB, area: 10, locked: false, stack: ['b', 'b', 'b', 'b', 'b'], candidates: [['b', 'b', 'b', 'b', 'b']], edges: [{ to: 0, sharedMm: 5 }] }
  ];
  const res = LO.coordinateLayers({ model, boundaryLinear: { r: 1, g: 1, b: 1 }, layerThicknessMm: 0.08, regions, lambdaB: 1, lambdaA: 0.2, colorBudget: 3 });
  assert.ok(Array.isArray(res.assignment) && res.assignment.length === 2);
  assert.deepEqual(res.assignment[1], ['b', 'b', 'b', 'b', 'b'], 'region without feasible alternative keeps baseline');
  assert.equal(typeof res.revertedRegions, 'number');
}
console.log('all m34 review-fix checks passed');