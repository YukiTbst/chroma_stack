/* Worker contract: the classic worker loads the engine scripts and returns a
   structured-cloneable plan for one message. Run: node tests/test-worker.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let received = null;
const ctx = vm.createContext({
  console, setTimeout, clearTimeout,
  importScripts: (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, 'app', 'js', f), 'utf8'), ctx);
  }
});
ctx.self = ctx;
ctx.postMessage = (msg) => { received = msg; };
vm.runInContext(fs.readFileSync(path.join(root, 'app', 'js', 'compute-worker.js'), 'utf8'), ctx);

const w = 60, h = 40;
const data = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) data.set([Math.round(40 + (i % w) * 3), 90, 160, 255], i * 4);
const options = {
  engine: 'td',
  palette: [
    { name: 'Black', hex: '#000000', td: 0.6 },
    { name: 'Jade White', hex: '#ffffff', td: 5 },
    { name: 'Red', hex: '#c00d1e', td: 5 },
    { name: 'Blue', hex: '#00358e', td: 4 }
  ],
  widthMm: 60, flatTopMm: 1.6, reliefMm: 0.16, variableHeight: true,
  layerHeight: 0.08, gradLayers: 4, foundationIndex: 1,
  stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.6,
  smoothMm: 0, lineWidthMm: 0.42, smoothLevel: 0, mergeDeltaE: 0,
  heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false,
  lineProtect: 'auto', families: 12, backgroundMode: 'off'
};
ctx.self.onmessage({ data: { id: 7, width: w, height: h, data: data.buffer, options } });
assert.ok(received, 'worker posts a reply');
assert.equal(received.id, 7);
assert.equal(received.ok, true, received.error || 'plan built');
assert.equal(received.plan.w, w);
assert.equal(received.plan.h, h);
assert.ok(received.plan.predicted.length === w * h);

/* A bad payload reports an error instead of throwing outside the worker. */
received = null;
ctx.self.onmessage({ data: { id: 8, width: 4, height: 4, data: new ArrayBuffer(4 * 4 * 4), options: { engine: 'td', palette: [] } } });
assert.ok(received && received.ok === false && received.id === 8, 'worker errors are returned as data');
console.log('all worker checks passed');