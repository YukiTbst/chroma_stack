/* Flat regions are finite stacks: layers 0..base-1 use the foundation
   filament, only the rest is the flat colour. Prediction must use that real
   thickness instead of returning the filament hex as an infinite solid.
   Run: node tests/test-flat-coverage.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
const C = globalThis.CS.color, E = globalThis.CS.engine;

const palette = E.buildUserPalette([
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 }
]);
const redLab = C.hexToLab('#c00d1e');
const base = {
  engine: 'td', palette, widthMm: 60, reliefMm: 0, layerHeight: 0.08,
  gradLayers: 6, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5,
  minFlatPercent: 0.6, smoothMm: 0, lineWidthMm: 0.42, smoothLevel: 0,
  mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false,
  lineProtect: 'off', families: 24, backgroundMode: 'off'
};
function chart(withWhite) {
  const w = 240, h = 240;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(withWhite ? [255, 255, 255, 255] : [192, 13, 30, 255], i * 4);
  if (withWhite) for (let y = 90; y < 150; y++) for (let x = 90; x < 150; x++) data.set([192, 13, 30, 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}
const expected = (layers) => C.rgb01ToLab((() => {
  const lin = E.compositeLinear({ r: 1, g: 1, b: 1 }, new Array(layers).fill(2), palette, 0.08);
  return { r: C.linearToSrgb(lin.r), g: C.linearToSrgb(lin.g), b: C.linearToSrgb(lin.b) };
})());

/* Thin flat top: one red layer above the white foundation. */
const thin = E.buildPlan(chart(true), { ...base, flatTopMm: 0.08 });
const i = 120 * 240 + 120;
assert.ok(thin.flatMask[i], 'red patch is flat');
assert.equal(thin.flatFilament[i], 2, 'flat top filament is Red');
assert.equal(thin.flatLayers - thin.flatBaseLayers, 1, 'one colour layer above the base');
const thinDE = C.deltaE2000(thin.predicted[i].lab, redLab);
console.log('thin flat top:', thin.predicted[i].hex, 'ΔE to Red', thinDE.toFixed(2), 'warnings', thin.warnings.length);
assert.ok(thinDE > 35, 'one translucent red layer over white must not be predicted as solid red');
assert.ok(C.deltaE2000(thin.predicted[i].lab, expected(1)) < 0.01, 'prediction equals the same finite stack composited once');
assert.ok(thin.warnings.some(w => w.includes('纯色区顶色只有')), 'thin flat coverage is reported to the user');

/* Normal flat top: six red layers above the base (gradLayers). */
const normal = E.buildPlan(chart(true), { ...base, flatTopMm: 1.6 });
const normalLayers = normal.flatLayers - normal.flatBaseLayers;
assert.equal(normalLayers, 6, 'normal flat top keeps six colour layers');
const normalDE = C.deltaE2000(normal.predicted[i].lab, redLab);
console.log('normal flat top:', normal.predicted[i].hex, 'ΔE to Red', normalDE.toFixed(2), 'layers', normalLayers);
assert.ok(normalDE > 3, 'six layers of a TD 5 filament still let some foundation through');
assert.ok(C.deltaE2000(normal.predicted[i].lab, expected(normalLayers)) < 0.01, 'prediction equals the same finite stack composited');
assert.equal(normal.flatTopMm, 1.6, 'flat top height is unchanged');

/* The all-flat branch must use the same finite model. */
const allFlat = E.buildPlan(chart(false), { ...base, flatTopMm: 1.6 });
const j = 120 * 240 + 120;
assert.ok(allFlat.flatMask[j] && allFlat.flatFilament[j] === 2, 'all-flat image is direct Red');
const allLayerCount = allFlat.flatLayers - allFlat.flatBaseLayers;
assert.ok(C.deltaE2000(allFlat.predicted[j].lab, expected(allLayerCount)) < 0.01, 'all-flat prediction matches the finite stack model');
assert.ok(C.deltaE2000(allFlat.predicted[j].lab, redLab) > 3, 'all-flat branch no longer claims infinite thickness');

console.log('all flat-coverage checks passed');