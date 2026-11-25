/* PERF3: parallel 3MF mesh worker. Meshes a chunk of prisms (one watertight object
   per colour + contiguous layer range) off the main thread. Returns transferable
   typed arrays so the pool can merge them into the shared assemble3MFParts path. */
'use strict';
/* GPU5: cache-bust every dependency with the app asset version forwarded in the
   worker URL (?v=…), so a deploy never leaves the pool on stale cached scripts. */
const __vq = (self.location && self.location.search || '').match(/[?&]v=([^&]+)/);
const __q = __vq ? '?v=' + __vq[1] : '';
importScripts('color.js' + __q, 'optics.js' + __q, 'earcut.js' + __q, 'height-curve.js' + __q, 'data-filaments.js' + __q, 'engine.js' + __q, 'layer-optimizer.js' + __q, 'zip.js' + __q, 'exporter.js' + __q);

self.onmessage = function (e) {
  const m = e.data || {};
  try {
    const palette = m.palette, lh = m.layerHeight, ew = m.ew, eh = m.eh, ps = m.pixelSize;
    // layerSwap carries a non-uniform cumulative thickness table (spec §3.2).
    const zOf = z => m.layerZMm ? m.layerZMm[z] : z * lh;
    const objects = [];
    const transfer = [];
    for (const t of m.tasks) {
      const positions = [], indices = [];
      CS.exporter.meshPrism(t.mask, ew, eh, ps, zOf(t.z0), zOf(t.z1), positions, indices);
      if (!indices.length) continue;
      for (let i = 0; i < positions.length; i += 3) { positions[i] += 128; positions[i + 1] += 128; }
      const pos = Float64Array.from(positions), idx = Uint32Array.from(indices);
      objects.push({ filament: t.f, name: `${palette[t.f].name} · L${t.z0 + 1}-${t.z1}`, positions: pos, indices: idx });
      transfer.push(pos.buffer, idx.buffer);
    }
    self.postMessage({ id: m.id, ok: true, objects }, transfer);
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
  }
};