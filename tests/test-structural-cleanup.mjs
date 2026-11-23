import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/engine.js');
require('../app/js/exporter.js');
const { engine, exporter } = globalThis.CS;

const palette = [
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 },
  { name: 'Yellow', hex: '#fce300', td: 6 },
  { name: 'Blue', hex: '#00358e', td: 4 }
];
const base = {
  engine: 'td', palette, foundationIndex: 1, widthMm: 75, flatTopMm: 1.6,
  reliefMm: 0.16, gradStartLayerOverride: 16, gradTopMmOverride: 1.76,
  gradLayers: 6, layerHeight: 0.08, families: 96, stdThreshold: 0,
  residualThreshold: 5, minFlatPercent: 0.6, lineWidthMm: 0.42,
  mergeDeltaE: 4, heightMergeDeltaE: 1.5, lineProtect: 'auto'
};
let failures = 0;
const check = (ok, msg) => {
  if (!ok) { failures++; console.error('FAIL', msg); }
  else console.log('ok  ', msg);
};

function makeNoisyLineArt(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  const set = (x, y, r, g, b) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const p = (y * w + x) * 4;
    data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
  };
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  // Large genuine regions must survive cleanup.
  for (let y = 28; y < 76; y++) for (let x = 25; x < 78; x++) set(x, y, 192, 13, 30);
  for (let y = 30; y < 82; y++) for (let x = 156; x < 207; x++) set(x, y, 0, 53, 142);
  // Enough real gradient area to activate edge cleanup (the engine deliberately
  // skips it on nearly-flat line art with less than 20% gradient pixels).
  for (let y = 12; y < 122; y++) for (let x = 88; x < 198; x++) {
    set(x, y, 80 + Math.round((x - 88) * 0.8), 60 + Math.round((y - 12) * 1.1), 180 - Math.round((x - 88) * 0.5));
  }
  // Continuous dark outline and diagonal line art.
  for (let x = 70; x <= 180; x++) {
    set(x, 105, 5, 5, 8); set(x, 106, 5, 5, 8);
    set(x, 180, 5, 5, 8); set(x, 181, 5, 5, 8);
  }
  for (let y = 105; y <= 181; y++) {
    set(70, y, 5, 5, 8); set(71, y, 5, 5, 8);
    set(180, y, 5, 5, 8); set(181, y, 5, 5, 8);
  }
  for (let t = 0; t < 110; t++) set(30 + t, 210 - t, 5, 5, 8);
  // Isolated primary/dark pixels mimic compression and anti-alias speckle.
  const colours = [[5, 5, 8], [192, 13, 30], [0, 53, 142], [245, 220, 20]];
  let seed = 1234567;
  for (let k = 0; k < 180; k++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const x = 8 + (seed % (w - 16));
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const y = 8 + (seed % (h - 16));
    const c = colours[k % colours.length];
    set(x, y, c[0], c[1], c[2]);
  }
  return { width: w, height: h, data };
}

function regionKeys(p) {
  const keys = new Int32Array(p.n);
  for (let i = 0; i < p.n; i++) keys[i] = p.flatMask[i] ? p.flatFilament[i] + 1 : -(p.familyId[i] + 2);
  return keys;
}

function componentStats(p) {
  const keys = regionKeys(p), seen = new Uint8Array(p.n), stack = new Int32Array(p.n);
  let components = 0, single = 0, belowMinimum = 0;
  const minArea = p.structureCleanup.minAreaPx || 2;
  for (let start = 0; start < p.n; start++) {
    if (seen[start]) continue;
    const key = keys[start];
    let top = 0, area = 0, protectedComponent = false;
    seen[start] = 1; stack[top++] = start;
    while (top) {
      const i = stack[--top]; area++;
      if (p.lineProtectMask && p.lineProtectMask[i]) protectedComponent = true;
      const x = i % p.w, y = (i / p.w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= p.w || yy < 0 || yy >= p.h) continue;
        const j = yy * p.w + xx;
        if (!seen[j] && keys[j] === key) { seen[j] = 1; stack[top++] = j; }
      }
    }
    components++;
    if (area === 1) single++;
    if (area < minArea && !protectedComponent) belowMinimum++;
  }
  return { components, single, belowMinimum };
}

function checkConsistent(p, name) {
  let valid = true;
  const counts = new Uint32Array(p.families.length);
  for (let i = 0; i < p.n; i++) {
    if (p.flatMask[i]) {
      if (p.flatFilament[i] === 0xffff || p.familyId[i] !== -1) valid = false;
    } else {
      const f = p.familyId[i];
      if (f < 0 || !p.families[f] || !p.families[f].recipe.length) valid = false;
      else counts[f]++;
    }
  }
  for (let f = 0; f < counts.length; f++) if (counts[f] !== p.familyPixels[f]) valid = false;
  check(valid, name + ': flat/family/filament representations and counts stay consistent');
}

