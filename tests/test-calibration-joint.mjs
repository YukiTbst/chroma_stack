/* P2: joint combination fit recovers known per-material parameters using the shared
   predictor; the fitter reads ONLY train (C07 no leakage); a cool white with an
   independent reference is not forced to pure white (C05); publishing is atomic and
   refuses unresolved / failing fits (C09). Synthetic = program validity, not physical
   acceptance. Run: node tests/test-calibration-joint.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/calibration-data.js');
require('../app/js/batch-calibration.js');
require('../app/js/matrix-calibration.js');
require('../app/js/calibration-joint.js');
const C = globalThis.CS.color, O = globalThis.CS.optics, CD = globalThis.CS.calibrationData, J = globalThis.CS.calibrationJoint;

const palette = [{ id: 'k', name: 'K', hex: '#000000' }, { id: 'w', name: 'W', hex: '#ffffff' }, { id: 'r', name: 'R', hex: '#c00d1e' }];
const KNOWN = {
  k: { logHd: [Math.log(0.04), Math.log(0.04), Math.log(0.04)], opaque: [0.02, 0.02, 0.02] },
  w: { logHd: [Math.log(1.1), Math.log(0.75), Math.log(0.77)], opaque: [0.95, 0.97, 0.96] }, // slightly cool white, NOT pure 1
  r: { logHd: [Math.log(1.2), Math.log(0.10), Math.log(0.06)], opaque: [0.70, 0.05, 0.02] }
};
const knownModel = J.modelFromTheta(KNOWN, 0.08);
const baseLin = { K: [0.03, 0.032, 0.034], W: [0.68, 0.70, 0.68] };
const manifest = J.buildComboManifest(palette, { layerHeight: 0.08 });
function observe(mut) {
  return manifest.cells.map(cell => {
    const sub = baseLin[cell.base];
    const pred = O.predictStack(knownModel, cell.stack, { linearRgb: { r: sub[0], g: sub[1], b: sub[2] } }, 0.08).linearRgb;
    let obs = [pred.r, pred.g, pred.b];
    let ok = [true, true, true];
    if (mut) { const m = mut(cell, obs); obs = m.obs; ok = m.ok; }
    return { cellId: cell.cellId, observedLinear: obs, substrateLinear: sub.slice(), channelsOk: ok };
  });
}
const obs = observe();
const fit = J.fitJointModel(obs, manifest, { noiseScale: 0.02, tolerance: 6 });
console.log('splits', fit.splits, 'trainLoss', fit.trainLoss.toFixed(4), 'devDE', fit.devDE && fit.devDE.toFixed(2), 'testDE', fit.testDE && fit.testDE.toFixed(2), 'publishable', fit.publishable);
assert.equal(fit.publishable, true, 'clean synthetic combo fit must be publishable');
assert.ok(fit.testDE < 3, `held-out test ΔE ${fit.testDE} must be small`);
const hr = fit.model.params.r;
assert.ok(Math.abs(Math.exp(hr.logHd[1]) - 0.10) / 0.10 < 0.3, 'R hdG recovered');
assert.ok(Math.abs(Math.exp(hr.logHd[2]) - 0.06) / 0.06 < 0.4, 'R hdB recovered');
// C05: cool white keeps a sub-unity opaque, not forced pure white.
assert.ok(fit.model.params.w.opaque[0] < 0.99, `white opaque R ${fit.model.params.w.opaque[0]} must not be forced to 1`);

// C07: corrupting TEST observations must not change the fitted parameters.
const obsBadTest = observe((cell, o) => cell.split === 'test' ? { obs: [0.5, 0.5, 0.5], ok: [true, true, true] } : { obs: o, ok: [true, true, true] });
const fitBad = J.fitJointModel(obsBadTest, manifest, { noiseScale: 0.02, tolerance: 6 });
assert.deepEqual(fitBad.model.params, fit.model.params, 'fitter must ignore test split (no leakage)');
assert.ok(fitBad.testDE > fit.testDE, 'corrupted test shows up only in the held-out report');

// C09: unresolved channel blocks publishing; atomic publish keeps old model on failure.
const obsSat = observe((cell, o) => (cell.base === 'W' && cell.stack.some(s => s.materialId === 'r')) ? { obs: [1, o[1], o[2]], ok: [false, true, true] } : { obs: o, ok: [true, true, true] });
const fitSat = J.fitJointModel(obsSat, manifest, { noiseScale: 0.02, tolerance: 6 });
assert.equal(fitSat.publishable, false, 'saturated/unresolved channel must block publish');
const v2 = { ...CD.emptyV2(), models: [{ modelId: 'mOld', params: {}, status: 'published' }], activeModelId: 'mOld' };
assert.equal(J.publishModel(v2, fitSat), null, 'failed fit must not overwrite active model');
const pub = J.publishModel(v2, fit);
assert.ok(pub && pub.activeModelId === fit.model.modelId, 'successful fit publishes atomically');
assert.equal(pub.models.length, 2, 'old model retained alongside new');
assert.equal(v2.activeModelId, 'mOld', 'publish does not mutate the input block');
console.log('all P2 joint-calibration checks passed');