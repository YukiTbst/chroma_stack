import { createRequire } from 'module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/view3d.js');
const { view3d, color } = globalThis.CS;

const w = 20, h = 20, n = w * h, at = 10 * w + 10;
const palette = [
  { name: 'Black', hex: '#000000' },
  { name: 'White', hex: '#ffffff' }
];
const flatMask = new Uint8Array(n).fill(1);
const flatFilament = new Uint16Array(n).fill(1);
const familyId = new Int16Array(n).fill(-1);
flatMask[at] = 0; flatFilament[at] = 0xffff; familyId[at] = 0;
const preview = new Uint8ClampedArray(n * 4).fill(255);
preview[at * 4] = preview[at * 4 + 1] = preview[at * 4 + 2] = 0;
const plan = {
  w, h, widthMm: 40, heightMm: 40, layerHeight: 0.08,
  flatMask, flatFilament, familyId, flatLayers: 20, gradStartLayer: 5,
  foundationIndex: 1, families: [{ recipe: [1, 1, 1, 1, 1, 1, 1, 0] }],
  palette, preview
};
assert.equal(view3d._materialAt(plan, at, 11), 1, 'foundation below the short black recipe is white');
assert.equal(view3d._materialAt(plan, at, 12), 0, 'layer 13 material is black');
assert.equal(view3d._materialAt(plan, at, 13), -1, 'layer 14 has no material above black');
assert.equal(view3d._sampleCell(plan, 0, 0, w, h).i, 0, 'native stack starts at source pixel (0,0), not (1,1)');
assert.equal(view3d._sampleCell(plan, w - 1, h - 1, w, h).i, n - 1, 'native stack ends at the last source pixel without duplication');

// Native front-camera projection must preserve image left/right and top/bottom.
view3d._V.dims = { w: 75, h: 75 };
view3d.reset();
const cam = view3d.getCamera();
assert.ok(Math.abs(cam.yaw - (Math.PI / 2 - 0.28)) < 1e-12, 'reset returns to a slightly angled front view');
const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
const eye = [cam.dist * Math.cos(cam.yaw) * cp, cam.targetY + cam.dist * sp, cam.dist * Math.sin(cam.yaw) * cp];
const view = view3d._math.lookAt(eye, [0, cam.targetY, 0], [0, 1, 0]);
const proj = view3d._math.perspective(35 * Math.PI / 180, 1, 0.1, 2000);
const mvp = view3d._math.mul4(proj, view);
function ndc(x, y, z) {
  const q = [x, y, z, 1], out = [];
  for (let r = 0; r < 4; r++) out[r] = mvp[r] * q[0] + mvp[4 + r] * q[1] + mvp[8 + r] * q[2] + mvp[12 + r] * q[3];
  return [out[0] / out[3], out[1] / out[3]];
}
const left = ndc(-37.5, cam.targetY, 0), right = ndc(37.5, cam.targetY, 0);
const top = ndc(0, cam.targetY, -37.5), bottom = ndc(0, cam.targetY, 37.5);
assert.ok(right[0] > left[0], 'image right projects to screen right (no horizontal mirror)');
assert.ok(top[1] > bottom[1], 'image top projects to screen top (no vertical mirror)');

// Capture the actual stack/section vertex buffers without requiring a GPU.
const buffers = {};
const gl = {
  ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, STATIC_DRAW: 3,
  UNSIGNED_INT: 4, UNSIGNED_SHORT: 5,
  bindBuffer() {},
  bufferData(target, data) { if (data instanceof Float32Array) buffers.vertices = data; else buffers.indices = data; }
};
const V = view3d._V;
V.gl = gl; V.vbo = {}; V.ibo = {}; V.uint32Ext = {};
V.plan = plan; V.mode = 'stack'; V.section = true; V.sectionPos = 0.5; V.exag = 8;
view3d._buildMesh();
assert.ok(V.indexCount > 0 && V.sectionCount > 0, 'stack and cross-section both generate geometry');
assert.equal(V.indexType, gl.UNSIGNED_INT, 'large stack uses 32-bit indices when available');
assert.ok(buffers.indices instanceof Uint32Array, 'stack index buffer is Uint32');
const verts = buffers.vertices;
const layerHeight = plan.layerHeight * V.exag;
const y0 = 12 * layerHeight, y1 = 13 * layerHeight;
const planeX = -plan.widthMm / 2 + 11 * plan.widthMm / w;
let blackBand = 0, whiteBand = 0, whiteBelow = 0;
for (let i = 0; i < verts.length; i += 9) {
  const x = verts[i], y = verts[i + 1], r = verts[i + 3], g = verts[i + 4], b = verts[i + 5];
  if (Math.abs(x - planeX) > 1e-6) continue;
  if (y >= y0 - 1e-6 && y <= y1 + 1e-6) {
    if (r === 0 && g === 0 && b === 0) blackBand++;
    if (y > y0 + 1e-6 && y < y1 - 1e-6 && r === 1 && g === 1 && b === 1) whiteBand++;
  }
  if (y < y0 && r === 1 && g === 1 && b === 1) whiteBelow++;
}
assert.ok(blackBand >= 4, 'cross-section contains the actual black layer-13 slab');
assert.ok(whiteBelow >= 4, 'cross-section contains white material below black');
assert.equal(whiteBand, 0, 'cross-section does not paint white inside the ended black layer');

