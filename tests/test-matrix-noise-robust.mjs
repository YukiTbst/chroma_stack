/* Per-channel HD must survive a noise floor on near-opaque channels. The
   differential-transmittance slope is weighted by d^2, so thick anchors dominate;
   but for a selective absorber (red blocks G/B) the true thick transmission is
   ~0, and sensor/flush noise leaves a small residual black/white difference dy
   (~0.01 linear, T ~ 1-2%). log10(T) there is noise-amplified, yet those pairs
   pass the |dy| gate and drive the d^2-weighted slope -> hdG/hdB inflate (pink
   cast). They must only BOUND the slope, not drive it. Deterministic synthetic
   red anchors: known per-channel HD, clean thin anchor + R, and a fixed noise
   floor on thick G/B. Pre-fix G/B inflate; post-fix they recover.
   Run: node tests/test-matrix-noise-robust.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/batch-calibration.js');
require('../app/js/matrix-calibration.js');
const C = globalThis.CS.color, M = globalThis.CS.matrixCalibration;

const TRUE = { hdR: 1.2, hdG: 0.10, hdB: 0.055 };
const opaqueScene = [0.70, 0.05, 0.02];
const gains = [0.9, 0.9, 0.88];
const opaqueCam = opaqueScene.map((v, c) => v * gains[c]);
const baseLin = { K: [0.030, 0.032, 0.034], W: [0.68, 0.70, 0.68] };
const baseRgb = { K: baseLin.K.map(v => C.linearToSrgb8(v)), W: baseLin.W.map(v => C.linearToSrgb8(v)) };
// Residual linear noise floor on thick G/B (independent per substrate), exactly
// the signature seen on the real board's red anchors (dy ~ 0.007-0.017).
const floor = { K: [0, 0.004, 0.003], W: [0, 0.020, 0.013] };
const anchors = [];
for (const d of [0.08, 0.32, 0.80]) for (const half of ['K', 'W']) {
  const T = [TRUE.hdR, TRUE.hdG, TRUE.hdB].map(h => Math.pow(10, -d / h));
  const lin = opaqueCam.map((o, c) => o * (1 - T[c]) + baseLin[half][c] * T[c]);
  if (d >= 0.3) for (let c = 1; c < 3; c++) lin[c] += floor[half][c];
  const rgb = lin.map(v => Math.max(0, Math.min(255, C.linearToSrgb8(v))));
  anchors.push({ thickness: d, base: half, rgb, substrate: baseRgb[half].slice() });
}
const fit = M.fitMatrixAnchors({ R: anchors }, ['R']).fits.R;
console.log('fitted hdRGB', fit.hdR.toFixed(3), fit.hdG.toFixed(3), fit.hdB.toFixed(3), 'true', TRUE.hdR, TRUE.hdG, TRUE.hdB);
const rel = (a, b) => Math.abs(a - b) / b;
assert.ok(rel(fit.hdR, TRUE.hdR) < 0.20, `hdR ${fit.hdR.toFixed(3)} vs ${TRUE.hdR}`);
assert.ok(rel(fit.hdG, TRUE.hdG) < 0.35, `hdG ${fit.hdG.toFixed(3)} vs ${TRUE.hdG} (noise-floor thick pairs must not inflate it)`);
assert.ok(rel(fit.hdB, TRUE.hdB) < 0.45, `hdB ${fit.hdB.toFixed(3)} vs ${TRUE.hdB}`);
console.log('all matrix noise-robustness checks passed');