import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/engine.js');
const { engine } = globalThis.CS;
const C = globalThis.CS.color;
const { mergeIneffectiveHeights } = engine;

function fam(hex, len, pixels, targetHex, recipeOffset = 0) {
  const predictedLab = C.hexToLab(hex);
  const targetLab = C.hexToLab(targetHex || hex);
  return {
    pixelCount: pixels,
    predictedHex: hex,
    predictedLab,
    targetLab,
    targetHex: targetHex || hex,
    recipe: new Array(len).fill(0).map((_, i) => (i + recipeOffset) % 5),
    layers: len,
    deltaE: C.deltaE2000(targetLab, predictedLab),
    sharedBaseLayers: 0,
    topLayer: len,
    topMm: len * 0.08
  };
}

let failures = 0;
const check = (ok, msg) => {
  if (!ok) { failures++; console.error('FAIL', msg); }
  else console.log('ok  ', msg);
};

// Two families have the same predicted colour; the tall one is a minority
// island. It should adopt the dominant short recipe, and both families should
// collapse into one family id.
{
  const tall = fam('#f8f9fa', 24, 1915, '#fffefe');
  const short = fam('#f8f9fa', 6, 13816, '#fbf9fb', 1);
  const families = [tall, short];
  const familyId = new Int16Array([0, 0, 1, 1, 1, -1]);
  const res = mergeIneffectiveHeights(families, familyId, 1.5, 4);
  check(res.changed === 1 && res.groups === 1, 'same-colour tall island is shortened and collapsed');
  check(tall.recipe.length === 6, 'tall family adopts the 6-layer recipe');
  check(Math.abs(short.pixelCount - 15731) < 1e-6, 'pixel counts are merged into the larger canonical family');
  check(tall.pixelCount === 0, 'the shortened duplicate family has no pixels');
  check(Array.from(familyId).slice(0, 5).every(id => id === 1), 'family ids are remapped to the canonical family');
  check(res.oldMax === 24 && res.newMax === 6, 'max height reports 24 → 6 layers');
}

// A large tall region should not be flattened to a tiny short island just
// because the predicted colours happen to be close.
{
  const tall = fam('#f8f9fa', 24, 10000, '#ffffff');
  const short = fam('#f8f9fa', 6, 500, '#fbf9fb', 1);
  const families = [tall, short];
  const familyId = new Int16Array([0, 1]);
  const res = mergeIneffectiveHeights(families, familyId, 1.5, 4);
  check(res.changed === 0 && res.groups === 0, 'dominant tall region keeps its height');
  check(tall.recipe.length === 24 && short.recipe.length === 6, 'recipes are unchanged');
}

// A real colour difference above the threshold must not be merged, even when
// it is a tiny area.
{
  const tall = fam('#f8f9fa', 24, 1000, '#ffffff');
  const short = fam('#e7e8ee', 5, 5000, '#e7e8ee', 1);
  const families = [tall, short];
  const familyId = new Int16Array([0, 1]);
  const res = mergeIneffectiveHeights(families, familyId, 1.0, 4);
  check(res.changed === 0 && res.groups === 0, 'colour difference above threshold is preserved');
}

// Small height gaps (e.g. 6 vs 5) are intentional texture, not a bug.
{
  const tall = fam('#f8f9fa', 6, 1000, '#ffffff');
  const short = fam('#f8f9fa', 5, 5000, '#fbf9fb', 1);
  const families = [tall, short];
  const familyId = new Int16Array([0, 1]);
  const res = mergeIneffectiveHeights(families, familyId, 1.5, 4);
  check(res.changed === 0, 'height gaps below four layers are preserved');
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall height-merge checks passed');