V.section = false; V.mode = 'finish';
view3d._buildMesh();
assert.equal(V.sectionCount, 0, 'finish mode has no stack cross-section');
assert.equal(V.indexType, gl.UNSIGNED_INT, 'finish heightfield also uses 32-bit indices when available');
let wallTriangles = 0;
for (let k = 0; k < buffers.indices.length; k += 3) {
  const ia = buffers.indices[k] * 9, ib = buffers.indices[k + 1] * 9, ic = buffers.indices[k + 2] * 9;
  const dark = [ia, ib, ic].every(j => Math.abs(buffers.vertices[j + 3] - 0.055) < 1e-4 && Math.abs(buffers.vertices[j + 4] - 0.062) < 1e-4 && Math.abs(buffers.vertices[j + 5] - 0.068) < 1e-4);
  if (!dark) continue;
  const a = [buffers.vertices[ia], buffers.vertices[ia + 1], buffers.vertices[ia + 2]];
  const b = [buffers.vertices[ib], buffers.vertices[ib + 1], buffers.vertices[ib + 2]];
  const c = [buffers.vertices[ic], buffers.vertices[ic + 1], buffers.vertices[ic + 2]];
  const u = b.map((v, d) => v - a[d]), v = c.map((v, d) => v - a[d]);
  const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const dot = cross[0] * buffers.vertices[ia + 6] + cross[1] * buffers.vertices[ia + 7] + cross[2] * buffers.vertices[ia + 8];
  assert.ok(dot > 0, 'finish wall winding agrees with its declared outward normal');
  wallTriangles++;
}
assert.ok(wallTriangles > 0, 'finish wall winding test actually inspected wall triangles');

// Without OES_element_index_uint, preserve stack/section by reducing the grid.
const cw = 110, ch = 110, cn = cw * ch;
const cFlat = new Uint8Array(cn), cFilament = new Uint16Array(cn).fill(0xffff), cFamily = new Int16Array(cn);
const cPreview = new Uint8ClampedArray(cn * 4);
for (let i = 0; i < cn; i++) {
  cFamily[i] = ((i % cw) + ((i / cw) | 0)) % 2;
  const v = cFamily[i] ? 255 : 0;
  cPreview[i * 4] = cPreview[i * 4 + 1] = cPreview[i * 4 + 2] = v; cPreview[i * 4 + 3] = 255;
}
const checker = { ...plan, w: cw, h: ch, n: cn, flatMask: cFlat, flatFilament: cFilament, familyId: cFamily,
  families: [{ recipe: [0] }, { recipe: new Array(20).fill(1) }], preview: cPreview };
V.plan = checker; V.uint32Ext = null; V.mode = 'stack'; V.section = true; V.sectionPos = 0.5;
view3d._buildMesh();
assert.equal(V.mode, 'stack', '16-bit fallback still reports the real stack mode');
assert.ok(V.vertexCount <= 65535, '16-bit stack reduces its grid to valid vertex counts');
assert.ok(buffers.indices instanceof Uint16Array, '16-bit fallback uses Uint16 indices');
assert.ok(V.sectionCount > 0, '16-bit fallback preserves the material cross-section');

// A single printable pixel on a large image must not disappear in preview.
const sw = 640, sn = sw * sw, singleMask = new Uint8Array(sn), singleFlat = new Uint8Array(sn).fill(1);
const singleFilament = new Uint16Array(sn).fill(1), singleFamily = new Int16Array(sn).fill(-1);
singleMask[12345] = 1;
const single = { ...plan, w: sw, h: sw, n: sn, flatMask: singleFlat, flatFilament: singleFilament,
  familyId: singleFamily, printMask: singleMask, preview: new Uint8ClampedArray(sn * 4).fill(255), families: [] };
V.plan = single; V.uint32Ext = {}; V.mode = 'stack'; V.section = false;
view3d._buildMesh();
assert.ok(V.indexCount > 0, '3D footprint search preserves a single printable pixel');
console.log('all 3D material-stack and orientation checks passed');
