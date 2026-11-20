/* P0 / C01,C02,C03,C04,C09: missing channel information must be expressed as
   missing, never fabricated as a "very transparent" TD=20; near-opaque noise
   handling (m29) must stay correct; a result with an unresolved channel must not
   be publishable; board analysis thickness must come from the board identity,
   not a silent 0.08 default. Run: node tests/test-calibration-channel-state.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/batch-calibration.js');
require('../app/js/matrix-calibration.js');
const C = globalThis.CS.color, M = globalThis.CS.matrixCalibration, B = globalThis.CS.batchCalibration;

const opaqueCam = [0.63, 0.045, 0.018];
const baseLin = { K: [0.030, 0.032, 0.034], W: [0.68, 0.70, 0.68] };
const baseRgb = { K: baseLin.K.map(v => C.linearToSrgb8(v)), W: baseLin.W.map(v => C.linearToSrgb8(v)) };
const HD = [1.2, 0.10, 0.055];
function anchors(mut) {
  const out = [];
  for (const d of [0.08, 0.32, 0.80]) for (const half of ['K', 'W']) {
    const T = HD.map(h => Math.pow(10, -d / h));
    const lin = opaqueCam.map((o, c) => o * (1 - T[c]) + baseLin[half][c] * T[c]);
    let rgb = lin.map(v => Math.max(0, Math.min(255, C.linearToSrgb8(v))));
    if (mut) rgb = mut(rgb, d, half);
    out.push({ thickness: d, base: half, rgb, substrate: baseRgb[half].slice() });
  }
  return out;
}

/* C01: white-base red channel fully saturated -> no usable R pairs -> unresolved,
   NOT a fabricated HD=2 / TD=20. G/B still estimated. */
{
  const a = anchors((rgb, d, half) => half === 'W' ? [255, rgb[1], rgb[2]] : rgb);
  const f = M.fitMatrixAnchors({ R: a }, ['R']).fits.R;
  console.log('C01 channelState', f.channelState, 'hdR', f.hdR);
  assert.equal(f.channelState[0], 'unresolved', 'saturated channel must be unresolved');
  assert.ok(f.hdR == null, `unresolved hdR must be null, got ${f.hdR} (no fake TD20)`);
  assert.equal(f.channelState[1], 'estimated');
  assert.ok(f.channelState[2] !== 'unresolved', 'near-opaque B may be a bound, not unresolved');
  assert.equal(f.publishable, false, 'unresolved channel must block publishing');
}

/* C03: black/white substrate has no contrast -> no meaningful division -> unresolved. */
{
  const flat = baseRgb.W.slice();
  const a = anchors().map(s => ({ ...s, substrate: flat.slice() }));
  const f = M.fitMatrixAnchors({ R: a }, ['R']).fits.R;
  console.log('C03 channelState', f.channelState);
  assert.ok(f.channelState.every(s => s === 'unresolved'), 'no base contrast -> all unresolved');
  assert.equal(f.publishable, false);
}

/* C02: m29 near-opaque noise floor stays correct (G/B estimated from thin anchor). */
{
  const floor = { K: [0, 0.004, 0.003], W: [0, 0.020, 0.013] };
  const a = [];
  for (const d of [0.08, 0.32, 0.80]) for (const half of ['K', 'W']) {
    const T = HD.map(h => Math.pow(10, -d / h));
    const lin = opaqueCam.map((o, c) => o * (1 - T[c]) + baseLin[half][c] * T[c]);
    if (d >= 0.3) for (let c = 1; c < 3; c++) lin[c] += floor[half][c];
    a.push({ thickness: d, base: half, rgb: lin.map(v => C.linearToSrgb8(v)), substrate: baseRgb[half].slice() });
  }
  const f = M.fitMatrixAnchors({ R: a }, ['R']).fits.R;
  console.log('C02 hdRGB', f.hdR.toFixed(3), f.hdG.toFixed(3), f.hdB.toFixed(3), f.channelState);
  assert.ok(Math.abs(f.hdG - 0.10) / 0.10 < 0.35, 'm29 noise behaviour preserved');
  assert.ok(f.channelState[1] !== 'unresolved' && f.channelState[2] !== 'unresolved');
  assert.equal(f.publishable, true);
}

/* C09: publish gate helper rejects unresolved results. */
{
  const a = anchors((rgb, d, half) => half === 'W' ? [255, rgb[1], rgb[2]] : rgb);
  const res = M.analyzeMatrixPhoto ? null : null;
  const f = M.fitMatrixAnchors({ R: a }, ['R']).fits.R;
  assert.equal(M.canPublish([{ publishable: f.publishable, channelState: f.channelState }]), false);
  assert.equal(M.canPublish([{ publishable: true, channelState: ['estimated', 'estimated', 'estimated'] }]), true);
}

/* C04: board thickness identity. Generation at 0.06 must not be analysed at 0.08. */
{
  const palette = [{ name: 'K', hex: '#101010' }, { name: 'W', hex: '#ffffff' }, { name: 'R', hex: '#c00d1e' }, { name: 'U', hex: '#00358e' }];
  const l6 = B.buildBatchLayout(palette, { layerHeight: 0.06 });
  assert.equal(l6.layerHeight, 0.06);
  const l8 = B.buildBatchLayout(palette);
  assert.equal(l8.layerHeight, 0.08);
  const t6 = l6.maxHeight, t8 = l8.maxHeight;
  assert.ok(Math.abs(t6 - t8) > 1e-6, '0.06 vs 0.08 total board height must differ');
  assert.notEqual(l6.patches[3].topLayer, l8.patches[3].topLayer, 'layer counts must differ with layer height');
  // persisted layout is honoured; a missing identity must NOT silently default.
  assert.equal(B.resolveAnalysisLayout(palette, l6).layerHeight, 0.06);
  assert.equal(B.resolveAnalysisLayout(palette, null), null, 'missing board identity -> pending confirmation, not 0.08');
}
console.log('all P0 channel-state / board-identity checks passed');