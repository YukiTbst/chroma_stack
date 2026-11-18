/* Six-colour TD matrix photo inversion: synthetic photographed board with
   known HDs, camera gains, projective warp, sensor noise, 90° rotation and a
   mirrored variant. Run from project root: node tests/test-matrix-calibration.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/batch-calibration.js');
require('../app/js/matrix-calibration.js');
const C = globalThis.CS.color;
const M = globalThis.CS.matrixCalibration;
const B = globalThis.CS.batchCalibration;

const layout = M.buildMatrixLayout();
assert.equal(layout.cells.length, 64);
assert.equal(layout.cells.filter(c => c.kind === 'mixed').length, 16);
assert.equal(layout.cells.filter(c => c.kind === 'single').length, 48);
assert.deepEqual(layout.steps, [1, 2, 4, 8]);
assert.equal(layout.totalLayers, 10);
assert.ok(Math.abs(layout.maxHeight - 0.96) < 1e-9);
assert.equal(layout.boardW, 100);

/* Parity with the physical board generator when its 3MF is present. */
const mf = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ChromaStack_TD_Matrix_100mm_6color.3mf');
if (fs.existsSync(mf)) {
  const buf = fs.readFileSync(mf);
  let meta = null;
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const nameLen = buf.readUInt16LE(i + 26), extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString();
    if (name !== 'Metadata/chromastack-td-matrix.json') continue;
    const method = buf.readUInt16LE(i + 8), compSize = buf.readUInt32LE(i + 18);
    const start = i + 30 + nameLen + extraLen;
    const raw = buf.slice(start, start + compSize);
    meta = JSON.parse(method === 8 ? zlib.inflateRawSync(raw).toString() : raw.toString());
    break;
  }
  assert.ok(meta, 'generator metadata found in 3MF');
  assert.deepEqual(meta.cells.map(c => [c.id, c.cx, c.cy, c.base, c.kind, c.recipe.join('')]),
    layout.cells.map(c => [c.id, c.cx, c.cy, c.base, c.kind, c.recipe.join('')]), 'JS layout matches printed board cells');
  assert.deepEqual(meta.markers.map(m => [m.cx, m.cy, m.filament]), layout.markers.map(m => [m.cx, m.cy, m.filament]), 'markers match');
  assert.deepEqual(meta.steps, layout.steps);
  console.log('layout parity with printed 3MF metadata passed');
} else {
  console.log('note: printed 3MF absent, skipping metadata parity');
}

/* ---- forward optical model ---- */
const TRUE_HD = { K: 0.26, W: 0.44, O: 0.62, Y: 0.78, C: 0.88, M: 0.58 };
const OPAQUE = { K: '#050505', W: '#ffffff', O: '#ff6a13', Y: '#fce300', C: '#0086d6', M: '#ec008c' };
const GAINS = [0.82, 0.93, 0.88];
const PLATE = C.hexToRgb01('#2a2a2a');
const lin = hex => { const r = C.hexToRgb01(hex); return [C.srgbToLinear(r.r), C.srgbToLinear(r.g), C.srgbToLinear(r.b)]; };
const O = {}; for (const k of Object.keys(TRUE_HD)) O[k] = lin(OPAQUE[k]);
const T = (k, d) => Math.pow(10, -d / TRUE_HD[k]);
const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
const plateLin = [C.srgbToLinear(PLATE.r), C.srgbToLinear(PLATE.g), C.srgbToLinear(PLATE.b)];
const BASE = {
  K: mix(O.K, plateLin, T('K', layout.baseHeight)),
  W: mix(O.W, plateLin, T('W', layout.baseHeight))
};
function cellLinear(cell) {
  let v = BASE[cell.base].slice();
  for (const f of cell.recipe) v = mix(O[f], v, T(f, layout.layerHeight));
  return v;
}
const MARKER_LIN = layout.markers.map(m => mix(O[m.filament], BASE[m.filament === 'W' ? 'K' : 'W'], T(m.filament, 2 * layout.layerHeight)));
const toCam = v => v.map((x, i) => C.linearToSrgb8(Math.min(1, x * GAINS[i])));

