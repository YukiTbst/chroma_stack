/* m46 F05: bounded/unresolved channels are NOT precise point calibrations.
   (1) fitJointModel must emit a per-channel state (estimated/bounded/unresolved)
   derived from JOINT identifiability, carried in model.params[id].state.
   (2) engine opticalModel override must apply ONLY 'estimated' channels; bounded/
   unresolved channels keep the library TD/opaque (a bound is not a measurement).
   Legacy state-less models stay fully applied (backward compatible).
   Run: node tests/test-m46-channel-semantics.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const m of ['color', 'optics', 'calibration-data', 'batch-calibration', 'matrix-calibration', 'calibration-joint', 'data-filaments', 'earcut', 'engine', 'zip', 'exporter', 'layer-optimizer']) require('../app/js/' + m + '.js');
const C = globalThis.CS.color, O = globalThis.CS.optics, E = globalThis.CS.engine, J = globalThis.CS.calibrationJoint;

const palette = E.buildUserPalette([
  { id: 'k', name: 'Black', hex: '#000000', td: 0.6 },
  { id: 'w', name: 'Jade White', hex: '#ffffff', td: 5 },
  { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }
]);
function img(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([255, 255, 255, 255], i * 4);
  for (let y = 10; y < 50; y++) for (let x = 10; x < 50; x++) d.set([192, 13, 30, 255], (y * w + x) * 4);
  return { width: w, height: h, data: d };
}
const base = { engine: 'td', palette, widthMm: 40, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08, gradLayers: 5, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1, smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false, lineProtect: 'off', families: 16, backgroundMode: 'off' };
const libRG = C.srgbToLinear(C.hexToRgb('#c00d1e').g / 255); // library red opaque G

// (2) Per-channel gating: r has R estimated, G bounded, B unresolved.
{
  const model = {
    params: {
      k: { logHd: [Math.log(0.05), Math.log(0.05), Math.log(0.05)], opaque: [0.02, 0.02, 0.02], state: ['estimated', 'estimated', 'estimated'] },
      r: { logHd: [Math.log(0.4), Math.log(0.1), Math.log(0.1)], opaque: [0.7, 0.05, 0.05], state: ['estimated', 'bounded', 'unresolved'] }
    }
  };
  const plan = E.buildPlan(img(80, 60), { ...base, opticalModel: model });
  const pr = plan.palette.find(p => p.id === 'r');
  assert.ok(Math.abs(pr.hdR - 0.4) < 1e-6, 'estimated R channel applied');
  assert.ok(Math.abs(pr.hdG - 0.5) < 1e-6, `bounded G channel must keep library hdG=0.5, got ${pr.hdG}`);
  assert.ok(Math.abs(pr.hdB - 0.5) < 1e-6, `unresolved B channel must keep library hdB=0.5, got ${pr.hdB}`);
  assert.ok(Math.abs(pr.lin.r - 0.7) < 1e-6, 'estimated R opaque applied');
  assert.ok(Math.abs(pr.lin.g - libRG) < 1e-6, `bounded G opaque must keep library ${libRG}, got ${pr.lin.g} (model would be 0.05)`);
  assert.ok(pr.fromModel, 'partially-modelled material still flagged fromModel');
  assert.deepEqual(pr.modelChannels, [true, false, false], 'per-channel model usage recorded');
  const pk = plan.palette.find(p => p.id === 'k');
  assert.deepEqual(pk.modelChannels, [true, true, true], 'all-estimated material fully applied');
}

// Legacy state-less model: every channel treated as estimated (backward compatible).
{
  const model = { params: { r: { logHd: [Math.log(0.4), Math.log(0.1), Math.log(0.1)], opaque: [0.7, 0.05, 0.05] } } };
  const plan = E.buildPlan(img(80, 60), { ...base, opticalModel: model });
  const pr = plan.palette.find(p => p.id === 'r');
  assert.ok(Math.abs(pr.hdG - 0.1) < 1e-6, 'legacy state-less model applies G channel');
  assert.ok(Math.abs(pr.lin.g - 0.05) < 1e-6, 'legacy state-less model applies G opaque');
}

// (1) fitJointModel emits per-channel state from joint identifiability.
{
  const pal = [{ id: 'k', name: 'K', hex: '#000000' }, { id: 'w', name: 'W', hex: '#ffffff' }, { id: 'r', name: 'R', hex: '#c00d1e' }];
  const KNOWN = { k: { logHd: [Math.log(0.04), Math.log(0.04), Math.log(0.04)], opaque: [0.02, 0.02, 0.02] }, w: { logHd: [Math.log(1.1), Math.log(0.75), Math.log(0.77)], opaque: [0.95, 0.97, 0.96] }, r: { logHd: [Math.log(1.2), Math.log(0.10), Math.log(0.06)], opaque: [0.70, 0.05, 0.02] } };
  const km = J.modelFromTheta(KNOWN, 0.08);
  const baseLin = { K: [0.03, 0.032, 0.034], W: [0.68, 0.70, 0.68] };
  const manifest = J.buildComboManifest(pal, { layerHeight: 0.08 });
  const obs = manifest.cells.map(cell => { const sub = baseLin[cell.base]; const pred = O.predictStack(km, cell.stack, { linearRgb: { r: sub[0], g: sub[1], b: sub[2] } }, 0.08).linearRgb; return { cellId: cell.cellId, observedLinear: [pred.r, pred.g, pred.b], substrateLinear: sub.slice(), channelsOk: [true, true, true] }; });
  const fit = J.fitJointModel(obs, manifest, { noiseScale: 0.02, tolerance: 6 });
  for (const id of ['k', 'w', 'r']) {
    const st = fit.model.params[id].state;
    assert.ok(Array.isArray(st) && st.length === 3, `${id} params carry a 3-channel state`);
    assert.ok(st.every(s => ['estimated', 'bounded', 'unresolved'].includes(s)), `${id} state values valid`);
    assert.ok(st.every(s => s === 'estimated'), `clean synthetic ${id} all channels estimated (joint constrained)`);
  }
}
console.log('F05 channel semantics passed: bounded/unresolved keep library values; fit emits joint channel state');