/* P2 analysis pipeline program-validity: render a synthetic combo board from a
   KNOWN model (axis-aligned, clean), then analyzeComboPhoto must recover the
   per-channel HD approximately. Real-photo absolute accuracy additionally needs an
   independent reference + uniform exposure (not claimed here).
   Run: node tests/test-combo-photo.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/calibration-data.js');
require('../app/js/batch-calibration.js');
require('../app/js/matrix-calibration.js');
require('../app/js/zip.js');
require('../app/js/calibration-joint.js');
const C = globalThis.CS.color, O = globalThis.CS.optics, J = globalThis.CS.calibrationJoint;

const palette = [
  { id: 'm', name: 'Magenta', hex: '#ec008c' }, { id: 'c', name: 'Cyan', hex: '#0086d6' },
  { id: 'k', name: 'Black', hex: '#000000' }, { id: 'w', name: 'Jade White', hex: '#ffffff' },
  { id: 'y', name: 'Yellow', hex: '#fce300' }, { id: 'o', name: 'Orange', hex: '#ff6a13' }
];
const TRUE = {
  k: { hd: [0.04, 0.04, 0.04], op: [0.02, 0.02, 0.02] },
  w: { hd: [1.0, 0.8, 0.8], op: [1, 1, 1] },
  m: { hd: [0.5, 0.06, 0.2], op: [0.6, 0.02, 0.2] },
  c: { hd: [0.06, 0.4, 0.6], op: [0.02, 0.3, 0.5] },
  y: { hd: [0.7, 0.6, 0.06], op: [0.8, 0.7, 0.05] },
  o: { hd: [0.6, 0.2, 0.05], op: [0.8, 0.25, 0.02] }
};
const model = { materials: {} };
for (const id of Object.keys(TRUE)) model.materials[id] = { lin: { r: TRUE[id].op[0], g: TRUE[id].op[1], b: TRUE[id].op[2] }, hdR: TRUE[id].hd[0], hdG: TRUE[id].hd[1], hdB: TRUE[id].hd[2] };
const manifest = J.buildComboManifest(palette, { layerHeight: 0.08, firstLayer: 0.24 });
const S = 8, W = Math.round(manifest.boardW * S), H = Math.round(manifest.boardD * S);
const data = new Uint8ClampedArray(W * H * 4);
const baseLin = { W: [1, 1, 1], K: [0.02, 0.02, 0.02] };
const cellAt = (bx, by) => manifest.cells.find(c => bx >= c.cx - c.size / 2 && bx <= c.cx + c.size / 2 && by >= c.cy - c.size / 2 && by <= c.cy + c.size / 2);
const markerAt = (bx, by) => manifest.markers.find(m => bx >= m.x - 1 && bx <= m.x + 1 && by >= m.y - 1 && by <= m.y + 1);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const bx = x / S, by = y / S;
  let lin = null;
  const inW = by >= manifest.halves.W.y0 && by <= manifest.halves.W.y1;
  const inK = by >= manifest.halves.K.y0 && by <= manifest.halves.K.y1;
  const mk = markerAt(bx, by);
  if (mk) lin = mk.filament === 'K' ? [0.02, 0.02, 0.02] : [1, 1, 1];
  else if (inW || inK) {
    const base = inW ? 'W' : 'K';
    const cell = cellAt(bx, by);
    lin = cell ? O.predictStack(model, cell.stack, { linearRgb: { r: baseLin[base][0], g: baseLin[base][1], b: baseLin[base][2] } }, 0.08).linearRgb : { r: baseLin[base][0], g: baseLin[base][1], b: baseLin[base][2] };
    lin = [lin.r, lin.g, lin.b];
  } else lin = [0.9, 0.9, 0.9];
  const p = (y * W + x) * 4;
  const g = 0.9; // realistic exposure so no channel saturates at 255
  data[p] = C.linearToSrgb8(lin[0] * g); data[p + 1] = C.linearToSrgb8(lin[1] * g); data[p + 2] = C.linearToSrgb8(lin[2] * g); data[p + 3] = 255;
}
const res = J.analyzeComboPhoto({ width: W, height: H, data }, manifest, palette, { noiseScale: 0.02, tolerance: 6 });
console.log('synthetic splits', JSON.stringify(res.fit.splits), 'testDE', res.fit.testDE && res.fit.testDE.toFixed(2), 'publishable', res.fit.publishable);
for (const id of Object.keys(TRUE)) {
  const hd = res.fit.model.params[id].logHd.map(Math.exp);
  const rel = Math.max(...hd.map((h, i) => Math.abs(h - TRUE[id].hd[i]) / TRUE[id].hd[i]));
  console.log(id, 'hd', hd.map(x => x.toFixed(3)).join('/'), 'true', TRUE[id].hd.join('/'), 'maxRel', rel.toFixed(2));
  assert.ok(rel < 0.35, `${id} HD recovered within 35% (got ${rel.toFixed(2)})`);
}
assert.ok(res.fit.testDE < 4, `held-out ΔE ${res.fit.testDE} small on clean synthetic`);
console.log('all combo-photo pipeline checks passed');