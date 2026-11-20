import { createRequire } from 'module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/engine.js');
require('../app/js/view3d.js');
globalThis.earcut = require('../app/js/earcut.js');
require('../app/js/zip.js');
require('../app/js/exporter.js');
const { engine, exporter, view3d } = globalThis.CS;

const w = 64, h = 64, n = w * h;
const data = new Uint8ClampedArray(n * 4);
const set = (x, y, r, g, b) => {
  const p = (y * w + x) * 4;
  data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
};
for (let i = 0; i < n; i++) set(i % w, (i / w) | 0, 255, 255, 255);
for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) set(x, y, 192, 13, 30);
// Enclosed white hole: same colour as the background but not border-connected.
for (let y = 28; y < 36; y++) for (let x = 28; x < 36; x++) set(x, y, 255, 255, 255);
// Detached foreground island must remain printable.
for (let y = 50; y < 54; y++) for (let x = 50; x < 54; x++) set(x, y, 0, 53, 142);
const image = { width: w, height: h, data };
const { lab } = engine.imageToLab(image);
const detected = engine.buildPrintMask(lab, w, h, { backgroundMode: 'auto', backgroundTolerance: 8 });
const at = (x, y) => y * w + x;
assert.equal(detected.printMask[at(0, 0)], 0, 'outer white background is removed');
assert.equal(detected.printMask[at(20, 20)], 1, 'coloured foreground remains');
assert.equal(detected.printMask[at(32, 32)], 1, 'enclosed white hole is not mistaken for background');
assert.equal(detected.printMask[at(51, 51)], 1, 'detached foreground island remains');
assert.ok(detected.background.removedPixels > 0 && detected.background.printPixels < n);
const picked = engine.buildPrintMask(lab, w, h, { backgroundMode: 'pick', backgroundColor: '#ffffff', backgroundTolerance: 8 });
assert.deepEqual(picked.printMask, detected.printMask, 'manual colour picking matches automatic white-border detection');

const tinyData = new Uint8ClampedArray(16 * 16 * 4).fill(255);
const tinyAt = (x, y) => (y * 16 + x) * 4;
for (const [x, y] of [[7, 7], [8, 7], [7, 8], [8, 8], [12, 12]]) {
  tinyData[tinyAt(x, y)] = 192; tinyData[tinyAt(x, y) + 1] = 13; tinyData[tinyAt(x, y) + 2] = 30;
}
const tinyMask = engine.buildPrintMask(engine.imageToLab({ width: 16, height: 16, data: tinyData }).lab, 16, 16,
  { backgroundMode: 'auto', backgroundTolerance: 8, backgroundEnvelope: true, backgroundEnvelopeMm: 2, widthMm: 16, lineWidthMm: 0.42 });
assert.equal(tinyMask.printMask[12 * 16 + 12], 1, 'even a one-pixel source accent is never discarded for connectivity');
assert.equal(tinyMask.background.componentsAfter, 1, 'tiny accent is connected into the main entity');
assert.equal(tinyMask.background.bridges, 0, 'bubble envelope uses distance fields, never straight bridge objects');

// Near-background compression speckles above ΔE8 are absorbed only in dark
// automatic mode. Manual picking still honors the exact user tolerance.
const darkData = new Uint8ClampedArray(32 * 32 * 4);
for (let i = 0; i < 32 * 32; i++) {
  darkData[i * 4] = 40; darkData[i * 4 + 1] = 39; darkData[i * 4 + 2] = 37; darkData[i * 4 + 3] = 255;
}
for (let y = 12; y < 20; y++) for (let x = 12; x < 20; x++) {
  const p = (y * 32 + x) * 4;
  darkData[p] = 192; darkData[p + 1] = 13; darkData[p + 2] = 30;
}
const speck = 5 * 32 + 25;
darkData[speck * 4] = 38; darkData[speck * 4 + 1] = 30; darkData[speck * 4 + 2] = 41;
const darkLab = engine.imageToLab({ width: 32, height: 32, data: darkData }).lab;
const autoDark = engine.buildPrintMask(darkLab, 32, 32, { backgroundMode: 'auto', backgroundTolerance: 8, backgroundEnvelope: false });
const pickedDark = engine.buildPrintMask(darkLab, 32, 32, { backgroundMode: 'pick', backgroundColor: '#282725', backgroundTolerance: 8, backgroundEnvelope: false });
assert.equal(autoDark.background.tolerance, 12, 'dark automatic mode raises its compression tolerance');
assert.equal(autoDark.sourcePrintMask[speck], 0, 'near-background compression speck is removed automatically');
assert.equal(pickedDark.background.tolerance, 8, 'manual colour picking keeps the exact tolerance');
assert.equal(pickedDark.sourcePrintMask[speck], 1, 'manual picking does not silently widen the threshold');
const diagonalData = new Uint8ClampedArray(2 * 2 * 4).fill(255);
diagonalData[0] = diagonalData[12] = 192;
const diagonal = engine.buildPrintMask(engine.imageToLab({ width: 2, height: 2, data: diagonalData }).lab, 2, 2,
  { backgroundMode: 'auto', backgroundTolerance: 8, backgroundEnvelope: true, backgroundEnvelopeMm: 1.5, widthMm: 2, lineWidthMm: 0.42 });
