/* Classic Web Worker: build one calibration plan off the UI thread.
   app.js falls back to synchronous planning if this worker is unavailable. */
'use strict';
importScripts('color.js', 'data-filaments.js', 'data-lut.js', 'earcut.js', 'optics.js', 'calibration-data.js', 'layer-optimizer.js', 'engine.js');

self.onmessage = function (e) {
  const msg = e.data || {};
  try {
    const image = {
      width: msg.width,
      height: msg.height,
      data: new Uint8ClampedArray(msg.data)
    };
    const plan = CS.engine.buildPlan(image, msg.options);
    self.postMessage({ id: msg.id, ok: true, plan });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String(err && err.message || err) });
  }
};