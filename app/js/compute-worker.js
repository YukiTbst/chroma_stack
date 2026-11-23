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
importScripts('color.js' + __q, 'data-filaments.js' + __q, 'data-lut.js' + __q, 'earcut.js' + __q, 'optics.js' + __q, 'height-curve.js' + __q, 'gamut-gpu.js' + __q, 'calibration-data.js' + __q, 'layer-optimizer.js' + __q, 'engine.js' + __q);

self.onmessage = async function (e) {
  const msg = e.data || {};
  try {
    const image = {
      width: msg.width,
      height: msg.height,
      data: new Uint8ClampedArray(msg.data)
    };
    const plan = await CS.engine.buildPlanAsync(image, msg.options);
    self.postMessage({ id: msg.id, ok: true, plan });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String(err && err.message || err) });
  }
};