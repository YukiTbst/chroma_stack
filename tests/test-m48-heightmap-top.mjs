/* m48 F02 (m47 review): the web heightmap (buildHeightCanvas) and height stats
   (actualHeightStats) go through actualTopLayer, which still used the OLD top rule
   (flat->flatLayers, family->recipe length, else gradStartLayer). It must follow the
   final material source like view3d.samplePlan: coordinated region recipe length, or
   the equal-height common top (incl. envelope support). Otherwise the equal-height
   envelope is drawn low. Run: node tests/test-m48-heightmap-top.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setPointerCapture() {}, appendChild() {}, remove() {}, getBoundingClientRect: () => ({ width: 320, height: 240, left: 0, top: 0 }), textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false, title: '' });
globalThis.window = globalThis;
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById: () => el(), createElement: () => el(), querySelectorAll: () => [], body: el() };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
for (const m of ['color', 'optics', 'earcut', 'data-filaments', 'engine', 'exporter', 'layer-optimizer', 'modes', 'settings', 'app']) require('../app/js/' + m + '.js');
const E = globalThis.CS.engine, dbg = globalThis.CS.appDebug;

const base = { engine: 'td', widthMm: 40, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08, gradLayers: 5, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1, smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false, lineProtect: 'off', families: 16, backgroundMode: 'off' };
const g2 = (w, h) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set([255, 255, 255, 255], i * 4); for (let y = 10; y < 40; y++) for (let x = 10; x < 40; x++) d.set([192, 13, 30, 255], (y * w + x) * 4); return { width: w, height: h, data: d }; };
const pal = E.buildUserPalette([{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }]);

// Equal-height + envelope: support columns must reach commonTopLayer in the heightmap.
{
  const p = await E.buildPlan(g2(60, 50), { ...base, palette: pal, equalHeight: true, backgroundMode: 'auto', backgroundColor: '#ffffff', backgroundTolerance: 8, backgroundEnvelope: true });
  let found = 0;
  for (let i = 0; i < p.n; i++) {
    if (!p.printMask[i] || p.flatMask[i] || p.familyId[i] >= 0) continue;
    assert.equal(dbg.actualTopLayer(p, i, p.flatMask), p.commonTopLayer, `envelope support cell ${i} heightmap top == commonTopLayer`);
    found++;
  }
  assert.ok(found > 0, 'envelope support cells exercised');
  const st = dbg.actualHeightStats(p, p.flatMask);
  assert.equal(st.max, p.commonTopLayer, 'height stats max reaches the equal-height common top');
}

// Coordinated regions: heightmap top follows the final region recipe length.
{
  const pal8 = E.buildUserPalette([{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }, { id: 'y', name: 'Yellow', hex: '#fce300', td: 6 }, { id: 'u', name: 'Blue', hex: '#00358e', td: 4 }, { id: 'c', name: 'Cyan', hex: '#0086d6', td: 3.5 }, { id: 'm', name: 'Magenta', hex: '#ec008c', td: 4.5 }, { id: 'o', name: 'Orange', hex: '#ff6a13', td: 5 }]);
  const gg = (w, h) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const t = x / (w - 1); d.set([Math.round(60 + 160 * t), Math.round(40 + 80 * t), Math.round(180 - 120 * t), 255], (y * w + x) * 4); } return { width: w, height: h, data: d }; };
  const p = await E.buildPlan(gg(60, 40), { ...base, palette: pal8, gradLayers: 20, equalHeight: true, layerCoordination: true, qualityPolicy: 'continuity', families: 24 });
  if (p.regionRecipes && p.coordination && p.coordination.changedRegions > 0) {
    let checked = 0;
    for (let i = 0; i < p.n; i++) {
      if (!p.printMask[i]) continue;
      const rr = p.regionRecipes[p.regionOf[i]];
      if (!rr) continue;
      assert.equal(dbg.actualTopLayer(p, i, p.flatMask), p.gradStartLayer + rr.length, `coordinated cell ${i} top follows region recipe length`);
      checked++;
    }
    assert.ok(checked > 0, 'coordinated cells exercised');
  }
}
console.log('F02 passed: heightmap/height-stats top follows final coordinated/equal-height geometry');