/* Classic Web Worker: build one calibration plan off the UI thread.
   app.js falls back to synchronous planning if this worker is unavailable.
   PERF2-GPU: uses buildPlanAsync (WebGPU batch matching pre-warm) when available;
   it falls back to the CPU path internally when WebGPU is absent. */
'use strict';
/* GPU5: cache-bust every dependency with the app asset version forwarded by app.js
   in the worker URL (?v=…). Without this a deploy leaves returning users on a stale
   cached worker/importScripts and the GPU path never activates. */
const __vq = (self.location && self.location.search || '').match(/[?&]v=([^&]+)/);
const __q = __vq ? '?v=' + __vq[1] : '';
importScripts('color.js' + __q, 'data-filaments.js' + __q, 'earcut.js' + __q, 'optics.js' + __q, 'height-curve.js' + __q, 'gamut-gpu.js' + __q, 'calibration-data.js' + __q, 'layer-optimizer.js' + __q, 'engine.js' + __q, 'parallel.js' + __q);

self.onmessage = async function (e) {
  const msg = e.data || {};
  let pool = null;
  try {
    const image = {
      width: msg.width,
      height: msg.height,
      data: new Uint8ClampedArray(msg.data)
    };
    // GPU7/R5: spawn a nested plan-worker pool only above the measured benefit point.
    // Pool startup + per-worker data transfer is a fixed cost; below ~1M pixels the
    // sync path is faster (review measured 230k px ~47% slower with the pool). 4x
    // (~2.9M px) is where parallel smoothing/assign clearly wins.
    const n = msg.width * msg.height;
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    if (n > 1000000 && cores > 2 && CS.parallel) {
      const size = Math.min(8, Math.max(2, cores - 1));
      pool = CS.parallel.makePool((f) => f + __q, size);
    }
    const options = pool ? Object.assign({}, msg.options, { pool }) : msg.options;
    const plan = await CS.engine.buildPlanAsync(image, options);
    if (pool) pool.destroy();
    self.postMessage({ id: msg.id, ok: true, plan });
  } catch (err) {
    if (pool) { try { pool.destroy(); } catch (_) {} }
    self.postMessage({ id: msg.id, ok: false, error: String(err && err.message || err) });
  }
};