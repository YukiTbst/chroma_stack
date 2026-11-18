import { createRequire } from 'module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/engine.js');
globalThis.earcut = require('../app/js/earcut.js');
require('../app/js/zip.js');
require('../app/js/exporter.js');
const { exporter, color } = globalThis.CS;

// A white plate with one gradient pixel whose eighth recipe layer is black.
// Web layer 13 (z index 12) is therefore black; layers 14+ have no material
// at that XY and must expose black, never a newly introduced white solid.
const w = 20, h = 20, n = w * h, at = 10 * w + 10;
const palette = [
  { name: 'Black', hex: '#000000', td: 0.6, brand: 'Test', material: 'PLA', lab: color.hexToLab('#000000') },
  { name: 'Jade White', hex: '#ffffff', td: 5, brand: 'Test', material: 'PLA', lab: color.hexToLab('#ffffff') }
];
const flatMask = new Uint8Array(n).fill(1);
const flatFilament = new Uint16Array(n).fill(1);
const nearest = new Uint16Array(n).fill(1);
const familyId = new Int16Array(n).fill(-1);
flatMask[at] = 0; flatFilament[at] = 0xffff; familyId[at] = 0;
const family = {
  targetLab: palette[0].lab, predictedLab: palette[0].lab, targetHex: '#000000', predictedHex: '#000000',
  recipe: [1, 1, 1, 1, 1, 1, 1, 0], pixelCount: 1, layers: 8, deltaE: 0
};
const predicted = Array.from({ length: n }, (_, i) => i === at
  ? { lab: palette[0].lab, hex: '#000000', family: 0 }
  : { lab: palette[1].lab, hex: '#ffffff', filamentIndex: 1 });
const plan = {
  engine: 'td', w, h, n, widthMm: 40, heightMm: 40, pixelSize: 2,
  layerHeight: 0.08, flatLayers: 20, gradStartLayer: 5, gradTopLayer: 20,
  actualGradTopLayer: 20, maxGradLayers: 15, maxLayers: 20,
  flatTopMm: 1.6, gradTopMm: 1.6, actualGradTopMm: 1.6, reliefMm: 0,
  variableHeight: true, palette, foundation: palette[1], foundationIndex: 1,
  flatMask, flatFilament, nearest, familyId, families: [family], predicted,
  lineWidthMm: 0.42, smoothMm: 1.1, smoothRadiusPx: 0,
  structureCleanup: { minAreaPx: 0, edgeOnly: false },
  lineProtectMask: new Uint8Array(n), lineDirectMask: null,
  lineInfo: { strokePercent: 1 / n * 100, directPercent: 0 },
  lineMode: 'auto', lineApplied: true, edgeClean: 0, edgePixelPercent: 0,
  stats: {
    meanDE: 0, p90: 0, toolChanges: 1, smoothLevel: 0,
    heightShortenedFamilies: 0, heightMergedFamilies: 0, heightSavedLayers: 0,
    supportAddedPixels: 0, supportAddedLayers: []
  }
};
plan.lineProtectMask[at] = 1;

function expectedFilament(plane, i, z) {
  if (plane.flatMask[i]) return z < plan.flatLayers ? plane.flatFilament[i] : -1;
  if (z < plan.gradStartLayer) return plan.foundationIndex;
  const f = plane.familyId[i], li = z - plan.gradStartLayer;
  return f >= 0 && li >= 0 && li < plan.families[f].recipe.length ? plan.families[f].recipe[li] : -1;
}
function prismFilament(prisms, i, z) {
  let found = -1;
  for (let f = 0; f < prisms.length; f++) {
    for (const prism of prisms[f]) {
      if (prism.mask[i] && z >= prism.z0 && z < prism.z1) {
        assert.equal(found, -1, `multiple prisms cover pixel ${i}, z ${z}`);
        found = f;
      }
    }
  }
  return found;
}

const native = exporter.samplePlane(plan, w, h);
assert.deepEqual(native.flatMask, plan.flatMask, 'native flat mask must be an exact copy');
assert.deepEqual(native.flatFilament, plan.flatFilament, 'native flat filament must be an exact copy');
assert.deepEqual(native.familyId, plan.familyId, 'native family ids must be an exact copy');
assert.equal(native.structureCleanup, null, 'native export must not run another regional cleanup');
assert.equal(expectedFilament(native, at, 12), 0, 'web/native layer 13 is black');
assert.equal(expectedFilament(native, at, 13), -1, 'web/native layer 14 has no new material');

const prisms = exporter.buildPrisms(plan, native);
for (let z = 0; z < plan.maxLayers; z++) {
  for (let i = 0; i < n; i++) {
    assert.equal(prismFilament(prisms, i, z), expectedFilament(native, i, z),
      `prism material mismatch at pixel ${i}, z ${z}`);
  }
}
assert.equal(prismFilament(prisms, at, 12), 0, 'black prism ends at layer 13 top');
assert.equal(prismFilament(prisms, at, 13), -1, 'no white prism may cover the black pixel in layer 14');
for (let z = 13; z < 20; z++) assert.equal(prismFilament(prisms, at, z), -1, `no white solid above ended black recipe at z ${z}`);

const out = exporter.build3MFBytes(plan);
assert.equal(out.ew, w, 'default export uses native width instead of silently downsampling to 300');
assert.equal(out.eh, h, 'default export uses native height');
assert.equal(Buffer.from(out.bytes.slice(0, 4)).toString('hex'), '504b0304', 'native 3MF is a valid ZIP');

// Flat regions now share the gradient foundation: substrate below gradStart,
// matched flat colour up to flatTop. Pixel 0 is a flat white pixel.
const plan2 = { ...plan, flatBaseLayers: 5, foundationIndex: 0 };
const native2 = exporter.samplePlane(plan2, w, h);
const prisms2 = exporter.buildPrisms(plan2, native2);
assert.equal(prismFilament(prisms2, 0, 0), 0, 'flat pixel starts on the foundation');
assert.equal(prismFilament(prisms2, 0, 4), 0, 'foundation runs through gradStart-1');
assert.equal(prismFilament(prisms2, 0, 5), 1, 'true flat colour starts at gradStartLayer');
assert.equal(prismFilament(prisms2, 0, 19), 1, 'flat colour reaches the flat top');
assert.equal(prismFilament(prisms2, 0, 20), -1, 'nothing above the flat top');
console.log('all native layer-consistency checks passed');
