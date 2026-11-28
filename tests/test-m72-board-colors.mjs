/* 3MF filament assignment must use the format proven before the GPU refactor: object-level
   pid/pindex + model_settings per-part extruder + project_settings filament_colour. Per-triangle
   pid/pindex triggers Bambu's "standard 3MF color" dialog which re-maps by clustered color and
   overrides extruder assignment (all parts fell to filament 1) -> must NOT be written.
   Run: node tests/test-m72-board-colors.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.earcut = require('../app/js/earcut.js');
for (const m of ['color', 'optics', 'data-filaments', 'calibration-data', 'calibration', 'batch-calibration', 'calibration-joint', 'engine', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const CS = globalThis.CS;
const db = (CS.FILAMENT_DB && CS.FILAMENT_DB.filaments) || [];
const pick = n => db.find(f => f.brand === 'BambuLab Basic' && f.material === 'PLA' && f.name === n);
const palette = ['Black', 'Jade White', 'Red', 'Blue'].map(pick).filter(Boolean).map(f => ({ id: f.id, name: f.name, hex: f.hex, td: f.td }));

function readStoreZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = {}; let off = 0;
  while (off + 4 <= bytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const compSize = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true), extraLen = dv.getUint16(off + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(off + 30, off + 30 + nameLen));
    const start = off + 30 + nameLen + extraLen;
    assert.equal(method, 0, 'store method');
    out[name] = new TextDecoder().decode(bytes.subarray(start, start + compSize));
    off = start + compSize;
  }
  return out;
}
function assertFormat(files, label, slotCount) {
  const model = files['3D/3dmodel.model'];
  const tris = (model.match(/<triangle /g) || []).length;
  const triColor = (model.match(/<triangle [^>]*pindex=/g) || []).length;
  assert.ok(tris > 0, label + ' has triangles');
  assert.equal(triColor, 0, label + ' triangles must NOT carry pindex (color-dialog override)');
  const objP = (model.match(/<object id="\d+" type="model" pid="1" pindex="\d+"/g) || []).length;
  assert.ok(objP > 0, label + ' object-level pindex present');
  assert.ok(/<basematerials id="1">/.test(model) && /displaycolor="#/.test(model), label + ' basematerials displaycolor');
  const ms = files['Metadata/model_settings.config'];
  const ext = (ms.match(/<metadata key="extruder" value="\d+"\/>/g) || []).length;
  assert.ok(ext >= slotCount, label + ' per-part extruder entries');
  const ps = JSON.parse(files['Metadata/project_settings.config']);
  assert.equal(ps.filament_colour.length, slotCount, label + ' colored filament slots');
}

// batch board
{
  const out = CS.batchCalibration.buildBatchCalibration3MF({ palette });
  assertFormat(readStoreZip(out.bytes), 'batch', palette.length);
}
// combo board
{
  const manifest = CS.calibrationJoint.buildComboManifest(palette, { layerHeight: 0.08, firstLayer: 0.24 });
  const out = CS.calibrationJoint.buildComboBoard3MF(palette, manifest);
  assertFormat(readStoreZip(out.bytes), 'combo', palette.length);
}
// wedge board
{
  const out = CS.calibration.buildCalibration3MF({ targetName: 'Red', targetHex: '#c00d1e', baseHex: '#000000', patches: 8 });
  const files = readStoreZip(out.bytes);
  assertFormat(files, 'wedge', 2);
  assert.ok(/Extension="config" ContentType="text\/xml"/.test(files['[Content_Types].xml']), 'config declared text/xml');
}
// main painting export (spatialMix)
{
  const E = CS.engine, X = CS.exporter;
  const w = 48, h = 32, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([x < 24 ? 192 : 250, 13 + (y % 40), 30, 255], (y * w + x) * 4);
  const plan = await E.buildPlan({ width: w, height: h, data: d }, { engine: 'td', palette, widthMm: 100, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1, families: 48, smoothMm: 0.8, lineWidthMm: 0.42, lineProtect: 'auto', backgroundMode: 'off' });
  const out = X.build3MFBytes(plan);
  const files = readStoreZip(out.bytes);
  const model = files['3D/3dmodel.model'];
  assert.equal((model.match(/<triangle [^>]*pindex=/g) || []).length, 0, 'painting triangles no pindex');
  const ps = JSON.parse(files['Metadata/project_settings.config']);
  assert.equal(ps.filament_colour.length, palette.length, 'painting colored slots');
}
console.log('m72 passed: object-level pindex + per-part extruder + colored slots; no per-triangle pindex');