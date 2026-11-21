/* m48 F-OUTLINE-02 remainder (m47 review): unprotected large images still downscale
   to 1280 on export, so thin lines can disappear / gaps merge. The user must get a
   FINAL export preview (the actual export grid, not the native preview) and a
   pre-export confirmation describing the downsample change.
   Run: node tests/test-m48-export-preview.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setPointerCapture() {}, appendChild() {}, remove() {}, getBoundingClientRect: () => ({ width: 320, height: 240, left: 0, top: 0 }), textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false, title: '' });
globalThis.window = globalThis;
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById: () => el(), createElement: () => el(), querySelectorAll: () => [], body: el() };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
for (const m of ['color', 'optics', 'earcut', 'data-filaments', 'engine', 'exporter', 'layer-optimizer', 'modes', 'settings', 'app']) require('../app/js/' + m + '.js');
const C = globalThis.CS.color, E = globalThis.CS.engine, X = globalThis.CS.exporter, dbg = globalThis.CS.appDebug;

const pal = E.buildUserPalette([{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }, { id: 'u', name: 'Blue', hex: '#00358e', td: 4 }]);
// Organic gradient plan wider than 1280, line protection OFF -> default downscale.
const w = 1600, h = 100, d = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const t = x / (w - 1); d.set([Math.round(40 + 180 * t), Math.round(60 + 80 * t), Math.round(200 - 140 * t), 255], (y * w + x) * 4); }
const base = { engine: 'td', palette: pal, widthMm: 160, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1, smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false, lineProtect: 'off', families: 16, backgroundMode: 'off' };
const p = E.buildPlan({ width: w, height: h, data: d }, base);
const grid = X.exportGridFor(p);
assert.ok(grid.downscaled, 'organic large plan downscales by default');

// (1) The export preview is rendered at the EXPORT grid, not the native grid.
const prev = dbg.exportPreviewPlan(p);
assert.equal(prev.width, grid.width, `export preview width must be the export grid (${grid.width}), not native ${p.w}`);
assert.equal(prev.height, grid.height, 'export preview height is the export grid');
assert.equal(prev.data.length, grid.width * grid.height * 4);

// (2) Preview colours match the export plane's top material (single source).
const plane = X.samplePlane(p, grid.width, grid.height);
let checked = 0, mismatch = 0;
for (let i = 0; i < grid.width * grid.height; i += 37) {
  if (plane.printMask && !plane.printMask[i]) continue;
  // top layer of this export cell
  let top;
  if (plane.regionRecipes && plane.regionOf) { const rr = plane.regionRecipes[plane.regionOf[i]]; if (rr) top = p.gradStartLayer + rr.length; }
  if (top == null) { if (p.equalHeight) top = p.commonTopLayer; else if (plane.flatMask[i]) top = p.flatLayers; else { const f = plane.familyId[i]; top = p.gradStartLayer + (f >= 0 ? p.families[f].recipe.length : 0); } }
  const masks = X.buildLayerMasks(p, plane, top - 1);
  let fi = -1; for (let f = 0; f < p.palette.length; f++) if (masks[f][i]) { fi = f; break; }
  if (fi < 0) continue;
  const want = C.hexToRgb(p.palette[fi].hex);
  if (prev.data[i * 4] !== want.r || prev.data[i * 4 + 1] !== want.g || prev.data[i * 4 + 2] !== want.b) mismatch++;
  checked++;
}
assert.ok(checked > 0, 'export preview cells checked');
assert.equal(mismatch, 0, `export preview must match export top material (${mismatch}/${checked} mismatch)`);

// (3) Pre-export confirmation describes the downsample; native export needs none.
const msg = dbg.exportConfirmMessage(p);
assert.ok(typeof msg === 'string' && msg.includes(String(grid.width)), 'downscaled export offers a confirmation naming the export grid');
assert.ok(/重新归类|变化|细线|确认/.test(msg), 'confirmation warns about downsample changes');
// A line-art plan exports native -> no downsample confirmation needed.
const art = E.buildPlan({ width: 40, height: 30, data: (() => { const a = new Uint8ClampedArray(40 * 30 * 4); for (let i = 0; i < 40 * 30; i++) a.set([255, 255, 255, 255], i * 4); for (let y = 5; y < 25; y++) a.set([0, 0, 0, 255], (y * 40 + 20) * 4); return a; })() }, { ...base, widthMm: 40, lineProtect: 'strong' });
assert.equal(dbg.exportConfirmMessage(art), null, 'native (line-art) export needs no downsample confirmation');
console.log('F-OUTLINE-02 remainder passed: export preview renders the export grid + pre-export confirmation');