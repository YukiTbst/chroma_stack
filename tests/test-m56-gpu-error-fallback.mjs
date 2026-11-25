/* R2 contract: invalid GPU scores must never silently select gamut[0] and report
   success. With a mock device whose read-back scores are all NaN, matchBatch must
   reject, and buildPlanAsync must fall back to the CPU path (computeEngine 'cpu').
   Run: node tests/test-m56-gpu-error-fallback.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function makeCtx() {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, performance });
  ctx.globalThis = ctx;
  ctx.GPUBufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 2, UNIFORM: 64, STORAGE: 128 };
  ctx.GPUMapMode = { READ: 1 };
  return ctx;
}
function load(ctx, files) {
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, 'app', 'js', f), 'utf8'), ctx);
}

/* Mock device returning NaN scores from every read-back buffer. */
function nanDevice() {
  const nanBuf = (size) => { const ab = new ArrayBuffer(size); new Float32Array(ab).fill(NaN); return ab; };
  return {
    limits: { maxStorageBufferBindingSize: 1 << 28, maxBufferSize: 1 << 28, maxComputeWorkgroupsPerDimension: 65535 },
    lost: new Promise(() => {}),
    createBuffer({ size, usage }) { return { size, usage, destroy() {}, mapAsync: async () => {}, getMappedRange: () => nanBuf(size), unmap() {} }; },
    queue: { writeBuffer() {}, submit() {} },
    createShaderModule() { return {}; },
    async createComputePipelineAsync() { return { getBindGroupLayout: () => ({}) }; },
    createBindGroup() { return {}; },
    createCommandEncoder() { return { beginComputePass() { return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }; }, copyBufferToBuffer() {}, finish() { return {}; } }; },
    pushErrorScope() {}, async popErrorScope() { return null; },
    destroy() {}
  };
}

const palette = [
  { id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'Jade White', hex: '#ffffff', td: 5 },
  { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }
];

/* (a) matchBatch rejects when no finite score exists. */
{
  const ctx = makeCtx();
  ctx.navigator = { gpu: { requestAdapter: async () => ({ requestDevice: async () => nanDevice() }) } };
  load(ctx, ['color.js', 'data-filaments.js', 'optics.js', 'height-curve.js', 'calibration-data.js', 'layer-optimizer.js', 'engine.js', 'gamut-gpu.js']);
  const CS = ctx.CS;
  const pal = CS.engine.buildUserPalette(palette);
  const gamut = CS.engine.buildTdGamut(pal, pal[1], 0.08, 4, true);
  const matcher = await CS.gamutGpu.createMatcher(gamut);
  assert.ok(matcher, 'matcher created against mock device');
  await assert.rejects(() => matcher.matchBatch([{ L: 50, a: 0, b: 0 }, { L: 30, a: 5, b: -5 }]), /no valid score/, 'NaN scores must reject, not pick gamut[0]');
  matcher.destroy();
}

/* (b) buildPlanAsync falls back to CPU (computeEngine 'cpu') when the GPU fails. */
{
  const ctx = makeCtx();
  ctx.navigator = { gpu: { requestAdapter: async () => ({ requestDevice: async () => nanDevice() }) } };
  load(ctx, ['color.js', 'data-filaments.js', 'optics.js', 'height-curve.js', 'calibration-data.js', 'layer-optimizer.js', 'engine.js', 'gamut-gpu.js']);
  const CS = ctx.CS;
  const w = 400, h = 300, n = w * h; // >= 100k so the GPU pre-warm is attempted (R5 threshold)
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) data.set([Math.round(30 + 180 * (i % w) / w), 90, 160, 255], i * 4);
  const opts = { engine: 'td', palette, widthMm: 80, layerHeight: 0.08, gradLayers: 4, foundationIndex: 1, families: 12, backgroundMode: 'off', smoothMm: 0.8, lineWidthMm: 0.42 };
  const plan = await CS.engine.buildPlanAsync({ width: w, height: h, data }, opts);
  assert.equal(plan.computeEngine, 'cpu', 'GPU failure must fall back to CPU');
  const cpu = await CS.engine.buildPlan({ width: w, height: h, data }, opts);
  assert.equal(plan.stats.meanDE, cpu.stats.meanDE, 'fallback plan equals pure CPU');
}

/* (c) R5: below the size threshold the GPU pre-warm is skipped entirely (CPU path). */
{
  const ctx = makeCtx();
  ctx.navigator = { gpu: { requestAdapter: async () => ({ requestDevice: async () => nanDevice() }) } };
  load(ctx, ['color.js', 'data-filaments.js', 'optics.js', 'height-curve.js', 'calibration-data.js', 'layer-optimizer.js', 'engine.js', 'gamut-gpu.js']);
  const CS = ctx.CS;
  const w = 80, h = 60, n = w * h; // 4800 < 100k
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) data.set([Math.round(30 + 180 * (i % w) / w), 90, 160, 255], i * 4);
  const opts = { engine: 'td', palette, widthMm: 80, layerHeight: 0.08, gradLayers: 4, foundationIndex: 1, families: 12, backgroundMode: 'off', smoothMm: 0.8, lineWidthMm: 0.42 };
  const plan = await CS.engine.buildPlanAsync({ width: w, height: h, data }, opts);
  assert.notEqual(plan.computeEngine, 'gpu', 'small plan must not use the GPU pre-warm');
  const cpu = await CS.engine.buildPlan({ width: w, height: h, data }, opts);
  assert.equal(plan.stats.meanDE, cpu.stats.meanDE, 'small plan equals pure CPU');
}

console.log('all GPU error-fallback checks passed');