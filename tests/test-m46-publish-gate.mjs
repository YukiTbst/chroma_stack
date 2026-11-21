/* m46 F06: the publish gate must re-evaluate identifiability from the JOINT fit
   (effective channels) + the WORST held-out cell + observation source + validation
   domain — not inherit the matrix-init unresolved flag or use the mean alone.
   Run: node tests/test-m46-publish-gate.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const m of ['color', 'optics', 'calibration-data', 'batch-calibration', 'matrix-calibration', 'calibration-joint']) require('../app/js/' + m + '.js');
const C = globalThis.CS.color, O = globalThis.CS.optics, CD = globalThis.CS.calibrationData, J = globalThis.CS.calibrationJoint;

const palette = [{ id: 'k', name: 'K', hex: '#000000' }, { id: 'w', name: 'W', hex: '#ffffff' }, { id: 'r', name: 'R', hex: '#c00d1e' }];
const KNOWN = { k: { logHd: [Math.log(0.04), Math.log(0.04), Math.log(0.04)], opaque: [0.02, 0.02, 0.02] }, w: { logHd: [Math.log(1.1), Math.log(0.75), Math.log(0.77)], opaque: [0.95, 0.97, 0.96] }, r: { logHd: [Math.log(1.2), Math.log(0.10), Math.log(0.06)], opaque: [0.70, 0.05, 0.02] } };
const km = J.modelFromTheta(KNOWN, 0.08);
const baseLin = { K: [0.03, 0.032, 0.034], W: [0.68, 0.70, 0.68] };
const manifest = J.buildComboManifest(palette, { layerHeight: 0.08 });
function observe(mut) {
  return manifest.cells.map(cell => {
    const sub = baseLin[cell.base];
    const pred = O.predictStack(km, cell.stack, { linearRgb: { r: sub[0], g: sub[1], b: sub[2] } }, 0.08).linearRgb;
    let obs = [pred.r, pred.g, pred.b], ok = [true, true, true];
    if (mut) { const m = mut(cell, obs); obs = m.obs; ok = m.ok; }
    return { cellId: cell.cellId, observedLinear: obs, substrateLinear: sub.slice(), channelsOk: ok };
  });
}

// Clean fit: publishable, worst-cell reported, all channels effective.
const fit = J.fitJointModel(observe(), manifest, { noiseScale: 0.02, tolerance: 6 });
assert.equal(fit.publishable, true, 'clean synthetic publishable');
assert.ok(typeof fit.worstTestDE === 'number' && fit.worstTestDE >= fit.testDE - 1e-9, 'worstTestDE reported and >= mean');
assert.ok(fit.gate && fit.gate.publishable === true, 'gate object exposed');
assert.equal(fit.gate.effectiveChannels, 9, '3 materials x 3 channels all estimated');
assert.equal(fit.gate.unresolved, 0); assert.equal(fit.gate.bounded, 0);

// KEY F06 CASE: one bad held-out cell keeps the MEAN within tolerance but the
// WORST cell far outside it. A mean-only gate wrongly publishes; worst-cell blocks.
const targetId = manifest.cells.find(c => c.split === 'test').cellId;
const obsOne = observe((cell, o) => cell.cellId === targetId ? { obs: [0.45, 0.45, 0.45], ok: [true, true, true] } : { obs: o, ok: [true, true, true] });
const fitOne = J.fitJointModel(obsOne, manifest, { noiseScale: 0.02, tolerance: 6 });
assert.ok(fitOne.testDE <= 6, `mean held-out ΔE ${fitOne.testDE.toFixed(2)} within tolerance`);
assert.ok(fitOne.worstTestDE > 6, `worst held-out ΔE ${fitOne.worstTestDE.toFixed(2)} exceeds tolerance`);
assert.equal(fitOne.publishable, false, 'worst-cell breach must block publish even when the mean passes');
assert.ok(fitOne.gate.reasons.some(r => /最差|worst/i.test(r)), 'gate explains the worst-cell breach');

// Saturated/unresolved still blocks (regression).
const obsSat = observe((cell, o) => (cell.base === 'W' && cell.stack.some(s => s.materialId === 'r')) ? { obs: [1, o[1], o[2]], ok: [false, true, true] } : { obs: o, ok: [true, true, true] });
assert.equal(J.fitJointModel(obsSat, manifest, { noiseScale: 0.02, tolerance: 6 }).publishable, false, 'saturated fit blocks publish');

// Relative-source observations cannot publish absolute values.
const fitRel = J.fitJointModel(observe(), manifest, { noiseScale: 0.02, tolerance: 6, relative: true });
assert.equal(fitRel.publishable, false, 'relative (no independent reference) calibration must not publish absolute');

// Gate units: joint effective channels + worst-cell + source + domain.
const G = J.publishGate;
const allEst = { k: ['estimated', 'estimated', 'estimated'], w: ['estimated', 'estimated', 'estimated'] };
assert.equal(G({ channelStates: allEst, worstTestDE: 2, meanTestDE: 1, tolerance: 6, domainOk: true, sourceAbsolute: true }).publishable, true);
assert.equal(G({ channelStates: allEst, worstTestDE: 9, meanTestDE: 1, tolerance: 6, domainOk: true, sourceAbsolute: true }).publishable, false, 'worst-cell breach');
assert.equal(G({ channelStates: { k: ['estimated', 'bounded', 'estimated'] }, worstTestDE: 1, meanTestDE: 1, tolerance: 6, domainOk: true, sourceAbsolute: true }).publishable, false, 'bounded channel blocks absolute publish');
assert.equal(G({ channelStates: { k: ['estimated', 'unresolved', 'estimated'] }, worstTestDE: 1, meanTestDE: 1, tolerance: 6, domainOk: true, sourceAbsolute: true }).publishable, false, 'unresolved channel blocks');
assert.equal(G({ channelStates: allEst, worstTestDE: 1, meanTestDE: 1, tolerance: 6, domainOk: false, sourceAbsolute: true }).publishable, false, 'cross-domain blocks');
assert.equal(G({ channelStates: allEst, worstTestDE: 1, meanTestDE: 1, tolerance: 6, domainOk: true, sourceAbsolute: false }).publishable, false, 'relative source blocks');

// Atomic publish still refuses non-publishable and keeps the old model.
const v2 = { ...CD.emptyV2(), models: [{ modelId: 'mOld', params: {}, status: 'published' }], activeModelId: 'mOld' };
assert.equal(J.publishModel(v2, fitOne), null, 'worst-cell-breaching fit must not publish');
const pub = J.publishModel(v2, fit);
assert.ok(pub && pub.activeModelId === fit.model.modelId && pub.models.length === 2, 'clean fit publishes atomically, old retained');
assert.equal(v2.activeModelId, 'mOld', 'publish does not mutate input');
console.log('F06 publish gate passed: joint effective channels + worst-cell + source + domain');