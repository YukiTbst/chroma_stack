/* Neutral lock under the real UI defaults: once a near-neutral target is
   planned with an all K/W stack, refine / shared bases / height merging may
   not replace it with a chromatic recipe. Run: node tests/test-neutral-refine.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/data-filaments.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
const C = globalThis.CS.color, E = globalThis.CS.engine;

const names = ['Black', 'Jade White', 'Red', 'Yellow', 'Blue'];
const palette = names.map(name => {
  const p = globalThis.CS.FILAMENT_DB.filaments.find(f => f.brand === 'BambuLab Basic' && f.material === 'PLA' && f.name === name);
  assert.ok(p, 'library filament ' + name);
  return { id: p.id, name, hex: p.hex, td: p.td, brand: p.brand, material: p.material };
});
const w = 120, h = 80;
const data = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  let v;
  if (x < 70) v = Math.round(240 - (x / 70) * 200);
  else v = (x % 12 < 3) ? 30 : 128;
  data.set([v, v, v, 255], (y * w + x) * 4);
}
const defaults = {
  engine: 'td', palette, widthMm: 150, flatTopMm: 1.6, reliefMm: 0.16,
  variableHeight: true, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1,
  stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.6,
  smoothMm: 0.8, lineWidthMm: 0.42, smoothLevel: 2, mergeDeltaE: 4,
  heightMergeDeltaE: 1.5, edgeClean: 1, vectorFlat: false, lineProtect: 'strong',
  families: 192, backgroundMode: 'off', backgroundTolerance: 8,
  backgroundEnvelope: true, backgroundEnvelopeMm: 1.5
};
const plan = E.buildPlan({ width: w, height: h, data }, defaults);
const neutralIdx = new Set(palette.map((p, i) => [p, i])
  .filter(([p]) => Math.hypot(C.hexToLab(p.hex).a, C.hexToLab(p.hex).b) < 8)
  .map(([, i]) => i));
let families = 0, pixels = 0, dirtyFamilies = 0, dirtyPixels = 0, locked = 0;
const examples = [];
for (const f of plan.families) {
  if (!f.pixelCount || Math.hypot(f.targetLab.a, f.targetLab.b) >= 8) continue;
  families++; pixels += f.pixelCount;
  if (f.neutralLocked) locked++;
  const chromatic = f.recipe.filter(i => !neutralIdx.has(i)).length / f.recipe.length;
  if (chromatic > 0.2) {
    dirtyFamilies++; dirtyPixels += f.pixelCount;
    examples.push({ target: f.targetHex, recipe: f.recipe, pixels: f.pixelCount, locked: !!f.neutralLocked, deltaE: f.deltaE });
  }
}
console.log(`neutral families ${families}, pixels ${pixels}, chromatic-heavy ${dirtyFamilies} (${dirtyPixels}px), locked ${locked}`);
if (examples.length) console.log(examples.slice(0, 3));
assert.ok(families > 4, 'test image must produce several near-neutral gradient families');
assert.ok(locked > 0, 'the hard neutral pass must lock K/W recipes for this greyscale scene');

/* Every locked recipe must be all-neutral, not just mostly neutral. */
for (const f of plan.families) {
  if (!f.neutralLocked) continue;
  assert.ok(f.recipe.every(i => neutralIdx.has(i)), `locked family ${f.targetHex} kept a chromatic layer: ${f.recipe.join(',')}`);
}

/* A near-neutral family may stay chromatic only when no K/W stack is inside
   the documented +5 ΔE budget; otherwise this is exactly the refine leak. */
const P = E.buildUserPalette(palette);
const gamut = E.buildTdGamut(P, P[1], 0.08, 6, true);
for (const ex of examples) {
  if (ex.locked) assert.fail('a locked family drifted to a chromatic recipe');
  const target = C.hexToLab(ex.target);
  let bestNeutral = Infinity;
  for (const e of gamut) if (!e.chromaFrac) bestNeutral = Math.min(bestNeutral, C.deltaE2000(target, e.lab));
  assert.ok(bestNeutral > ex.deltaE + 5,
    `${ex.target}: chromatic recipe only valid if the neutral option misses the +5 budget (neutral ${bestNeutral.toFixed(2)}, chosen ${ex.deltaE.toFixed(2)})`);
}

/* The lock must survive the shared-base / height-merge passes as well. */
const noMerge = E.buildPlan({ width: w, height: h, data }, { ...defaults, mergeDeltaE: 0, heightMergeDeltaE: 0 });
for (const f of noMerge.families) {
  if (!f.neutralLocked || !f.pixelCount) continue;
  assert.ok(f.recipe.every(i => neutralIdx.has(i)), 'no-merge plan must keep locked recipes neutral');
}
console.log('all neutral-refine checks passed');