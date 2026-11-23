/* ChromaStack WebGPU gamut matcher (PERF2-GPU). Accelerates the colour-gamut
   nearest-neighbour shortlist with GPU parallel distance computation, while the
   FINAL selection stays on the CPU in float64 using the original algorithm — so the
   generated plan is bit-identical to the CPU path. The GPU only returns a candidate
   SUPERSET (top-K by Lab and by ΔE94, K wider than the CPU shortlist); the CPU then
   reproduces the exact Lab-512 / ΔE94-4096 pool and ΔE2000 ranking on that superset.
   When WebGPU is unavailable the matcher is null and the engine uses the pure-CPU
   path unchanged. */
(function (root) {
  const CS = root.CS = root.CS || {};

  const DIST_WGSL = `
struct Gamut { lab: array<vec3<f32>>, };
struct Targets { t: array<vec3<f32>>, };
struct Out { d: array<f32>, };
@group(0) @binding(0) var<storage, read> gamut: Gamut;
@group(0) @binding(1) var<storage, read> targets: Targets;
@group(0) @binding(2) var<storage, read_write> out: Out;
struct Params { n: u32, batch: u32, metric: u32, pad: u32, };
@group(0) @binding(3) var<uniform> params: Params;

fn de94(t: vec3<f32>, l: vec3<f32>) -> f32 {
  let c1 = sqrt(t.y * t.y + t.z * t.z);
  let c2 = sqrt(l.y * l.y + l.z * l.z);
  let dl = t.x - l.x;
  let dc = c1 - c2;
  let da = t.y - l.y;
  let db = t.z - l.z;
  let dh2 = max(0.0, da * da + db * db - dc * dc);
  let sc = 1.0 + 0.045 * c1;
  let sh = 1.0 + 0.015 * c1;
  let a2 = dc / sc;
  let b2 = sqrt(dh2) / sh;
  return dl * dl + a2 * a2 + b2 * b2;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  let total = params.n * params.batch;
  if (idx >= total) { return; }
  let b = idx / params.n;
  let i = idx % params.n;
  let t = targets.t[b];
  let l = gamut.lab[i];
  let dl = t.x - l.x; let da = t.y - l.y; let db = t.z - l.z;
  var d: f32;
  if (params.metric == 0u) {
    d = dl * dl + da * da + db * db;
  } else {
    d = de94(t, l);
  }
  out.d[idx] = d;
}
`;

  async function init() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      if (!device) return null;
      return device;
    } catch (e) { return null; }
  }

  // Build a matcher bound to a gamut. Returns null when WebGPU is unavailable.
  async function createMatcher(gamut) {
    const device = await init();
    if (!device || !gamut || !gamut.length) return null;
    const n = gamut.length;
    // Upload gamut Lab as vec3<f32> (std430 stride 16 bytes via vec3 alignment).
    const labData = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { const l = gamut[i].lab; labData[i * 4] = l.L; labData[i * 4 + 1] = l.a; labData[i * 4 + 2] = l.b; }
    const labBuf = device.createBuffer({ size: labData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(labBuf, 0, labData);
    const module = device.createShaderModule({ code: DIST_WGSL });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const paramBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    // Compute distances for a batch of targets (metric 0=Lab, 1=ΔE94). Returns Float32Array
    // of length batch*n (row-major per target). Caller does exact CPU selection.
    async function distances(targets, metric) {
      const batch = targets.length;
      const tData = new Float32Array(batch * 4);
      for (let b = 0; b < batch; b++) { tData[b * 4] = targets[b].L; tData[b * 4 + 1] = targets[b].a; tData[b * 4 + 2] = targets[b].b; }
      const tBuf = device.createBuffer({ size: tData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(tBuf, 0, tData);
      const outSize = batch * n * 4;
      const outBuf = device.createBuffer({ size: outSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const readBuf = device.createBuffer({ size: outSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      device.queue.writeBuffer(paramBuf, 0, new Uint32Array([n, batch, metric, 0]));
      const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: labBuf } },
        { binding: 1, resource: { buffer: tBuf } },
        { binding: 2, resource: { buffer: outBuf } },
        { binding: 3, resource: { buffer: paramBuf } },
      ] });
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(batch * n / 256));
      pass.end();
      enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, outSize);
      device.queue.submit([enc.finish()]);
      await readBuf.mapAsync(GPUMapMode.READ);
      const res = new Float32Array(readBuf.getMappedRange().slice(0));
      readBuf.unmap();
      tBuf.destroy(); outBuf.destroy(); readBuf.destroy();
      return res;
    }

    return {
      device, n, distances,
      destroy() { labBuf.destroy(); paramBuf.destroy(); device.destroy(); }
    };
  }

  CS.gamutGpu = { init, createMatcher };
})(typeof globalThis !== 'undefined' ? globalThis : this);