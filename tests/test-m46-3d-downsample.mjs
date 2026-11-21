/* m46 #98: downsampled 3D sidewall / cross-section must sample the NATIVE source
   pixel (source[gridIndex]), not the grid index itself. buildStackMesh reduces the
   grid when the plan is larger than maxGrid; layeredFace was passed the grid index
   i=y*gw+x and called materialAt(plan,i,z) as if it were a native pixel index, so
   walls/section read the wrong material once gw<plan.w.
   Run: node tests/test-m46-3d-downsample.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/view3d.js');
const { view3d } = globalThis.CS;

// Native 300x40 plan, all flat: left half (nativeX<150) black top, right half white.
const w = 300, h = 40, n = w * h;
const flatMask = new Uint8Array(n).fill(1);
const flatFilament = new Uint16Array(n);
const familyId = new Int16Array(n).fill(-1);
const preview = new Uint8ClampedArray(n * 4);
for (let i = 0; i < n; i++) {
  const black = (i % w) < 150;
  flatFilament[i] = black ? 0 : 1;
  const v = black ? 0 : 255;
  preview[i * 4] = preview[i * 4 + 1] = preview[i * 4 + 2] = v; preview[i * 4 + 3] = 255;
}
const plan = {
  w, h, n, widthMm: 60, heightMm: 8, layerHeight: 0.08,
  flatMask, flatFilament, familyId, flatLayers: 10, flatBaseLayers: 5, gradStartLayer: 5,
  foundationIndex: 1, families: [], palette: [{ name: 'Black', hex: '#000000' }, { name: 'White', hex: '#ffffff' }], preview
};

const buffers = {};
const gl = { ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, STATIC_DRAW: 3, UNSIGNED_INT: 4, UNSIGNED_SHORT: 5, bindBuffer() {}, bufferData(t, d) { if (d instanceof Float32Array) buffers.vertices = d; else buffers.indices = d; } };
const V = view3d._V;
V.gl = gl; V.vbo = {}; V.ibo = {}; V.uint32Ext = {};
V.plan = plan; V.mode = 'stack'; V.section = true; V.sectionPos = 0.25; V.exag = 8;
view3d._buildMesh();

// Grid is downsampled: gw=240 (<300), gh=32. Section cut at grid x=60 -> native x~75
// (left/black half). Every section flat-band quad (layers 5..9) must be BLACK.
const gw = 240, gh = 32, cut = Math.round(0.25 * (gw - 1));
const cw = plan.widthMm / gw, lh = plan.layerHeight * V.exag;
const planeX = -plan.widthMm / 2 + (cut + 1) * cw;
const bandLo = 5 * lh, bandHi = 10 * lh;
// Confirm the source column really is the black half.
const srcI = view3d._sampleCell(plan, cut, 0, gw, gh).i;
assert.ok((srcI % w) < 150, 'section column maps to the black (left) native half');
assert.equal(view3d._materialAt(plan, srcI, 7), 0, 'native source flat band is black');

let bandVerts = 0, wrongWhite = 0;
const verts = buffers.vertices;
for (let i = 0; i < verts.length; i += 9) {
  const x = verts[i], y = verts[i + 1], r = verts[i + 3], g = verts[i + 4], b = verts[i + 5];
  if (Math.abs(x - planeX) > 1e-6) continue;           // section plane only
  if (y < (bandLo + bandHi) / 2) continue;              // upper half of the flat band (top edge verts)
  bandVerts++;
  if (r > 0.5 && g > 0.5 && b > 0.5) wrongWhite++;      // white where black belongs
}
assert.ok(bandVerts > 0, 'section flat band produced vertices');
assert.equal(wrongWhite, 0, `downsampled section must read native source material (found ${wrongWhite} white verts in the black half)`);
console.log(`downsampled 3D section native-index passed: ${bandVerts} band verts, 0 wrong-material`);