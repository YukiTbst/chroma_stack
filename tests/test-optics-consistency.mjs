/* P1 / S01: one colour predictor everywhere. The engine's legacy composite, the
   shared optics module, and the full-stack predictStack must agree numerically;
   splitting or merging equal-material layers must not change the result (thickness
   is additive). Run: node tests/test-optics-consistency.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/data-filaments.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
const C = globalThis.CS.color, O = globalThis.CS.optics, E = globalThis.CS.engine;

const palette = E.buildUserPalette([
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 },
  { name: 'Blue', hex: '#00358e', td: 4 }
]);
const bg = { r: 1, g: 1, b: 1 };
const lh = 0.08;
const seq = [0, 0, 2, 2, 3];
const near = (a, b) => Math.abs(a - b) < 1e-9;
const sameLin = (a, b) => near(a.r, b.r) && near(a.g, b.g) && near(a.b, b.b);

// engine legacy composite === shared optics composite
const eLin = E.compositeLinear(bg, seq, palette, lh);
const oLin = O.compositeLinear(bg, seq, palette, lh);
assert.ok(sameLin(eLin, oLin), 'engine and optics composite agree');

// full-stack predictStack (per-layer) === legacy seq composite
const model = { materials: {} };
palette.forEach((p, i) => { model.materials[String(i)] = p; });
const stack = seq.map(i => ({ materialId: String(i), layerCount: 1 }));
const ps = O.predictStack(model, stack, { linearRgb: bg }, lh);
assert.ok(sameLin(ps.linearRgb, oLin), 'predictStack per-layer equals seq composite');
assert.ok(ps.lab && Number.isFinite(ps.lab.L), 'predictStack returns Lab');

// merged runs [0x2,2x2,3x1] === per-layer
const merged = [{ materialId: '0', layerCount: 2 }, { materialId: '2', layerCount: 2 }, { materialId: '3', layerCount: 1 }];
const pm = O.predictStack(model, merged, { linearRgb: bg }, lh);
assert.ok(sameLin(pm.linearRgb, ps.linearRgb), 'merging equal-material layers is numerically identical');

// splitting a run into single layers is identical (thickness additive)
const split = [{ materialId: '0', layerCount: 1 }, { materialId: '0', layerCount: 1 }, { materialId: '2', layerCount: 1 }, { materialId: '2', layerCount: 1 }, { materialId: '3', layerCount: 1 }];
const psp = O.predictStack(model, split, { linearRgb: bg }, lh);
assert.ok(sameLin(psp.linearRgb, pm.linearRgb), 'splitting runs is numerically identical');

// explicit thickness segments equal layerCount*schedule
const thick = merged.map(s => ({ materialId: s.materialId, thicknessMm: s.layerCount * lh }));
const pt = O.predictStack(model, thick, { linearRgb: bg }, lh);
assert.ok(sameLin(pt.linearRgb, pm.linearRgb), 'thicknessMm segments equal layerCount*schedule');

// A-B vs B-A differ (layer order matters), same materials same count
const ab = O.predictStack(model, [{ materialId: '2', layerCount: 1 }, { materialId: '3', layerCount: 1 }], { linearRgb: bg }, lh);
const ba = O.predictStack(model, [{ materialId: '3', layerCount: 1 }, { materialId: '2', layerCount: 1 }], { linearRgb: bg }, lh);
assert.ok(!sameLin(ab.linearRgb, ba.linearRgb), 'A-B and B-A must predict differently');

// support-stack boundary vs measured boundary are distinct and not double counted
const sup = O.predictStack(model, [{ materialId: '2', layerCount: 1 }], { supportStack: [{ materialId: '1', layerCount: 4 }] }, lh);
const meas = O.predictStack(model, [{ materialId: '2', layerCount: 1 }], { linearRgb: O.compositeLinear({ r: 0, g: 0, b: 0 }, [1, 1, 1, 1], palette, lh) }, lh);
assert.ok(sameLin(sup.linearRgb, meas.linearRgb), 'modeled support stack equals measured substrate boundary');
console.log('all optics consistency (S01) checks passed');