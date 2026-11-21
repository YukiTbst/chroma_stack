/* m47 F-OUTLINE-02: large-image export must not widen protected thin lines relative
   to the native preview. exportGridFor caps the long side at 1280; downsampling a
   2560/1600 working grid lets the protected-stroke vote turn a 1px line into a full
   coarse cell (2x physical width) and swallow narrow white gaps. Line-art plans must
   export at native resolution so preview == export; organic plans keep the 1280 cap.
   Run: node tests/test-m47-outline-downsample.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.earcut = require('../app/js/earcut.js');
for (const m of ['color', 'optics', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const X = globalThis.CS.exporter;

function linePlan(w, h, lineX, protect) {
  const n = w * h;
  const flatMask = new Uint8Array(n).fill(1);
  const flatFilament = new Uint16Array(n).fill(1);
  const familyId = new Int16Array(n).fill(-1);
  const lineProtectMask = protect ? new Uint8Array(n) : null;
  const predicted = new Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, black = (x === lineX);
    flatFilament[i] = black ? 0 : 1;
    if (lineProtectMask) lineProtectMask[i] = black ? 1 : 0;
    predicted[i] = { lab: black ? { L: 0, a: 0, b: 0 } : { L: 100, a: 0, b: 0 } };
  }
  return { w, h, widthMm: w * 0.1, heightMm: h * 0.1, flatMask, flatFilament, familyId, printMask: null, lineProtectMask, lineDirectMask: null, lineApplied: !!protect, predicted, manualMask: null, background: { enabled: false }, structureCleanup: null };
}
function lineWidthMm(plan, plane) {
  const pxMm = plan.widthMm / plane.ew;
  const row = (plane.eh >> 1);
  let count = 0;
  for (let x = 0; x < plane.ew; x++) { const i = row * plane.ew + x; if (plane.flatMask[i] && plane.flatFilament[i] === 0) count++; }
  return count * pxMm;
}

// (A) exportGridFor: line-art plans keep native resolution; organic plans keep the cap.
{
  const art = { w: 2560, h: 1280, lineApplied: true, lineProtectMask: new Uint8Array(1) };
  const gArt = X.exportGridFor(art);
  assert.equal(gArt.width, 2560, 'line-art plan exports at native width (no downscale)');
  assert.equal(gArt.downscaled, false, 'line-art plan is not downscaled');
  const organic = { w: 2560, h: 1280, lineApplied: false, lineProtectMask: null };
  const gOrg = X.exportGridFor(organic);
  assert.equal(gOrg.width, 1280, 'organic plan keeps the 1280 long-side cap');
  assert.equal(gOrg.downscaled, true);
  // explicit exportMax override still honoured
  assert.equal(X.exportGridFor(art, 600).width, 600, 'explicit exportMax override respected');
}

// (B) Fidelity: a 1px protected line keeps its native physical width through export.
{
  const plan = linePlan(1600, 80, 800, true);
  const nativeWidth = 0.1; // 1px * (widthMm/w = 0.1)
  const grid = X.exportGridFor(plan);
  const plane = X.samplePlane(plan, grid.width, grid.height);
  const exportWidth = lineWidthMm(plan, plane);
  assert.ok(Math.abs(exportWidth - nativeWidth) < 1e-6, `export line width must equal native (${exportWidth.toFixed(4)} vs ${nativeWidth} mm)`);
}

// (C) A narrow white gap between two protected lines must survive export.
{
  const w = 1600, h = 80, n = w * h;
  const plan = linePlan(w, h, 800, true);
  // second black line at x=803 -> 2px white gap (801,802) between them
  for (let y = 0; y < h; y++) { const i = y * w + 803; plan.flatFilament[i] = 0; plan.lineProtectMask[i] = 1; plan.predicted[i] = { lab: { L: 0, a: 0, b: 0 } }; }
  const grid = X.exportGridFor(plan);
  const plane = X.samplePlane(plan, grid.width, grid.height);
  const row = plane.eh >> 1;
  // count white cells strictly between the two black lines in the export row
  let blackCells = [];
  for (let x = 0; x < plane.ew; x++) { const i = row * plane.ew + x; if (plane.flatMask[i] && plan.flatFilament[i] === 0) blackCells.push(x); }
  // native has 2 distinct lines; export must still show 2 distinct black runs (gap not swallowed)
  let runs = 0; for (let k = 0; k < blackCells.length; k++) if (k === 0 || blackCells[k] !== blackCells[k - 1] + 1) runs++;
  assert.equal(runs, 2, `two protected lines with a 2px white gap must stay 2 distinct runs in export (got ${runs})`);
}
console.log('F-OUTLINE-02 passed: line-art exports native, thin-line width and white gaps preserved');