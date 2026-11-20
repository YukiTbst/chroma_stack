/* Vector direct-colour conversion is judged per connected component: a small
   island sharing a colour family with a large area must not be flattened just
   because the family total qualifies. Run: node tests/test-vector-components.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
const E = globalThis.CS.engine;

const palette = [
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 },
  { name: 'Yellow', hex: '#fce300', td: 6 },
  { name: 'Blue', hex: '#00358e', td: 4 }
];
const w = 200, h = 200;
const data = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) data.set([255, 255, 255, 255], i * 4);
const rect = (x, y, ww, hh, rgb) => {
  for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + ww; xx++) data.set([...rgb, 255], (yy * w + xx) * 4);
};
rect(30, 30, 40, 40, [200, 40, 56]);   // large gradient patch (same colour)
rect(150, 150, 9, 9, [200, 40, 56]);   // small island, below the conversion area
const base = {
  engine: 'td', palette, widthMm: 20, flatTopMm: 1.6, reliefMm: 0.16,
  variableHeight: true, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1,
  stdThreshold: 0, residualThreshold: 2, minFlatPercent: 0.6,
  smoothMm: 0, lineWidthMm: 0.42, smoothLevel: 0, mergeDeltaE: 0,
  heightMergeDeltaE: 1.5, edgeClean: 0, lineProtect: 'off', families: 4, backgroundMode: 'off'
};
const off = E.buildPlan({ width: w, height: h, data }, { ...base, vectorFlat: false });
const bigIdx = 50 * w + 50, smallIdx = 154 * w + 154;
assert.equal(off.flatMask[bigIdx], 0, 'large patch starts as gradient');
assert.equal(off.flatMask[smallIdx], 0, 'small island starts as gradient');
assert.equal(off.familyId[bigIdx], off.familyId[smallIdx], 'both patches share one colour family');

const on = E.buildPlan({ width: w, height: h, data }, { ...base, vectorFlat: true });
console.log('vector', { families: on.vectorFlatFamilies, pixels: on.vectorFlatPixels, components: on.vectorInfo && on.vectorInfo.components });
assert.equal(on.flatMask[bigIdx], 1, 'large component is converted to direct colour');
assert.equal(on.flatFilament[bigIdx], 2, 'large component uses the Red filament');
assert.equal(on.flatMask[smallIdx], 0, 'small island is not flattened just because its family qualifies');
assert.ok(on.familyId[smallIdx] >= 0, 'small island keeps its gradient recipe');
assert.ok(on.vectorFlatPixels > 0);
console.log('all vector-component checks passed');