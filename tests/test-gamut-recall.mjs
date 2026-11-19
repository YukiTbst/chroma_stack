/* Candidate recall: small gamuts are matched exactly; large gamuts use a
   union of Lab-nearest and ΔE94-nearest pools. Compare against a brute-force
   oracle instead of trusting one distance ranking.
   Run: node tests/test-gamut-recall.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/engine.js');
const C = globalThis.CS.color, E = globalThis.CS.engine;

function makePalette(colors) {
  return E.buildUserPalette(colors.map(([name, hex, td]) => ({ name, hex, td })));
}
const small = makePalette([
  ['Black', '#000000', 0.6], ['Jade White', '#ffffff', 5],
  ['Red', '#c00d1e', 5], ['Yellow', '#fce300', 6], ['Blue', '#00358e', 4]
]);
const gamut = E.buildTdGamut(small, small[1], 0.08, 6, true);
console.log('small gamut entries', gamut.length);
assert.ok(gamut.length > 300 && gamut.length <= 6000, 'small gamut stays in the exact-scan range');

const oracle = (target, g) => {
  let best = null, bestScore = Infinity;
  for (const e of g) {
    const sc = E.gamutScore(target, e);
    if (sc < bestScore) { bestScore = sc; best = e; }
  }
  return { best, bestScore };
};
const scoreOfResult = (target, got) => E.gamutScore(target, {
  lab: got.lab, runs: got.runs, distinct: new Set(got.seq).size, chromaFrac: 0
});

let worstExact = 0;
for (let n = 0; n < 240; n++) {
  // Saturated targets: no neutral lock/bias can interfere with the comparison.
  const L = 18 + (n * 37) % 72;
  const a = 24 + (n * 53) % 64;
  const b = -65 + (n * 29) % 120;
  const target = { L, a, b };
  const { bestScore } = oracle(target, gamut);
  const got = E.matchGamut(target, gamut);
  assert.ok(got, 'matcher returns a candidate');
  const extra = scoreOfResult(target, got) - bestScore;
  if (extra > worstExact) worstExact = extra;
  assert.ok(extra <= 1e-9, `exact scan must pick the oracle optimum (extra ${extra.toFixed(4)}, target ${L}/${a}/${b})`);
}
console.log('exact-scan max extra ΔE', worstExact.toFixed(4));

/* Large gamut: reachable chromatic targets must stay close to the oracle. */
const bigPal = makePalette([
  ['Black', '#000000', 0.6], ['Jade White', '#ffffff', 5],
  ['Red', '#c00d1e', 5], ['Yellow', '#fce300', 6], ['Blue', '#00358e', 4], ['Green', '#00a35c', 4]
]);
const big = E.buildTdGamut(bigPal, bigPal[1], 0.08, 8, true);
console.log('large gamut entries', big.length);
assert.ok(big.length > 6000, 'large gamut exercises the pool path');
const reachable = big.filter(e => Math.hypot(e.lab.a, e.lab.b) > 20);
assert.ok(reachable.length > 1000, 'enough saturated gamut colours to sample');
let worstReach = 0;
for (let n = 0; n < 24; n++) {
  const src = reachable[(n * 977) % reachable.length].lab;
  const target = { L: src.L + ((n % 5) - 2) * 0.7, a: src.a + ((n % 7) - 3) * 0.7, b: src.b + ((n % 3) - 1) * 0.7 };
  const { bestScore } = oracle(target, big);
  const got = E.matchGamut(target, big);
  const extra = scoreOfResult(target, got) - bestScore;
  if (extra > worstReach) worstReach = extra;
  assert.ok(extra <= 0.6, `reachable target recall within 0.6 ΔE (extra ${extra.toFixed(3)})`);
}
console.log('reachable-target worst extra ΔE', worstReach.toFixed(3));

/* Strongly out-of-gamut saturated targets: report the gap, keep it bounded. */
let worstFar = 0;
for (let n = 0; n < 8; n++) {
  const target = { L: 20 + (n * 41) % 68, a: 40 + (n * 61) % 50, b: 20 + (n * 47) % 90 };
  const { bestScore } = oracle(target, big);
  const got = E.matchGamut(target, big);
  const extra = scoreOfResult(target, got) - bestScore;
  if (extra > worstFar) worstFar = extra;
}
console.log('out-of-gamut worst extra ΔE', worstFar.toFixed(3));
assert.ok(worstFar <= 2.5, 'out-of-gamut recall stays within 2.5 ΔE of the oracle');
console.log('all gamut-recall checks passed');