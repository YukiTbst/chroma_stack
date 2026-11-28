/* Calibration boards must carry per-triangle color (pid/pindex) + colored filament slots so
   Bambu/Orca auto-assigns filaments instead of leaving every object uncolored (user report).
   Run: node tests/test-m72-board-colors.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.earcut = require('../app/js/earcut.js');
for (const m of ['color', 'optics', 'data-filaments', 'calibration-data', 'calibration', 'batch-calibration', 'calibration-joint', 'zip']) require('../app/js/' + m + '.js');
const CS = globalThis.CS;
const db = (CS.FILAMENT_DB && CS.FILAMENT_DB.filaments) || [];
const pick = n => db.find(f => f.brand === 'BambuLab Basic' && f.material === 'PLA' && f.name === n);
const palette = ['Black', 'Jade White', 'Red', 'Blue'].map(pick).filter(Boolean).map(f => ({ id: f.id, name: f.name, hex: f.hex, td: f.td }));

// minimal store-ZIP reader (createZip uses method 0)
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

// batch board
{
  const out = CS.batchCalibration.buildBatchCalibration3MF({ palette });
  const files = readStoreZip(out.bytes);
  const model = files['3D/3dmodel.model'];
  const tris = (model.match(/<triangle /g) || []).length;
  const colored = (model.match(/<triangle [^>]*pid="1" pindex="\d+"/g) || []).length;
  assert.ok(tris > 0 && colored === tris, `batch all ${tris} triangles carry pid/pindex (got ${colored})`);
  assert.ok(/<basematerials id="1">/.test(model) && /displaycolor="#/.test(model), 'batch basematerials displaycolor');
  const ps = JSON.parse(files['Metadata/project_settings.config']);
  assert.equal(ps.filament_colour.length, palette.length, 'batch colored filament slots');
  assert.deepEqual(ps.filament_colour, palette.map(p => p.hex), 'slot colors match palette');
  const ms = files['Metadata/model_settings.config'];
  assert.ok(/filament_map_mode/.test(ms), 'batch filament_map_mode');
}
// combo board
{
  const manifest = CS.calibrationJoint.buildComboManifest(palette, { layerHeight: 0.08, firstLayer: 0.24 });
  const out = CS.calibrationJoint.buildComboBoard3MF(palette, manifest);
  const files = readStoreZip(out.bytes);
  const model = files['3D/3dmodel.model'];
  const tris = (model.match(/<triangle /g) || []).length;
  const colored = (model.match(/<triangle [^>]*pid="1" pindex="\d+"/g) || []).length;
  assert.ok(tris > 0 && colored === tris, `combo all ${tris} triangles carry pid/pindex`);
  assert.ok(files['Metadata/project_settings.config'], 'combo project_settings present');
}
// single-target wedge board (calibration.js)
{
  const out = CS.calibration.buildCalibration3MF({ targetName: 'Red', targetHex: '#c00d1e', baseHex: '#000000', patches: 8 });
  const files = readStoreZip(out.bytes);
  const model = files['3D/3dmodel.model'];
  const tris = (model.match(/<triangle /g) || []).length;
  const colored = (model.match(/<triangle [^>]*pid="1" pindex="\d+"/g) || []).length;
  assert.ok(tris > 0 && colored === tris, `wedge all ${tris} triangles carry pid/pindex`);
  assert.ok(/Extension="config" ContentType="text\/xml"/.test(files['[Content_Types].xml']), 'config declared text/xml');
  const ps = JSON.parse(files['Metadata/project_settings.config']);
  assert.equal(ps.filament_colour.length, 2, 'wedge two colored slots');
}
console.log('m72 passed: calibration boards carry per-triangle colors + colored filament slots');