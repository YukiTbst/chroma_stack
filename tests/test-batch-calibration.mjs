import { createRequire } from 'module';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/calibration.js');
require('../app/js/zip.js');
require('../app/js/batch-calibration.js');
const { batchCalibration: B, color: C } = globalThis.CS;

const palette = [
  { id: 'black', name: 'Black', hex: '#000000', td: 3, hd: 0.3, brand: 'Test', material: 'PLA' },
  { id: 'red', name: 'Red', hex: '#c00d1e', td: 7, hd: 0.7, brand: 'Test', material: 'PLA' },
  { id: 'white', name: 'White', hex: '#ffffff', td: 5, hd: 0.5, brand: 'Test', material: 'PLA' },
  { id: 'blue', name: 'Blue', hex: '#00358e', td: 11, hd: 1.1, brand: 'Test', material: 'PLA' }
];
// The printed samples deliberately differ from the nominal starting values.
const actual = [
  { hex: '#000000', hd: 0.28 },
  { hex: '#d8162c', hd: 0.62 },
  { hex: '#ffffff', hd: 0.46 },
  { hex: '#164b9f', hd: 0.92 }
];
const layout = B.buildBatchLayout(palette);
const out = B.buildBatchCalibration3MF({ palette, layout });
assert.equal(Buffer.from(out.bytes.slice(0, 4)).toString('hex'), '504b0304', 'batch calibration plate is a valid 3MF ZIP');
assert.ok(layout.boardW <= 180 && layout.boardD <= 180, 'batch plate fits an A1 mini bed');
assert.equal(layout.baseIndex, 0, 'the darkest filament forms the thin black base');
assert.equal(layout.whiteIndex, 2, 'white is measured directly over black');
assert.deepEqual(layout.order, [2, 0, 1, 3], 'white is first and every selected filament has one contiguous band');
assert.equal(layout.baseLayers, 2, 'black foundation is only two layers thick');
assert.equal(layout.patches.length, palette.length * 3, 'every filament has three cumulative thickness terraces');
assert.equal(layout.rails.length, palette.length, 'every band exposes its thickest terrace as the next substrate reference');
assert.equal(layout.markers.length, 4, 'plate has four perspective markers');
assert.equal(out.meta.printMode, 'single-filament-per-layer', 'plate uses one material at each Z height');
assert.equal(layout.layerFilaments.length, layout.totalLayers);
assert.equal(layout.maxHeight, layout.totalLayers * layout.layerHeight);
assert.ok(layout.maxHeight <= 3, `low pyramid is ${layout.maxHeight.toFixed(2)} mm high in this four-colour example`);
const changes = layout.layerFilaments.reduce((n, f, i) => n + (i > 0 && f !== layout.layerFilaments[i - 1] ? 1 : 0), 0);
assert.equal(changes, palette.length, 'only band boundaries require a material change');
let zLayer = layout.baseLayers;
for (let bandIndex = 0; bandIndex < layout.bands.length; bandIndex++) {
  const band = layout.bands[bandIndex];
  assert.equal(band.segments.length, 3);
  assert.equal(band.totalLayers, band.segments.reduce((n, s) => n + Math.round((s.z1 - s.z0) / layout.layerHeight), 0));
  let previousSize = Infinity;
  for (const segment of band.segments) {
    const size = segment.x1 - segment.x0;
    assert.ok(size < previousSize, 'terraces form a nested pyramid rather than parallel strips');
    assert.equal(segment.z0, zLayer * layout.layerHeight, 'each terrace starts at the preceding Z layer');
    previousSize = size;
    zLayer += Math.round((segment.z1 - segment.z0) / layout.layerHeight);
  }
  const supportX0 = bandIndex === 0 ? 0 : layout.bands[bandIndex - 1].segments.at(-1).x0;
  assert.ok(band.segments[0].x0 >= supportX0, 'each new band remains on the preceding thick terrace');
}
assert.equal(zLayer, layout.totalLayers, 'geometry and layer-material table have identical Z coverage');
for (let i = 1; i < layout.layerFilaments.length; i++) {
  if (i === layout.baseLayers) assert.equal(layout.layerFilaments[i], layout.whiteIndex, 'first layer above black is white');
}
const whiteBand = layout.bands[0];
assert.equal(whiteBand.filamentIndex, layout.whiteIndex);
const whiteTop = whiteBand.segments.at(-1).z1;