assert.equal(diagonal.background.componentsBefore, 2, 'corner-only contact is not counted as a single printable entity');
assert.equal(diagonal.background.componentsAfter, 1, 'bubble fills the corner gap into a real four-connected entity');

// A narrow-mouth cavity starts connected to the exterior, then becomes an
// enclosed hole after the bubble seals its mouth. It can be deleted/restored.
const uw = 40, uh = 40, uData = new Uint8ClampedArray(uw * uh * 4).fill(255);
for (let y = 8; y < 32; y++) for (let x = 8; x < 32; x++) {
  if (!(x < 11 || x >= 29 || y < 11 || y >= 29)) continue;
  if (y < 11 && x >= 18 && x <= 21) continue;
  const p = (y * uw + x) * 4;
  uData[p] = 192; uData[p + 1] = 13; uData[p + 2] = 30;
}
const uImage = { width: uw, height: uh, data: uData };
const uOptions = { backgroundMode: 'auto', backgroundTolerance: 8, backgroundEnvelope: true, backgroundEnvelopeMm: 4, widthMm: 40, lineWidthMm: 0.42 };
const uFilled = engine.buildPrintMask(engine.imageToLab(uImage).lab, uw, uh, uOptions, 1);
const uCenter = 20 * uw + 20, holeId = uFilled.holeMap[uCenter];
assert.ok(holeId >= 0, 'closed U-shaped interior is registered as an editable hole');
assert.equal(uFilled.printMask[uCenter], 1, 'enclosed interior is filled by default');
assert.ok(uFilled.background.holes.some(h => h.id === holeId), 'hole metadata is available for point selection');
const uDeleted = engine.buildPrintMask(engine.imageToLab(uImage).lab, uw, uh, { ...uOptions, backgroundDeletedHoles: [holeId] }, 1);
assert.equal(uDeleted.printMask[uCenter], 0, 'selected internal region is deleted from the printable mask');
assert.equal(uDeleted.background.deletedHoles, 1, 'deleted internal region count is reported');
assert.equal(uDeleted.background.componentsAfter, 1, 'deleting an internal hole does not disconnect the outer envelope');
const uRestored = engine.buildPrintMask(engine.imageToLab(uImage).lab, uw, uh, uOptions, 1);
assert.equal(uRestored.printMask[uCenter], 1, 'removing the ID restores the internal region');

const whiteLab = engine.imageToLab({ width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) }).lab;
const empty = engine.buildPrintMask(whiteLab, 8, 8, { backgroundMode: 'auto', backgroundTolerance: 8 });
assert.ok(empty.background.failed, 'all-background recognition is marked as failed');
assert.equal(empty.background.removedPixels, 0, 'failed background removal reports zero actually removed pixels');
assert.ok(empty.printMask.every(v => v === 1), 'all-background image falls back to a non-empty print');

