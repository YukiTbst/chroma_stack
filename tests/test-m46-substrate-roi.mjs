/* m46 substrate ROI: the substrate sample region must be the foundation polygon
   minus every cell footprint — not a fixed square window that can land in a
   neighbouring cell or off the half under skew. analyzeComboPhoto exposes the
   board-space substratePoints it actually used; each must be inside the cell's
   substrate half and outside ALL cell footprints.
   Run: node tests/test-m46-substrate-roi.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const m of ['color', 'optics', 'calibration-data', 'batch-calibration', 'matrix-calibration', 'zip', 'calibration-joint']) require('../app/js/' + m + '.js');
const C = globalThis.CS.color, O = globalThis.CS.optics, J = globalThis.CS.calibrationJoint;

const palette = [{ id: 'k', name: 'Black', hex: '#000000' }, { id: 'w', name: 'White', hex: '#ffffff' }, { id: 'r', name: 'Red', hex: '#c00d1e' }, { id: 'u', name: 'Blue', hex: '#00358e' }];
const TRUE = { k: { hd: [0.04, 0.04, 0.04], op: [0.02, 0.02, 0.02] }, w: { hd: [1.0, 0.8, 0.8], op: [1, 1, 1] }, r: { hd: [0.5, 0.08, 0.06], op: [0.7, 0.05, 0.03] }, u: { hd: [0.08, 0.2, 0.5], op: [0.03, 0.1, 0.5] } };
const model = { materials: {} };
for (const id of Object.keys(TRUE)) model.materials[id] = { lin: { r: TRUE[id].op[0], g: TRUE[id].op[1], b: TRUE[id].op[2] }, hdR: TRUE[id].hd[0], hdG: TRUE[id].hd[1], hdB: TRUE[id].hd[2] };
const manifest = J.buildComboManifest(palette, { layerHeight: 0.08, firstLayer: 0.24 });
const S = 8, W = Math.round(manifest.boardW * S), H = Math.round(manifest.boardD * S);
const baseLin = { W: [1, 1, 1], K: [0.02, 0.02, 0.02] };
const data = new Uint8ClampedArray(W * H * 4);
const cellAt = (bx, by) => manifest.cells.find(c => bx >= c.cx - c.size / 2 && bx <= c.cx + c.size / 2 && by >= c.cy - c.size / 2 && by <= c.cy + c.size / 2);
const markerAt = (bx, by) => manifest.markers.find(m => bx >= m.x - 1 && bx <= m.x + 1 && by >= m.y - 1 && by <= m.y + 1);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const bx = x / S, by = y / S; let lin;
  const inW = by >= manifest.halves.W.y0 && by <= manifest.halves.W.y1, inK = by >= manifest.halves.K.y0 && by <= manifest.halves.K.y1;
  const mk = markerAt(bx, by);
  if (mk) lin = mk.filament === 'K' ? [0.02, 0.02, 0.02] : [1, 1, 1];
  else if (inW || inK) { const base = inW ? 'W' : 'K'; const cell = cellAt(bx, by); const p = cell ? O.predictStack(model, cell.stack, { linearRgb: { r: baseLin[base][0], g: baseLin[base][1], b: baseLin[base][2] } }, 0.08).linearRgb : { r: baseLin[base][0], g: baseLin[base][1], b: baseLin[base][2] }; lin = [p.r, p.g, p.b]; }
  else lin = [0.5, 0.5, 0.5];
  const g = 0.9, q = (y * W + x) * 4;
  data[q] = C.linearToSrgb8(lin[0] * g); data[q + 1] = C.linearToSrgb8(lin[1] * g); data[q + 2] = C.linearToSrgb8(lin[2] * g); data[q + 3] = 255;
}
const res = J.analyzeComboPhoto({ width: W, height: H, data }, manifest, palette, { noiseScale: 0.02, tolerance: 6 });
const inAnyCell = (bx, by) => manifest.cells.some(c => bx >= c.cx - c.size / 2 && bx <= c.cx + c.size / 2 && by >= c.cy - c.size / 2 && by <= c.cy + c.size / 2);
let checked = 0;
for (const o of res.observations) {
  const cell = manifest.cells.find(c => c.cellId === o.cellId);
  assert.ok(Array.isArray(o.substratePoints) && o.substratePoints.length >= 2, `${o.cellId} exposes >=2 substrate sample points`);
  const half = manifest.halves[cell.base];
  for (const [bx, by] of o.substratePoints) {
    assert.ok(!inAnyCell(bx, by), `${o.cellId} substrate point (${bx},${by}) must be outside every cell footprint`);
    assert.ok(by >= half.y0 && by <= half.y1 && bx >= 0 && bx <= manifest.boardW, `${o.cellId} substrate point must be on its ${cell.base} half`);
  }
  checked++;
}
assert.ok(checked > 0, 'observations checked');
console.log(`substrate polygon ROI passed: ${checked} cells, all substrate points off-cell and on-half`);