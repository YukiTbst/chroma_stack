/* ChromaStack luminance→height curve (绘画/亮度浮雕 mode). A control-point curve maps
   normalized source luminance x∈[0,1] to a height fraction y∈[0,1], evaluated by
   piecewise-linear interpolation through points sorted by x (clamped at the ends).
   Pure helpers shared by the engine, the curve-editor UI and the worker. */
(function (root) {
  const CS = root.CS = root.CS || {};

  // Bright → high (default). Dark → high (line art: black strokes raised on white).
  function defaultCurve() { return [{ x: 0, y: 0 }, { x: 1, y: 1 }]; }
  function invertCurve() { return [{ x: 0, y: 1 }, { x: 1, y: 0 }]; }
  // Contrast S-curve: lifts highlights and deepens shadows around the midtone.
  function contrastCurve() { return [{ x: 0, y: 0 }, { x: 0.25, y: 0.08 }, { x: 0.75, y: 0.92 }, { x: 1, y: 1 }]; }

  function validateCurve(pts) {
    if (!Array.isArray(pts) || pts.length < 2) return { ok: false, error: 'curve needs at least 2 control points' };
    for (const p of pts) {
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || !isFinite(p.x) || !isFinite(p.y)) return { ok: false, error: 'curve control point must be finite numbers' };
      if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return { ok: false, error: 'curve control point must be within [0,1]' };
    }
    return { ok: true, value: pts };
  }

  function evalCurve(pts, x) {
    if (!Array.isArray(pts) || !pts.length) return Math.max(0, Math.min(1, x));
    const p = pts.slice().sort((a, b) => a.x - b.x);
    if (x <= p[0].x) return p[0].y;
    if (x >= p[p.length - 1].x) return p[p.length - 1].y;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      if (x >= a.x && x <= b.x) {
        const t = (b.x - a.x) > 1e-9 ? (x - a.x) / (b.x - a.x) : 0;
        return a.y + (b.y - a.y) * t;
      }
    }
    return p[p.length - 1].y;
  }

  CS.heightCurve = { defaultCurve, invertCurve, contrastCurve, validateCurve, evalCurve };
})(typeof globalThis !== 'undefined' ? globalThis : this);