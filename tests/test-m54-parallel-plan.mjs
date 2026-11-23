/* GPU7 contract: the parallel plan phases (row-band smoothing + per-pixel assign via
   a worker pool) must produce a BIT-IDENTICAL plan to the sync path. This drives
   buildPlan with an in-process mock pool that runs the exact plan-worker kernels,
   then compares every structural field against the no-pool plan.
   Run: node tests/test-m54-parallel-plan.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ctx = vm.createContext({ console, setTimeout, clearTimeout, performance });
ctx.globalThis = ctx;
for (const f of ['color.js', 'data-filaments.js', 'data-lut.js', 'optics.js', 'height-curve.js', 'calibration-data.js', 'layer-optimizer.js', 'engine.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'app', 'js', f), 'utf8'), ctx);
}
const CS = ctx.CS, E = CS.engine;

/* Mock pool replicating plan-worker.js: stores init/setData state per worker and
   runs the shared kernels on the requested band/range. */
function mockPool(size) {
  const S = [], D = [];
  return {
    size,
    call(i, m) {
      if (m.op === 'init') {
        S[i] = { mask: new Uint8Array(m.mask), protect: m.protect ? new Uint8Array(m.protect) : null, lab: m.lab ? new Float32Array(m.lab) : null, neutralNeed: m.neutralNeed ? new Uint8Array(m.neutralNeed) : null, famNeutral: m.famNeutral ? new Uint8Array(m.famNeutral) : null, famPredL: new Float64Array(m.famPredL), w: m.w, h: m.h, familyCount: m.familyCount, radius: m.radius, colorTol: m.colorTol };
        return Promise.resolve({ ok: true });
      }
      if (m.op === 'setData') {
        D[i] = { lab: new Float32Array(m.lab), mask: new Uint8Array(m.mask), stroke: m.stroke ? new Uint8Array(m.stroke) : null, w: m.w };
        return Promise.resolve({ ok: true });
      }
      if (m.op === 'smooth') {
        const s = S[i], src = new Int16Array(m.src), out = new Int16Array(s.w * s.h);
        E.smoothFamilyMapBand(src, out, s.mask, s.protect, s.lab, s.familyCount, s.famPredL, s.neutralNeed, s.famNeutral, s.w, s.h, s.radius, m.y0, m.y1, s.colorTol);
        return Promise.resolve({ ok: true, y0: m.y0, out: out.slice(m.y0 * s.w, m.y1 * s.w).buffer });
      }
      if (m.op === 'assign') {
        const d = D[i], res = E.assignFamiliesRange(d.lab, d.mask, new Float64Array(m.pred), m.F, d.w, m.i0, m.i1, d.stroke);
        return Promise.resolve({ ok: true, familyId: res.familyId.buffer, counts: res.counts.buffer });
      }
      return Promise.resolve({ ok: false, error: 'unknown op' });
    }
  };
}

/* Gradient image with smooth ramps + a neutral band so smoothing/assign/neutral
   member paths all exercise. 240x180 gives multiple row bands at pool size 4. */
const w = 240, h = 180, n = w * h;
const data = new Uint8ClampedArray(n * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x;
  const r = Math.round(30 + 180 * x / w), g = Math.round(40 + 120 * y / h), b = Math.round(200 - 120 * x / w);
  data.set([r, g, b, 255], i * 4);
}
const image = { width: w, height: h, data };
const opts = {
  engine: 'td', palette: [
    { name: 'Black', hex: '#000000', td: 0.6 }, { name: 'Jade White', hex: '#ffffff', td: 5 },
    { name: 'Red', hex: '#c00d1e', td: 5 }, { name: 'Blue', hex: '#00358e', td: 4 }, { name: 'Yellow', hex: '#f7b500', td: 8 }
  ], widthMm: 120, flatTopMm: 1.6, reliefMm: 0.16, variableHeight: true, layerHeight: 0.08, gradLayers: 5,
  foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.4, smoothMm: 0.8, lineWidthMm: 0.42,
  mergeDeltaE: 1.5, heightMergeDeltaE: 1.5, edgeClean: 1, families: 24, backgroundMode: 'off', lineProtect: 'auto'
};

const sync = await E.buildPlan(image, opts);
const par = await E.buildPlan(image, { ...opts, pool: mockPool(4) });

/* Structural fields must match exactly. */
assert.equal(par.w, sync.w); assert.equal(par.h, sync.h);
assert.deepEqual(Array.from(par.familyId), Array.from(sync.familyId), 'familyId bit-identical');
assert.deepEqual(Array.from(par.flatMask), Array.from(sync.flatMask), 'flatMask bit-identical');
assert.deepEqual(Array.from(par.flatFilament), Array.from(sync.flatFilament), 'flatFilament bit-identical');
assert.deepEqual(Array.from(par.regionId), Array.from(sync.regionId), 'regionId bit-identical');
assert.equal(par.regionCount, sync.regionCount, 'regionCount');
assert.equal(par.families.length, sync.families.length, 'family count');
for (let f = 0; f < sync.families.length; f++) {
  assert.deepEqual(par.families[f].recipe, sync.families[f].recipe, 'recipe ' + f);
  assert.equal(par.families[f].deltaE, sync.families[f].deltaE, 'deltaE ' + f);
}
for (let i = 0; i < n; i++) {
  assert.equal(par.predicted[i].hex, sync.predicted[i].hex, 'predicted hex ' + i);
}
assert.equal(par.stats.meanDE, sync.stats.meanDE, 'meanDE bit-identical');
assert.equal(par.stats.p90, sync.stats.p90, 'p90');
assert.equal(par.structureCleanup.mergedPixels, sync.structureCleanup.mergedPixels, 'cleanup mergedPixels');
assert.deepEqual(Array.from(par.preview), Array.from(sync.preview), 'preview bytes identical');

/* A second pool size must also be identical (band boundaries differ). */
const par7 = await E.buildPlan(image, { ...opts, pool: mockPool(7) });
assert.deepEqual(Array.from(par7.familyId), Array.from(sync.familyId), 'familyId identical at pool size 7');
assert.equal(par7.stats.meanDE, sync.stats.meanDE, 'meanDE identical at pool size 7');

console.log('all parallel-plan bit-identical checks passed');