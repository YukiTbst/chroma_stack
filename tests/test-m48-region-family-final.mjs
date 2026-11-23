/* m48 F04 (m47 review): the region map and family colour descriptions must show the
   FINAL coordinated colour, not the pre-coordination family prediction.
   buildRegionMapCanvas used families[f].predictedHex; planSummary.families only had
   the nominal predictedHex. Run: node tests/test-m48-region-family-final.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setPointerCapture() {}, appendChild() {}, remove() {}, getBoundingClientRect: () => ({ width: 320, height: 240, left: 0, top: 0 }), textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false, title: '' });
globalThis.window = globalThis;
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById: () => el(), createElement: () => el(), querySelectorAll: () => [], body: el() };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
for (const m of ['color', 'optics', 'earcut', 'data-filaments', 'engine', 'exporter', 'layer-optimizer', 'modes', 'settings', 'app']) require('../app/js/' + m + '.js');
const C = globalThis.CS.color, E = globalThis.CS.engine, X = globalThis.CS.exporter, dbg = globalThis.CS.appDebug;

const pal8 = E.buildUserPalette([{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }, { id: 'y', name: 'Yellow', hex: '#fce300', td: 6 }, { id: 'u', name: 'Blue', hex: '#00358e', td: 4 }, { id: 'c', name: 'Cyan', hex: '#0086d6', td: 3.5 }, { id: 'm', name: 'Magenta', hex: '#ec008c', td: 4.5 }, { id: 'o', name: 'Orange', hex: '#ff6a13', td: 5 }]);
const cols = [[200, 40, 40], [40, 160, 80], [40, 80, 200], [220, 180, 40], [200, 40, 160], [40, 180, 200], [240, 120, 40], [120, 40, 200], [80, 200, 120], [200, 80, 80], [60, 60, 180], [180, 180, 60], [200, 100, 140], [100, 200, 180], [160, 80, 200], [220, 140, 80]];
const w = 80, h = 60, d = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = Math.floor(x / (w - 1) * 4) + Math.floor(y / (h - 1) * 4) * 4; const c = cols[k % 16]; d.set([c[0], c[1], c[2], 255], (y * w + x) * 4); }
const base = { engine: 'td', palette: pal8, widthMm: 40, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08, gradLayers: 20, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1, smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false, lineProtect: 'off', families: 24, backgroundMode: 'off' };
const p = await E.buildPlan({ width: w, height: h, data: d }, { ...base, equalHeight: true, layerCoordination: true, qualityPolicy: 'continuity' });
assert.ok(p.coordination && p.coordination.changedRegions > 0, 'fixture coordinates regions');

// (1) Region map: a coordinated gradient cell shows the FINAL predicted colour.
{
  let checked = 0;
  for (let i = 0; i < p.n; i++) {
    if (!p.printMask[i] || p.flatMask[i]) continue;
    const f = p.familyId[i]; if (f < 0) continue;
    if (p.predicted[i].hex.toLowerCase() === p.families[f].predictedHex.toLowerCase()) continue; // not changed
    assert.equal(dbg.regionMapHex(p, i).toLowerCase(), p.predicted[i].hex.toLowerCase(), `region map cell ${i} must show final predicted colour, not pre-coordination family hex`);
    checked++;
  }
  assert.ok(checked > 0, 'coordinated gradient cells exercised');
}

// (2) planSummary.families carries the dominant FINAL predicted hex per family.
{
  const s = X.planSummary(p);
  const dom = {};
  for (let i = 0; i < p.n; i++) {
    if (!p.printMask[i]) continue; const f = p.familyId[i]; if (f < 0) continue;
    const hx = p.predicted[i].hex.toLowerCase();
    (dom[f] = dom[f] || {})[hx] = (dom[f][hx] || 0) + 1;
  }
  let checked = 0;
  for (const fam of s.families) {
    const counts = dom[fam.id]; if (!counts) continue;
    const want = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    assert.ok(typeof fam.finalPredictedHex === 'string', `family ${fam.id} exposes finalPredictedHex`);
    assert.equal(fam.finalPredictedHex.toLowerCase(), want, `family ${fam.id} finalPredictedHex is the dominant final colour`);
    checked++;
  }
  assert.ok(checked > 0, 'families exercised');
}
console.log('F04 passed: region map + plan-package family colours reflect final coordinated colours');