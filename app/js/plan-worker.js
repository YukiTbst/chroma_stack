/* GPU7: parallel plan-phase worker. Runs per-pixel / row-band kernels off the main
   thread using the SAME engine functions as the sync path, so results are
   bit-identical. Static arrays (mask/protect/lab/neutral) are uploaded once via
   'init'; each 'smooth' message carries a src snapshot + row band [y0,y1).
   Version query is forwarded by the pool (?v=…) to bust caches on deploy. */
'use strict';
const __vq = (self.location && self.location.search || '').match(/[?&]v=([^&]+)/);
const __q = __vq ? '?v=' + __vq[1] : '';
importScripts('color.js' + __q, 'optics.js' + __q, 'height-curve.js' + __q, 'data-filaments.js' + __q, 'calibration-data.js' + __q, 'layer-optimizer.js' + __q, 'engine.js' + __q);

let S = null;
let D = null;
self.onmessage = function (e) {
  const m = e.data || {};
  try {
    if (m.op === 'setData') {
      D = { lab: new Float32Array(m.lab), mask: new Uint8Array(m.mask), stroke: m.stroke ? new Uint8Array(m.stroke) : null, w: m.w };
      self.postMessage({ id: m.id, ok: true });
      return;
    }
    if (m.op === 'init') {
      S = {
        mask: new Uint8Array(m.mask),
        protect: m.protect ? new Uint8Array(m.protect) : null,
        lab: m.lab ? new Float32Array(m.lab) : null,
        neutralNeed: m.neutralNeed ? new Uint8Array(m.neutralNeed) : null,
        famNeutral: m.famNeutral ? new Uint8Array(m.famNeutral) : null,
        famPredL: new Float64Array(m.famPredL),
        w: m.w, h: m.h, familyCount: m.familyCount, radius: m.radius, colorTol: m.colorTol,
        // R5: reuse one full-size output buffer across passes instead of allocating
        // per call; only the band slice is copied for transfer.
        out: new Int16Array(m.w * m.h)
      };
      self.postMessage({ id: m.id, ok: true });
      return;
    }
    if (m.op === 'smooth') {
      const src = new Int16Array(m.src);
      const out = S.out;
      CS.engine.smoothFamilyMapBand(src, out, S.mask, S.protect, S.lab, S.familyCount, S.famPredL, S.neutralNeed, S.famNeutral, S.w, S.h, S.radius, m.y0, m.y1, S.colorTol);
      const band = out.slice(m.y0 * S.w, m.y1 * S.w);
      self.postMessage({ id: m.id, ok: true, y0: m.y0, out: band.buffer }, [band.buffer]);
      return;
    }
    if (m.op === 'assign') {
      // Pure per-pixel nearest-family assignment over [i0,i1) using the persisted
      // lab/mask/stroke (setData). pred is flat Float64Array (F*3).
      const pred = new Float64Array(m.pred);
      const res = CS.engine.assignFamiliesRange(D.lab, D.mask, pred, m.F, D.w, m.i0, m.i1, D.stroke);
      self.postMessage({ id: m.id, ok: true, familyId: res.familyId.buffer, counts: res.counts.buffer }, [res.familyId.buffer, res.counts.buffer]);
      return;
    }
    self.postMessage({ id: m.id, ok: false, error: 'unknown op ' + m.op });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
  }
};