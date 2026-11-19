/* Gamut enumeration is canonical: AMS order must not change the reachable
   candidate set, and near-identical colour buckets keep structural variants.
   Run: node tests/test-enumeration-fairness.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/engine.js');
const C = globalThis.CS.color, E = globalThis.CS.engine;

const colors = [
  ['Black', '#000000', 0.6], ['Jade White', '#ffffff', 5], ['Red', '#c00d1e', 5],
  ['Yellow', '#fce300', 6], ['Blue', '#00358e', 4], ['Green', '#00a35c', 4]
];
const A = colors.map(([name, hex, td]) => ({ name, hex, td }));
const B = colors.slice().reverse().map(([name, hex, td]) => ({ name, hex, td }));
const PA = E.buildUserPalette(A), PB = E.buildUserPalette(B);
assert.ok(PA.every(p => p.key), 'palette entries carry a stable key');
const foundationA = PA.find(p => p.name === 'Jade White');
const foundationB = PB.find(p => p.name === 'Jade White');
const gA = E.buildTdGamut(PA, foundationA, 0.08, 6, true);
const gB = E.buildTdGamut(PB, foundationB, 0.08, 6, true);
const sig = (g, P) => g.seq.map(i => P[i].key).join('>');
const setA = new Set(gA.map(e => sig(e, PA)));
const setB = new Set(gB.map(e => sig(e, PB)));
console.log('gamut sizes', gA.length, gB.length, 'unique stacks', setA.size, setB.size);
assert.equal(gA.length, gB.length, 'palette order does not change the candidate count');
assert.equal(setA.size, setB.size, 'palette order does not change the physical stack set');
for (const s of setA) assert.ok(setB.has(s), 'every stack is present in both orders');

/* Structural diversity per near-identical colour bucket. */
const buckets = new Map();
for (const e of gA) {
  const key = Math.round(e.lab.L * 2) + '|' + Math.round(e.lab.a * 2) + '|' + Math.round(e.lab.b * 2) + '|' + e.length;
  const s = e.runs + '|' + e.distinct;
  if (!buckets.has(key)) buckets.set(key, new Set());
  buckets.get(key).add(s);
}
let multi = 0;
for (const s of buckets.values()) if (s.size > 1) multi++;
console.log('buckets', buckets.size, 'with structural variants', multi);
assert.ok(multi > 10, 'near-identical buckets keep more than one structural recipe');

/* Matched physical recipes are also order independent. */
const targets = [{ L: 55, a: 30, b: 12 }, { L: 35, a: -10, b: 28 }, { L: 75, a: 8, b: -20 }, { L: 60, a: 0, b: 0 }];
for (const t of targets) {
  const ma = E.matchGamut(t, gA);
  const mb = E.matchGamut(t, gB);
  assert.equal(sig(ma, PA), sig(mb, PB), `matched recipe stays physical under reorder (${t.L}/${t.a}/${t.b})`);
}
console.log('all enumeration-fairness checks passed');