/* GPU6 contract: the WebGPU matcher must chunk large target batches so the score
   buffer fits maxStorageBufferBindingSize and the dispatch fits
   maxComputeWorkgroupsPerDimension. At 4x the near-neutral exact-pixel set reaches
   ~56k targets; an unchunked rawBest allocates a ~700MB buffer and the device
   rejects it, silently falling back to CPU. This test drives gamut-gpu.js against a
   mock device that enforces the same limits and uses an L1 score, then checks a
   large batch succeeds and returns the correct per-target argmin.
   Run: node tests/test-m53-gpu-chunk.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const GPUBufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 2, UNIFORM: 64, STORAGE: 128 };
const GPUMapMode = { READ: 1 };

/* Mock device enforcing a storage-binding byte cap and a workgroup cap. The compute
   pass fills the out buffer with L1(target, gamutLab) so argmin is checkable. */
function makeDevice(maxBind, maxWG) {
  const dev = {
    destroy() {},
    limits: {
      maxStorageBufferBindingSize: maxBind,
      maxBufferSize: maxBind * 2,
      maxComputeWorkgroupsPerDimension: maxWG,
      maxComputeInvocationsPerWorkgroup: 256
    },
    queue: {
      writeBuffer(buf, off, data) { buf._typed = data; buf._data = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)); },
      submit(cmds) { for (const c of cmds) c._run(); }
    },
    createBuffer({ size, usage }) {
      if ((usage & GPUBufferUsage.STORAGE) && size > maxBind) throw new Error('storage buffer ' + size + ' exceeds binding limit ' + maxBind);
      const buf = { size, usage, destroy() {} };
      if (usage & GPUBufferUsage.MAP_READ) {
        buf.mapAsync = async () => {};
        buf.getMappedRange = () => buf._data.buffer.slice(0);
        buf.unmap = () => {};
      }
      return buf;
    },
    createShaderModule() { return {}; },
    createComputePipeline() { return { getBindGroupLayout: () => ({}) }; },
    async createComputePipelineAsync() { return { getBindGroupLayout: () => ({}) }; },
    pushErrorScope() {}, async popErrorScope() { return null; },
    lost: new Promise(() => {}),
    createBindGroup({ entries }) { const m = {}; for (const e of entries) m[e.binding] = e.resource.buffer; return { _m: m }; },
    createCommandEncoder() {
      const ops = [];
      const runCompute = (bg) => {
        const lab = bg._m[0]._typed, tgt = bg._m[2]._typed, out = bg._m[3], par = bg._m[4]._typed;
        const n = par[0], batch = par[1];
        out._data = new Uint8Array(batch * n * 4);
        const f = new Float32Array(out._data.buffer);
        for (let b = 0; b < batch; b++) {
          const tl = tgt[b * 4], ta = tgt[b * 4 + 1], tb = tgt[b * 4 + 2];
          for (let i = 0; i < n; i++) {
            f[b * n + i] = Math.abs(tl - lab[i * 4]) + Math.abs(ta - lab[i * 4 + 1]) + Math.abs(tb - lab[i * 4 + 2]);
          }
        }
      };
      return {
        beginComputePass() {
          const pass = { _bg: null, _w: 0, setPipeline() {}, setBindGroup(i, bg) { this._bg = bg; }, dispatchWorkgroups(w) { if (w > maxWG) throw new Error('workgroups ' + w + ' exceeds ' + maxWG); this._w = w; }, end() { ops.push({ t: 'c', bg: this._bg }); } };
          return pass;
        },
        copyBufferToBuffer(src, so, dst, doff, size) { ops.push({ t: 'copy', src, dst, size }); },
        finish() { return { _run() { for (const op of ops) { if (op.t === 'c') runCompute(op.bg); else op.dst._data = op.src._data.slice(0, op.size); } } }; }
      };
    }
  };
  return dev;
}

function loadGpu(dev) {
  const ctx = vm.createContext({
    console, GPUBufferUsage, GPUMapMode,
    navigator: { gpu: { requestAdapter: async () => ({ requestDevice: async () => dev }) } }
  });
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(path.join(root, 'app', 'js', 'color.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'app', 'js', 'gamut-gpu.js'), 'utf8'), ctx);
  return ctx.CS;
}

/* Synthetic gamut: 40 distinct Lab entries with the fields createMatcher reads. */
const n = 40;
const gamut = [];
for (let i = 0; i < n; i++) {
  const lab = { L: 10 + i * 2, a: (i % 7) - 3, b: (i % 5) - 2 };
  gamut.push({ lab, seq: [i % 3], lin: [0, 0, 0], hex: '#000000', length: 1, runs: 1, distinct: 1, chromaFrac: 0 });
}
gamut.neutral = [];

function l1Best(t) { let bi = 0, bs = Infinity; for (let i = 0; i < n; i++) { const g = gamut[i].lab; const s = Math.abs(t.L - g.L) + Math.abs(t.a - g.a) + Math.abs(t.b - g.b); if (s < bs) { bs = s; bi = i; } } return bi; }

/* Small binding cap forces chunking: chunkCap = floor(100000/(40*4)) = 625. */
const CS = loadGpu(makeDevice(100000, 65535));
const matcher = await CS.gamutGpu.createMatcher(gamut);
assert.ok(matcher, 'matcher created');

/* Large batch (5000 targets) — unchunked out buffer = 5000*40*4 = 800KB > 100KB cap. */
const targets = [];
for (let b = 0; b < 5000; b++) targets.push({ L: (b * 37) % 100, a: ((b * 13) % 21) - 10, b: ((b * 7) % 17) - 8 });
const res = await matcher.scanBestBatch(targets);
assert.equal(res.length, targets.length, 'every target scored');
let mismatches = 0;
for (let b = 0; b < targets.length; b++) { if (res[b].g !== gamut[l1Best(targets[b])]) mismatches++; }
assert.equal(mismatches, 0, 'chunked argmin matches per-target L1 best');

/* Small batch still works (single-chunk path). */
const small = targets.slice(0, 10);
const rs = await matcher.scanBestBatch(small);
assert.equal(rs.length, 10);
for (let b = 0; b < 10; b++) assert.equal(rs[b].g, gamut[l1Best(small[b])]);

matcher.destroy();
console.log('all GPU chunking checks passed');