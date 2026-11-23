/* P3: equal-height (flat) geometry contract + free candidate layer-order diversity.
   G01: every retained pixel has a full material column to ONE common top and AIR
   above. G02: no AIR placeholder inside the column. S03: A-B-A repeat runs exist in
   the extended candidate set. Relief mode is untouched.
   Run: node tests/test-equal-height.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/data-filaments.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
const C = globalThis.CS.color, E = globalThis.CS.engine;

const palette = E.buildUserPalette([
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 },
  { name: 'Blue', hex: '#00358e', td: 4 }
]);
function mixed(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([255, 255, 255, 255], i * 4);
  for (let y = 20; y < 60; y++) for (let x = 20; x < 60; x++) data.set([192, 13, 30, 255], (y * w + x) * 4);
  for (let y = 20; y < 100; y++) for (let x = 80; x < 140; x++) data.set([80 + (x - 80), 60 + (y - 20), 180 - (x - 80), 255], (y * w + x) * 4);
  for (let x = 10; x < 150; x++) { data.set([5, 5, 8, 255], (105 * w + x) * 4); data.set([5, 5, 8, 255], (106 * w + x) * 4); }
  return { width: w, height: h, data };
}
const base = {
  engine: 'td', palette, widthMm: 60, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08,
  gradLayers: 6, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1,
  smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0,
  vectorFlat: false, lineProtect: 'strong', families: 24, backgroundMode: 'off'
};
const plan = await E.buildPlan(mixed(160, 120), { ...base, equalHeight: true });
assert.equal(plan.equalHeight, true);
const top = plan.commonTopLayer;
assert.ok(top > 0, 'common top defined');
assert.equal(plan.flatLayers, top, 'flat regions reach the common top');
assert.equal(plan.gradTopLayer, top, 'gradient top equals common top');
// G01/G02: full column below top, AIR at/above top, for EVERY retained pixel.
let checked = 0;
for (let i = 0; i < plan.n; i++) {
  if (!plan.printMask[i]) continue;
  const x = i % plan.w, y = (i / plan.w) | 0;
  for (let z = 0; z < top; z++) assert.ok(E.filamentAt(plan, x, y, z) >= 0, `no AIR inside column at ${x},${y},${z}`);
  assert.equal(E.filamentAt(plan, x, y, top), -1, `AIR at common top ${x},${y}`);
  checked++;
}
assert.ok(checked > 1000, 'mixed image exercises many pixels');
// gradient families all exactly N colour layers (no short recipe padded later)
for (const f of plan.families) if (f.pixelCount) assert.equal(f.recipe.length, plan.maxGradLayers, 'equal-height family uses full N layers');
console.log('equal-height G01/G02 passed, commonTop', top, 'pixels', checked);

// S03: extended candidate set contains a non-contiguous repeat run A-B-A.
const g = E.buildTdGamut(palette, palette[1], 0.08, 6, false, { allowRepeat: true, diverse: true });
const isABA = seq => { for (let a = 0; a < seq.length; a++) for (let b = a + 2; b < seq.length; b++) if (seq[a] === seq[b] && seq.slice(a, b + 1).some(v => v !== seq[a])) return true; return false; };
assert.ok(g.some(e => isABA(e.seq)), 'A-B-A repeat-run candidate present');
const gOld = E.buildTdGamut(palette, palette[1], 0.08, 6, false);
assert.ok(!gOld.some(e => isABA(e.seq)), 'legacy generator has no repeat runs (unchanged)');
assert.ok(g.length >= gOld.length, 'diverse mode does not shrink the candidate set');
console.log('S03/S04 candidate diversity passed, gamut', g.length, 'vs legacy', gOld.length);
console.log('all P3 equal-height / candidate checks passed');