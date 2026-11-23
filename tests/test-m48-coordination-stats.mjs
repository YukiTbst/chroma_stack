/* m48 F03 (m47 review): after same-layer coordination, ALL colour-error stats must
   reflect the final predicted colours. The recompute refreshed sumDE/maxDE and
   groupStats.gradient, but meanDE (const, pre-coordination), median/p90 (from the
   stale global hist), under2/5/10 and groupStats.line/flat were never recomputed.
   Run: node tests/test-m48-coordination-stats.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const m of ['color', 'optics', 'data-filaments', 'earcut', 'engine', 'layer-optimizer', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const C = globalThis.CS.color, E = globalThis.CS.engine;

const pal8 = E.buildUserPalette([{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }, { id: 'y', name: 'Yellow', hex: '#fce300', td: 6 }, { id: 'u', name: 'Blue', hex: '#00358e', td: 4 }, { id: 'c', name: 'Cyan', hex: '#0086d6', td: 3.5 }, { id: 'm', name: 'Magenta', hex: '#ec008c', td: 4.5 }, { id: 'o', name: 'Orange', hex: '#ff6a13', td: 5 }]);
const cols = [[200, 40, 40], [40, 160, 80], [40, 80, 200], [220, 180, 40], [200, 40, 160], [40, 180, 200], [240, 120, 40], [120, 40, 200], [80, 200, 120], [200, 80, 80], [60, 60, 180], [180, 180, 60], [200, 100, 140], [100, 200, 180], [160, 80, 200], [220, 140, 80]];
const w = 80, h = 60, d = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = Math.floor(x / (w - 1) * 4) + Math.floor(y / (h - 1) * 4) * 4; const c = cols[k % 16]; d.set([c[0], c[1], c[2], 255], (y * w + x) * 4); }
const img = { width: w, height: h, data: d };
const base = { engine: 'td', palette: pal8, widthMm: 40, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08, gradLayers: 20, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1, smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false, lineProtect: 'off', families: 24, backgroundMode: 'off' };
const p = await E.buildPlan(img, { ...base, equalHeight: true, layerCoordination: true, qualityPolicy: 'continuity' });
assert.ok(p.coordination && p.coordination.changedRegions > 0, 'fixture coordinates regions');

// Recompute the truth from the FINAL predicted colours.
const src = E.imageToLab(img).lab;
let sum = 0, cnt = 0, u2 = 0, u5 = 0, u10 = 0;
const hist = new Uint32Array(101);
const grp = { line: { s: 0, n: 0 }, flat: { s: 0, n: 0 }, gradient: { s: 0, n: 0 } };
for (let i = 0; i < p.n; i++) {
  if (!p.printMask[i]) continue;
  const de = C.deltaE2000({ L: src[i * 3], a: src[i * 3 + 1], b: src[i * 3 + 2] }, p.predicted[i].lab);
  sum += de; cnt++; hist[Math.min(100, Math.round(de))]++;
  if (de <= 2) u2++; if (de <= 5) u5++; if (de <= 10) u10++;
  const g = (p.lineDirectMask && p.lineDirectMask[i]) ? 'line' : p.flatMask[i] ? 'flat' : 'gradient';
  grp[g].s += de; grp[g].n++;
}
const trueMean = sum / cnt;
let cum = 0, trueMedian = 0, trueP90 = 0;
for (let b = 0; b <= 100; b++) { cum += hist[b]; if (!trueMedian && cum >= cnt * 0.5) trueMedian = b; if (!trueP90 && cum >= cnt * 0.9) { trueP90 = b; break; } }

assert.ok(Math.abs(p.stats.meanDE - trueMean) < 0.01, `meanDE must reflect coordinated predicted (${p.stats.meanDE} vs ${trueMean.toFixed(3)})`);
assert.equal(p.stats.median, trueMedian, `median must reflect coordinated hist (${p.stats.median} vs ${trueMedian})`);
assert.equal(p.stats.p90, trueP90, `p90 must reflect coordinated hist (${p.stats.p90} vs ${trueP90})`);
assert.ok(Math.abs(p.stats.under5 - u5 / cnt * 100) < 0.1, `under5 must reflect coordinated (${p.stats.under5} vs ${(u5 / cnt * 100).toFixed(2)})`);
assert.ok(Math.abs(p.stats.under2 - u2 / cnt * 100) < 0.1, 'under2 reflects coordinated');
assert.ok(Math.abs(p.stats.under10 - u10 / cnt * 100) < 0.1, 'under10 reflects coordinated');
for (const g of ['line', 'flat', 'gradient']) {
  if (!grp[g].n) continue;
  const want = +(grp[g].s / grp[g].n).toFixed(2);
  assert.ok(Math.abs(p.diagnostics.groups[g].meanDE - want) < 0.02, `group ${g} meanDE reflects coordinated (${p.diagnostics.groups[g].meanDE} vs ${want})`);
}
console.log(`F03 passed: meanDE/median/p90/under/group stats all reflect coordinated predicted (changed ${p.coordination.changedRegions})`);