/* Maximum gradient height is an upper bound, not a target. A plan whose
   recipes naturally end shorter must keep its real height; the largest
   family may not be lifted to touch the configured limit.
   Run: node tests/test-height-limit.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/data-filaments.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
const E = globalThis.CS.engine;

const palette = [
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 }
];
const w = 200, h = 100;
const data = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const v = Math.round(26 + x / w * 16); // near-black gradient; short stacks suffice
  data.set([v, v, v, 255], (y * w + x) * 4);
}
const plan = E.buildPlan({ width: w, height: h, data }, {
  engine: 'td', palette, widthMm: 60, flatTopMm: 1.6, reliefMm: 0.16,
  layerHeight: 0.08, gradLayers: 12, foundationIndex: 1,
  stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.6,
  smoothMm: 0, lineWidthMm: 0.42, smoothLevel: 0, mergeDeltaE: 0,
  heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false,
  lineProtect: 'off', families: 24, backgroundMode: 'off'
});
const fams = plan.families.filter(f => f.pixelCount > 0);
const maxLen = fams.reduce((m, f) => Math.max(m, f.recipe.length), 0);
console.log('maxGrad', plan.maxGradLayers, 'gradStart', plan.gradStartLayer,
  'actualTop', plan.actualGradTopLayer, 'recipe lengths', fams.map(f => f.recipe.length));
assert.equal(plan.maxGradLayers, 12, 'configured maximum stays available as a budget');
assert.ok(maxLen < plan.maxGradLayers, `no family may be lifted to the limit (max recipe ${maxLen})`);
assert.equal(plan.actualGradTopLayer, plan.gradStartLayer + maxLen, 'actual top follows the real recipes');
assert.equal(plan.gradTopLayer, plan.actualGradTopLayer, 'reported top is the actual top, not the budget');
for (const f of fams) {
  assert.ok(f.recipe.length > 0 && f.recipe.length <= plan.maxGradLayers, 'recipe lengths stay within the budget');
  assert.ok(f.topLayer === plan.gradStartLayer + f.recipe.length, 'family height follows its own recipe');
  assert.ok(f.topLayer <= plan.gradTopLayer, 'no family exceeds the actual top');
}
assert.equal(plan.actualGradTopMm, plan.actualGradTopLayer * plan.layerHeight, 'physical height is consistent');
console.log('all height-limit checks passed');