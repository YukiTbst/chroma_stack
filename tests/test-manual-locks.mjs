/* R1: manual edits are sparse persistent locks, not a frozen full-image
   snapshot. Runs the REAL buildOptions extracted from app.js source (the same
   function the UI calls) against a state object, then the real engine, and
   checks final plan + export readouts. Also drives the real brush primitives
   through CS.appDebug.
   Run: node tests/test-manual-locks.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

/* Minimal DOM stub: app.js must load without running init(). */
const el = () => ({
  style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, setPointerCapture() {}, appendChild() {}, remove() {},
  getBoundingClientRect: () => ({ width: 320, height: 240, left: 0, top: 0 }),
  textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false, title: ''
});
globalThis.window = globalThis;
globalThis.document = {
  readyState: 'loading',
  addEventListener() {},
  getElementById: () => el(),
  createElement: () => el(),
  querySelectorAll: () => [],
  body: el()
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

require('../app/js/color.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
require('../app/js/exporter.js');
require('../app/js/modes.js');
require('../app/js/settings.js');
require('../app/js/app.js');
const C = globalThis.CS.color, E = globalThis.CS.engine, X = globalThis.CS.exporter;

/* ---- the real buildOptions, executed from source (not a grep) ---- */
const appSrc = fs.readFileSync(new URL('../app/js/app.js', import.meta.url), 'utf8');
const boStart = appSrc.indexOf('function buildOptions()');
const boEnd = appSrc.indexOf('function updateBackgroundUI');
assert.ok(boStart > 0 && boEnd > boStart, 'locate buildOptions in app.js');
const makeBuildOptions = new Function('state', appSrc.slice(boStart, boEnd) + '\nreturn buildOptions;');

const palette = E.buildUserPalette([
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 }
]);
const WHITE = 1;
const w = 320, h = 240, n = w * h;
/* Both near-white features sit INSIDE the gray gradient patch so they are
   isolated flat components (the gradient fails the residual gate, so it never
   merges with them). stdThreshold is pinned high so the per-pixel std gate
   does not erase the small island's boundary — this test is about the area
   gates and nozzle-scale cleanup, not std segmentation. The pre-fix repro
   uses the identical image and stdThreshold. */
const STD_T = 30;
const img = (() => {
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) data.set([255, 255, 255, 255], i * 4);
  for (let y = 60; y < 180; y++) for (let x = 80; x < 240; x++) {
    const v = Math.round(60 + 140 * (x - 80) / 160);
    data.set([v, v, v, 255], (y * w + x) * 4);
  }
  // 20x20 near-white square: flat only below the 0.6% area gate (400 < 461).
  for (let y = 80; y < 100; y++) for (let x = 100; x < 120; x++) data.set([245, 245, 245, 255], (y * w + x) * 4);
  // 4x5 near-white island: auto-flat at 0.02% (20 >= 15) but below the
  // nozzle-scale cleanup area (20 < 32 at lineWidthMm 0.6 / widthMm 60).
  for (let y = 120; y < 125; y++) for (let x = 150; x < 154; x++) data.set([245, 245, 245, 255], (y * w + x) * 4);
  return { width: w, height: h, data };
})();
const squareIdx = 90 * w + 110;
const islandIdx = 122 * w + 152;
const bgIdx = 10 * w + 10;

function freshState() {
  return {
    imageData: img, engine: 'td', tdPalette: palette, lutKey: 'bambu_8',
    lutTdOverrides: {}, lutHexOverrides: {},
    widthMm: 60, flatTopMm: 1.6, reliefMm: 0, gradStartOverride: null, gradTopMmOverride: null,
    variableHeight: true, layerHeight: 0.08, gradLayers: 6, foundationIndex: WHITE,
    families: 12, stdThreshold: STD_T, residualThreshold: 5, minFlatPercent: 0.6,
    smoothLevel: 0, smoothMm: 0, lineWidthMm: 0.6, mergeDeltaE: 0,
    lineProtect: 'off', heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false,
    edgeSnap: true, lineRepair: true,
    backgroundMode: 'off', backgroundColor: '#ffffff', backgroundTolerance: 8,
    backgroundEnvelope: true, backgroundEnvelopeMm: 2, backgroundHoleIds: new Set(),
    overrideMask: null, lockMask: null, lockValue: null
  };
}
const masksEqual = (a, b) => { for (let i = 0; i < n; i++) if (a.flatMask[i] !== b.flatMask[i]) return false; return true; };
const countDiff = (a, b) => { let d = 0; for (let i = 0; i < n; i++) if (a.flatMask[i] !== b.flatMask[i]) d++; return d; };

