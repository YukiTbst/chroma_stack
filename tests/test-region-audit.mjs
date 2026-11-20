/* Spatial regions vs recipes, adjacency-limited shared bases, and the sampled
   per-layer print audit. Run: node tests/test-region-audit.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
const C = globalThis.CS.color, E = globalThis.CS.engine;

const palette = [
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 },
  { name: 'Yellow', hex: '#fce300', td: 6 },
  { name: 'Blue', hex: '#00358e', td: 4 }
];
const w = 100, h = 100;
const base = {
  engine: 'td', palette, widthMm: 30, flatTopMm: 1.6, reliefMm: 0.16,
  variableHeight: true, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1,
  stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.02,
  smoothMm: 0, lineWidthMm: 0.42, smoothLevel: 0, mergeDeltaE: 0,
  heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false,
  lineProtect: 'off', families: 8, backgroundMode: 'off'
};
function white() {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([255, 255, 255, 255], i * 4);
  return data;
}
function put(data, x, y, rgb) { data.set([...rgb, 255], (y * w + x) * 4); }

/* Two isolated gradient details: two spatial regions inside one colour family. */
const dots = white();
put(dots, 20, 20, [211, 58, 74]);
put(dots, 70, 70, [211, 58, 74]);
const dotPlan = E.buildPlan({ width: w, height: h, data: dots }, base);
let regions = new Set();
for (let i = 0; i < w * h; i++) if (dotPlan.regionId[i] >= 0) regions.add(dotPlan.regionId[i]);
console.log('regions', dotPlan.regionCount, 'set', regions.size, 'audit', dotPlan.diagnostics.printAudit);
assert.ok(dotPlan.regionId && dotPlan.regionCount >= 2, 'two separate details are two spatial regions');
assert.ok(dotPlan.diagnostics.printAudit.belowMinIslands > 0, 'one-pixel islands are reported by the layer audit');
assert.equal(dotPlan.regionId[50 * w + 50], -1, 'flat background has no gradient region id');

/* A solid patch produces no sub-minimum islands. */
const block = white();
for (let y = 30; y < 70; y++) for (let x = 30; x < 70; x++) put(block, x, y, [192, 13, 30]);
const blockPlan = E.buildPlan({ width: w, height: h, data: block }, { ...base, residualThreshold: 5 });
console.log('solid audit', blockPlan.diagnostics.printAudit);
assert.equal(blockPlan.diagnostics.printAudit.belowMinIslands, 0, 'a solid patch has no tiny per-layer islands');

/* Shared bases only between spatially adjacent families. */
const P = E.buildUserPalette(palette);
const gamut = E.buildTdGamut(P, P[1], 0.08, 6, true);
let pair = null;
for (let i = 0; i < gamut.length && !pair; i++) {
  const a = gamut[i];
  if (a.seq.length < 4) continue;
  for (let j = i + 1; j < gamut.length; j++) {
    const b = gamut[j];
    if (b.seq.length < 4 || b.seq[0] !== a.seq[0] || b.seq[1] !== a.seq[1]) continue;
    if (C.deltaE2000(a.lab, b.lab) > 3) continue;
    pair = { a, b };
    break;
  }
}
assert.ok(pair, 'gamut contains two near families sharing a prefix');
const mkFam = (g, px) => ({
  targetLab: g.lab, targetHex: C.labToHex(g.lab), predictedLab: g.lab, predictedHex: C.labToHex(g.lab),
  recipe: g.seq.slice(), deltaE: 0, pixelCount: px, layers: g.seq.length,
  topLayer: 6 + g.seq.length, topMm: 0, neutralLocked: false, neutral: false, sharedBaseLayers: 0
});
const adjacent = [mkFam(pair.a, 800), mkFam(pair.b, 300)];
const adj1 = [new Map([[1, 40]]), new Map([[0, 40]])];
const resAdj = E.mergeCommonBases(adjacent, gamut, 4, 6, adj1);
console.log('adjacent merge', resAdj, adjacent.map(f => f.sharedBaseLayers));
assert.ok(resAdj.groups >= 1 && adjacent.some(f => f.sharedBaseLayers >= 2), 'adjacent families share a base');

const distant = [mkFam(pair.a, 800), mkFam(pair.b, 300)];
const adj0 = [new Map(), new Map()];
const resFar = E.mergeCommonBases(distant, gamut, 4, 6, adj0);
console.log('distant merge', resFar, distant.map(f => f.sharedBaseLayers));
assert.equal(resFar.groups, 0, 'distant families do not share a base');
assert.ok(distant.every(f => f.sharedBaseLayers === 0));
console.log('all region/audit checks passed');