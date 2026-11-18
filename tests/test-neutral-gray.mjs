/* Neutral-grey preference: scene greys should be planned with black/white
   stacks, not red/yellow/blue combinations that leave chromatic speckle around
   dark lines. Run: node tests/test-neutral-gray.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
globalThis.earcut = require('../app/js/earcut.js');
require('../app/js/engine.js');
const C = globalThis.CS.color, E = globalThis.CS.engine;

const w = 120, h = 80;
const data = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  let v;
  if (x < 70) {
    v = Math.round(240 - (x / 70) * 200); // smooth neutral gradient
  } else {
    v = 128; // mid grey field
    if (x % 12 < 3) v = 30;               // black vertical strokes
  }
  const p = (y * w + x) * 4;
  data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255;
}
const pal = (name, hex, td) => ({ name, hex, td, brand: 'Test', material: 'PLA', lab: C.hexToLab(hex) });
const palette = [
  pal('Black', '#2a2829', 0.5), pal('Jade White', '#ffffff', 8),
  pal('Red', '#ef342f', 1.5), pal('Yellow', '#fce300', 6), pal('Blue', '#003eba', 1.8)
];
const plan = E.buildPlan({ width: w, height: h, data }, {
  engine: 'td', palette, widthMm: 60, flatTopMm: 1.0, reliefMm: 0.16,
  layerHeight: 0.08, variableHeight: true, families: 24, stdThreshold: 0,
  residualThreshold: 100, minFlatPercent: 0.1, smoothMm: 0.0, lineWidthMm: 0.42,
  mergeDeltaE: 0, lineProtect: 'auto', heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false
});

const neutralIdx = new Set(palette.map((p, i) => [p, i]).filter(([p]) => Math.hypot(p.lab.a, p.lab.b) < 8).map(([, i]) => i));
let greyFamilies = 0, dirty = 0, worst = null;
for (const f of plan.families) {
  const chroma = Math.hypot(f.targetLab.a, f.targetLab.b);
  if (chroma >= 8 || !f.recipe || !f.recipe.length) continue;
  greyFamilies++;
  const chromaticLayers = f.recipe.filter(i => !neutralIdx.has(i)).length;
  const frac = chromaticLayers / f.recipe.length;
  if (frac > 0.2) {
    dirty++;
    if (!worst || frac > worst.frac) worst = { frac, hex: f.targetHex, a: f.targetLab.a, b: f.targetLab.b, recipe: f.recipe.join(',') };
  }
}
console.log(`grey families ${greyFamilies}, chromatic-heavy ${dirty}`, worst || '');
assert.ok(greyFamilies > 4, 'test image must produce grey grad families');
assert.equal(dirty, 0, 'near-neutral targets must not be planned with chromatic filament stacks');
console.log('all neutral-grey preference checks passed');