/* ============ A. brush opened but nothing painted: parameters must win ==== */
{
  const st = freshState();
  const buildOptions = makeBuildOptions(st);
  const p0 = E.buildPlan(img, buildOptions());
  assert.equal(p0.flatMask[squareIdx], 0, 'precondition: 400px square is gradient at 0.6%');
  // Open the brush: the UI snapshots the current plan as the display canvas.
  st.overrideMask = new Uint8Array(p0.flatMask);
  st.minFlatPercent = 0.02;
  const saved = [st.overrideMask, st.lockMask, st.lockValue];
  st.overrideMask = st.lockMask = st.lockValue = null;
  const auto = E.buildPlan(img, buildOptions());
  [st.overrideMask, st.lockMask, st.lockValue] = saved;
  assert.equal(auto.flatMask[squareIdx], 1, 'precondition: parameter change really moves the square to flat');
  const withBrush = E.buildPlan(img, buildOptions());
  const frozen = countDiff(withBrush, auto);
  console.log(`A brush-open-no-paint: ${frozen} pixels differ from same-parameter auto`);
  assert.equal(frozen, 0, 'opening the brush without painting must not freeze the old segmentation');
}

/* ============ B. one erased pixel: it stays gradient, everything else follows params ==== */
{
  const st = freshState();
  const buildOptions = makeBuildOptions(st);
  const p0 = E.buildPlan(img, buildOptions());
  assert.equal(p0.flatMask[bgIdx], 1, 'precondition: background pixel is flat');
  // Paint one pixel to gradient (both the display canvas and the sparse lock).
  st.overrideMask = new Uint8Array(p0.flatMask);
  st.overrideMask[bgIdx] = 0;
  st.lockMask = new Uint8Array(n); st.lockValue = new Uint8Array(n);
  st.lockMask[bgIdx] = 1; st.lockValue[bgIdx] = 0;
  const p1 = E.buildPlan(img, buildOptions());
  console.log(`B erase-one-pixel: flatMask=${p1.flatMask[bgIdx]} manualPixels=${p1.diagnostics.manualPixels}`);
  assert.equal(p1.flatMask[bgIdx], 0, 'painted pixel ends up gradient in the final plan');
  assert.equal(p1.diagnostics.manualPixels, 1, 'exactly one manual pixel');
  // Change partition parameters: the lock survives, all other pixels re-auto.
  st.minFlatPercent = 0.02;
  const p2 = E.buildPlan(img, buildOptions());
  const saved = [st.overrideMask, st.lockMask, st.lockValue];
  st.overrideMask = st.lockMask = st.lockValue = null;
  const auto = E.buildPlan(img, buildOptions());
  [st.overrideMask, st.lockMask, st.lockValue] = saved;
  assert.equal(p2.flatMask[bgIdx], 0, 'lock survives the parameter change');
  assert.equal(p2.diagnostics.manualPixels, 1);
  let frozen = 0;
  for (let i = 0; i < n; i++) if (i !== bgIdx && p2.flatMask[i] !== auto.flatMask[i]) frozen++;
  console.log(`B after param change: ${frozen} unpainted pixels frozen`);
  assert.equal(frozen, 0, 'unpainted pixels must follow the new automatic segmentation');
  assert.equal(p2.flatMask[squareIdx], auto.flatMask[squareIdx], 'square follows parameters');
}

