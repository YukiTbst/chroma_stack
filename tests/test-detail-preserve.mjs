/* Detail preservation: small but genuinely different colour patches must not
   be flipped to "flat" by the area-based hole filler before colour matching.
   Regression for the review case: 640 px / 150 mm, 32 px = 7.5 mm chips.
   Run: node tests/test-detail-preserve.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
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
const defaults = {
  engine: 'td', palette, widthMm: 150, flatTopMm: 1.6, reliefMm: 0.16,
  variableHeight: true, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1,
  stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.6,
  smoothMm: 0.8, lineWidthMm: 0.42, smoothLevel: 2, mergeDeltaE: 4,
  heightMergeDeltaE: 1.5, edgeClean: 1, vectorFlat: false, lineProtect: 'strong',
  families: 192, backgroundMode: 'off', backgroundTolerance: 8,
  backgroundEnvelope: true, backgroundEnvelopeMm: 1.5
};
const W = 640, H = 640;
const data = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) data.set([255, 255, 255, 255], i * 4);
function rect(x, y, w, h, rgb) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) data.set([...rgb, 255], (yy * W + xx) * 4);
}
const sizes = [8, 16, 24, 32, 38, 40, 48, 64];
const chips = [];
for (const [row, [name, rgb]] of [['gray', [140, 140, 142]], ['skin', [242, 214, 190]]].entries()) {
  sizes.forEach((size, j) => {
    const x = 20 + j * 78, y = 20 + row * 90;
    rect(x, y, size, size, rgb);
    chips.push({ name, rgb, size, x, y });
  });
}
function patchMetrics(plan) {
  return chips.map(chip => {
    const m = Math.max(1, Math.floor(chip.size / 4));
    const target = C.rgb255ToLab({ r: chip.rgb[0], g: chip.rgb[1], b: chip.rgb[2] });
    let sum = 0, n = 0, flat = 0;
    for (let y = chip.y + m; y < chip.y + chip.size - m; y++) {
      for (let x = chip.x + m; x < chip.x + chip.size - m; x++) {
        const i = y * plan.w + x;
        sum += C.deltaE2000(target, plan.predicted[i].lab);
        flat += plan.flatMask[i] ? 1 : 0;
        n++;
      }
    }
    return { name: chip.name, sizePx: chip.size, sizeMm: chip.size * 150 / W, innerPixels: n, flatInnerPixels: flat, meanDeltaE: sum / n };
  });
}
const plan = E.buildPlan({ width: W, height: H, data }, { ...defaults, lineProtect: 'off', smoothMm: 0, edgeClean: 0, minFlatPercent: 0.6 });
const chipsOut = patchMetrics(plan);
const pick = (name, size) => chipsOut.find(c => c.name === name && c.sizePx === size);
const gray = pick('gray', 32), skin = pick('skin', 32);
console.log('7.5mm gray chip', gray, '\n7.5mm skin chip', skin);
assert.ok(gray.meanDeltaE < 6, `7.5 mm grey chip must survive the default area threshold (mean ΔE ${gray.meanDeltaE.toFixed(2)})`);
assert.ok(skin.meanDeltaE < 6, `7.5 mm skin chip must survive the default area threshold (mean ΔE ${skin.meanDeltaE.toFixed(2)})`);
assert.ok(gray.flatInnerPixels < gray.innerPixels * 0.1, 'a genuinely different colour patch must not be converted to flat');
assert.ok(skin.flatInnerPixels < skin.innerPixels * 0.1, 'skin patch must not be converted to flat');

/* The gate must still absorb colour-noise pinholes inside a flat field. */
const nw = 120, nh = 120;
const noise = new Uint8ClampedArray(nw * nh * 4);
for (let i = 0; i < nw * nh; i++) noise.set([255, 255, 255, 255], i * 4);
for (let y = 57; y < 63; y++) for (let x = 57; x < 63; x++) {
  const v = ((x + y) % 2) ? 246 : 250; // tiny near-white texture, ΔE < residual threshold
  noise.set([v, v, v, 255], (y * nw + x) * 4);
}
const noisePlan = E.buildPlan({ width: nw, height: nh, data: noise }, {
  ...defaults, widthMm: 60, flatTopMm: 1.0, reliefMm: 0.16, layerHeight: 0.08,
  minFlatPercent: 0.6, lineProtect: 'off', smoothMm: 0, edgeClean: 0
});
let flatInside = 0;
for (let y = 57; y < 63; y++) for (let x = 57; x < 63; x++) flatInside += noisePlan.flatMask[y * nw + x] ? 1 : 0;
assert.ok(flatInside >= 30, 'near-white noise inside a flat field is still absorbed (flat pixels: ' + flatInside + '/36)');
console.log('all detail-preservation checks passed');