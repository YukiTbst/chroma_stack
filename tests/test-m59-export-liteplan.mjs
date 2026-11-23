/* R7 contract: litePlan (per-pixel arrays stripped for worker transfer) must assemble
   a byte-identical 3MF to the full plan — assemble3MFParts only reads metadata.
   Run: node tests/test-m59-export-liteplan.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.earcut = require('../app/js/earcut.js');
for (const m of ['height-curve', 'color', 'optics', 'data-filaments', 'engine', 'layer-optimizer', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const E = globalThis.CS.engine, X = globalThis.CS.exporter;

const pal = E.buildUserPalette([{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }, { id: 'u', name: 'Blue', hex: '#00358e', td: 4 }]);
const w = 200, h = 150, d = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const t = x / (w - 1), s = y / (h - 1); d.set([Math.round(40 + 180 * t), Math.round(50 + 120 * s), Math.round(200 - 150 * t), 255], (y * w + x) * 4); }
const base = { engine: 'td', palette: pal, widthMm: 120, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.2, smoothMm: 0.8, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 1, lineProtect: 'auto', families: 24, backgroundMode: 'off' };
const plan = await E.buildPlan({ width: w, height: h, data: d }, base);

const grid = X.exportGridFor(plan);
const ew = grid.width, eh = grid.height, pixelSize = plan.widthMm / ew;
const plane = X.samplePlane(plan, ew, eh);
const prisms = X.buildPrisms(plan, plane);
const used = [];
for (let f = 0; f < plan.palette.length; f++) if (prisms[f].length) used.push(f);
const rawObjects = X.meshPrismObjects(plan, prisms, ew, eh, pixelSize, used);

const full = X.assemble3MFParts(plan, rawObjects, grid, plane, ew, eh, pixelSize);
const lite = X.litePlan(plan);
assert.equal(lite.predicted, undefined, 'litePlan strips predicted');
assert.equal(lite.preview, undefined, 'litePlan strips preview');
assert.equal(lite.flatMask, undefined, 'litePlan strips flatMask');
assert.ok(lite.palette && lite.stats, 'litePlan keeps metadata');
const liteOut = X.assemble3MFParts(lite, rawObjects, grid, plane, ew, eh, pixelSize);

const fbytes = (f) => typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : Buffer.from(f.data);
assert.equal(full.files.length, liteOut.files.length, 'file count');
for (let i = 0; i < full.files.length; i++) {
  assert.equal(full.files[i].name, liteOut.files[i].name, 'file name ' + i);
  assert.equal(Buffer.compare(fbytes(full.files[i]), fbytes(liteOut.files[i])), 0, 'file content identical: ' + full.files[i].name);
}
assert.equal(full.meta.triangles, liteOut.meta.triangles, 'triangle count');
console.log('all export litePlan checks passed (' + full.files.length + ' files, ' + full.meta.triangles + ' triangles)');