/* R1 contract: the GPU pre-warm cache must never supply recipes computed against a
   DIFFERENT gamut than the formal plan uses. The pre-warm builds its gamut from the
   raw palette + requested gradLayers, but buildPlan applies opticalModel to the
   palette and recomputes colorLayers when gradTopMmOverride > 0. A Lab-only cache key
   let those wrong recipes leak into the plan (real repro: 4 vs 6 layers, ~22 ΔE).
   This drives buildPlanAsync with a mock GPU matcher that scores against the pre-warm
   gamut, then asserts the plan is identical to the pure-CPU buildPlan for (a) height
   overrides and (b) opticalModel. Run: node tests/test-m55-gpu-prewarm-consistency.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ctx = vm.createContext({ console, setTimeout, clearTimeout, performance, navigator: { gpu: { requestAdapter: async () => ({}) } } });
ctx.globalThis = ctx;
for (const f of ['color.js', 'data-filaments.js', 'data-lut.js', 'optics.js', 'height-curve.js', 'calibration-data.js', 'layer-optimizer.js', 'engine.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'app', 'js', f), 'utf8'), ctx);
}
const CS = ctx.CS, E = CS.engine;

/* Mock WebGPU matcher: scores targets against the gamut it is handed (the pre-warm
   gamut), exactly like the real shader would. If the formal plan uses a different
   gamut, these cached recipes are wrong and must NOT be used. Counts createMatcher
   calls so the test can assert the GPU path was actually exercised. */
let matcherCalls = 0;
CS.gamutGpu = {
  async createMatcher(gamut) {
    matcherCalls++;
    return {
      n: gamut.length,
      async matchBatch(targets) { return targets.map(t => E.matchGamut(t, gamut)); },
      async scanBestBatch(targets) { return targets.map(t => E.scanGamutBest(t, gamut)); },
      destroy() {}
    };
  }
};

const w = 400, h = 300, n = w * h; // > 100k so the GPU pre-warm is attempted
const data = new Uint8ClampedArray(n * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x;
  data.set([Math.round(30 + 180 * x / w), Math.round(40 + 120 * y / h), Math.round(200 - 120 * x / w), 255], i * 4);
}
const image = { width: w, height: h, data };
const palette = [
  { id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'Jade White', hex: '#ffffff', td: 5 },
  { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }, { id: 'u', name: 'Blue', hex: '#00358e', td: 4 }, { id: 'y', name: 'Yellow', hex: '#f7b500', td: 8 }
];
const base = {
  engine: 'td', palette, widthMm: 120, flatTopMm: 1.6, reliefMm: 0.16, variableHeight: true, layerHeight: 0.08,
  gradLayers: 4, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.4, smoothMm: 0.8,
  lineWidthMm: 0.42, mergeDeltaE: 1.5, heightMergeDeltaE: 1.5, edgeClean: 1, families: 24, backgroundMode: 'off', lineProtect: 'auto'
};

function compare(cpu, gpu, label) {
  assert.equal(gpu.w, cpu.w); assert.equal(gpu.h, cpu.h);
  let fd = 0, hd = 0, maxDE = 0;
  for (let i = 0; i < n; i++) {
    if (gpu.familyId[i] !== cpu.familyId[i]) fd++;
    if (gpu.predicted[i].hex !== cpu.predicted[i].hex) hd++;
    const d = CS.color.deltaE2000(gpu.predicted[i].lab, cpu.predicted[i].lab);
    if (d > maxDE) maxDE = d;
  }
  assert.equal(fd, 0, label + ': familyId identical (got ' + fd + ' diffs)');
  assert.equal(hd, 0, label + ': predicted hex identical (got ' + hd + ' diffs)');
  assert.equal(gpu.stats.meanDE, cpu.stats.meanDE, label + ': meanDE identical');
  assert.ok(maxDE < 1e-9, label + ': max visual diff ~0 (got ' + maxDE + ')');
}

/* (a) height overrides: requested gradLayers=4 but topOverride forces 6 colour layers.
   The pre-warm must now use the FINAL geometry (6 layers) and still match the CPU. */
const optsHeight = { ...base, gradStartLayerOverride: 5, gradTopMmOverride: 0.88 };
const cpuH = await E.buildPlan(image, optsHeight);
let mc = matcherCalls;
const gpuH = await E.buildPlanAsync(image, optsHeight);
assert.ok(matcherCalls > mc, 'height-override: GPU matcher must be invoked (not skipped)');
assert.equal(gpuH.computeEngine, 'gpu', 'height-override: GPU path active');
compare(cpuH, gpuH, 'height-override');

/* (b) opticalModel: formal palette TD/opaque overridden, pre-warm must use the model too. */
const opticalModel = {
  params: {
    k: { state: ['estimated', 'estimated', 'estimated'], logHd: [Math.log(0.05), Math.log(0.05), Math.log(0.05)], opaque: [0.02, 0.02, 0.02] },
    w: { state: ['estimated', 'estimated', 'estimated'], logHd: [Math.log(1.1), Math.log(0.8), Math.log(0.75)], opaque: [0.95, 0.97, 0.96] },
    r: { state: ['estimated', 'estimated', 'estimated'], logHd: [Math.log(1.2), Math.log(0.1), Math.log(0.06)], opaque: [0.7, 0.05, 0.02] }
  },
  compatibilityDomain: { layerHeightMm: 0.08 }
};
const optsOpt = { ...base, opticalModel };
const cpuO = await E.buildPlan(image, optsOpt);
mc = matcherCalls;
const gpuO = await E.buildPlanAsync(image, optsOpt);
assert.ok(matcherCalls > mc, 'opticalModel: GPU matcher must be invoked (not skipped)');
assert.equal(gpuO.computeEngine, 'gpu', 'opticalModel: GPU path active');
compare(cpuO, gpuO, 'opticalModel');

/* (c) default (no override/model) must STILL be identical (GPU pre-warm valid). */
const cpuD = await E.buildPlan(image, base);
mc = matcherCalls;
const gpuD = await E.buildPlanAsync(image, base);
assert.ok(matcherCalls > mc, 'default: GPU matcher invoked');
compare(cpuD, gpuD, 'default');

console.log('all GPU pre-warm consistency checks passed');