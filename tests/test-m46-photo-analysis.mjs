/* m46 photo analysis: (A) orientation scoring must derive the expected colour class
   from the material HEX, not assume materialId IS the colour letter; (B) auto corner
   detection must pick the 4 pads forming the marker rectangle, not stray blobs;
   (C) normalizeWhite must find the white reference by hex/brightness, not id==='w'.
   Run: node tests/test-m46-photo-analysis.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const m of ['color', 'optics', 'calibration-data', 'batch-calibration', 'matrix-calibration', 'zip', 'calibration-joint']) require('../app/js/' + m + '.js');
const C = globalThis.CS.color, O = globalThis.CS.optics, J = globalThis.CS.calibrationJoint;

// Real-world-style material IDs (NOT single colour letters).
const palette = [
  { id: 'bambu-magenta', name: 'Magenta', hex: '#ec008c' }, { id: 'bambu-cyan', name: 'Cyan', hex: '#0086d6' },
  { id: 'bambu-black', name: 'Black', hex: '#000000' }, { id: 'bambu-white', name: 'Jade White', hex: '#ffffff' },
  { id: 'bambu-yellow', name: 'Yellow', hex: '#fce300' }, { id: 'bambu-orange', name: 'Orange', hex: '#ff6a13' }
];
const TRUE = {
  'bambu-black': { hd: [0.04, 0.04, 0.04], op: [0.02, 0.02, 0.02] }, 'bambu-white': { hd: [1.0, 0.8, 0.8], op: [1, 1, 1] },
  'bambu-magenta': { hd: [0.5, 0.06, 0.2], op: [0.6, 0.02, 0.2] }, 'bambu-cyan': { hd: [0.06, 0.4, 0.6], op: [0.02, 0.3, 0.5] },
  'bambu-yellow': { hd: [0.7, 0.6, 0.06], op: [0.8, 0.7, 0.05] }, 'bambu-orange': { hd: [0.6, 0.2, 0.05], op: [0.8, 0.25, 0.02] }
};
const model = { materials: {} };
for (const id of Object.keys(TRUE)) model.materials[id] = { lin: { r: TRUE[id].op[0], g: TRUE[id].op[1], b: TRUE[id].op[2] }, hdR: TRUE[id].hd[0], hdG: TRUE[id].hd[1], hdB: TRUE[id].hd[2] };
const manifest = J.buildComboManifest(palette, { layerHeight: 0.08, firstLayer: 0.24 });
const S = 8, W = Math.round(manifest.boardW * S), H = Math.round(manifest.boardD * S);
const baseLin = { W: [1, 1, 1], K: [0.02, 0.02, 0.02] };
function render(strays) {
  const data = new Uint8ClampedArray(W * H * 4);
  const cellAt = (bx, by) => manifest.cells.find(c => bx >= c.cx - c.size / 2 && bx <= c.cx + c.size / 2 && by >= c.cy - c.size / 2 && by <= c.cy + c.size / 2);
  const markerAt = (bx, by) => manifest.markers.find(m => bx >= m.x - 1 && bx <= m.x + 1 && by >= m.y - 1 && by <= m.y + 1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const bx = x / S, by = y / S; let lin;
    const inW = by >= manifest.halves.W.y0 && by <= manifest.halves.W.y1, inK = by >= manifest.halves.K.y0 && by <= manifest.halves.K.y1;
    const mk = markerAt(bx, by);
    if (mk) lin = mk.filament === 'K' ? [0.02, 0.02, 0.02] : [1, 1, 1];
    else if (inW || inK) { const base = inW ? 'W' : 'K'; const cell = cellAt(bx, by); const p = cell ? O.predictStack(model, cell.stack, { linearRgb: { r: baseLin[base][0], g: baseLin[base][1], b: baseLin[base][2] } }, 0.08).linearRgb : { r: baseLin[base][0], g: baseLin[base][1], b: baseLin[base][2] }; lin = [p.r, p.g, p.b]; }
    else lin = [0.15, 0.15, 0.15]; // neutral margin so stray pads stay isolated
    const g = 0.9, q = (y * W + x) * 4;
    data[q] = C.linearToSrgb8(lin[0] * g); data[q + 1] = C.linearToSrgb8(lin[1] * g); data[q + 2] = C.linearToSrgb8(lin[2] * g); data[q + 3] = 255;
  }
  const box = (bx, by, half, val) => { const cx = Math.round(bx * S), cy = Math.round(by * S), r = Math.round(half * S); for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) { if (x < 0 || y < 0 || x >= W || y >= H) continue; const q = (y * W + x) * 4; data[q] = val; data[q + 1] = val; data[q + 2] = val; } };
  if (strays) { box(0.6, manifest.markers[0].y, 1, 12); box(manifest.boardW - 0.6, manifest.markers[2].y, 1, 245); }
  return { width: W, height: H, data };
}

// (A) Orientation scoring works with non-letter material IDs (derived from hex).
{
  const res = J.analyzeComboPhoto(render(false), manifest, palette, { noiseScale: 0.02, tolerance: 6 });
  const matched = parseInt(res.anchorMatch.split('/')[0], 10), total = parseInt(res.anchorMatch.split('/')[1], 10);
  assert.ok(matched >= Math.ceil(total * 0.6), `thick-anchor hue agreement with real IDs must be high (got ${res.anchorMatch})`);
  assert.equal(res.orientation, 'identity', 'clean axis-aligned board detected as identity');
}

// (B) Stray blobs must not be mistaken for corner pads.
{
  const res = J.analyzeComboPhoto(render(true), manifest, palette, { noiseScale: 0.02, tolerance: 6 });
  const expTL = manifest.markers[0].x * S, expBR = manifest.markers[2].x * S;
  assert.ok(Math.abs(res.markers.TL.cx - expTL) < 5, `TL pad must be the real corner (got ${res.markers.TL.cx.toFixed(1)}, want ~${expTL})`);
  assert.ok(Math.abs(res.markers.BR.cx - expBR) < 5, `BR pad must be the real corner (got ${res.markers.BR.cx.toFixed(1)}, want ~${expBR})`);
}

// (C) normalizeWhite finds the white reference by hex (palette) and by brightness (no palette).
{
  const res = J.analyzeComboPhoto(render(false), manifest, palette, { noiseScale: 0.02, tolerance: 6 });
  const nw = J.normalizeWhite(res.observations, manifest, palette);
  assert.ok(nw.gain[0] < 0.99, `white reference gain derived from hex (got ${nw.gain[0].toFixed(3)}, exposure 0.9)`);
  const nw2 = J.normalizeWhite(res.observations, manifest);
  assert.ok(nw2.gain[0] < 0.99, `white reference found by brightness without palette (got ${nw2.gain[0].toFixed(3)})`);
}
console.log('m46 photo analysis passed: hex-derived colour class + robust corner pads + white reference');