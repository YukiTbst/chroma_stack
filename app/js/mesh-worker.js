/* PERF3: parallel 3MF mesh worker. Meshes a chunk of prisms (one watertight object
   per colour + contiguous layer range) off the main thread. Returns transferable
   typed arrays so the pool can merge them into the shared assemble3MFParts path. */
'use strict';
importScripts('color.js', 'optics.js', 'earcut.js', 'height-curve.js', 'data-filaments.js', 'engine.js', 'layer-optimizer.js', 'zip.js', 'exporter.js');

self.onmessage = function (e) {
  const m = e.data || {};
  try {
    const palette = m.palette, lh = m.layerHeight, ew = m.ew, eh = m.eh, ps = m.pixelSize;
    const objects = [];
    const transfer = [];
    for (const t of m.tasks) {
      const positions = [], indices = [];
      CS.exporter.meshPrism(t.mask, ew, eh, ps, t.z0 * lh, t.z1 * lh, positions, indices);
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