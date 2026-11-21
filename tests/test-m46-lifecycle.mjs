/* m46 #100 lifecycle: (A) analysis can read the ACTUAL embedded board manifest from
   the 3MF (not a rebuilt approximation); (B) a fitted model records its applicable
   domain (board hash + material set + layer height); (C) publish retains the source
   observations + session link atomically; (D) confirmPublish verifies the transaction.
   Run: node tests/test-m46-lifecycle.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const m of ['color', 'optics', 'calibration-data', 'batch-calibration', 'matrix-calibration', 'zip', 'calibration-joint']) require('../app/js/' + m + '.js');
const C = globalThis.CS.color, O = globalThis.CS.optics, CD = globalThis.CS.calibrationData, J = globalThis.CS.calibrationJoint;

const palette = [{ id: 'k', name: 'K', hex: '#000000' }, { id: 'w', name: 'W', hex: '#ffffff' }, { id: 'r', name: 'R', hex: '#c00d1e' }];

// (A) Read the embedded manifest back from the generated 3MF.
{
  const manifest = J.buildComboManifest(palette, { layerHeight: 0.08, firstLayer: 0.24 });
  const { bytes } = J.buildComboBoard3MF(palette, manifest);
  const read = J.readComboManifest(bytes);
  assert.ok(read && read.manifest, 'readComboManifest returns the embedded manifest');
  assert.equal(read.manifest.manifestHash, manifest.manifestHash, 'embedded manifest hash round-trips');
  assert.equal(read.manifest.cells.length, manifest.cells.length, 'all cells round-trip');
  assert.deepEqual(read.manifest.markers, manifest.markers, 'markers round-trip');
  assert.equal(read.manifest.layerHeight, 0.08);
}

// Clean synthetic fit for the lifecycle checks.
const KNOWN = { k: { logHd: [Math.log(0.04), Math.log(0.04), Math.log(0.04)], opaque: [0.02, 0.02, 0.02] }, w: { logHd: [Math.log(1.1), Math.log(0.75), Math.log(0.77)], opaque: [0.95, 0.97, 0.96] }, r: { logHd: [Math.log(1.2), Math.log(0.10), Math.log(0.06)], opaque: [0.70, 0.05, 0.02] } };
const km = J.modelFromTheta(KNOWN, 0.08);
const baseLin = { K: [0.03, 0.032, 0.034], W: [0.68, 0.70, 0.68] };
const manifest = J.buildComboManifest(palette, { layerHeight: 0.08 });
const obs = manifest.cells.map(cell => { const sub = baseLin[cell.base]; const pred = O.predictStack(km, cell.stack, { linearRgb: { r: sub[0], g: sub[1], b: sub[2] } }, 0.08).linearRgb; return { cellId: cell.cellId, observedLinear: [pred.r, pred.g, pred.b], substrateLinear: sub.slice(), channelsOk: [true, true, true] }; });
const fitted = J.fitJointModel(obs, manifest, { noiseScale: 0.02, tolerance: 6 });
assert.equal(fitted.publishable, true, 'clean fit publishable');

// (B) Applicable domain recorded on the model.
{
  const dom = fitted.model.compatibilityDomain;
  assert.equal(dom.layerHeightMm, 0.08);
  assert.equal(dom.boardManifestHash, manifest.manifestHash, 'domain records the board manifest hash');
  assert.ok(Array.isArray(dom.materialIds) && dom.materialIds.includes('k') && dom.materialIds.includes('w') && dom.materialIds.includes('r'), 'domain records the material set');
}

// (C) Publish retains domain + session + observations, atomically.
{
  const v2 = { ...CD.emptyV2(), models: [{ modelId: 'mOld', params: {}, status: 'published' }], activeModelId: 'mOld', observations: [] };
  const session = { sessionId: 's-test', manifestHash: manifest.manifestHash, observations: obs };
  const pub = J.publishModel(v2, fitted, session);
  assert.ok(pub && pub.activeModelId === fitted.model.modelId, 'publish switches active model');
  const entry = pub.models.find(m => m.modelId === fitted.model.modelId);
  assert.equal(entry.compatibilityDomain.boardManifestHash, manifest.manifestHash, 'entry retains domain board hash');
  assert.ok(entry.session && entry.session.sessionId === 's-test' && entry.session.observationCount === obs.length, 'entry retains session link + observation count');
  assert.equal(pub.observations.length, obs.length, 'source observations retained (append-only)');
  assert.ok(pub.observations.every(o => o.sessionId === 's-test' && o.manifestHash === manifest.manifestHash), 'retained observations carry sessionId/manifestHash');
  assert.equal(CD.validateV2(pub).ok, true, 'published block validates');
  // atomic: input untouched, old model retained
  assert.equal(v2.activeModelId, 'mOld', 'input not mutated');
  assert.equal(v2.observations.length, 0, 'input observations not mutated');
  assert.ok(pub.models.some(m => m.modelId === 'mOld'), 'old model retained');
  // backward compatible: no session => no retention, still publishes
  const pub2 = J.publishModel(v2, fitted);
  assert.ok(pub2 && pub2.activeModelId === fitted.model.modelId, '2-arg publish still works');
  assert.equal(pub2.observations.length, 0, 'no session => no observation retention');
}

// (D) Transaction confirmation.
{
  const pub = J.publishModel(CD.emptyV2(), fitted, { sessionId: 's-test', manifestHash: manifest.manifestHash, observations: obs });
  const ok = J.confirmPublish(pub, fitted.model.modelId);
  assert.equal(ok.ok, true, 'confirmPublish verifies the active published model');
  assert.equal(ok.domain.boardManifestHash, manifest.manifestHash);
  assert.equal(J.confirmPublish(pub, 'm-bogus').ok, false, 'confirmPublish rejects a non-active id');
}
console.log('m46 lifecycle passed: embedded manifest reader + domain + observation retention + transaction confirm');