function unzipStored(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files = {};
  let p = 0;
  while (p + 30 <= bytes.length && view.getUint32(p, true) === 0x04034b50) {
    const method = view.getUint16(p + 8, true), size = view.getUint32(p + 18, true), nameLength = view.getUint16(p + 26, true), extraLength = view.getUint16(p + 28, true);
    assert.equal(method, 0, 'test ZIP reader handles stored entries');
    const name = new TextDecoder().decode(bytes.slice(p + 30, p + 30 + nameLength));
    const start = p + 30 + nameLength + extraLength;
    files[name] = bytes.slice(start, start + size);
    p = start + size;
  }
  return files;
}
const files = unzipStored(out.bytes);
const modelXml = new TextDecoder().decode(files['3D/3dmodel.model']);
const savedLayout = JSON.parse(new TextDecoder().decode(files['Metadata/chromastack-batch-calibration.json']));
assert.equal(savedLayout.printMode, 'single-filament-per-layer');
assert.deepEqual(savedLayout.layout.layerFilaments, layout.layerFilaments, '3MF carries the exact layer-material map');
const meshObjects = [...modelXml.matchAll(/<object id="(\d+)"[^>]*pindex="(\d+)"[^>]*name="([^"]*)"[\s\S]*?<\/object>/g)].map(match => ({
  id: Number(match[1]), pindex: Number(match[2]), name: match[3],
  zs: [...match[0].matchAll(/<vertex[^>]* z="([\d.-]+)"/g)].map(m => Number(m[1]))
}));
for (let layer = 0; layer < layout.totalLayers; layer++) {
  const z = (layer + 0.5) * layout.layerHeight;
  const active = new Set(meshObjects.filter(o => Math.min(...o.zs) < z && Math.max(...o.zs) > z).map(o => o.pindex));
  assert.deepEqual([...active], [layout.layerFilaments[layer]], `actual 3MF meshes contain only filament ${layout.layerFilaments[layer]} at Z layer ${layer + 1}`);
}
const markerObject = meshObjects.find(o => o.name.includes('白色角点'));
assert.ok(markerObject, '3MF contains four white marker towers');
assert.equal(markerObject.pindex, layout.whiteIndex, 'markers use the white-band filament');
const markerZs = markerObject.zs;
assert.equal(Math.min(...markerZs), layout.baseHeight);
assert.equal(Math.max(...markerZs), whiteTop, 'markers rise through every white-band layer and never add a second material above it');
writeFileSync(new URL('batch-pyramid.3mf', import.meta.url), out.bytes);

// Render the actual visible pyramid faces with known HD. A band's substrate is
// the preceding band's finite-thickness final terrace, not an imaginary opaque
// rail. Then warp the board projectively and apply a non-clipping camera cast.
const scale = 6, bw = Math.round(layout.boardW * scale), bh = Math.round(layout.boardD * scale);
const board = new Uint8ClampedArray(bw * bh * 4);
const rect = (x0, y0, x1, y1, rgb) => {
  for (let y = Math.max(0, Math.round(y0 * scale)); y < Math.min(bh, Math.round(y1 * scale)); y++) {
    for (let x = Math.max(0, Math.round(x0 * scale)); x < Math.min(bw, Math.round(x1 * scale)); x++) {
      const p = (y * bw + x) * 4;
      board[p] = rgb[0]; board[p + 1] = rgb[1]; board[p + 2] = rgb[2]; board[p + 3] = 255;
    }
  }
};
const rgbOf = hex => { const c = C.hexToRgb(hex); return [c.r, c.g, c.b]; };
const blend = (baseHex, fgHex, thickness, hd) => {
  const b = rgbOf(baseHex), f = rgbOf(fgHex), T = Math.pow(10, -thickness / hd);
  return b.map((v, c) => C.linearToSrgb8(C.srgbToLinear(f[c] / 255) * (1 - T) + C.srgbToLinear(v / 255) * T));
};
const hexOf = rgb => C.rgbToHex(...rgb.map(v => Math.round(v)));
rect(0, 0, layout.boardW, layout.boardD, rgbOf(actual[layout.baseIndex].hex));
let substrate = actual[layout.baseIndex].hex, whiteRailRgb = [255, 255, 255];
for (const band of layout.bands) {
  const k = band.filamentIndex;
  for (let t = 0; t < band.segments.length; t++) {
    const s = band.segments[t], patch = band.segments[t] && layout.patches.find(p => p.filamentIndex === k && p.terrace === t);
    const rgb = blend(substrate, actual[k].hex, patch.thickness, actual[k].hd);
    rect(s.x0, s.y0, s.x1, s.y1, rgb);
    if (t === 2) {
      substrate = hexOf(rgb);
      if (k === layout.whiteIndex) whiteRailRgb = rgb;
    }
  }
}
for (const m of layout.markers) rect(m.x - 1, m.y - 1, m.x + 1, m.y + 1, whiteRailRgb);

