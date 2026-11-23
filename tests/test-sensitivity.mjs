/* F10 model sensitivity: thinner / more translucent stacks react more to an
   HD perturbation. This is a simulated scenario, reported as diagnostics.
   Run: node tests/test-sensitivity.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
const E = globalThis.CS.engine;

const palette = E.buildUserPalette([
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 }
]);
const bg = palette[1].lin;
const overWhite = E.recipeSensitivity([2], palette, bg, 0.08, 0.1);
const overRed = E.recipeSensitivity([2], palette, palette[2].lin, 0.08, 0.1);
const whiteOnBlack = E.recipeSensitivity([1], palette, palette[0].lin, 0.08, 0.1);
const opaque = E.recipeSensitivity([0, 0, 0], palette, bg, 0.08, 0.1);
console.log('sensitivity red/white', overWhite.toFixed(2), 'red/red', overRed.toFixed(2), 'white/black', whiteOnBlack.toFixed(2), 'black stack', opaque.toFixed(2));
assert.ok(overWhite > overRed + 0.5, 'a translucent layer over a contrasting base is the sensitive case');
assert.ok(whiteOnBlack > opaque + 1, 'a thin light layer over dark is more sensitive than an opaque dark stack');
assert.ok(opaque < 1, 'an opaque black stack barely moves under ±10% HD');

const w = 120, h = 80;
const data = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const t = x / (w - 1);
  data.set([Math.round(255 - 60 * t), Math.round(255 - 220 * t), Math.round(255 - 220 * t), 255], (y * w + x) * 4);
}
const plan = await E.buildPlan({ width: w, height: h, data }, {
  engine: 'td', palette, widthMm: 60, flatTopMm: 1.6, reliefMm: 0.16,
  variableHeight: true, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1,
  stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.6,
  smoothMm: 0, lineWidthMm: 0.42, smoothLevel: 0, mergeDeltaE: 0,
  heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false,
  lineProtect: 'off', families: 24, backgroundMode: 'off'
});
const dg = plan.diagnostics.sensitivity;
console.log('plan sensitivity', dg, 'families', plan.families.filter(f => f.pixelCount > 0).map(f => f.sensitivity));
assert.equal(dg.frac, 0.1);
let worst = 0;
for (const f of plan.families) {
  if (!f.pixelCount || !f.recipe || !f.recipe.length) continue;
  const se = E.recipeSensitivity(f.recipe, plan.palette, plan.foundation.lin, plan.layerHeight, 0.1);
  assert.ok(Math.abs(se - f.sensitivity) < 0.02, 'family sensitivity matches the model');
  worst = Math.max(worst, se);
}
assert.ok(Math.abs(worst - dg.worstDE) < 0.02, 'diagnostics report the worst family');
if (dg.familiesOver5 > 0) {
  assert.ok(plan.warnings.some(x => x.includes('模型敏感度')), 'sensitive recipes are surfaced as a warning');
}
console.log('all sensitivity checks passed');