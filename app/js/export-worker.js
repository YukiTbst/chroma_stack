/* R7: 3MF assembly + zip worker. The vertex/triangle XML loop and DEFLATE compression
   for large models used to run on the main thread, blocking the UI ("not responding")
   and risking an OOM crash from multiple full-size copies. This worker receives the
   meshed objects (transferable typed arrays) + a lightweight plan (litePlan, no
   per-pixel arrays), runs the shared assemble3MFParts + createZipAsync, and returns
   only the final bytes. Byte-identical to the main-thread path. */
'use strict';
const __vq = (self.location && self.location.search || '').match(/[?&]v=([^&]+)/);
const __q = __vq ? '?v=' + __vq[1] : '';
importScripts('color.js' + __q, 'optics.js' + __q, 'earcut.js' + __q, 'height-curve.js' + __q, 'data-filaments.js' + __q, 'engine.js' + __q, 'layer-optimizer.js' + __q, 'zip.js' + __q, 'exporter.js' + __q);

self.onmessage = async function (e) {
  const m = e.data || {};
  try {
    const objects = m.objects.map(o => ({
      filament: o.filament, name: o.name,
      positions: new Float64Array(o.positions), indices: new Uint32Array(o.indices)
    }));
    const out = CS.exporter.assemble3MFParts(m.plan, objects, m.grid, m.plane, m.ew, m.eh, m.pixelSize);
    const bytes = CS.zip.createZipAsync ? await CS.zip.createZipAsync(out.files) : CS.zip.createZip(out.files);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    self.postMessage({
      id: m.id, ok: true, bytes: buf, meta: out.meta, objects: out.objects,
      ew: out.ew, eh: out.eh, pixelSize: out.pixelSize,
      exportDownscaled: out.exportDownscaled, exportChange: out.exportChange
    }, [buf]);
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
  }
};