const art = makeNoisyLineArt(240, 240);
const raw = await engine.buildPlan(art, { ...base, smoothMm: 0, edgeClean: 0, vectorFlat: false });
const variants = {
  smooth: await engine.buildPlan(art, { ...base, smoothMm: 3, edgeClean: 0, vectorFlat: false }),
  vector: await engine.buildPlan(art, { ...base, smoothMm: 0, edgeClean: 0, vectorFlat: true }),
  edge: await engine.buildPlan(art, { ...base, smoothMm: 0, edgeClean: 3, vectorFlat: false }),
  all: await engine.buildPlan(art, { ...base, smoothMm: 3, edgeClean: 3, vectorFlat: true })
};
const rawStats = componentStats(raw);
console.log('raw', rawStats);
check(rawStats.single > 20, 'synthetic source reproduces isolated single-pixel regions');
for (const [name, p] of Object.entries(variants)) {
  const s = componentStats(p);
  console.log(name, { ...s, meanDE: +p.stats.meanDE.toFixed(2), cleanup: p.structureCleanup });
  check(s.single === 0, name + ': no isolated single-pixel printable region remains');
  check(s.belowMinimum === 0, name + ': unprotected regions converge to the nozzle-scale minimum area');
  check(s.components < rawStats.components, name + ': cleanup reduces rather than creates regions');
  check(p.structureCleanup.converged, name + ': iterative cleanup converges');
  checkConsistent(p, name);
}

const srcLab = engine.imageToLab(art).lab;
let lifted = 0;
// Isolated dark speckles are meant to be absorbed. Check the known continuous
// diagonal instead of granting every protected noise pixel immunity.
for (let t = 0; t < 110; t++) {
  const i = (210 - t) * art.width + 30 + t;
  if (variants.all.predicted[i].lab.L > srcLab[i * 3] + 30) lifted++;
}
check(lifted === 0, 'physical cleanup does not lift the continuous dark stroke to a light recipe');

const strong = await engine.buildPlan(art, { ...base, smoothMm: 3, edgeClean: 3, vectorFlat: true, lineProtect: 'strong' });
let diagonalDark = 0;
for (let t = 0; t < 110; t++) {
  const i = (210 - t) * art.width + 30 + t;
  if (strong.flatMask[i] && strong.predicted[i].lab.L < 20) diagonalDark++;
}
check(diagonalDark >= 105, 'strong direct line remains continuous after nozzle-scale island cleanup');
checkConsistent(strong, 'strong');

// All-flat mask overrides used to skip the gradient-only cleanup entirely.
const w = 40, h = 40, flatData = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) {
  flatData[i * 4] = flatData[i * 4 + 1] = flatData[i * 4 + 2] = 255;
  flatData[i * 4 + 3] = 255;
}
const center = (20 * w + 20) * 4;
flatData[center] = 192; flatData[center + 1] = 13; flatData[center + 2] = 30;
const flatImage = { width: w, height: h, data: flatData };
const maskOverride = new Uint8Array(w * h).fill(1);
const flatClean = await engine.buildPlan(flatImage, { ...base, widthMm: 75, maskOverride, smoothMm: 3, edgeClean: 0, vectorFlat: false });
check(flatClean.flatMask[20 * w + 20] === 1 && flatClean.flatFilament[20 * w + 20] === 1,
  'all-flat mask override still absorbs an isolated red pixel into white');

// Below one pixel of majority radius, smoothing itself must be a true no-op.
const subpixel = await engine.buildPlan(flatImage, { ...base, widthMm: 400, maskOverride, smoothMm: 0.8, edgeClean: 0, vectorFlat: false });
check(subpixel.smoothRadiusPx === 0 && subpixel.structureCleanup.mergedPixels === 0 && subpixel.flatFilament[20 * w + 20] === 2,
  'subpixel smoothing does not secretly run island cleanup');
const subpixelEdge = await engine.buildPlan(art, { ...base, widthMm: 400, smoothMm: 0.8, edgeClean: 1, vectorFlat: false });
check(subpixelEdge.smoothRadiusPx === 0 && subpixelEdge.structureCleanup.edgeOnly,
  'subpixel physical smoothing does not widen edge-only cleanup to the whole image');

