/* m46 #99: the plan package (planSummary JSON + markdown) must reflect the FINAL
   coordinated material, not pre-coordination family recipes. It needs a region map
   summary, the per-region final recipes (matching regionRecipes / filamentAt), and a
   structure note that family recipes are the pre-coordination segmentation.
   Run: node tests/test-m46-plan-package.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const m of ['color', 'optics', 'data-filaments', 'earcut', 'engine', 'zip', 'exporter', 'layer-optimizer']) require('../app/js/' + m + '.js');
const E = globalThis.CS.engine, X = globalThis.CS.exporter;

const pal8 = E.buildUserPalette([
  { id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 },
  { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }, { id: 'y', name: 'Yellow', hex: '#fce300', td: 6 },
  { id: 'u', name: 'Blue', hex: '#00358e', td: 4 }, { id: 'c', name: 'Cyan', hex: '#0086d6', td: 3.5 },
  { id: 'm', name: 'Magenta', hex: '#ec008c', td: 4.5 }, { id: 'o', name: 'Orange', hex: '#ff6a13', td: 5 }
]);
const g = (w, h) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const t = x / (w - 1); d.set([Math.round(60 + 160 * t), Math.round(40 + 80 * t), Math.round(180 - 120 * t), 255], (y * w + x) * 4); } return { width: w, height: h, data: d }; };
const base = { engine: 'td', palette: pal8, widthMm: 40, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08, gradLayers: 20, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1, smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false, lineProtect: 'off', families: 24, backgroundMode: 'off' };
const plan = E.buildPlan(g(60, 40), { ...base, equalHeight: true, layerCoordination: true, qualityPolicy: 'continuity' });
assert.ok(plan.coordination && plan.coordination.changedRegions > 0, 'fixture actually coordinates regions');
assert.ok(plan.regionRecipes && plan.regionOf, 'plan carries coordinated region recipes');

const s = X.planSummary(plan);
// Region map summary + final coordinated recipes must be present.
assert.ok(s.regionMap, 'planSummary exposes a region map summary');
assert.equal(s.regionMap.coordinatedRegions, Object.keys(plan.regionRecipes).length, 'coordinated region count matches regionRecipes');
assert.ok(s.coordination && Array.isArray(s.coordination.regions) && s.coordination.regions.length > 0, 'planSummary exposes final coordinated region recipes');
assert.equal(s.coordination.changedRegions, plan.coordination.changedRegions);

// Each listed region recipe must equal the authoritative regionRecipes (== filamentAt).
const regionPixels = {};
for (let i = 0; i < plan.n; i++) { const r = plan.regionOf[i]; if (r >= 0) regionPixels[r] = (regionPixels[r] || 0) + 1; }
let differsFromFamily = 0;
for (const reg of s.coordination.regions) {
  const rr = plan.regionRecipes[reg.regionId];
  assert.ok(rr, `region ${reg.regionId} has a final recipe`);
  assert.deepEqual(reg.recipeBottomToTop, rr.map(x => plan.palette[x].name), `region ${reg.regionId} recipe matches regionRecipes`);
  assert.equal(reg.pixels, regionPixels[reg.regionId], `region ${reg.regionId} pixel count matches region map`);
  // verify against filamentAt for a member pixel
  let member = -1; for (let i = 0; i < plan.n; i++) if (plan.regionOf[i] === reg.regionId) { member = i; break; }
  const seq = []; for (let z = plan.gradStartLayer; z < plan.gradStartLayer + rr.length; z++) seq.push(E.filamentAt(plan, member % plan.w, (member / plan.w) | 0, z));
  assert.deepEqual(seq, rr, `region ${reg.regionId} recipe equals filamentAt`);
  const fam = plan.familyId[member];
  if (fam >= 0 && plan.families[fam].recipe.join(',') !== rr.join(',')) differsFromFamily++;
}
assert.ok(differsFromFamily > 0, 'at least one final region recipe differs from the pre-coordination family recipe');

// Family entries must be flagged as pre-coordination segmentation when superseded.
assert.ok(s.families.every(f => typeof f.coordinated === 'boolean'), 'family entries flag coordination status');

// Markdown structure must describe coordination and list final recipes.
const md = X.buildPlanMarkdown(plan);
assert.ok(/协调/.test(md), 'markdown mentions same-layer coordination');
assert.ok(/最终配方|协调后/.test(md), 'markdown distinguishes final coordinated recipes');
console.log(`plan package coordination passed: ${s.coordination.regions.length} final regions, ${differsFromFamily} differ from family recipes`);