const palette = [
  { name: 'Black', hex: '#000000', td: 0.6 }, { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 }, { name: 'Yellow', hex: '#fce300', td: 6 }, { name: 'Blue', hex: '#00358e', td: 4 }
];
const base = {
  engine: 'td', palette, foundationIndex: 1, widthMm: 64, flatTopMm: 0.8, reliefMm: 0.08,
  gradStartLayerOverride: 5, gradTopMmOverride: 0.88, gradLayers: 4, layerHeight: 0.08,
  families: 16, residualThreshold: 5, minFlatPercent: 0.6, smoothMm: 0,
  lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 0, edgeClean: 0,
  vectorFlat: false, lineProtect: 'off'
};
const off = engine.buildPlan(image, { ...base, backgroundMode: 'off' });
const plan = engine.buildPlan(image, { ...base, backgroundMode: 'auto', backgroundTolerance: 8 });
assert.ok(off.printMask.every(v => v === 1), 'disabled background removal keeps the full rectangle');
assert.ok(plan.background.enabled && plan.stats.printPixels < n, 'plan exposes its printable silhouette');
assert.equal(plan.stats.flatPixels + plan.stats.gradPixels + plan.stats.supportPixels, plan.stats.printPixels, 'material statistics cover direct, gradient and support pixels exactly once');
assert.ok(plan.stats.supportPixels > 0, 'envelope support is reported separately from true gradient pixels');
assert.ok(plan.reliefMm >= 0, 'support-only additions do not create a fake negative relief height');
assert.equal(plan.preview[at(0, 0) * 4 + 3], 0, 'background preview is transparent');
assert.equal(plan.preview[at(32, 32) * 4 + 3], 255, 'enclosed white preview remains visible');
assert.equal(engine.filamentAt(plan, 0, 0, 0), -1, 'background has no material at layer 0');
assert.ok(engine.filamentAt(plan, 20, 20, 0) >= 0, 'foreground has material at layer 0');
const grams = p => p.stats.grams.reduce((a, b) => a + b, 0);
assert.ok(grams(plan) < grams(off), 'background removal reduces actual material usage');

const plane = exporter.samplePlane(plan, w, h);
assert.deepEqual(plane.printMask, plan.printMask, 'native export copies the exact silhouette');
const prisms = exporter.buildPrisms(plan, plane);
for (const group of prisms) for (const prism of group) assert.equal(prism.mask[at(0, 0)], 0, 'no prism occupies background');
const out = exporter.build3MFBytes(plan);
assert.equal(out.ew, w, 'silhouette export remains native resolution');
assert.equal(out.meta.background.enabled, true, '3MF metadata records background removal');

// Stack buffers must not include the old outer rectangular plate.
const gl = {
  ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, STATIC_DRAW: 3, UNSIGNED_INT: 4, UNSIGNED_SHORT: 5,
  bindBuffer() {}, bufferData(target, data) { if (data instanceof Float32Array) this.vertices = data; else this.indices = data; }
};
const V = view3d._V;
Object.assign(V, { gl, vbo: {}, ibo: {}, uint32Ext: {}, plan, mode: 'stack', section: true, sectionPos: 0.5, exag: 8 });
view3d._buildMesh();
const verts = gl.vertices;
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (let i = 0; i < verts.length; i += 9) {
  minX = Math.min(minX, verts[i]); maxX = Math.max(maxX, verts[i]);
  minZ = Math.min(minZ, verts[i + 2]); maxZ = Math.max(maxZ, verts[i + 2]);
}
assert.ok(minX > -32 && maxX < 32 && minZ > -32 && maxZ < 32, '3D geometry follows the silhouette instead of the old outer plate');
assert.equal(view3d._samplePlan(plan, 0, 0).top, 0, 'background has zero height in 3D');
assert.equal(view3d._materialAt(plan, at(0, 0), 0), -1, 'background has no 3D filament layer');

// Finish mode must also omit the old rectangular wall, not only stack mode.
V.mode = 'finish'; V.section = false;
view3d._buildMesh();
let fx0 = Infinity, fx1 = -Infinity, fz0 = Infinity, fz1 = -Infinity;
for (const vi of gl.indices) {
  const j = vi * 9;
  fx0 = Math.min(fx0, gl.vertices[j]); fx1 = Math.max(fx1, gl.vertices[j]);
  fz0 = Math.min(fz0, gl.vertices[j + 2]); fz1 = Math.max(fz1, gl.vertices[j + 2]);
}
assert.ok(fx0 > -32 && fx1 < 32 && fz0 > -32 && fz1 < 32, 'finish mode has no full-rectangle outer wall');

