/* ChromaStack WebGPU gamut matcher (PERF2-GPU). The GPU computes ΔE2000+penalty for
   the WHOLE gamut in parallel for a batch of targets; the CPU then takes the argmin
   and reports the exact float64 ΔE2000 plus the neutral lock. With the visual/geometric
   consistency contract the GPU may pick a near-tie alternative (f32), which is visually
   indistinguishable and often slightly better than the CPU shortlist optimum. When
   WebGPU is unavailable createMatcher resolves null and the engine uses the pure-CPU
   path unchanged. */
(function (root) {
  const CS = root.CS = root.CS || {};

  const SCORE_WGSL = `
const PI: f32 = 3.141592653589793;
struct Gamut { lab: array<vec3<f32>>, };
struct Meta { m: array<vec3<f32>>, };   // runs, distinct, chromaFrac
struct Targets { t: array<vec3<f32>>, };
struct OutIdx { v: array<u32>, };
struct OutScore { v: array<f32>, };
@group(0) @binding(0) var<storage, read> gamut: Gamut;
@group(0) @binding(1) var<storage, read> gmeta: Meta;
@group(0) @binding(2) var<storage, read> targets: Targets;
@group(0) @binding(3) var<storage, read_write> outIdx: OutIdx;
struct Params { n: u32, batch: u32, pad0: u32, pad1: u32, };
@group(0) @binding(4) var<uniform> params: Params;
@group(0) @binding(5) var<storage, read_write> outScore: OutScore;

fn deltaE2000(lab1: vec3<f32>, lab2: vec3<f32>) -> f32 {
  let L1 = lab1.x; let a1 = lab1.y; let b1 = lab1.z;
  let L2 = lab2.x; let a2 = lab2.y; let b2 = lab2.z;
  let C1 = sqrt(a1 * a1 + b1 * b1); let C2 = sqrt(a2 * a2 + b2 * b2);
  let Cbar = (C1 + C2) / 2.0;
  let Cbar7 = pow(Cbar, 7.0);
  let G = 0.5 * (1.0 - sqrt(Cbar7 / (Cbar7 + 6103515625.0)));
  let a1p = (1.0 + G) * a1; let a2p = (1.0 + G) * a2;
  let C1p = sqrt(a1p * a1p + b1 * b1); let C2p = sqrt(a2p * a2p + b2 * b2);
  var h1p = atan2(b1, a1p) * 180.0 / PI; if (h1p < 0.0) { h1p = h1p + 360.0; }
  var h2p = atan2(b2, a2p) * 180.0 / PI; if (h2p < 0.0) { h2p = h2p + 360.0; }
  let dLp = L2 - L1; let dCp = C2p - C1p;
  var dhp = 0.0;
  if (C1p * C2p != 0.0) { dhp = h2p - h1p; if (dhp > 180.0) { dhp = dhp - 360.0; } else if (dhp < -180.0) { dhp = dhp + 360.0; } }
  let dHp = 2.0 * sqrt(C1p * C2p) * sin((dhp / 2.0) * PI / 180.0);
  let Lbarp = (L1 + L2) / 2.0; let Cbarp = (C1p + C2p) / 2.0;
  var hbarp = h1p + h2p;
  if (C1p * C2p != 0.0) {
    if (abs(h1p - h2p) > 180.0) { hbarp = select((h1p + h2p - 360.0) / 2.0, (h1p + h2p + 360.0) / 2.0, h1p + h2p < 360.0); }
    else { hbarp = (h1p + h2p) / 2.0; }
  }
  let T = 1.0 - 0.17 * cos((hbarp - 30.0) * PI / 180.0) + 0.24 * cos((2.0 * hbarp) * PI / 180.0)
        + 0.32 * cos((3.0 * hbarp + 6.0) * PI / 180.0) - 0.20 * cos((4.0 * hbarp - 63.0) * PI / 180.0);
  let dh = (hbarp - 275.0) / 25.0;
  let dTheta = 30.0 * exp(-(dh * dh));
  let Cbarp7 = pow(Cbarp, 7.0);
  let RC = 2.0 * sqrt(Cbarp7 / (Cbarp7 + 6103515625.0));
  let dl50 = Lbarp - 50.0; let dl50sq = dl50 * dl50;
  let SL = 1.0 + (0.015 * dl50sq) / sqrt(20.0 + dl50sq);
  let SC = 1.0 + 0.045 * Cbarp;
  let SH = 1.0 + 0.015 * Cbarp * T;
  let RT = -sin(2.0 * dTheta * PI / 180.0) * RC;
  let x = dLp / SL; let y = dCp / SC; let z = dHp / SH;
  return sqrt(x * x + y * y + z * z + RT * y * z);
}

fn penalty(t: vec3<f32>, m: vec3<f32>) -> f32 {
  var p = 0.12 * max(0.0, m.x - 1.0) + 0.25 * max(0.0, m.y - 1.0);
  if (m.z > 0.0) {
    let chroma = sqrt(t.y * t.y + t.z * t.z);
    if (chroma < 16.0) { p = p + 3.5 * m.z * (1.0 - chroma / 16.0); }
  }
  return p;
}

var<workgroup> shIdx: array<u32, 256>;
var<workgroup> shScore: array<f32, 256>;

// P3: one workgroup per target reduces over the whole gamut and writes ONLY the
// winning index + score (was: full batch*gamut score matrix read back to CPU).
// Tie-break is (score, index) lexicographic so the result is deterministic and
// matches the CPU lowest-index-on-tie rule. 1e38 sentinel marks "no finite score".
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let tid = lid.x;
  if (b >= params.batch) { return; }
  let t = targets.t[b];
  // F-GPU-01: 0xFFFFFFFF is an explicit "no valid candidate" index sentinel. A finite
  // score sentinel (1e38) is unsafe because Math.fround(1e38) < 1e38 in JS, so the
  // read-back check could miss it. The index is validated against the gamut range on
  // the CPU side, which is exact regardless of f32 rounding.
  var bestIdx: u32 = 0xFFFFFFFFu;
  var bestScore: f32 = 1e38;
  var i = tid;
  loop {
    if (i >= params.n) { break; }
    let s = deltaE2000(t, gamut.lab[i]) + penalty(t, gmeta.m[i]);
    if (s < bestScore || (s == bestScore && i < bestIdx)) { bestScore = s; bestIdx = i; }
    i += 256u;
  }
  shIdx[tid] = bestIdx;
  shScore[tid] = bestScore;
  workgroupBarrier();
  var stride = 128u;
  loop {
    if (stride == 0u) { break; }
    if (tid < stride) {
      let s1 = shScore[tid]; let i1 = shIdx[tid];
      let s2 = shScore[tid + stride]; let i2 = shIdx[tid + stride];
      if (s2 < s1 || (s2 == s1 && i2 < i1)) { shScore[tid] = s2; shIdx[tid] = i2; }
    }
    workgroupBarrier();
    stride = stride / 2u;
  }
  if (tid == 0u) { outIdx.v[b] = shIdx[0]; outScore.v[b] = shScore[0]; }
}
`;

  async function init() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      return device || null;
    } catch (e) { return null; }
  }

  async function createMatcher(gamut) {
    const device = await init();
    if (!device || !gamut || !gamut.length) return null;
    const C = CS.color;
    const n = gamut.length;
    const labData = new Float32Array(n * 4);
    const metaData = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const g = gamut[i], l = g.lab;
      labData[i * 4] = l.L; labData[i * 4 + 1] = l.a; labData[i * 4 + 2] = l.b;
      metaData[i * 4] = g.runs || 1; metaData[i * 4 + 1] = g.distinct || 1; metaData[i * 4 + 2] = g.chromaFrac || 0;
    }
    const labBuf = device.createBuffer({ size: labData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(labBuf, 0, labData);
    const gmetaBuf = device.createBuffer({ size: metaData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(gmetaBuf, 0, metaData);
    const module = device.createShaderModule({ code: SCORE_WGSL });
    // R2: async pipeline creation surfaces shader compilation errors as a rejection
    // (caught by buildPlanAsync -> CPU) instead of a silent invalid pipeline.
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const paramBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const neutral = gamut.neutral || [];
    // R2: once the device is lost, every later call must fail fast so the engine
    // falls back to CPU rather than hanging or returning garbage.
    let deviceLost = false;
    if (device.lost && typeof device.lost.then === 'function') {
      device.lost.then(() => { deviceLost = true; }).catch(() => { deviceLost = true; });
    }

    function bestNeutralFor(t) {
      if (Math.hypot(t.a, t.b) >= 8) return null;
      let best = null, de = Infinity;
      for (const e of neutral) { const d = C.deltaE2000(t, e.lab); if (d < de) { de = d; best = e; } }
      return best ? { entry: best, de } : null;
    }
    function isNeutralEntry(g) { return !(g.chromaFrac > 0); }

    // P3: one workgroup per target, so a chunk is bounded by the workgroup-per-dimension
    // limit (not by a batch*gamut score buffer). Readback is now batch*(idx+score) only.
    const lim = device.limits || {};
    const maxWG = lim.maxComputeWorkgroupsPerDimension || 65535;
    const chunkCap = Math.max(1, maxWG);

    // GPU reduces the whole gamut per target and returns only the winning index+score.
    async function rawBestChunk(targets) {
      const batch = targets.length;
      if (!batch) return [];
      if (deviceLost) throw new Error('GPU device lost');
      device.pushErrorScope('validation');
      const tData = new Float32Array(batch * 4);
      for (let b = 0; b < batch; b++) { tData[b * 4] = targets[b].L; tData[b * 4 + 1] = targets[b].a; tData[b * 4 + 2] = targets[b].b; }
      const tBuf = device.createBuffer({ size: tData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(tBuf, 0, tData);
      const outSize = batch * 4;
      const outIdxBuf = device.createBuffer({ size: outSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const outScoreBuf = device.createBuffer({ size: outSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const readIdxBuf = device.createBuffer({ size: outSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const readScoreBuf = device.createBuffer({ size: outSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      device.queue.writeBuffer(paramBuf, 0, new Uint32Array([n, batch, 0, 0]));
      const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: labBuf } }, { binding: 1, resource: { buffer: gmetaBuf } },
        { binding: 2, resource: { buffer: tBuf } }, { binding: 3, resource: { buffer: outIdxBuf } },
        { binding: 4, resource: { buffer: paramBuf } }, { binding: 5, resource: { buffer: outScoreBuf } },
      ] });
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(batch);
      pass.end();
      enc.copyBufferToBuffer(outIdxBuf, 0, readIdxBuf, 0, outSize);
      enc.copyBufferToBuffer(outScoreBuf, 0, readScoreBuf, 0, outSize);
      device.queue.submit([enc.finish()]);
      const gpuErr = await device.popErrorScope();
      const cleanup = () => { tBuf.destroy(); outIdxBuf.destroy(); outScoreBuf.destroy(); readIdxBuf.destroy(); readScoreBuf.destroy(); };
      if (gpuErr) { cleanup(); throw new Error('GPU validation error: ' + (gpuErr.message || gpuErr)); }
      await readIdxBuf.mapAsync(GPUMapMode.READ);
      await readScoreBuf.mapAsync(GPUMapMode.READ);
      const idx = new Uint32Array(readIdxBuf.getMappedRange().slice(0));
      const score = new Float32Array(readScoreBuf.getMappedRange().slice(0));
      readIdxBuf.unmap(); readScoreBuf.unmap();
      cleanup();
      const out = [];
      const sentinel = Math.fround(1e38);
      for (let b = 0; b < batch; b++) {
        const bi = idx[b], s = score[b];
        // F-GPU-01: validate the index against the gamut range (the shader writes
        // 0xFFFFFFFF when no candidate won) AND guard the score. The f32 sentinel
        // read back is Math.fround(1e38) (< 1e38), so compare against that exact value;
        // any invalid result throws -> buildPlanAsync falls back to CPU, never gamut[0].
        if (bi >= n || !Number.isFinite(s) || s >= sentinel) throw new Error('GPU produced no valid score for target ' + b);
        out.push({ index: bi, entry: gamut[bi] });
      }
      return out;
    }

    // Split oversized batches into device-sized chunks and concatenate. Small
    // batches take the single-dispatch path unchanged.
    async function rawBest(targets) {
      const batch = targets.length;
      if (!batch) return [];
      if (batch <= chunkCap) return rawBestChunk(targets);
      const out = [];
      for (let s = 0; s < batch; s += chunkCap) {
        const part = await rawBestChunk(targets.slice(s, s + chunkCap));
        for (let i = 0; i < part.length; i++) out.push(part[i]);
      }
      return out;
    }

    // scanGamutBest-shaped: raw best entry + exact f64 ΔE (no neutral lock).
    async function scanBestBatch(targets) {
      const raw = await rawBest(targets);
      return raw.map((r, b) => ({ g: r.entry, bestDE: C.deltaE2000(targets[b], r.entry.lab) }));
    }

    // matchGamut-shaped: raw best + exact f64 ΔE report + neutral lock.
    async function matchBatch(targets) {
      const raw = await rawBest(targets);
      const results = [];
      for (let b = 0; b < targets.length; b++) {
        const t = targets[b], g = raw[b].entry;
        let bestDE = C.deltaE2000(t, g.lab);
        let entry = g, neutralLocked = false;
        const nb = bestNeutralFor(t);
        if (nb && nb.de <= bestDE + 5) { entry = nb.entry; bestDE = nb.de; neutralLocked = true; }
        results.push({
          seq: entry.seq.slice(), lab: entry.lab, lin: entry.lin, hex: entry.hex,
          deltaE: bestDE, length: entry.length, runs: entry.runs,
          neutral: isNeutralEntry(entry), neutralLocked
        });
      }
      return results;
    }

    return { device, n, matchBatch, scanBestBatch, destroy() { labBuf.destroy(); gmetaBuf.destroy(); paramBuf.destroy(); device.destroy(); } };
  }

  CS.gamutGpu = { init, createMatcher };
})(typeof globalThis !== 'undefined' ? globalThis : this);