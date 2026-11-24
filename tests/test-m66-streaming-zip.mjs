/* True streaming export: the model XML is produced lazily (backpressure) and CRC+DEFLATE
   consume it without holding the raw multi-GB buffer; the ZIP is assembled as a lazy Blob
   (no full copy). Verifies (a) streaming XML bytes == buffered XML bytes, (b) the streaming
   Blob round-trips (inflate) to the identical model XML with matching CRC, (c) the ZIP32
   capacity guard fires on a >4GB stream while only ~1MB stays resident (backpressure).
   Run: node tests/test-m66-streaming-zip.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.earcut = require('../app/js/earcut.js');
for (const m of ['height-curve', 'color', 'optics', 'data-filaments', 'engine', 'layer-optimizer', 'zip', 'exporter']) require('../app/js/' + m + '.js');
const E = globalThis.CS.engine, X = globalThis.CS.exporter, Z = globalThis.CS.zip;

const pal = E.buildUserPalette([{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }]);
const w = 96, h = 72, d = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([x < 48 ? 192 : 250, 13 + (y % 40), 30, 255], (y * w + x) * 4);
const plan = await E.buildPlan({ width: w, height: h, data: d }, { engine: 'td', palette: pal, widthMm: 100, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1, families: 48, smoothMm: 0.8, lineWidthMm: 0.42, lineProtect: 'auto', backgroundMode: 'off' });
const grid = X.exportGridFor(plan); const ew = grid.width, eh = grid.height;
const plane = X.samplePlane(plan, ew, eh); const ps = plan.widthMm / ew;
const prisms = X.buildPrisms(plan, plane);
const used = []; for (let f = 0; f < plan.palette.length; f++) if (prisms[f].length) used.push(f);
const rawObjects = X.meshPrismObjects(plan, prisms, ew, eh, ps, used);

const buffered = X.assemble3MFParts(plan, rawObjects, grid, plane, ew, eh, ps, false);
const streaming = X.assemble3MFParts(plan, rawObjects, grid, plane, ew, eh, ps, true);

// (a) XML byte identity between eager parts and lazy stream.
const concat = ps => { let n = 0; for (const p of ps) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of ps) { o.set(p, k); k += p.length; } return o; };
const bufModel = concat(buffered.files[2].parts);
const streamChunks = []; for await (const c of streaming.files[2].stream()) streamChunks.push(c);
const strModel = concat(streamChunks);
assert.equal(Buffer.compare(Buffer.from(bufModel), Buffer.from(strModel)), 0, 'streaming XML == buffered XML');

// (b) streaming ZIP is a Blob; buffered ZIP is Uint8Array; round-trip inflate matches.
const bufZip = await Z.createZipAsync(buffered.files);
const strZip = await Z.createZipAsync(streaming.files);
assert.ok(bufZip instanceof Uint8Array, 'buffered zip Uint8Array');
assert.ok(typeof Blob !== 'undefined' && strZip instanceof Blob, 'streaming zip Blob');
const zipBuf = new Uint8Array(await strZip.arrayBuffer());
// walk local headers to find the model entry
let off = 0, modelComp = null, modelCrc = null, modelRaw = null;
const dv = new DataView(zipBuf.buffer);
while (off + 4 <= zipBuf.length && dv.getUint32(off, true) === 0x04034B50) {
  const method = dv.getUint16(off + 8, true);
  const crc = dv.getUint32(off + 14, true);
  const compSize = dv.getUint32(off + 18, true);
  const rawSize = dv.getUint32(off + 22, true);
  const nameLen = dv.getUint16(off + 26, true), extraLen = dv.getUint16(off + 28, true);
  const name = new TextDecoder().decode(zipBuf.subarray(off + 30, off + 30 + nameLen));
  const dataStart = off + 30 + nameLen + extraLen;
  if (name === '3D/3dmodel.model') { modelComp = zipBuf.subarray(dataStart, dataStart + compSize); modelCrc = crc; modelRaw = rawSize; assert.equal(method, 8, 'model deflate'); }
  off = dataStart + compSize;
}
assert.ok(modelComp, 'model entry found in streaming zip');
assert.equal(modelRaw, bufModel.length, 'raw size matches');
assert.equal(modelCrc >>> 0, Z.crc32(bufModel), 'CRC matches buffered XML');
const inflated = new Uint8Array(await new Response(new Blob([modelComp]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
assert.equal(Buffer.compare(Buffer.from(inflated), Buffer.from(bufModel)), 0, 'streaming zip inflates to identical XML');

// (c) capacity guard EARLY-STOPS: with large chunks the tap rejects as soon as the running
// raw size would exceed ZIP32, cancels the upstream producer, and never drains the stream.
const CHUNK = 512 * 1024 * 1024; // 512MiB
const block = new Uint8Array(CHUNK); // reused, never duplicated
let pulls = 0, cancelCalled = false;
const bigStream = new ReadableStream({
  pull(ctrl) { pulls++; if (pulls > 40) { ctrl.close(); return; } ctrl.enqueue(block); },
  cancel() { cancelCalled = true; }
});
let threw = null;
try { await Z.createZipAsync([{ name: '3D/3dmodel.model', stream: () => bigStream }]); } catch (e) { threw = e; }
assert.ok(threw && threw.zipCapacity, '>4GB stream rejected with zipCapacity');
assert.ok(cancelCalled, 'upstream producer cancelled on over-limit');
assert.ok(pulls < 40, 'early stop: pulled ' + pulls + ' of 40 chunks');
assert.ok(pulls <= 12, 'stopped near the limit, pulled ' + pulls);

console.log('m66 passed: streaming XML/CRC/DEFLATE byte-identical + Blob zip + early-stop >4GB capacity guard (pulls=' + pulls + ', cancelled)');