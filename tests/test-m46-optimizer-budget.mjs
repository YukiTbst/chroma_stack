/* m46 F07: (1) the absolute colour budget must not reject a candidate that is
   BETTER than an over-budget baseline (and reduces boundary cost); (2) revertedRegions
   must count genuine content rollbacks, not never-moved locked/over-budget regions
   (reference equality falsely flagged them because assign/baseline are separate slices).
   Run: node tests/test-m46-optimizer-budget.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const m of ['color', 'optics', 'layer-optimizer']) require('../app/js/' + m + '.js');
const C = globalThis.CS.color, LO = globalThis.CS.layerOptimizer;

const model = { materials: { a: { lin: { r: 0.7, g: 0.05, b: 0.05 }, hdR: 0.4, hdG: 0.1, hdB: 0.1 }, b: { lin: { r: 0.05, g: 0.3, b: 0.6 }, hdR: 0.1, hdG: 0.4, hdB: 0.6 } } };
const A0 = ['a', 'a', 'a', 'a', 'a'], A1 = ['b', 'a', 'a', 'a', 'a'], B0 = ['b', 'b', 'b', 'b', 'b'];
const bl = { r: 1, g: 1, b: 1 }, lh = 0.08;

// (1) Better-than-baseline candidate over the absolute budget must be accepted.
{
  const labA = C.hexToLab('#603060'), labB = C.hexToLab('#205090');
  const regions = [
    { id: 0, lab: labA, area: 10, locked: false, stack: A0.slice(), candidates: [A0.slice(), A1.slice()], edges: [{ to: 1, sharedMm: 5 }] },
    { id: 1, lab: labB, area: 10, locked: false, stack: B0.slice(), candidates: [B0.slice()], edges: [{ to: 0, sharedMm: 5 }] }
  ];
  const res = LO.coordinateLayers({ model, boundaryLinear: bl, layerThicknessMm: lh, regions, lambdaB: 1, lambdaA: 0.2, colorBudget: 2 });
  // precondition: both stacks are over the absolute budget, A1 is closer to target.
  const de = s => C.deltaE2000(globalThis.CS.optics.predictStack(model, s.map(m => ({ materialId: m, layerCount: 1 })), { linearRgb: bl }, lh).lab, labA);
  assert.ok(de(A0) > 2 && de(A1) > 2 && de(A1) < de(A0), 'fixture: over-budget baseline with a better candidate');
  assert.deepEqual(res.assignment[0], A1, 'better-than-baseline candidate accepted despite exceeding the absolute budget');
  assert.ok(res.boundaryAfter < res.boundaryBefore, 'boundary cost reduced');
  assert.equal(res.revertedRegions, 0, 'a successful move is not a revert');
  assert.equal(res.improved, true);
}

// (2) A locked region that never proposes a change must NOT be counted as reverted.
{
  const regions = [
    { id: 0, lab: C.hexToLab('#b03030'), area: 10, locked: true, stack: A0.slice(), candidates: [A0.slice(), A1.slice()], edges: [] }
  ];
  const res = LO.coordinateLayers({ model, boundaryLinear: bl, layerThicknessMm: lh, regions, lambdaB: 1, lambdaA: 0.2, colorBudget: 3 });
  assert.deepEqual(res.assignment[0], A0, 'locked region keeps baseline');
  assert.equal(res.revertedRegions, 0, 'never-moved locked region is not a revert');
  assert.equal(res.reverted, false, 'reverted flag false when nothing was rolled back');
  assert.equal(res.improved, false);
}

// An over-budget UNLOCKED region that never moves is likewise not a revert.
{
  const regions = [
    { id: 0, lab: C.hexToLab('#603060'), area: 10, locked: false, stack: A0.slice(), candidates: [A0.slice()], edges: [] }
  ];
  const res = LO.coordinateLayers({ model, boundaryLinear: bl, layerThicknessMm: lh, regions, lambdaB: 1, lambdaA: 0.2, colorBudget: 2 });
  assert.equal(res.revertedRegions, 0, 'over-budget baseline kept unchanged is not a revert');
  assert.equal(res.reverted, false);
}
console.log('F07 optimizer budget + revert count passed');