/* Classic Web Worker: build one calibration plan off the UI thread.
   app.js falls back to synchronous planning if this worker is unavailable.
   PERF2-GPU: uses buildPlanAsync (WebGPU batch matching pre-warm) when available;
   it falls back to the CPU path internally when WebGPU is absent. */
'use strict';
importScripts('color.js', 'data-filaments.js', 'data-lut.js', 'earcut.js', 'optics.js', 'height-curve.js', 'gamut-gpu.js', 'calibration-data.js', 'layer-optimizer.js', 'engine.js');

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