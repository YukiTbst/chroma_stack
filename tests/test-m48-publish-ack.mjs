/* m48 F06 (m47 review): publish confirmation must bind to the server ACK, not just
   validate the local block. confirmPublish(v2, modelId, ack) verifies the server
   acknowledged a revision and that the acknowledged data has the model active.
   publishComboModel awaits the profile flush and rolls back if the ACK is missing.
   Run: node tests/test-m48-publish-ack.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setPointerCapture() {}, appendChild() {}, remove() {}, getBoundingClientRect: () => ({ width: 320, height: 240, left: 0, top: 0 }), textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false, title: '' });
globalThis.window = globalThis;
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById: () => el(), createElement: () => el(), querySelectorAll: () => [], body: el() };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.confirm = () => true;
for (const m of ['color', 'optics', 'earcut', 'data-filaments', 'engine', 'exporter', 'layer-optimizer', 'modes', 'settings', 'calibration-data', 'batch-calibration', 'matrix-calibration', 'zip', 'calibration-joint', 'app']) require('../app/js/' + m + '.js');
const O = globalThis.CS.optics, E = globalThis.CS.engine, CD = globalThis.CS.calibrationData, J = globalThis.CS.calibrationJoint, dbg = globalThis.CS.appDebug;

// Clean publishable fit.
const pal3 = [{ id: 'k', name: 'K', hex: '#000000' }, { id: 'w', name: 'W', hex: '#ffffff' }, { id: 'r', name: 'R', hex: '#c00d1e' }];
const KNOWN = { k: { logHd: [Math.log(0.04), Math.log(0.04), Math.log(0.04)], opaque: [0.02, 0.02, 0.02] }, w: { logHd: [Math.log(1.1), Math.log(0.75), Math.log(0.77)], opaque: [0.95, 0.97, 0.96] }, r: { logHd: [Math.log(1.2), Math.log(0.10), Math.log(0.06)], opaque: [0.70, 0.05, 0.02] } };
const km = J.modelFromTheta(KNOWN, 0.08);
const baseLin = { K: [0.03, 0.032, 0.034], W: [0.68, 0.70, 0.68] };
const manifest = J.buildComboManifest(pal3, { layerHeight: 0.08 });
const obs = manifest.cells.map(cell => { const sub = baseLin[cell.base]; const pred = O.predictStack(km, cell.stack, { linearRgb: { r: sub[0], g: sub[1], b: sub[2] } }, 0.08).linearRgb; return { cellId: cell.cellId, observedLinear: [pred.r, pred.g, pred.b], substrateLinear: sub.slice(), channelsOk: [true, true, true] }; });
const fitted = J.fitJointModel(obs, manifest, { noiseScale: 0.02, tolerance: 6 });
const modelId = fitted.model.modelId;
const pub = J.publishModel(CD.emptyV2(), fitted, { sessionId: 's-1', manifestHash: manifest.manifestHash, observations: obs });

// (A) confirmPublish ACK binding.
assert.equal(J.confirmPublish(pub, modelId).ok, true, 'local confirm without ack');
assert.equal(J.confirmPublish(pub, modelId, { profileId: 'p1', revision: 5, activeModelId: modelId }).ok, true, 'server ACK ok');
assert.equal(J.confirmPublish(pub, modelId, { profileId: 'p1', revision: 5, activeModelId: modelId }).serverRevision, 5);
assert.equal(J.confirmPublish(pub, modelId, { profileId: 'p1', revision: null, activeModelId: modelId }).ok, false, 'missing server revision must fail confirmation');
assert.equal(J.confirmPublish(pub, modelId, { profileId: 'p1', revision: 5, activeModelId: 'm-other' }).ok, false, 'ACK active-model mismatch must fail');

// (B) publishComboModel awaits the ACK and rolls back when it is missing.
let savedSnapshot = null, ackRevision = 5;
globalThis.CS.profiles = {
  activeId: () => 'p1', hasConflict: () => false, backupActive: () => true, clearActive: () => Promise.resolve(),
  save: (snap) => { savedSnapshot = snap; return true; },
  flush: async () => savedSnapshot,
  revision: () => ackRevision,
  cachedData: () => savedSnapshot
};
async function seed() {
  const palette = E.buildUserPalette([{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'Jade White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }]);
  const d = new Uint8ClampedArray(40 * 30 * 4); for (let i = 0; i < 40 * 30; i++) d.set([255, 255, 255, 255], i * 4); for (let y = 8; y < 22; y++) for (let x = 8; x < 30; x++) d.set([192, 13, 30, 255], (y * 40 + x) * 4);
  dbg.state.plan = await E.buildPlan({ width: 40, height: 30, data: d }, { engine: 'td', palette, widthMm: 40, flatTopMm: 1.6, layerHeight: 0.08, gradLayers: 5, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1, smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false, lineProtect: 'off', families: 16, backgroundMode: 'off' });
  dbg.state.tdPalette = palette;
  dbg.state.lockMask = new Uint8Array(dbg.state.plan.n); dbg.state.lockValue = new Uint8Array(dbg.state.plan.n);
  for (let i = 100; i < 160; i++) { dbg.state.lockMask[i] = 1; dbg.state.lockValue[i] = 1; }
  dbg.state.undo = [{ mask: null, locks: new Uint8Array(dbg.state.lockMask), values: new Uint8Array(dbg.state.lockValue) }];
  dbg.state.comboObs = { manifest, observations: obs };
}

// ACK present -> published.
ackRevision = 5; await seed();
dbg.state.calibrationV2 = CD.emptyV2();
await dbg.publishComboModel();
assert.equal(dbg.state.calibrationV2.activeModelId, modelId, 'published when server ACK present');
assert.equal(dbg.state.plan, null, 'stale plan invalidated');
assert.ok(dbg.state.lockMask && dbg.state.lockMask[120] === 1, 'manual locks preserved');

// ACK missing -> roll back, keep old model.
ackRevision = null; await seed();
dbg.state.calibrationV2 = { ...CD.emptyV2(), models: [{ modelId: 'mOld', params: {}, status: 'published' }], activeModelId: 'mOld' };
await dbg.publishComboModel();
assert.equal(dbg.state.calibrationV2.activeModelId, 'mOld', 'without server ACK the publish must roll back to the old model');
assert.ok(dbg.state.lockMask && dbg.state.lockMask[120] === 1, 'manual locks preserved on rollback');

// (C) Stale Worker results (mismatched request id) are rejected, not applied.
{
  let stale = false;
  class FakeWorker {
    constructor() { this.onmessage = null; this.onerror = null; }
    postMessage(msg) { setTimeout(() => { if (this.onmessage) this.onmessage({ data: { id: msg.id + (stale ? 999 : 0), ok: true, plan: { fake: true } } }); }, 0); }
    terminate() {}
  }
  globalThis.Worker = FakeWorker;
  const image = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  stale = false;
  const fresh = await dbg.runPlanInWorker(image, {}, 5);
  assert.ok(fresh && fresh.fake, 'matching request id resolves the plan');
  stale = true;
  const old = await dbg.runPlanInWorker(image, {}, 5);
  assert.equal(old, null, 'mismatched (stale) request id must resolve null, not apply the old plan');
}
console.log('F06 passed: publish confirmation binds to server ACK; missing ACK rolls back; stale Worker results rejected');