/* ============ C. painting the value a pixel already has still locks it ==== */
{
  const st = freshState();
  st.minFlatPercent = 0.02;
  const buildOptions = makeBuildOptions(st);
  const p0 = E.buildPlan(img, buildOptions());
  assert.equal(p0.flatMask[islandIdx], 1, 'precondition: 20px island is auto-flat at 0.02%');
  // Paint the whole island flat — the same value it already has.
  st.overrideMask = new Uint8Array(p0.flatMask);
  st.lockMask = new Uint8Array(n); st.lockValue = new Uint8Array(n);
  for (let y = 120; y < 125; y++) for (let x = 150; x < 154; x++) {
    const i = y * w + x;
    st.overrideMask[i] = 1; st.lockMask[i] = 1; st.lockValue[i] = 1;
  }
  st.smoothMm = 0.8; // cleanup would absorb the 20px island (minAreaPx 32)
  const p1 = E.buildPlan(img, buildOptions());
  console.log(`C same-value lock: island flat=${p1.flatMask[islandIdx]} filament=${p1.flatFilament[islandIdx]} manualPixels=${p1.diagnostics.manualPixels}`);
  assert.equal(p1.diagnostics.manualPixels, 20, 'all 20 painted pixels are locked');
  assert.equal(p1.flatMask[islandIdx], 1, 'same-value paint still protects the island from cleanup');
  assert.equal(p1.flatFilament[islandIdx], WHITE, 'locked island keeps its painted material');
  for (let y = 120; y < 125; y++) for (let x = 150; x < 154; x++) {
    const i = y * w + x;
    assert.equal(p1.flatMask[i], 1, 'every locked island pixel stays flat');
    assert.equal(p1.flatFilament[i], WHITE, 'every locked island pixel keeps White');
  }
  // Without the lock the same geometry IS absorbed: prove the test bites.
  st.lockMask = null; st.lockValue = null; st.overrideMask = null;
  const unlocked = E.buildPlan(img, buildOptions());
  assert.equal(unlocked.flatMask[islandIdx], 0, 'control: unlocked island is absorbed by cleanup');

  /* Export readout shares the lock: native export is exact, and downsampled
     export cleanup must not absorb the painted island either. */
  st.lockMask = new Uint8Array(n); st.lockValue = new Uint8Array(n);
  for (let y = 120; y < 125; y++) for (let x = 150; x < 154; x++) { const i = y * w + x; st.lockMask[i] = 1; st.lockValue[i] = 1; }
  const locked = E.buildPlan(img, buildOptions());
  const native = X.samplePlane(locked, w, h);
  assert.equal(native.flatMask[islandIdx], 1, 'native export keeps the lock');
  assert.equal(native.flatFilament[islandIdx], WHITE);
  const grid = X.exportGridFor(locked, 160);
  const coarse = X.samplePlane(locked, grid.width, grid.height);
  const cx = Math.floor(152 * grid.width / w), cy = Math.floor(122 * grid.height / h);
  const ci = cy * grid.width + cx;
  console.log(`C export ${grid.width}x${grid.height}: island cell flat=${coarse.flatMask[ci]} changed=${coarse.changeStats.changedPercent}%`);
  assert.equal(coarse.flatMask[ci], 1, 'downsampled export cleanup respects the manual lock');
  assert.equal(coarse.flatFilament[ci], WHITE, 'downsampled export keeps the painted material');
}

/* ============ D. pixel preset switches reach the TD plan (behavioral) ==== */
{
  const st = freshState();
  st.edgeSnap = false; st.lineRepair = false;
  const buildOptions = makeBuildOptions(st);
  const opts = buildOptions();
  assert.equal(opts.engine, 'td');
  assert.equal(opts.edgeSnap, false, 'TD options echo edgeSnap=false');
  assert.equal(opts.lineRepair, false, 'TD options echo lineRepair=false');
  const plan = E.buildPlan(img, opts);
  assert.equal(plan.edgeSnap, false, 'TD plan echoes edgeSnap=false');
  assert.equal(plan.lineRepair, false, 'TD plan echoes lineRepair=false');
}

/* ============ E. the real brush primitives via CS.appDebug ==== */
{
  const dbg = globalThis.CS.appDebug;
  assert.ok(dbg && typeof dbg.buildOptions === 'function', 'appDebug exposes the real functions');
  const st = dbg.state;
  Object.assign(st, freshState());
  st.plan = E.buildPlan(img, dbg.buildOptions());
  dbg.ensureBrushCanvas();
  assert.ok(st.overrideMask && !st.lockMask, 'opening the brush creates no locks');
  dbg.snapshotUndo();
  dbg.applyPaint(st.plan, 10.5, 10.5, 0.4, 0);
  assert.equal(st.lockMask[bgIdx], 1, 'applyPaint records the position');
  assert.equal(st.lockValue[bgIdx], 0, 'applyPaint records the value');
  const p1 = E.buildPlan(img, dbg.buildOptions());
  assert.equal(p1.flatMask[bgIdx], 0, 'real brush path erases the pixel');
  dbg.rebaseBrushCanvas(p1);
  assert.equal(st.overrideMask[bgIdx], p1.flatMask[bgIdx], '2D readout equals the final plan');
  let readoutDiff = 0;
  for (let i = 0; i < n; i++) if (st.overrideMask[i] !== p1.flatMask[i]) readoutDiff++;
  assert.equal(readoutDiff, 0, 'whole 2D readout equals the final plan');
  // Undo restores the previous lock set, not just the display canvas.
  dbg.undoBrush();
  assert.ok(!st.lockMask || st.lockMask[bgIdx] === 0, 'undo removes the lock');
  const p2 = E.buildPlan(img, dbg.buildOptions());
  assert.equal(p2.flatMask[bgIdx], 1, 'after undo the pixel is automatic again');
  // A second paint + clear removes every lock.
  dbg.applyPaint(st.plan, 30.5, 30.5, 0.4, 0);
  dbg.clearBrush();
  assert.equal(st.lockMask, null, 'clear removes locks');
  assert.equal(st.overrideMask, null, 'clear removes the canvas');
  const p3 = E.buildPlan(img, dbg.buildOptions());
  assert.equal(p3.diagnostics.manualPixels, 0, 'clear returns to pure automatic');
}

console.log('all R1 manual-lock checks passed');
process.exit(0);