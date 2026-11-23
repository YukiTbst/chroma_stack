/* m50 PERF3: the parallel export path (per-prism mesh chunks -> shared assemble3MFParts)
   must produce byte-identical 3MF to the serial build3MFBytes. Simulates the mesh-worker
   (typed-array positions/indices) and verifies the merged assembly matches exactly.
   Run: node tests/test-m50-parallel-export.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.earcut = require('../app/js/earcut.js');
for (const m of ['height-curve', 'color', 'optics', 'data-filaments', 'engine', 'layer-optimizer', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const E = globalThis.CS.engine, X = globalThis.CS.exporter, Z = globalThis.CS.zip;

const pal = E.buildUserPalette([{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }, { id: 'y', name: 'Yellow', hex: '#fce300', td: 6 }, { id: 'u', name: 'Blue', hex: '#00358e', td: 4 }, { id: 'c', name: 'Cyan', hex: '#0086d6', td: 3.5 }]);
const w = 320, h = 240, d = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const t = x / (w - 1), s = y / (h - 1); d.set([Math.round(40 + 180 * t + 30 * Math.sin(s * 6)), Math.round(50 + 120 * s + 40 * t), Math.round(200 - 150 * t + 30 * s), 255], (y * w + x) * 4); }
const base = { engine: 'td', palette: pal, widthMm: 150, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08, gradLayers: 8, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1, smoothMm: 0.8, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 1, lineProtect: 'auto', families: 48, backgroundMode: 'off' };
const plan = await E.buildPlan({ width: w, height: h, data: d }, base);

// Serial reference.
const serial = X.build3MFBytes(plan);

// Parallel path: split prisms into contiguous chunks, mesh each (as the worker does,
// with transferable typed arrays), merge in order, assemble + zip.
const grid = X.exportGridFor(plan);
const ew = grid.width, eh = grid.height;
const plane = X.samplePlane(plan, ew, eh);
const pixelSize = plan.widthMm / ew;
const prisms = X.buildPrisms(plan, plane);
const tasks = [];
for (let f = 0; f < plan.palette.length; f++) for (const pr of prisms[f]) tasks.push({ f, mask: pr.mask, z0: pr.z0, z1: pr.z1 });
const n = Math.min(4, tasks.length), per = Math.ceil(tasks.length / n);
const chunks = []; for (let i = 0; i < tasks.length; i += per) chunks.push(tasks.slice(i, i + per));
const paletteLite = plan.palette.map(pp => ({ name: pp.name, hex: pp.hex }));
const rawObjects = [];
for (const chunk of chunks) {
  // emulate mesh-worker: meshPrism per task, typed arrays, plate offset baked
  for (const t of chunk) {
    const positions = [], indices = [];
    X.meshPrism(t.mask, ew, eh, pixelSize, t.z0 * plan.layerHeight, t.z1 * plan.layerHeight, positions, indices);
    if (!indices.length) continue;
    for (let i = 0; i < positions.length; i += 3) { positions[i] += 128; positions[i + 1] += 128; }
    rawObjects.push({ filament: t.f, name: `${paletteLite[t.f].name} · L${t.z0 + 1}-${t.z1}`, positions: Float64Array.from(positions), indices: Uint32Array.from(indices) });
  }
}
const out = X.assemble3MFParts(plan, rawObjects, grid, plane, ew, eh, pixelSize);
const parBytes = Z.createZip(out.files);

// R6: compare the 3MF file CONTENTS, not the ZIP container bytes — zip.js stamps
// each entry with the current time, so two real-time zips can differ by a second
// even when the geometry/XML are identical (the old byte compare flaked).
const fbytes = (f) => typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : Buffer.from(f.data);
const sFiles = serial.files.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
const pFiles = out.files.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
assert.equal(sFiles.length, pFiles.length, '3MF file count matches');
for (let i = 0; i < sFiles.length; i++) {
  assert.equal(sFiles[i].name, pFiles[i].name, '3MF file name ' + i);
  assert.equal(Buffer.compare(fbytes(sFiles[i]), fbytes(pFiles[i])), 0, '3MF file content identical: ' + sFiles[i].name);
}
assert.equal(out.objects.length, serial.objects.length, 'object count matches');
assert.equal(out.meta.triangles, serial.meta.triangles, 'triangle count matches');
console.log(`PERF3 passed: parallel export content-identical (${(parBytes.length / 1e6).toFixed(2)}MB, ${out.objects.length} objects, ${out.meta.triangles} triangles, ${chunks.length} chunks, ${sFiles.length} files)`);