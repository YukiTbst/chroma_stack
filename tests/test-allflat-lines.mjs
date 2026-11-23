/* R7: an all-flat plan with strong line protection and physical smoothing
   must not crash, and the line-material consistency check must actually run
   in the all-flat branch (protected strokes keep their filament; a stroke
   island absorbed by cleanup loses its direct-print bit).
   The review repro: 640x480 red, whole-image flat maskOverride, widthMm 150,
   smoothMm 0.8, lineProtect strong -> "lineDirectFilament is not defined".
   Run: node tests/test-allflat-lines.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
const E = globalThis.CS.engine;

const palette = E.buildUserPalette([
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 }
]);
const BLACK = 0, WHITE = 1, RED = 2;
const base = {
  engine: 'td', palette, widthMm: 150, reliefMm: 0, layerHeight: 0.08,
  gradLayers: 6, foundationIndex: WHITE, flatTopMm: 1.6,
  stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.6,
  lineWidthMm: 0.42, smoothLevel: 0, mergeDeltaE: 0, heightMergeDeltaE: 1.5,
  edgeClean: 0, vectorFlat: false, families: 16, backgroundMode: 'off'
};

function solid(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([192, 13, 30, 255], i * 4);
  return { width: w, height: h, data };
}
/* White paper, one long vertical black stroke, one tiny 2x2 black dot.
   Coordinates scale with the working resolution. */
function lineArt(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([255, 255, 255, 255], i * 4);
  const lx = Math.round(w * 0.3), y0 = Math.round(h * 0.2), y1 = Math.round(h * 0.8);
  for (let y = y0; y < y1; y++) for (let x = lx; x < lx + 2; x++) data.set([0, 0, 0, 255], (y * w + x) * 4);
  const dx = Math.round(w * 0.15), dy = Math.round(h * 0.2);
  for (let y = dy; y < dy + 2; y++) for (let x = dx; x < dx + 2; x++) data.set([0, 0, 0, 255], (y * w + x) * 4);
  return { width: w, height: h, data, line: { x: lx, y0, y1 }, dot: { x: dx, y: dy } };
}
/* Mixed partition: white flat background + a real gray gradient patch. */
function mixed(w, h) {
  const img = lineArt(w, h);
  const x0 = Math.round(w * 0.55), x1 = Math.round(w * 0.85);
  const y0 = Math.round(h * 0.3), y1 = Math.round(h * 0.7);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const v = Math.round(60 + 140 * (x - x0) / (x1 - x0));
    img.data.set([v, v, v, 255], (y * w + x) * 4);
  }
  img.patch = { x0, x1, y0, y1 };
  return img;
}
const flatOverride = (w, h) => new Uint8Array(w * h).fill(1);

function checkLineMaterial(plan, img, label) {
  const { width: w, height: h } = img;
  assert.equal(plan.predicted.length, w * h, label + ': plan covers every pixel');
  assert.ok(plan.maxLayers >= 1, label + ': plan has layers');
  // Every surviving direct-print pixel must still be flat with the filament
  // the consistency check snapshotted (flatFilament is written from nearest).
  let direct = 0;
  for (let i = 0; i < w * h; i++) {
    if (!plan.lineDirectMask || !plan.lineDirectMask[i]) continue;
    direct++;
    assert.equal(plan.flatMask[i], 1, label + ': direct pixel stays flat');
    assert.equal(plan.flatFilament[i], plan.nearest[i], label + ': direct pixel material consistent');
  }
  return direct;
}

let runs = 0;
async function run(img, opts, label) {
  const t0 = Date.now();
  const plan = await E.buildPlan(img, { ...base, ...opts });
  runs++;
  console.log(`${label}: ok in ${Date.now() - t0}ms, maxLayers=${plan.maxLayers}, manualPixels=${plan.diagnostics.manualPixels}`);
  return plan;
}

/* ---- 1. the exact review repro, plus the smoothMm=0 control ---- */
const red640 = solid(640, 480);
for (const lineProtect of ['strong', 'off']) {
  for (const smoothMm of [0.8, 0]) {
    const plan = await run(red640, { lineProtect, smoothMm, maskOverride: flatOverride(640, 480) },
      `all-flat red 640 ${lineProtect} smooth=${smoothMm}`);
    checkLineMaterial(plan, red640, 'red640');
    for (let i = 0; i < 640 * 480; i++) assert.equal(plan.flatMask[i], 1, 'red640 stays all flat');
  }
}

