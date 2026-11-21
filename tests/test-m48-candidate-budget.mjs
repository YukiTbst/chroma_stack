/* m48 F05 (m47 review): production candidate generation must offer candidates up to
   max(budget, baseline error), not the absolute budget alone. Otherwise a candidate
   that is better than an over-budget baseline (and cuts boundary cost) never reaches
   the optimizer, even though F07 relaxed the optimizer's feasibility to accept it.
   Run: node tests/test-m48-candidate-budget.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const m of ['color', 'optics', 'data-filaments', 'earcut', 'engine', 'layer-optimizer', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const C = globalThis.CS.color, E = globalThis.CS.engine, O = globalThis.CS.optics;

const pal8 = E.buildUserPalette([{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }, { id: 'y', name: 'Yellow', hex: '#fce300', td: 6 }, { id: 'u', name: 'Blue', hex: '#00358e', td: 4 }, { id: 'c', name: 'Cyan', hex: '#0086d6', td: 3.5 }, { id: 'm', name: 'Magenta', hex: '#ec008c', td: 4.5 }, { id: 'o', name: 'Orange', hex: '#ff6a13', td: 5 }]);
const cols = [[200, 40, 40], [40, 160, 80], [40, 80, 200], [220, 180, 40], [200, 40, 160], [40, 180, 200], [240, 120, 40], [120, 40, 200], [80, 200, 120], [200, 80, 80], [60, 60, 180], [180, 180, 60], [200, 100, 140], [100, 200, 180], [160, 80, 200], [220, 140, 80]];
const w = 80, h = 60, d = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = Math.floor(x / (w - 1) * 4) + Math.floor(y / (h - 1) * 4) * 4; const c = cols[k % 16]; d.set([c[0], c[1], c[2], 255], (y * w + x) * 4); }
const img = { width: w, height: h, data: d };
const base = { engine: 'td', palette: pal8, widthMm: 40, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08, gradLayers: 20, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1, smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false, lineProtect: 'off', families: 24, backgroundMode: 'off' };
const p = E.buildPlan(img, { ...base, equalHeight: true, layerCoordination: true, qualityPolicy: 'continuity' });
assert.ok(p.regionRecipes && p.coordination.changedRegions > 0, 'fixture coordinates');
const budget = 2.0, N = 20;
const src = E.imageToLab(img).lab;
const regSum = {}, regCnt = {}, regFirst = {};
for (let i = 0; i < p.n; i++) { if (!p.printMask[i]) continue; const r = p.regionOf[i]; if (r < 0) continue; regSum[r] = regSum[r] || [0, 0, 0]; regSum[r][0] += src[i * 3]; regSum[r][1] += src[i * 3 + 1]; regSum[r][2] += src[i * 3 + 2]; regCnt[r] = (regCnt[r] || 0) + 1; if (regFirst[r] == null) regFirst[r] = i; }

let overBudgetBetter = 0;
for (const rk of Object.keys(p.regionRecipes)) {
  const r = +rk, rr = p.regionRecipes[r], m0 = regFirst[r];
  const mean = { L: regSum[r][0] / regCnt[r], a: regSum[r][1] / regCnt[r], b: regSum[r][2] / regCnt[r] };
  const cur = p.flatMask[m0] ? new Array(N).fill(p.flatFilament[m0]) : (p.familyId[m0] >= 0 ? p.families[p.familyId[m0]].recipe : new Array(N).fill(1));
  const bde = C.deltaE2000(mean, O.compositeLab(p.foundation.lin, cur, p.palette, p.layerHeight).lab);
  const fde = C.deltaE2000(mean, O.compositeLab(p.foundation.lin, rr, p.palette, p.layerHeight).lab);
  // A move that lands ABOVE the absolute budget but BELOW the baseline error is only
  // reachable when candidate generation offers up to max(budget, baseline error).
  if (fde > budget && fde < bde - 1e-6) overBudgetBetter++;
}
assert.ok(overBudgetBetter > 0, `coordination must use better-than-baseline candidates above the absolute budget (found ${overBudgetBetter}; absolute-budget filtering hid them)`);
console.log(`F05 passed: ${overBudgetBetter} regions improved via over-budget better-than-baseline candidates (changed ${p.coordination.changedRegions})`);