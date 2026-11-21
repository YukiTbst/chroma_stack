/* m49 LC2: luminance mode export / 3D / heightmap consistency. Export is native (the
   height field is the texture); export layer masks == filamentAt; 3D samplePlan and the
   web heightmap top == the per-pixel height field; export preview renders that grid.
   Run: node tests/test-m49-luminance-export.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setPointerCapture() {}, appendChild() {}, remove() {}, getBoundingClientRect: () => ({ width: 320, height: 240, left: 0, top: 0 }), textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false, title: '' });
globalThis.window = globalThis;
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById: () => el(), createElement: () => el(), querySelectorAll: () => [], body: el() };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
for (const m of ['height-curve', 'color', 'optics', 'earcut', 'data-filaments', 'engine', 'layer-optimizer', 'zip', 'exporter', 'view3d', 'modes', 'settings', 'app']) require('../app/js/' + m + '.js');
const E = globalThis.CS.engine, X = globalThis.CS.exporter, V = globalThis.CS.view3d, HC = globalThis.CS.heightCurve, dbg = globalThis.CS.appDebug;

const w = 40, h = 30, d = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) d.set([255, 255, 255, 255], i * 4);
for (let y = 5; y < 25; y++) d.set([0, 0, 0, 255], (y * w + 20) * 4);
const pal = E.buildUserPalette([{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }]);
const p = E.buildPlan({ width: w, height: h, data: d }, { engine: 'td', palette: pal, widthMm: 40, flatTopMm: 0.8, reliefMm: 0.8, layerHeight: 0.08, gradLayers: 4, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1, smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false, lineProtect: 'off', families: 16, backgroundMode: 'off', luminanceHeight: true, luminanceCurve: HC.invertCurve() });

// Native export (height field preserved).
const grid = X.exportGridFor(p);
assert.equal(grid.downscaled, false, 'luminance plan exports native');
assert.equal(grid.width, p.w);
const plane = X.samplePlane(p, grid.width, grid.height);
assert.ok(plane.luminanceHeight && plane.topLayer, 'export plane carries the height field');

// Export layer masks == filamentAt at every layer/pixel.
let diff = 0, occ = 0;
for (let z = 0; z < p.maxLayers; z++) {
  const masks = X.buildLayerMasks(p, plane, z);
  for (let i = 0; i < p.n; i++) {
    if (!p.printMask[i]) continue;
    const fa = E.filamentAt(p, i % p.w, (i / p.w) | 0, z);
    let got = -1, cnt = 0;
    for (let f = 0; f < pal.length; f++) if (masks[f][i]) { cnt++; got = f; }
    const ok = fa < 0 ? cnt === 0 : (cnt === 1 && got === fa);
    if (!ok) diff++;
    if (fa >= 0) occ++;
  }
}
assert.equal(diff, 0, `export masks must equal filamentAt (diff=${diff}/${occ})`);
assert.ok(occ > 0, 'occupied voxels exercised');

// 3D top + web heightmap top == height field.
for (let i = 0; i < p.n; i += 13) {
  if (!p.printMask[i]) continue;
  assert.equal(V._samplePlan(p, i % p.w, (i / p.w) | 0).top, p.topLayer[i], `3D top cell ${i} == height field`);
  assert.equal(dbg.actualTopLayer(p, i, p.flatMask), p.topLayer[i], `heightmap top cell ${i} == height field`);
}
const st = dbg.actualHeightStats(p, p.flatMask);
assert.equal(st.max, p.maxLayers, 'height stats max == tallest column');

// Export preview renders the native grid top material.
const pv = dbg.exportPreviewPlan(p);
assert.equal(pv.width, p.w, 'export preview is native grid');
const lineI = 15 * w + 20, bgI = 2 * w + 2;
const lineTop = E.filamentAt(p, 20, 15, p.topLayer[lineI] - 1);
const c = globalThis.CS.color.hexToRgb(pal[lineTop].hex);
assert.equal(pv.data[lineI * 4], c.r, 'preview line top colour matches export');
console.log(`LC2 passed: native export, masks==filamentAt (${occ} voxels, 0 diff), 3D/heightmap top == height field`);