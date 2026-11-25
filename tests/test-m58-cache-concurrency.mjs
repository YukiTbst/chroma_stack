/* R4 contract: activeMatchCache is module-global; async buildPlan must not let two
   overlapping plans cross-use caches. buildPlan is serialized per realm and clears the
   cache in finally. This runs concurrent plans with DIFFERENT palettes through a
   yielding mock pool and asserts each equals its pure-CPU reference; also that a
   throwing plan leaves no dangling cache for the next plan.
   Run: node tests/test-m58-cache-concurrency.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ctx = vm.createContext({ console, setTimeout, clearTimeout, performance });
ctx.globalThis = ctx;
for (const f of ['color.js', 'data-filaments.js', 'optics.js', 'height-curve.js', 'calibration-data.js', 'layer-optimizer.js', 'engine.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'app', 'js', f), 'utf8'), ctx);
}
const CS = ctx.CS, E = CS.engine;

/* Yielding mock pool: each call resolves on a later macrotask so concurrent plans
   genuinely interleave at await points (exercising the global-cache hazard). */
function mockPool(size) {
  const S = [], D = [];
  const delay = (v) => new Promise(res => setTimeout(() => res(v), 2));
  return {
    size,
    call(i, m) {
      if (m.op === 'init') { S[i] = { mask: new Uint8Array(m.mask), protect: m.protect ? new Uint8Array(m.protect) : null, lab: m.lab ? new Float32Array(m.lab) : null, neutralNeed: m.neutralNeed ? new Uint8Array(m.neutralNeed) : null, famNeutral: m.famNeutral ? new Uint8Array(m.famNeutral) : null, famPredL: new Float64Array(m.famPredL), w: m.w, h: m.h, familyCount: m.familyCount, radius: m.radius, colorTol: m.colorTol }; return delay({ ok: true }); }
      if (m.op === 'setData') { D[i] = { lab: new Float32Array(m.lab), mask: new Uint8Array(m.mask), stroke: m.stroke ? new Uint8Array(m.stroke) : null, w: m.w }; return delay({ ok: true }); }
      if (m.op === 'smooth') { const s = S[i], src = new Int16Array(m.src), out = new Int16Array(s.w * s.h); E.smoothFamilyMapBand(src, out, s.mask, s.protect, s.lab, s.familyCount, s.famPredL, s.neutralNeed, s.famNeutral, s.w, s.h, s.radius, m.y0, m.y1, s.colorTol); return delay({ ok: true, y0: m.y0, out: out.slice(m.y0 * s.w, m.y1 * s.w).buffer }); }
      if (m.op === 'assign') { const d = D[i], r = E.assignFamiliesRange(d.lab, d.mask, new Float64Array(m.pred), m.F, d.w, m.i0, m.i1, d.stroke); return delay({ ok: true, familyId: r.familyId.buffer, counts: r.counts.buffer }); }
      return delay({ ok: false, error: 'unknown op' });
    }
  };
}

const w = 120, h = 90, n = w * h;
const data = new Uint8ClampedArray(n * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; data.set([Math.round(30 + 180 * x / w), Math.round(40 + 120 * y / h), Math.round(200 - 120 * x / w), 255], i * 4); }
const image = { width: w, height: h, data };
const palA = [{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }, { id: 'u', name: 'Blue', hex: '#00358e', td: 4 }];
const palB = [{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 }, { id: 'y', name: 'Yellow', hex: '#f7b500', td: 8 }, { id: 'g', name: 'Green', hex: '#00a651', td: 6 }];
const base = { engine: 'td', widthMm: 100, flatTopMm: 1.6, reliefMm: 0.16, variableHeight: true, layerHeight: 0.08, gradLayers: 5, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.4, smoothMm: 0.8, lineWidthMm: 0.42, mergeDeltaE: 1.5, heightMergeDeltaE: 1.5, edgeClean: 1, families: 16, backgroundMode: 'off', lineProtect: 'auto' };
const optsA = { ...base, palette: palA }, optsB = { ...base, palette: palB };

function eq(a, b, label) {
  let fd = 0, hd = 0;
  for (let i = 0; i < n; i++) { if (a.familyId[i] !== b.familyId[i]) fd++; if (a.predicted[i].hex !== b.predicted[i].hex) hd++; }
  assert.equal(fd, 0, label + ' familyId'); assert.equal(hd, 0, label + ' hex');
  assert.equal(a.stats.meanDE, b.stats.meanDE, label + ' meanDE');
}

const refA = await E.buildPlan(image, optsA);
const refB = await E.buildPlan(image, optsB);

/* Concurrent plans with different palettes + yielding pool: each must equal its ref. */
const [a, b] = await Promise.all([
  E.buildPlan(image, { ...optsA, pool: mockPool(3) }),
  E.buildPlan(image, { ...optsB, pool: mockPool(3) })
]);
eq(a, refA, 'concurrent A');
eq(b, refB, 'concurrent B');

/* A throwing plan must not leave a dangling cache: the next plan stays correct. */
await assert.rejects(() => E.buildPlan(image, { ...optsA, palette: [] }), /耗材|palette/);
const after = await E.buildPlan(image, { ...optsA, pool: mockPool(3) });
eq(after, refA, 'after-throw');

console.log('all cache concurrency checks passed');