/* ---- rasterise straight, then warp + noise ---- */
const SCALE = 12, OFF = 60;
const N = Math.round(100 * SCALE + 2 * OFF);
const straight = new Uint8ClampedArray(N * N * 4);
const baseCam = { K: toCam(BASE.K), W: toCam(BASE.W) };
const cellCam = layout.cells.map(c => toCam(cellLinear(c)));
const markerCam = MARKER_LIN.map(toCam);
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const mmX = (x - OFF) / SCALE, mmY = (y - OFF) / SCALE;
  let rgb = [128, 128, 128];
  if (mmX >= 0 && mmY >= 0 && mmX <= 100 && mmY <= 100) {
    rgb = baseCam[mmY < 50 ? 'K' : 'W'];
    for (let i = 0; i < layout.markers.length; i++) {
      const m = layout.markers[i];
      if (mmX >= m.x && mmX <= m.x + m.size && mmY >= m.y && mmY <= m.y + m.size) rgb = markerCam[i];
    }
    for (let i = 0; i < layout.cells.length; i++) {
      const c = layout.cells[i];
      if (mmX >= c.x && mmX <= c.x + c.size && mmY >= c.y && mmY <= c.y + c.size) rgb = cellCam[i];
    }
  }
  const p = (y * N + x) * 4;
  straight[p] = rgb[0]; straight[p + 1] = rgb[1]; straight[p + 2] = rgb[2]; straight[p + 3] = 255;
}
const srcCorners = [{ cx: OFF, cy: OFF }, { cx: OFF + 100 * SCALE, cy: OFF }, { cx: OFF + 100 * SCALE, cy: OFF + 100 * SCALE }, { cx: OFF, cy: OFF + 100 * SCALE }];
const dstCorners = [{ cx: OFF + 6, cy: OFF + 4 }, { cx: OFF + 100 * SCALE - 8, cy: OFF + 10 }, { cx: OFF + 100 * SCALE - 4, cy: OFF + 100 * SCALE - 6 }, { cx: OFF + 9, cy: OFF + 100 * SCALE - 8 }];
const inv = B.homography(dstCorners, srcCorners);
let seed = 42;
const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 4 - 2; };
function warped() {
  const data = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const s = inv(x, y), sx = Math.round(s.x), sy = Math.round(s.y);
    const p = (y * N + x) * 4;
    if (sx < 0 || sy < 0 || sx >= N || sy >= N) { data[p] = data[p + 1] = data[p + 2] = 128; data[p + 3] = 255; continue; }
    const q = (sy * N + sx) * 4;
    for (let c = 0; c < 3; c++) data[p + c] = straight[q + c] + noise();
    data[p + 3] = 255;
  }
  return { width: N, height: N, data };
}
function rot90cw(img) {
  const data = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const p = (y * N + x) * 4, q = (x * N + (N - 1 - y)) * 4; // new(x,y) = old(x, N-1-y): 90° CCW
    for (let c = 0; c < 4; c++) data[p + c] = img.data[q + c];
  }
  return { width: N, height: N, data };
}
function mirrorX(img) {
  const data = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const p = (y * N + x) * 4, q = (y * N + (N - 1 - x)) * 4;
    for (let c = 0; c < 4; c++) data[p + c] = img.data[q + c];
  }
  return { width: N, height: N, data };
}

/* Palette deliberately shuffled: roles must be recovered from luminance/hue. */
const palette = [
  { id: 'y', name: 'Yellow', hex: '#fce300', td: 6, brand: 'T', material: 'PLA' },
  { id: 'k', name: 'Black', hex: '#0a0a0a', td: 0.6, brand: 'T', material: 'PLA' },
  { id: 'm', name: 'Magenta', hex: '#ec008c', td: 5, brand: 'T', material: 'PLA' },
  { id: 'w', name: 'Jade White', hex: '#ffffff', td: 5, brand: 'T', material: 'PLA' },
  { id: 'c', name: 'Cyan', hex: '#0086d6', td: 3.5, brand: 'T', material: 'PLA' },
  { id: 'o', name: 'Orange', hex: '#ff6a13', td: 5, brand: 'T', material: 'PLA' }
];
const mapping = M.matchMatrixPalette(palette);
assert.deepEqual(mapping, { K: 1, W: 3, O: 5, Y: 0, C: 4, M: 2 }, 'board roles map onto the shuffled palette');
assert.throws(() => M.matchMatrixPalette(palette.slice(0, 5)), /六类/);

function checkResult(result, tag) {
  assert.equal(result.results.length, 6);
  for (const r of result.results) {
    const truth = TRUE_HD[r.code];
    assert.ok(Math.abs(r.hd - truth) / truth < 0.12, `${tag} ${r.code} HD ${r.hd.toFixed(3)} vs ${truth}`);
    const de = C.deltaE2000(C.hexToLab(r.hex), C.hexToLab(OPAQUE[r.code]));
    assert.ok(de < 3, `${tag} ${r.code} hex ΔE ${de.toFixed(2)}`);
    assert.ok(r.opaqueFit, `${tag} ${r.code} identifiable`);
    assert.ok(r.score > 0.5, `${tag} ${r.code} score ${r.score.toFixed(2)}`);
  }
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(result.whiteBalance.cameraGains[c] - GAINS[c]) < 0.05, `${tag} gain ${c}`);
  assert.ok(result.matrixChecks.meanDE < 3, `${tag} mixed cross-check mean ΔE ${result.matrixChecks.meanDE.toFixed(2)}`);
  assert.ok(result.matrixChecks.maxDE < 6, `${tag} mixed cross-check max ΔE ${result.matrixChecks.maxDE.toFixed(2)}`);
  console.log(`${tag}: HD ` + result.results.map(r => `${r.code} ${r.hd.toFixed(2)}`).join(' ') +
    ` · mixed ΔE mean ${result.matrixChecks.meanDE.toFixed(2)} max ${result.matrixChecks.maxDE.toFixed(2)}`);
}

checkResult(M.analyzeMatrixPhoto(warped(), palette), 'warped');
checkResult(M.analyzeMatrixPhoto(rot90cw(warped()), palette), 'rotated90');
const mirrored = M.analyzeMatrixPhoto(mirrorX(warped()), palette);
checkResult(mirrored, 'mirrored');
assert.equal(mirrored.orientation.mirror, true, 'mirrored photo detected as reflection');
assert.equal(M.analyzeMatrixPhoto(rot90cw(warped()), palette).orientation.mirror, false, 'rotated photo not flagged mirrored');

/* wrong board type must fail loudly, not silently mis-fit */
const blank = { width: 400, height: 400, data: new Uint8ClampedArray(400 * 400 * 4).fill(128) };
assert.throws(() => M.analyzeMatrixPhoto(blank, palette), /定位点/);
console.log('all matrix-calibration checks passed');