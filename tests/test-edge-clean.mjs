import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/engine.js');
const { engine } = globalThis.CS;

const w = 200, h = 150;
const data = new Uint8ClampedArray(w * h * 4);
const set = (x, y, r, g, b) => {
  if (x < 0 || x >= w || y < 0 || y >= h) return;
  const p = (y * w + x) * 4;
  data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
};
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  // Smooth gradient background in the upper 60%.
  if (y < 90) set(x, y, Math.round(40 + 180 * x / w), Math.round(80 + 120 * y / h), Math.round(190 - 130 * x / w));
  else set(x, y, 245, 240, 232);
}
// Hard black block with a 1 px mid-grey anti-alias border.
for (let y = 95; y < 135; y++) for (let x = 45; x < 155; x++) {
  const border = x === 45 || x === 154 || y === 95 || y === 134;
  if (border) set(x, y, 128, 128, 128);
  else set(x, y, 8, 8, 10);
}
const image = { width: w, height: h, data };
const palette = [
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 },
  { name: 'Yellow', hex: '#fce300', td: 6 },
  { name: 'Blue', hex: '#00358e', td: 4 }
];
const base = {
  engine: 'td', palette, foundationIndex: 1, widthMm: 100, flatTopMm: 1.6, reliefMm: 0.16,
  gradLayers: 6, gradTopMmOverride: 1.76, families: 96, layerHeight: 0.08,
  stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.6, smoothLevel: 1, mergeDeltaE: 0,
  lineProtect: 'off', heightMergeDeltaE: 0
};

let failures = 0;
const check = (ok, msg) => {
  if (!ok) { failures++; console.error('FAIL', msg); }
  else console.log('ok  ', msg);
};

const off = engine.buildPlan(image, { ...base, edgeClean: 0 });
const on = engine.buildPlan(image, { ...base, edgeClean: 2 });
console.log('off', { dE: +off.stats.meanDE.toFixed(2), families: off.stats.familyCount });
console.log('on ', { dE: +on.stats.meanDE.toFixed(2), families: on.stats.familyCount, edge: +on.edgePixelPercent.toFixed(1), clean: on.edgeClean });
check(off.edgeClean === 0, 'edge cleanup can be switched off');
check(on.edgeClean === 2 && on.edgePixelPercent > 0, 'edge cleanup detects the anti-aliased border');
check(on.stats.familyCount <= off.stats.familyCount + Math.max(2, Math.round(off.stats.familyCount * 0.1)), 'edge cleanup does not add colour families (10% slack for sampling changes)');
check(on.stats.meanDE <= off.stats.meanDE + 2.5, 'edge cleanup does not destroy colour accuracy');
check(on.predicted && on.familyId.length === w * h, 'edge cleanup produces a valid plan');
check(off.stats.supportAddedPixels === 0 && on.stats.supportAddedPixels === 0, 'support audit finds no floating islands above layer 0');

const vector = engine.buildPlan(image, { ...base, edgeClean: 0, vectorFlat: true });
console.log('vec', { dE: +vector.stats.meanDE.toFixed(2), flat: +vector.stats.flatPercent.toFixed(1), families: vector.vectorFlatFamilies, pixels: vector.vectorFlatPixels });
check(vector.vectorFlatFamilies > 0 && vector.vectorFlatPixels > 0, 'vector direct-colour mode converts at least one family');
check(vector.stats.flatPercent >= off.stats.flatPercent, 'vector mode does not reduce direct-colour area');
check(vector.stats.meanDE <= off.stats.meanDE + 1.0, 'vector mode keeps colour error under control');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall edge-clean checks passed');