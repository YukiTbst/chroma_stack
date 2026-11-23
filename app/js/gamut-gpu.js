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
struct Out { s: array<f32>, };
@group(0) @binding(0) var<storage, read> gamut: Gamut;
@group(0) @binding(1) var<storage, read> gmeta: Meta;
@group(0) @binding(2) var<storage, read> targets: Targets;
@group(0) @binding(3) var<storage, read_write> out: Out;
struct Params { n: u32, batch: u32, pad0: u32, pad1: u32, };
@group(0) @binding(4) var<uniform> params: Params;

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
  let dTheta = 30.0 * exp(-pow((hbarp - 275.0) / 25.0, 2.0));
  let Cbarp7 = pow(Cbarp, 7.0);
  let RC = 2.0 * sqrt(Cbarp7 / (Cbarp7 + 6103515625.0));
  let SL = 1.0 + (0.015 * pow(Lbarp - 50.0, 2.0)) / sqrt(20.0 + pow(Lbarp - 50.0, 2.0));
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

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  let total = params.n * params.batch;
  if (idx >= total) { return; }
  let b = idx / params.n;
  let i = idx % params.n;
  let t = targets.t[b];
  let de = deltaE2000(t, gamut.lab[i]);
  out.s[idx] = de + penalty(t, gmeta.m[i]);
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
    const metaBuf = device.createBuffer({ size: metaData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(metaBuf, 0, metaData);
    const module = device.createShaderModule({ code: SCORE_WGSL });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const paramBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const neutral = gamut.neutral || [];

    function bestNeutralFor(t) {
      if (Math.hypot(t.a, t.b) >= 8) return null;
      let best = null, de = Infinity;
      for (const e of neutral) { const d = C.deltaE2000(t, e.lab); if (d < de) { de = d; best = e; } }
      return best ? { entry: best, de } : null;
    }
    function isNeutralEntry(g) { return !(g.chromaFrac > 0); }

    // Match a batch of targets. GPU scores the whole gamut; CPU argmin + exact f64 ΔE
    // report + neutral lock. Returns an array of matchGamut-shaped results (or null).
    async function matchBatch(targets) {
      const batch = targets.length;
      if (!batch) return [];
      const tData = new Float32Array(batch * 4);
      for (let b = 0; b < batch; b++) { tData[b * 4] = targets[b].L; tData[b * 4 + 1] = targets[b].a; tData[b * 4 + 2] = targets[b].b; }
      const tBuf = device.createBuffer({ size: tData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(tBuf, 0, tData);
      const outSize = batch * n * 4;
      const outBuf = device.createBuffer({ size: outSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const readBuf = device.createBuffer({ size: outSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      device.queue.writeBuffer(paramBuf, 0, new Uint32Array([n, batch, 0, 0]));
      const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: labBuf } }, { binding: 1, resource: { buffer: metaBuf } },
        { binding: 2, resource: { buffer: tBuf } }, { binding: 3, resource: { buffer: outBuf } },
        { binding: 4, resource: { buffer: paramBuf } },
      ] });
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(batch * n / 256));
      pass.end();
      enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, outSize);
      device.queue.submit([enc.finish()]);
      await readBuf.mapAsync(GPUMapMode.READ);
      const scores = new Float32Array(readBuf.getMappedRange().slice(0));
      readBuf.unmap();
      tBuf.destroy(); outBuf.destroy(); readBuf.destroy();
      const results = [];
      for (let b = 0; b < batch; b++) {
        const t = targets[b];
        let bi = 0, bs = Infinity;
        const off = b * n;
        for (let i = 0; i < n; i++) { const s = scores[off + i]; if (s < bs) { bs = s; bi = i; } }
        const g = gamut[bi];
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

    return { device, n, matchBatch, destroy() { labBuf.destroy(); metaBuf.destroy(); paramBuf.destroy(); device.destroy(); } };
  }

  CS.gamutGpu = { init, createMatcher };
})(typeof globalThis !== 'undefined' ? globalThis : this);