const src = [{ x: 0, y: 0 }, { x: layout.boardW, y: 0 }, { x: layout.boardW, y: layout.boardD }, { x: 0, y: layout.boardD }];
const dst = [{ x: 48, y: 38 }, { x: 594, y: 62 }, { x: 618, y: 574 }, { x: 24, y: 594 }];
const forward = B.homography(src, dst), inverse = B.homography(dst, src);
const photoCorners = layout.markers.map(m => forward(m.x, m.y));
const minX = Math.floor(Math.min(...dst.map(p => p.x))) - 12, maxX = Math.ceil(Math.max(...dst.map(p => p.x))) + 12;
const minY = Math.floor(Math.min(...dst.map(p => p.y))) - 12, maxY = Math.ceil(Math.max(...dst.map(p => p.y))) + 12;
const w = maxX - minX + 1, h = maxY - minY + 1, shiftedDst = dst.map(p => ({ x: p.x - minX, y: p.y - minY }));
const invShifted = B.homography(shiftedDst, src), data = new Uint8ClampedArray(w * h * 4), cameraGain = [0.85, 0.95, 0.90];
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const q = invShifted(x, y), sx = Math.round(q.x * scale), sy = Math.round(q.y * scale), p = (y * w + x) * 4;
  const inside = sx >= 0 && sx < bw && sy >= 0 && sy < bh, sp = (sy * bw + sx) * 4;
  for (let c = 0; c < 3; c++) data[p + c] = Math.min(255, Math.round((inside ? board[sp + c] : [28, 30, 32][c]) * cameraGain[c]));
  data[p + 3] = 255;
}
const imageData = { width: w, height: h, data };
const shiftedMarkers = photoCorners.map(p => ({ ...p, x: p.x - minX, y: p.y - minY }));
const detected = B.detectMarkers(imageData, true);
for (let i = 0; i < 4; i++) assert.ok(Math.hypot(detected[i].cx - shiftedMarkers[i].x, detected[i].cy - shiftedMarkers[i].y) < 2.5, `perspective marker ${i + 1} is detected at the correct corner`);
const analysis = B.analyzeBatchPhoto(imageData, palette, { layout });
assert.equal(analysis.results.length, palette.length, 'photo returns one calibration per filament');
for (const result of analysis.results) {
  const expected = actual[result.index];
  const relative = Math.abs(result.hd - expected.hd) / expected.hd;
  assert.ok(relative < 0.12, `${result.name}: recovered HD ${result.hd.toFixed(3)} is within 12% of ${expected.hd}`);
  assert.ok(Math.abs(result.td - expected.hd * 10) / (expected.hd * 10) < 0.12, `${result.name}: TD follows the recovered HD`);
  assert.ok(C.deltaE2000(C.hexToLab(result.hex), C.hexToLab(expected.hex)) < 3, `${result.name}: recovered opaque colour ${result.hex} matches ${expected.hex}`);
  assert.ok(result.score > 0.65, `${result.name}: fit has meaningful confidence`);
  assert.equal(result.samples.length, 3, `${result.name}: all three physical terraces are sampled`);
}
assert.ok(Math.abs(analysis.whiteBalance.gains[0] - 1 / cameraGain[0]) < 0.04, 'white balance removes the red-channel cast without assuming the last white terrace is opaque');
assert.ok(Math.abs(analysis.whiteBalance.gains[1] - 1 / cameraGain[1]) < 0.04, 'white balance removes the green-channel cast');
assert.ok(Math.abs(analysis.whiteBalance.gains[2] - 1 / cameraGain[2]) < 0.04, 'white balance removes the blue-channel cast');
const app = (await import('node:fs')).readFileSync(new URL('../app/js/app.js', import.meta.url), 'utf8');
assert.ok(app.includes('state.batchPalette = palette.map'), 'batch plate keeps its original filament order');
assert.ok(app.includes('palette.findIndex(p => (r.id && p.id === r.id)'), 'photo results are applied by filament model rather than current list order');
assert.ok(app.includes('每个 Z 层仅一种耗材'), 'UI describes the real single-material-per-Z print mode');
console.log(`all pyramid batch-calibration checks passed: ${layout.maxHeight.toFixed(2)} mm, ${changes} material changes`);