/* ---- 2. all-flat line art: strong/off x smooth on/off ---- */
const art640 = lineArt(640, 480);
const dotIdx = art640.dot.y * 640 + art640.dot.x;
const lineIdx = Math.round((art640.line.y0 + art640.line.y1) / 2) * 640 + art640.line.x;
for (const lineProtect of ['strong', 'off']) {
  for (const smoothMm of [0.8, 0]) {
    const label = `all-flat art640 ${lineProtect} smooth=${smoothMm}`;
    const plan = await run(art640, { lineProtect, smoothMm, maskOverride: flatOverride(640, 480) }, label);
    const direct = checkLineMaterial(plan, art640, label);
    if (lineProtect === 'strong') {
      // The long stroke survives cleanup and keeps its protected material.
      assert.equal(plan.lineDirectMask[lineIdx], 1, label + ': long stroke stays direct');
      assert.equal(plan.flatFilament[lineIdx], BLACK, label + ': stroke keeps Black');
      assert.equal(plan.flatFilament[art640.line.y0 * 640 + art640.line.x + 1], BLACK, label + ': stroke width keeps Black');
      if (smoothMm > 0) {
        // The 2x2 dot is below the nozzle-scale feature area: cleanup absorbs
        // it into the paper, and the consistency check must revoke its direct
        // bit instead of leaving a black island flagged as line material.
        assert.equal(plan.flatMask[dotIdx], 1, label + ': dot stays flat');
        assert.equal(plan.flatFilament[dotIdx], WHITE, label + ': dot absorbed into paper');
        assert.equal(plan.lineDirectMask[dotIdx], 0, label + ': absorbed dot loses direct bit');
        assert.ok(plan.structureCleanup.mergedPixels >= 4, label + ': cleanup really merged the dot');
      }
      assert.ok(direct > 0, label + ': strong mode has direct pixels');
    } else {
      assert.equal(direct, 0, label + ': line protection off has no direct pixels');
    }
  }
}

/* ---- 3. all-flat + a manual lock (painted flat, no full snapshot needed) ---- */
{
  const manualMask = new Uint8Array(640 * 480);
  manualMask[dotIdx] = 1; // paint the dot flat: it must survive cleanup
  const label = 'all-flat art640 strong smooth=0.8 manual-lock';
  const plan = await run(art640, { lineProtect: 'strong', smoothMm: 0.8, maskOverride: flatOverride(640, 480), manualMask }, label);
  checkLineMaterial(plan, art640, label);
  assert.equal(plan.diagnostics.manualPixels, 1, label + ': one painted pixel');
  assert.equal(plan.flatMask[dotIdx], 1, label + ': locked dot stays flat');
  assert.equal(plan.flatFilament[dotIdx], BLACK, label + ': locked dot keeps its painted material');
  assert.equal(plan.lineDirectMask[dotIdx], 1, label + ': locked dot keeps direct bit');
}

/* ---- 4. larger working resolutions with the crashing combination ---- */
for (const [w, h] of [[1280, 960], [2560, 1920]]) {
  const img = solid(w, h);
  const plan = await run(img, { lineProtect: 'strong', smoothMm: 0.8, maskOverride: flatOverride(w, h) },
    `all-flat red ${w} strong smooth=0.8`);
  checkLineMaterial(plan, img, `red${w}`);
}

/* ---- 5. mixed partition: gradient branch with the same matrix ---- */
const mix640 = mixed(640, 480);
const patchIdx = Math.round((mix640.patch.y0 + mix640.patch.y1) / 2) * 640 + Math.round((mix640.patch.x0 + mix640.patch.x1) / 2);
for (const lineProtect of ['strong', 'off']) {
  for (const smoothMm of [0.8, 0]) {
    const label = `mixed640 ${lineProtect} smooth=${smoothMm}`;
    const plan = await run(mix640, { lineProtect, smoothMm }, label);
    checkLineMaterial(plan, mix640, label);
    assert.equal(plan.flatMask[patchIdx], 0, label + ': gradient patch stays gradient');
    if (lineProtect === 'strong') {
      assert.equal(plan.lineDirectMask[lineIdx], 1, label + ': stroke direct in mixed plan');
      assert.equal(plan.flatFilament[lineIdx], BLACK, label + ': stroke material in mixed plan');
    }
  }
}
{
  const manualMask = new Uint8Array(640 * 480);
  manualMask[patchIdx] = 1; // paint one gradient pixel flat
  const label = 'mixed640 strong smooth=0.8 manual-lock';
  const plan = await run(mix640, { lineProtect: 'strong', smoothMm: 0.8, manualMask }, label);
  checkLineMaterial(plan, mix640, label);
  assert.equal(plan.diagnostics.manualPixels, 1, label + ': one painted pixel');
  assert.equal(plan.flatMask[patchIdx], 1, label + ': painted gradient pixel becomes flat');
}

console.log(`all R7 all-flat/line-material checks passed (${runs} plans)`);