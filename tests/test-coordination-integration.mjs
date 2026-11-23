/* P3/P4 integration: geometryMode=flat + qualityPolicy=continuity runs the spatial
   coordination post-pass inside buildPlan; boundary never increases; locked pixels
   and relief default are untouched; filamentAt/predicted consume regionRecipes.
   Run: node tests/test-coordination-integration.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/data-filaments.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
require('../app/js/layer-optimizer.js');
const C = globalThis.CS.color, E = globalThis.CS.engine;

const palette = E.buildUserPalette([
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 },
  { name: 'Yellow', hex: '#fce300', td: 6 },
  { name: 'Blue', hex: '#00358e', td: 4 }
]);
function img(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([255, 255, 255, 255], i * 4);
  for (let y = 20; y < 90; y++) for (let x = 15; x < 70; x++) data.set([180, 40, 40, 255], (y * w + x) * 4);
  for (let y = 20; y < 90; y++) for (let x = 75; x < 130; x++) data.set([170, 60, 30, 255], (y * w + x) * 4);
  for (let x = 10; x < 140; x++) data.set([5, 5, 8, 255], (100 * w + x) * 4);
  return { width: w, height: h, data };
}
const base = {
  engine: 'td', palette, widthMm: 60, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08,
  gradLayers: 5, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1,
  smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0,
  vectorFlat: false, lineProtect: 'strong', families: 24, backgroundMode: 'off'
};
const image = img(150, 110);
const locked = new Uint8Array(image.width * image.height); locked[50 * image.width + 40] = 1;

const plain = await E.buildPlan(image, { ...base, equalHeight: true });
const coord = await E.buildPlan(image, { ...base, equalHeight: true, layerCoordination: true, qualityPolicy: 'continuity', manualMask: locked });
assert.ok(coord.coordination, 'coordination audit present');
assert.ok(coord.coordination.boundaryAfter <= coord.coordination.boundaryBefore + 1e-9, 'boundary must not increase');
assert.equal(plain.coordination, null, 'no coordination without the policy');
assert.equal(plain.regionRecipes, null);
// relief default untouched
const relief = await E.buildPlan(image, base);
assert.equal(relief.equalHeight, false);
assert.equal(relief.coordination, null);
// locked pixel keeps its material vs the non-coordinated equal-height plan
const li = 50 * image.width + 40, lx = 40, ly = 50;
const topZ = coord.commonTopLayer - 1;
assert.equal(E.filamentAt(coord, lx, ly, topZ), E.filamentAt(plain, lx, ly, topZ), 'locked pixel material unchanged');
// filamentAt agrees with regionRecipes where present
if (coord.regionRecipes) {
  let checked = 0;
  for (let i = 0; i < coord.n && checked < 50; i++) {
    const rr = coord.regionRecipes[coord.regionOf[i]];
    if (!rr) continue;
    const x = i % coord.w, y = (i / coord.w) | 0;
    assert.equal(E.filamentAt(coord, x, y, coord.gradStartLayer), rr[0], 'filamentAt reads regionRecipe');
    checked++;
  }
  // changed regions may be zero when no feasible beneficial move exists (valid);
  // the beneficial-move case is covered by test-layer-optimizer.mjs.
}
console.log('coordination', JSON.stringify(coord.coordination));
console.log('all P3/P4 integration checks passed');