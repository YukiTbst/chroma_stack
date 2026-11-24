/* F-GPU-01 contract: the reduction shader's "no valid candidate" output must reject,
   not silently return gamut[0]. The shader writes idx=0xFFFFFFFF + score=f32(1e38);
   Math.fround(1e38) < 1e38, so a naive `s >= 1e38` check misses it. This injects exact
   read-back bytes (idx + score buffers) into the production matcher and asserts the
   index-range + fround-score guards reject invalid results and accept valid ones.
   Run: node tests/test-m61-gpu-sentinel.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const GPUBufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 2, UNIFORM: 64, STORAGE: 128 };
function queueDevice(reads) {
  let qi = 0;
  return {
    limits: { maxStorageBufferBindingSize: 1 << 28, maxBufferSize: 1 << 28, maxComputeWorkgroupsPerDimension: 65535 },
    lost: new Promise(() => {}),
    createBuffer({ size, usage }) {
      const b = { size, usage, destroy() {}, unmap() {} };
      if (usage & GPUBufferUsage.MAP_READ) { b.mapAsync = async () => {}; b.getMappedRange = () => reads[qi++].slice(0); }
      return b;
    },
    queue: { writeBuffer() {}, submit() {} },
    createShaderModule() { return {}; },
    async createComputePipelineAsync() { return { getBindGroupLayout: () => ({}) }; },
    createBindGroup() { return {}; },
    createCommandEncoder() { return { beginComputePass() { return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }; }, copyBufferToBuffer() {}, finish() { return {}; } }; },
    pushErrorScope() {}, async popErrorScope() { return null; },
    destroy() {}
  };
}
function loadMatcher(reads) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, performance, GPUBufferUsage, GPUMapMode: { READ: 1 }, navigator: { gpu: { requestAdapter: async () => ({ requestDevice: async () => queueDevice(reads) }) } } });
  ctx.globalThis = ctx;
  for (const f of ['color.js', 'data-filaments.js', 'optics.js', 'height-curve.js', 'calibration-data.js', 'layer-optimizer.js', 'engine.js', 'gamut-gpu.js']) vm.runInContext(fs.readFileSync(path.join(root, 'app', 'js', f), 'utf8'), ctx);
  const CS = ctx.CS;
  const pal = CS.engine.buildUserPalette([{ id: 'k', name: 'Black', hex: '#000000', td: 0.6 }, { id: 'w', name: 'White', hex: '#ffffff', td: 5 }, { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }, { id: 'u', name: 'Blue', hex: '#00358e', td: 4 }]);
  const gamut = CS.engine.buildTdGamut(pal, pal[1], 0.08, 4, true);
  return CS.gamutGpu.createMatcher(gamut).then(m => ({ m, gamut }));
}
const u32 = (...v) => Uint32Array.from(v).buffer;
const f32 = (...v) => Float32Array.from(v).buffer;
const SENTINEL = Math.fround(1e38);

/* (1) the exact F-GPU-01 case: idx 0 (looks valid) + f32 sentinel score -> must reject. */
{
  const { m } = await loadMatcher([u32(0), f32(SENTINEL)]);
  await assert.rejects(() => m.matchBatch([{ L: 50, a: 0, b: 0 }]), /no valid score/, 'f32 sentinel with idx 0 must reject');
  m.destroy();
}
/* (2) shader all-invalid output: idx 0xFFFFFFFF + NaN score -> reject via index range. */
{
  const { m } = await loadMatcher([u32(0xFFFFFFFF), f32(NaN)]);
  await assert.rejects(() => m.matchBatch([{ L: 50, a: 0, b: 0 }]), /no valid score/, 'invalid index sentinel must reject');
  m.destroy();
}
/* (3) valid result accepted: idx 2 + finite score (scanBestBatch returns the raw winner). */
{
  const { m, gamut } = await loadMatcher([u32(2), f32(1.5)]);
  const r = await m.scanBestBatch([{ L: 50, a: 0, b: 0 }]);
  assert.equal(r[0].g.seq.join(','), gamut[2].seq.join(','), 'valid winner is gamut[2]');
  m.destroy();
}
/* (4) mixed batch: target 0 valid, target 1 sentinel -> whole batch rejects (CPU fallback). */
{
  const { m } = await loadMatcher([u32(2, 0xFFFFFFFF), f32(1.5, SENTINEL)]);
  await assert.rejects(() => m.matchBatch([{ L: 50, a: 0, b: 0 }, { L: 30, a: 2, b: -2 }]), /no valid score/, 'mixed invalid batch must reject');
  m.destroy();
}
console.log('all GPU sentinel checks passed (fround sentinel=' + SENTINEL + ')');