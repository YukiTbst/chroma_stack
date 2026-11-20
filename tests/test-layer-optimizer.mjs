/* P4: same-layer continuity coordination. G09: a pair-only beneficial move is found
   (two adjacent uniform regions share more layers at equal colour budget); with no
   feasible alternative the baseline is returned unchanged. G05: distant same-color
   islands are separate regions with no connecting edge (no false connectivity reward).
   Run: node tests/test-layer-optimizer.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/layer-optimizer.js');
const C = globalThis.CS.color, O = globalThis.CS.optics, LO = globalThis.CS.layerOptimizer;

const model = { materials: {
  K: { hex: '#000000', hdR: 0.04, hdG: 0.04, hdB: 0.04 },
  W: { hex: '#ffffff', hdR: 1.1, hdG: 0.75, hdB: 0.77 },
  R: { hex: '#c00d1e', hdR: 1.2, hdG: 0.10, hdB: 0.06 },
  Y: { hex: '#fce300', hdR: 0.6, hdG: 0.5, hdB: 0.05 }
} };
const boundary = { r: 1, g: 1, b: 1 };
const pred = stack => O.predictStack(model, stack.map(m => ({ materialId: m, layerCount: 1 })), { linearRgb: boundary }, 0.08).lab;
const A = ['K', 'K', 'R', 'R', 'K'];
const B0 = ['Y', 'Y', 'K', 'K', 'R'];
const B1 = ['K', 'K', 'R', 'K', 'R'];
const regions = [
  { id: 0, lab: pred(A), area: 10, locked: false, stack: A.slice(), candidates: [A.slice()], edges: [{ to: 1, sharedMm: 10 }] },
  { id: 1, lab: pred(B0), area: 10, locked: false, stack: B0.slice(), candidates: [B0.slice(), B1.slice()], edges: [{ to: 0, sharedMm: 10 }] }
];
const res = LO.coordinateLayers({ model, boundaryLinear: boundary, layerThicknessMm: 0.08, regions, lambdaB: 1, lambdaA: 0.2, colorBudget: 1.0 });
console.log('improved', res.improved, 'boundary', res.boundaryBefore.toFixed(2), '->', res.boundaryAfter.toFixed(2));
assert.equal(res.improved, true, 'pair coordination must reduce boundary');
assert.ok(res.boundaryAfter < res.boundaryBefore, 'boundary strictly reduced');
assert.deepEqual(res.assignment[1], B1, 'region B adopts the shared-layer stack');
assert.ok(C.deltaE2000(pred(res.assignment[1]), regions[1].lab) <= 1.0, 'colour budget respected');

// no feasible alternative -> baseline unchanged
const regions2 = regions.map(r => ({ ...r, candidates: [r.stack.slice()] }));
const res2 = LO.coordinateLayers({ model, boundaryLinear: boundary, layerThicknessMm: 0.08, regions: regions2, colorBudget: 1.0 });
assert.equal(res2.improved, false);
assert.deepEqual(res2.assignment, regions2.map(r => r.stack), 'no benefit -> keep original');

// G05: distant same-color islands -> separate regions, no edge between them
const w = 20, h = 10, n = w * h;
const plan = { n, w, h, printMask: new Uint8Array(n).fill(1), flatMask: new Uint8Array(n).fill(1), flatFilament: new Uint16Array(n).fill(1), familyId: new Int16Array(n).fill(-1) };
for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) plan.flatFilament[y * w + x] = 2;
for (let y = 2; y < 5; y++) for (let x = 14; x < 17; x++) plan.flatFilament[y * w + x] = 2;
const g = LO.buildRegionGraph(plan, 0.5, null);
const reds = g.regions.filter(r => plan.flatFilament[r.members[0]] === 2);
assert.equal(reds.length, 2, 'two distant red islands are two regions');
const linked = reds[0].edges.some(e => e.to === reds[1].id);
assert.equal(linked, false, 'distant islands must not share a boundary edge');
console.log('all P4 layer-optimizer checks passed');