const dotData = new Uint8ClampedArray(flatData);
dotData[center] = dotData[center + 1] = dotData[center + 2] = 0;
const directDot = await engine.buildPlan({ width: w, height: h, data: dotData },
  { ...base, widthMm: 75, smoothMm: 3, edgeClean: 0, vectorFlat: false, lineProtect: 'strong' });
check(directDot.predicted[20 * w + 20].lab.L > 90 && directDot.lineDirectMask && directDot.lineDirectMask[20 * w + 20] === 0,
  'an isolated strong-line dot cleared to white also loses its direct-stroke marker');

// Downsampling must vote over the source footprint, not resurrect the centre
// pixel as an island. Positive keys are flat filaments; negative are families.
const sampleBase = {
  w: 4, h: 4,
  flatMask: new Uint8Array(16).fill(1),
  flatFilament: new Uint16Array(16).fill(1),
  familyId: new Int16Array(16).fill(-1),
  lineProtectMask: new Uint8Array(16),
  lineDirectMask: null
};
sampleBase.flatFilament[1 * 4 + 1] = 2; // old nearest centre of output (0,0)
const majority = exporter.samplePlane(sampleBase, 2, 2);
check(majority.flatMask[0] === 1 && majority.flatFilament[0] === 1,
  '3MF downsampling does not resurrect a single centre pixel as an island');

const tie = { ...sampleBase, flatFilament: new Uint16Array(16).fill(1), lineProtectMask: new Uint8Array(16) };
for (const x of [0, 1]) { tie.flatFilament[x] = 0; tie.lineProtectMask[x] = 1; }
const tieSample = exporter.samplePlane(tie, 2, 2);
check(tieSample.flatMask[0] === 1 && tieSample.flatFilament[0] === 0,
  '3MF downsampling keeps a protected continuous stroke on an exact tie');

const cross = {
  ...sampleBase,
  flatMask: new Uint8Array(16),
  flatFilament: new Uint16Array(16).fill(0xffff),
  familyId: new Int16Array(16)
};
cross.flatMask[1 * 4 + 1] = 1; cross.flatFilament[1 * 4 + 1] = 2; cross.familyId[1 * 4 + 1] = -1;
const crossSample = exporter.samplePlane(cross, 2, 2);
check(crossSample.flatMask[0] === 0 && crossSample.familyId[0] === 0 && crossSample.flatFilament[0] === 0xffff,
  '3MF footprint voting remains consistent across flat/family representations');

// Winning-region Lab, not the minority centre colour, guides export cleanup.
// Desired 3×3 plane: red singleton at (0,0), a stable blue domino at (1,0)/(1,1),
// and near-red elsewhere. The red singleton must choose near-red, not blue.
const sw = 6, colours = ['#c00d1e', '#d1293b', '#00358e'];
const colourPlan = {
  w: sw, h: sw, widthMm: 60, lineWidthMm: 0.42,
  flatMask: new Uint8Array(sw * sw).fill(1),
  flatFilament: new Uint16Array(sw * sw).fill(1),
  familyId: new Int16Array(sw * sw).fill(-1),
  lineProtectMask: new Uint8Array(sw * sw), lineDirectMask: null,
  families: [], structureCleanup: { minAreaPx: 2, edgeOnly: false },
  palette: colours.map(hex => ({ hex, lab: CS.color.hexToLab(hex) })),
  predicted: []
};
for (let i = 0; i < sw * sw; i++) colourPlan.predicted[i] = { lab: CS.color.hexToLab(colours[1]) };
const setOutputColour = (ox, oy, fi) => {
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const i = (oy * 2 + dy) * sw + ox * 2 + dx;
    colourPlan.flatFilament[i] = fi;
    colourPlan.predicted[i] = { lab: CS.color.hexToLab(colours[fi]) };
  }
};
setOutputColour(1, 0, 2); setOutputColour(1, 1, 2);
setOutputColour(0, 0, 0);
colourPlan.flatFilament[1 * sw + 1] = 2; // minority blue at the old centre sample
colourPlan.predicted[1 * sw + 1] = { lab: CS.color.hexToLab(colours[2]) };
const colourSample = exporter.samplePlane(colourPlan, 3, 3);
check(colourSample.flatFilament[0] === 1,
  'export cleanup uses the winning region mean Lab instead of a minority centre colour');

const sampled = exporter.samplePlane(variants.all, 120, 120);
const sampledStats = componentStats({ ...sampled, w: 120, h: 120, n: 120 * 120, structureCleanup: { minAreaPx: 2 } });
console.log('sampled export', sampledStats, sampled.structureCleanup);
check(sampledStats.single === 0, 'actual 2× export downsampling re-converges without single-pixel islands');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall structural-cleanup checks passed');
