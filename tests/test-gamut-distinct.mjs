/* Gamut complexity accounting: every enumerated recipe must carry a valid
   distinct count and the scorer must actually consume it. Run:
   node tests/test-gamut-distinct.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/engine.js');
const C = globalThis.CS.color, E = globalThis.CS.engine;

const palette = E.buildUserPalette([
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 8 },
  { name: 'Red', hex: '#c00d1e', td: 4 },
  { name: 'Yellow', hex: '#fce300', td: 5 }
]);
const gamut = E.buildTdGamut(palette, palette[1], 0.08, 6, true);
assert.ok(gamut.length > 200, 'gamut enumeration produced candidates');
let missing = 0, badMerge = 0, maxDistinct = 0, multi = 0;
for (const g of gamut) {
  if (!Number.isInteger(g.distinct) || g.distinct < 1) { missing++; continue; }
  if (g.distinct !== new Set(g.seq).size) badMerge++;
  if (g.distinct > maxDistinct) maxDistinct = g.distinct;
  if (g.distinct > 1) multi++;
}
console.log(`gamut ${gamut.length} entries, max distinct ${maxDistinct}, multi-colour ${multi}, missing ${missing}`);
assert.equal(missing, 0, 'every gamut entry must expose an integer distinct count');
assert.equal(badMerge, 0, 'distinct must equal the number of distinct filaments in the recipe');
assert.ok(maxDistinct >= 3, 'enumeration must produce multi-filament recipes');
assert.ok(multi > 100, 'multi-filament recipes exist in quantity');

/* Scoring consumes the field: same colour/runs, more distinct filaments must
   cost more. A missing field would silently score both identically. */
const target = C.hexToLab('#808080');
const base = { lab: C.hexToLab('#7a7a7a'), runs: 2, chromaFrac: 0 };
const two = { ...base, distinct: 2 };
const four = { ...base, distinct: 4 };
const p2 = E.gamutPenalty(target, two);
const p4 = E.gamutPenalty(target, four);
console.log('penalty distinct=2', p2.toFixed(2), 'distinct=4', p4.toFixed(2));
assert.ok(p4 - p2 > 0.49, 'each extra distinct filament must add its 0.25 ΔE penalty');

/* Defaulting must not mask a missing field: an entry without distinct is
   treated as one filament, but real entries never rely on that fallback. */
assert.equal(E.gamutPenalty(target, { ...base }), E.gamutPenalty(target, { ...base, distinct: 1 }), 'fallback still equals one distinct material');
console.log('all gamut-distinct checks passed');