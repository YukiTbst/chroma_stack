/* Product presets and their engine wiring: sticker keeps equal height and
   line repair, photo keeps relief, pixel disables AA snapping and gap repair.
   Run: node tests/test-presets.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
require('../app/js/modes.js');
const C = globalThis.CS.color, E = globalThis.CS.engine, M = globalThis.CS.modes;

const sticker = M.preset('sticker'), photo = M.preset('photo'), pixel = M.preset('pixel');
assert.equal(M.preset('custom'), null);
assert.equal(sticker.variableHeight, false, 'sticker defaults to equal height');
assert.equal(sticker.lineProtect, 'strong');
assert.equal(sticker.lineRepair, true);
assert.equal(photo.variableHeight, true);
assert.equal(pixel.edgeSnap, false, 'pixel art disables AA snapping');
assert.equal(pixel.lineRepair, false, 'pixel art disables gap repair');
assert.equal(pixel.lineProtect, 'off');

const w = 240, h = 200;
const data = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) data.set([255, 255, 255, 255], i * 4);
const rect = (x, y, ww, hh, rgb) => {
  for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + ww; xx++) data.set([...rgb, 255], (yy * w + xx) * 4);
};
const palette = [
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 },
  { name: 'Blue', hex: '#00358e', td: 4 }
];
const base = {
  engine: 'td', palette, widthMm: 30, flatTopMm: 1.6, reliefMm: 0.16,
  variableHeight: true, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1,
  stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.6,
  smoothMm: 0, lineWidthMm: 0.42, smoothLevel: 0, mergeDeltaE: 0,
  heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false,
  lineProtect: 'strong', families: 12, backgroundMode: 'off'
};

/* Sticker preset: every gradient recipe has the same length. */
const grad = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const v = Math.round(40 + 160 * x / w);
  grad.set([v, Math.round(v * 0.7), Math.round(v * 0.5), 255], (y * w + x) * 4);
}
const stickerPlan = await E.buildPlan({ width: w, height: h, data: grad }, { ...base, ...sticker, edgeClean: 0, smoothMm: 0 });
const lens = stickerPlan.families.filter(f => f.pixelCount > 0).map(f => f.recipe.length);
console.log('sticker lengths', lens, 'maxGrad', stickerPlan.maxGradLayers);
assert.ok(lens.length > 0 && lens.every(l => l === stickerPlan.maxGradLayers), 'sticker mode plans equal-height recipes');

/* Pixel preset disables AA snapping and gap repair. */
const line = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) line.set([255, 255, 255, 255], i * 4);
rect(20, 100, 80, 3, [0, 0, 0]);
rect(100, 100, 2, 3, [200, 199, 225]);
rect(102, 100, 80, 3, [0, 0, 0]);
const repaired = await E.buildPlan({ width: w, height: h, data: line }, { ...base, lineRepair: true, edgeSnap: true });
const unrepaired = await E.buildPlan({ width: w, height: h, data: line }, { ...base, lineRepair: false, edgeSnap: false });
console.log('gap flat', repaired.flatMask[101 * w + 101], unrepaired.flatMask[101 * w + 101],
  'snap flags', repaired.edgeSnap, unrepaired.edgeSnap);
assert.equal(repaired.lineRepair, true);
assert.equal(unrepaired.lineRepair, false);
assert.equal(unrepaired.edgeSnap, false);
assert.equal(repaired.edgeSnap, true);

/* Static wiring: mode selector, backup button, script order. */
const html = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
assert.ok(html.includes('id="useMode"') && html.includes('id="btnRestoreBackup"'));
assert.ok(html.indexOf('js/modes.js') > 0 && html.indexOf('js/modes.js') < html.indexOf('js/app.js'), 'modes load before the app');

/* The TD engine branch must forward the new structural options. The physical
   LUT engine is retired, so there is only the TD branch to check. */
const appSrc = fs.readFileSync(new URL('../app/js/app.js', import.meta.url), 'utf8');
const tdStart = appSrc.indexOf("engine: 'td', palette: state.tdPalette");
assert.ok(tdStart > 0, 'locate the TD option branch');
const tdBlock = appSrc.slice(tdStart, appSrc.indexOf('function updateBackgroundUI'));
for (const key of ['manualMask', 'edgeSnap', 'lineRepair']) {
  const count = (text) => text.split(key + ':').length - 1;
  assert.equal(count(tdBlock), 1, key + ' is forwarded exactly once in the TD branch');
}
console.log('all preset checks passed');