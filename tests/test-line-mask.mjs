/* Manual brush edits are sparse locks: only painted pixels override the
   automatic plan; strong line protection keeps working everywhere else.
   Line radii must follow print width, not fixed pixel counts.
   Run: node tests/test-line-mask.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
const E = globalThis.CS.engine;

const w = 200, h = 200;
const data = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) data.set([255, 255, 255, 255], i * 4);
for (let y = 20; y < 180; y++) for (let x = 100; x < 103; x++) data.set([8, 8, 10, 255], (y * w + x) * 4);
const img = { width: w, height: h, data };
const palette = [
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 }
];
const base = {
  engine: 'td', palette, widthMm: 30, flatTopMm: 1.6, reliefMm: 0.16,
  variableHeight: true, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1,
  stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.6,
  smoothMm: 0, lineWidthMm: 0.42, smoothLevel: 0, mergeDeltaE: 0,
  heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false,
  lineProtect: 'strong', families: 8, backgroundMode: 'off'
};
const basePlan = E.buildPlan(img, base);
const i = 100 * w + 101;
assert.ok(basePlan.lineDirectMask && basePlan.lineDirectMask[i], 'strong mode direct-prints the line core');

/* A full mask snapshot alone must not switch line protection off. */
const maskSnapshot = new Uint8Array(basePlan.flatMask);
const withSnapshot = E.buildPlan(img, { ...base, maskOverride: maskSnapshot });
assert.ok(withSnapshot.lineDirectMask && withSnapshot.lineDirectMask[i], 'mask snapshot no longer disables strong lines');

/* Painting one line pixel to gradient only unlocks that pixel. */
const painted = new Uint8Array(basePlan.flatMask);
painted[i] = 0;
const manual = new Uint8Array(w * h);
manual[i] = 1;
const withManual = E.buildPlan(img, { ...base, maskOverride: painted, manualMask: manual });
assert.equal(withManual.flatMask[i], 0, 'painted pixel is forced gradient');
assert.ok(!withManual.lineProtectMask[i], 'painted pixel leaves the protected line core');
assert.ok(!withManual.lineDirectMask || !withManual.lineDirectMask[i], 'painted pixel is not direct-printed');
assert.equal(withManual.diagnostics.manualPixels, 1);
const other = 100 * w + 100;
assert.ok(withManual.lineDirectMask && withManual.lineDirectMask[other], 'untouched line pixels stay protected');

/* Detection radii scale with physical line width. */
const { lab, alpha } = E.imageToLab(img);
const at15 = E.buildStrokeInfo(lab, alpha, w, h, { pixelSize: 0.15, lineWidthMm: 0.42 });
const at3 = E.buildStrokeInfo(lab, alpha, w, h, { pixelSize: 0.3, lineWidthMm: 0.42 });
console.log('radii', at15.radii, at3.radii);
assert.equal(at15.radii.strokeR, Math.round(1.7 * (0.42 / 0.15)), 'stroke radius follows mm/pixel');
assert.ok(at15.radii.strokeR > at3.radii.strokeR, 'finer pixels protect a physically wider band');
assert.ok(at15.radii.repairR >= 2 && at3.radii.repairR >= 1);
console.log('all line-mask checks passed');