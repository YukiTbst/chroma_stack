/* m48 F01 (m47 review): publishing or resetting calibration must NOT erase the
   user's manual region locks (lockMask/lockValue) or undo history. markDirty(true)
   calls clearManualEdits; the calibration lifecycle wrongly used markDirty(true).
   Calibration changes TD values, not the image segmentation, so image-independent
   persistent locks and undo must survive. Run: node tests/test-m48-calibration-locks.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setPointerCapture() {}, appendChild() {}, remove() {}, getBoundingClientRect: () => ({ width: 320, height: 240, left: 0, top: 0 }), textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false, title: '' });
globalThis.window = globalThis;
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById: () => el(), createElement: () => el(), querySelectorAll: () => [], body: el() };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.confirm = () => true;

for (const m of ['color', 'optics', 'earcut', 'data-filaments', 'engine', 'exporter', 'modes', 'settings', 'calibration-data', 'batch-calibration', 'matrix-calibration', 'zip', 'calibration-joint', 'app']) require('../app/js/' + m + '.js');
const C = globalThis.CS.color, O = globalThis.CS.optics, E = globalThis.CS.engine, J = globalThis.CS.calibrationJoint, CD = globalThis.CS.calibrationData;
const dbg = globalThis.CS.appDebug;
globalThis.CS.profiles = { backupActive: () => true, clearActive: () => Promise.resolve() };

const palette = E.buildUserPalette([{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'Jade White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }]);
function img(w, h) { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set([255, 255, 255, 255], i * 4); for (let y = 8; y < 22; y++) for (let x = 8; x < 30; x++) d.set([192, 13, 30, 255], (y * w + x) * 4); return { width: w, height: h, data: d }; }
const baseOpts = { engine: 'td', palette, widthMm: 40, flatTopMm: 1.6, layerHeight: 0.08, gradLayers: 5, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1, smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false, lineProtect: 'off', families: 16, backgroundMode: 'off' };

function seedLocks() {
  const plan = E.buildPlan(img(40, 30), baseOpts);
  dbg.state.plan = plan;
  dbg.state.tdPalette = palette;
  const n = plan.n;
  dbg.state.lockMask = new Uint8Array(n); dbg.state.lockValue = new Uint8Array(n);
  for (let i = 100; i < 160; i++) { dbg.state.lockMask[i] = 1; dbg.state.lockValue[i] = 1; }
  dbg.state.overrideMask = new Uint8Array(plan.flatMask);
  dbg.state.undo = [{ mask: new Uint8Array(dbg.state.overrideMask), locks: new Uint8Array(dbg.state.lockMask), values: new Uint8Array(dbg.state.lockValue) }];
  return n;
}
function locksIntact(n) {
  assert.ok(dbg.state.lockMask && dbg.state.lockMask.length === n, 'lockMask preserved');
  let cnt = 0; for (let i = 100; i < 160; i++) cnt += dbg.state.lockMask[i];
  assert.equal(cnt, 60, 'painted lock bits preserved');
  assert.ok(dbg.state.lockValue && dbg.state.lockValue[120] === 1, 'lockValue preserved');
  assert.equal(dbg.state.undo.length, 1, 'undo history preserved');
}

// resetSettings must preserve manual locks + undo.
{
  const n = seedLocks();
  dbg.resetSettings();
  locksIntact(n);
  assert.equal(dbg.state.plan, null, 'reset still invalidates the stale plan');
}

// publishComboModel must preserve manual locks + undo (publishable clean fit).
{
  const n = seedLocks();
  const pal3 = [{ id: 'k', name: 'K', hex: '#000000' }, { id: 'w', name: 'W', hex: '#ffffff' }, { id: 'r', name: 'R', hex: '#c00d1e' }];
  const KNOWN = { k: { logHd: [Math.log(0.04), Math.log(0.04), Math.log(0.04)], opaque: [0.02, 0.02, 0.02] }, w: { logHd: [Math.log(1.1), Math.log(0.75), Math.log(0.77)], opaque: [0.95, 0.97, 0.96] }, r: { logHd: [Math.log(1.2), Math.log(0.10), Math.log(0.06)], opaque: [0.70, 0.05, 0.02] } };
  const km = J.modelFromTheta(KNOWN, 0.08);
  const baseLin = { K: [0.03, 0.032, 0.034], W: [0.68, 0.70, 0.68] };
  const manifest = J.buildComboManifest(pal3, { layerHeight: 0.08 });
  const obs = manifest.cells.map(cell => { const sub = baseLin[cell.base]; const pred = O.predictStack(km, cell.stack, { linearRgb: { r: sub[0], g: sub[1], b: sub[2] } }, 0.08).linearRgb; return { cellId: cell.cellId, observedLinear: [pred.r, pred.g, pred.b], substrateLinear: sub.slice(), channelsOk: [true, true, true] }; });
  dbg.state.comboObs = { manifest, observations: obs };
  dbg.state.calibrationV2 = CD.emptyV2();
  await dbg.publishComboModel();
  assert.ok(dbg.state.calibrationV2 && dbg.state.calibrationV2.activeModelId, 'model actually published (markDirty path exercised)');
  locksIntact(n);
  assert.equal(dbg.state.plan, null, 'publish still invalidates the stale plan');
}
console.log('F01 passed: publish/reset calibration preserve manual locks + undo history');