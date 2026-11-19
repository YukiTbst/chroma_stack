/* Line protection is not permission to redraw: gap repair may only join
   pixels from the same colour family, so a real skin band crossing a black
   line must keep its colour. Hue-compatible AA gaps still bridge.
   Run: node tests/test-line-gap-guard.mjs */
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
const base = {
  engine: 'td', palette, widthMm: 150, flatTopMm: 1.6, reliefMm: 0.16,
  variableHeight: true, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1,
  stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.02,
  smoothMm: 0, lineWidthMm: 0.42, smoothLevel: 0, mergeDeltaE: 0,
  heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false,
  lineProtect: 'strong', families: 48, backgroundMode: 'off'
};
function blank(w, h) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) a.set([255, 255, 255, 255], i * 4);
  return a;
}
function rect(a, w, x, y, ww, hh, rgb) {
  for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + ww; xx++) a.set([...rgb, 255], (yy * w + xx) * 4);
}

/* Review case: 3 px black line crossed by a 4 px skin band. */
const skin = blank(240, 240);
rect(skin, 240, 40, 20, 3, 200, [8, 8, 10]);
rect(skin, 240, 140, 20, 3, 200, [8, 8, 10]);
rect(skin, 240, 36, 105, 11, 4, [242, 214, 190]);
rect(skin, 240, 180, 105, 11, 4, [242, 214, 190]);
const skinPlan = E.buildPlan({ width: 240, height: 240, data: skin }, base);
const skinLab = C.rgb255ToLab({ r: 242, g: 214, b: 190 });
let dark = 0, sum = 0, n = 0;
for (let y = 105; y < 109; y++) for (let x = 40; x < 43; x++) {
  const px = skinPlan.predicted[y * 240 + x];
  sum += C.deltaE2000(skinLab, px.lab);
  if (px.lab.L < 45) dark++;
  n++;
}
console.log(`skin crossing: dark ${dark}/${n}, mean ΔE ${(sum / n).toFixed(2)}`);
assert.equal(dark, 0, 'protection must not repaint real skin pixels black');
assert.ok(sum / n < 6, 'skin band keeps its colour across the black line');

/* Positive control: a hue-compatible, non-ink AA gap still bridges. */
const blue = blank(240, 240);
const lineRgb = C.hexToRgb(palette[4].hex);
const gapLab = { L: 81, a: 5.6, b: -12.8 }; // pale blue, non-ink (L≥80, chroma<18)
const gapRgb = C.hexToRgb(C.labToHex(gapLab));
rect(blue, 240, 20, 100, 80, 3, [lineRgb.r, lineRgb.g, lineRgb.b]);
rect(blue, 240, 100, 100, 2, 3, [gapRgb.r, gapRgb.g, gapRgb.b]);
rect(blue, 240, 102, 100, 80, 3, [lineRgb.r, lineRgb.g, lineRgb.b]);
const bluePlan = E.buildPlan({ width: 240, height: 240, data: blue }, base);
const gapA = bluePlan.predicted[101 * 240 + 100];
const gapB = bluePlan.predicted[101 * 240 + 101];
console.log('pale-blue gap predicted', gapA.hex, gapB.hex,
  'filaments', bluePlan.flatFilament[101 * 240 + 100], bluePlan.flatFilament[101 * 240 + 101]);
assert.ok(C.deltaE2000(gapA.lab, C.hexToLab(palette[4].hex)) < 8 &&
  C.deltaE2000(gapB.lab, C.hexToLab(palette[4].hex)) < 8,
  'a same-hue AA gap still joins the stroke');

console.log('all line-gap guard checks passed');