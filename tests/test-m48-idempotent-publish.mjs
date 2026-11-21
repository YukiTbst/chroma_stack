/* m48 F08 (m47 review): repeat publish must be idempotent and record provenance.
   publishModel appended a new model entry and re-appended observations on every call,
   so re-publishing the same content-derived modelId grew models/observations without
   bound and could create duplicate-id blocks. Source/session must be recorded reliably.
   Run: node tests/test-m48-idempotent-publish.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const m of ['color', 'optics', 'calibration-data', 'batch-calibration', 'matrix-calibration', 'zip', 'calibration-joint']) require('../app/js/' + m + '.js');
const O = globalThis.CS.optics, CD = globalThis.CS.calibrationData, J = globalThis.CS.calibrationJoint;

const palette = [{ id: 'k', name: 'K', hex: '#000000' }, { id: 'w', name: 'W', hex: '#ffffff' }, { id: 'r', name: 'R', hex: '#c00d1e' }];
const KNOWN = { k: { logHd: [Math.log(0.04), Math.log(0.04), Math.log(0.04)], opaque: [0.02, 0.02, 0.02] }, w: { logHd: [Math.log(1.1), Math.log(0.75), Math.log(0.77)], opaque: [0.95, 0.97, 0.96] }, r: { logHd: [Math.log(1.2), Math.log(0.10), Math.log(0.06)], opaque: [0.70, 0.05, 0.02] } };
const km = J.modelFromTheta(KNOWN, 0.08);
const baseLin = { K: [0.03, 0.032, 0.034], W: [0.68, 0.70, 0.68] };
const manifest = J.buildComboManifest(palette, { layerHeight: 0.08 });
const obs = manifest.cells.map(cell => { const sub = baseLin[cell.base]; const pred = O.predictStack(km, cell.stack, { linearRgb: { r: sub[0], g: sub[1], b: sub[2] } }, 0.08).linearRgb; return { cellId: cell.cellId, observedLinear: [pred.r, pred.g, pred.b], substrateLinear: sub.slice(), channelsOk: [true, true, true] }; });
const fitted = J.fitJointModel(obs, manifest, { noiseScale: 0.02, tolerance: 6 });
assert.equal(fitted.publishable, true);
const session = { sessionId: 's-1', manifestHash: manifest.manifestHash, observations: obs };
const v2 = { ...CD.emptyV2(), models: [{ modelId: 'mOld', params: {}, status: 'published' }], activeModelId: 'mOld' };

const pub1 = J.publishModel(v2, fitted, session);
assert.equal(pub1.models.length, 2, 'first publish: old + new');
assert.equal(pub1.observations.length, obs.length, 'first publish retains observations once');

// Re-publish the SAME model + session: idempotent, no growth, no duplicate id.
const pub2 = J.publishModel(pub1, fitted, session);
assert.equal(pub2.models.length, 2, `repeat publish must not grow models (got ${pub2.models.length})`);
assert.equal(pub2.observations.length, obs.length, `repeat publish must not duplicate observations (got ${pub2.observations.length})`);
assert.equal(pub2.activeModelId, fitted.model.modelId);
assert.equal(pub2.models.filter(m => m.modelId === fitted.model.modelId).length, 1, 'exactly one entry for the model id');
assert.equal(CD.validateV2(pub2).ok, true, 'idempotent block still validates (no duplicate-id collision)');

// A third publish with a fresh session id adds new observations but still one model entry.
const pub3 = J.publishModel(pub2, fitted, { sessionId: 's-2', manifestHash: manifest.manifestHash, observations: obs });
assert.equal(pub3.models.length, 2, 'model entry count stays idempotent across sessions');
assert.equal(pub3.observations.length, obs.length * 2, 'a distinct session retains its own observations');

// Provenance recorded reliably (not only via optional session fields).
const entry = pub2.models.find(m => m.modelId === fitted.model.modelId);
assert.ok(entry.source && entry.source.boardManifestHash === manifest.manifestHash, 'model records source board manifest hash');
assert.equal(entry.compatibilityDomain.boardManifestHash, manifest.manifestHash);
console.log('F08 passed: repeat publish idempotent, observations deduped per session, source recorded');