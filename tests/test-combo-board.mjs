/* P2配套: the printable combination board embeds the SAME manifest used for
   generation/fitting; thickness identity survives the 3MF round-trip (C04).
   Run: node tests/test-combo-board.mjs */
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/calibration-data.js');
require('../app/js/batch-calibration.js');
require('../app/js/matrix-calibration.js');
require('../app/js/zip.js');
require('../app/js/calibration-joint.js');
const J = globalThis.CS.calibrationJoint;

const palette = [{ id: 'k', name: 'K', hex: '#000000' }, { id: 'w', name: 'W', hex: '#ffffff' }, { id: 'r', name: 'R', hex: '#c00d1e' }];
const manifest = J.buildComboManifest(palette, { layerHeight: 0.06 });
assert.equal(manifest.layerHeight, 0.06, 'board honours requested layer height, not default 0.08');
const { bytes } = J.buildComboBoard3MF(palette, manifest);
const buf = Buffer.from(bytes);
let meta = null;
for (let i = 0; i + 4 < buf.length; i++) {
  if (buf.readUInt32LE(i) !== 0x04034b50) continue;
  const nameLen = buf.readUInt16LE(i + 26), extraLen = buf.readUInt16LE(i + 28);
  const name = buf.slice(i + 30, i + 30 + nameLen).toString();
  if (name !== 'Metadata/chromastack-combo-calibration.json') continue;
  const method = buf.readUInt16LE(i + 8), compSize = buf.readUInt32LE(i + 18);
  const raw = buf.slice(i + 30 + nameLen + extraLen, i + 30 + nameLen + extraLen + compSize);
  meta = JSON.parse(method === 8 ? zlib.inflateRawSync(raw).toString() : raw.toString());
  break;
}
assert.ok(meta, 'manifest embedded in 3MF');
assert.equal(meta.manifest.manifestHash, manifest.manifestHash, 'embedded manifest hash matches generation');
assert.equal(meta.manifest.layerHeight, 0.06);
for (const c of meta.manifest.cells) {
  const expect = c.stack.reduce((s, x) => s + x.layerCount, 0) * 0.06;
  assert.ok(Math.abs(c.thicknessMm - expect) < 1e-9, 'cell thickness = layers * manifest layerHeight');
}
// geometry: a cell's top Z equals baseHeight + thickness (read vertices of its parts)
const model = (() => {
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const nameLen = buf.readUInt16LE(i + 26), extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString();
    if (name !== '3D/3dmodel.model') continue;
    const method = buf.readUInt16LE(i + 8), compSize = buf.readUInt32LE(i + 18);
    const raw = buf.slice(i + 30 + nameLen + extraLen, i + 30 + nameLen + extraLen + compSize);
    return method === 8 ? zlib.inflateRawSync(raw).toString() : raw.toString();
  }
})();
assert.ok(model.includes('ChromaStack_Combo_Calibration'), 'model present');
const c0 = manifest.cells[0];
const topZ = (manifest.baseHeight + c0.thicknessMm).toFixed(3);
assert.ok(model.includes(`z="${topZ}"`), `cell top vertex z=${topZ} present in geometry`);
// Dual-substrate contract: W cells on white half, K cells on black half.
assert.ok(manifest.halves && manifest.halves.W && manifest.halves.K, 'manifest defines two substrate halves');
for (const c of manifest.cells) {
  if (c.base === 'W') assert.ok(c.cy > manifest.halves.W.y0 && c.cy < manifest.halves.W.y1, 'W cell on white half');
  else assert.ok(c.cy > manifest.halves.K.y0 && c.cy < manifest.halves.K.y1, 'K cell on black half');
}
assert.ok(model.includes('foundation-white') && model.includes('foundation-black'), 'both substrate foundations present');
// Markers must be ON the board (inside a foundation half), not in the empty margin.
for (const m of manifest.markers) {
  const half = m.filament === 'K' ? manifest.halves.W : manifest.halves.K; // opposite-colour marker sits on the other half
  assert.ok(m.x >= 0 && m.x <= manifest.boardW, 'marker x on board');
  assert.ok(m.y >= half.y0 && m.y <= half.y1, `marker y=${m.y} inside its half ${half.y0}..${half.y1}`);
}
console.log('markers on-board verified:', JSON.stringify(manifest.markers));
// manifestHash must actually capture nested geometry (marker/cell moves change it).
const CD = globalThis.CS.calibrationData;
const h0 = CD.manifestHash(manifest);
const moved = JSON.parse(JSON.stringify(manifest)); moved.markers[0].y += 1;
assert.notEqual(CD.manifestHash(moved), h0, 'hash must change when a marker moves');
const movedCell = JSON.parse(JSON.stringify(manifest)); movedCell.cells[0].cx += 1;
assert.notEqual(CD.manifestHash(movedCell), h0, 'hash must change when a cell moves');
console.log('dual-substrate halves verified: W', manifest.halves.W, 'K', manifest.halves.K);
console.log('combo board manifest round-trip + thickness identity passed, cells', manifest.cells.length);