// Native export is genuinely native for small and non-square inputs too.
const tn = 8 * 20;
const tiny = {
  ...plan, w: 8, h: 20, n: tn, widthMm: 8, heightMm: 20, pixelSize: 1,
  flatMask: new Uint8Array(tn).fill(1), flatFilament: new Uint16Array(tn).fill(1),
  nearest: new Uint16Array(tn).fill(1), familyId: new Int16Array(tn).fill(-1),
  printMask: new Uint8Array(tn).fill(1), background: { enabled: false },
  lineProtectMask: new Uint8Array(tn),
  predicted: Array.from({ length: tn }, () => ({ lab: palette[1].lab || CS.color.hexToLab('#ffffff'), hex: '#ffffff', filamentIndex: 1 })),
  preview: new Uint8ClampedArray(tn * 4).fill(255)
};
const tinyOut = exporter.build3MFBytes(tiny);
assert.equal(tinyOut.ew, 8, 'small native export does not upsample width to 16');
assert.equal(tinyOut.eh, 20, 'small native export preserves non-square height');

// Envelope-added pixels inherit the nearest foreground recipe, not a tall
// direct-white background column. Force the foreground into gradient families
// so this cannot accidentally pass through matching flat heights.
const bridgeData = new Uint8ClampedArray(data);
for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) {
  const p = (y * w + x) * 4;
  if (x >= 28 && x < 36 && y >= 28 && y < 36) continue;
  bridgeData[p] = 208; bridgeData[p + 1] = 128; bridgeData[p + 2] = 144;
}
const bridgeImage = { width: w, height: h, data: bridgeData };
const bridgeSource = engine.buildPrintMask(engine.imageToLab(bridgeImage).lab, w, h,
  { backgroundMode: 'auto', backgroundTolerance: 8, backgroundEnvelope: true, backgroundEnvelopeMm: 2, widthMm: 64, lineWidthMm: 0.42 });
const bridgePlan = engine.buildPlan(bridgeImage, { ...base, residualThreshold: 0.5, backgroundMode: 'auto', backgroundTolerance: 8, backgroundEnvelope: true, backgroundEnvelopeMm: 2 });
let added = 0, directWhiteAdded = 0, tallSupportAdded = 0;
for (let i = 0; i < n; i++) {
  if (bridgePlan.printMask[i] && !bridgeSource.sourcePrintMask[i]) {
    added++;
    if (bridgePlan.flatMask[i] && bridgePlan.flatFilament[i] === 1) directWhiteAdded++;
    if (engine.filamentAt(bridgePlan, i % w, (i / w) | 0, bridgePlan.gradStartLayer) !== -1) tallSupportAdded++;
  }
}
assert.ok(added > 0, 'envelope creates closing/bridge pixels to test');
assert.equal(directWhiteAdded, 0, 'closing/bridge pixels do not become direct-white background columns');
assert.equal(tallSupportAdded, 0, 'envelope support ends at the shared foundation, never a tall wall');
assert.equal(bridgePlan.stats.supportPixels, added, 'support is counted as material but excluded from colour recipes');
assert.ok(Math.abs(bridgePlan.stats.flatPercent + bridgePlan.stats.gradPercent - 100) < 1e-9, 'flat/gradient percentages use only real colour pixels');
assert.equal(bridgePlan.background.componentsAfter, 1, 'envelope leaves exactly one connected printable entity');

const app = fs.readFileSync(new URL('../app/js/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
assert.ok(html.includes('id="backgroundMode"') && html.includes('id="btnPickBackground"') && html.includes('id="btnBackgroundHole"'), 'background and internal-hole controls exist');
assert.ok(app.includes('function toggleBackgroundHoleAt'), 'internal regions can be toggled by mouse');
assert.ok(app.includes('backgroundDeletedHoles: Array.from(state.backgroundHoleIds)'), 'selected hole IDs reach the envelope builder');
assert.ok(app.includes("$('widthMm').addEventListener('input'") && app.includes('state.backgroundHoleIds.clear(); state.backgroundHolePick = false;'), 'geometry edits invalidate stale hole IDs');
assert.ok(app.includes("state.dirty || state.analyzing || state.backgroundMode === 'off' || !state.backgroundEnvelope"), 'stale plans cannot be edited after background parameters change');
assert.ok(app.includes('function beginBackgroundPick') && app.includes('function pickBackgroundAt'), 'mouse colour picking is wired');
assert.ok(app.includes('backgroundMode: state.backgroundMode'), 'background options reach buildPlan');
const beginPick = app.slice(app.indexOf('function beginBackgroundPick'), app.indexOf('function pickBackgroundAt'));
assert.ok(beginPick.includes('markDirty(false)'), 'entering colour picking immediately invalidates the old export');
console.log('all background-silhouette checks passed');
