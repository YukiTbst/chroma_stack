/* Multi-colour TD matrix photo analysis (75 mm, 12-layer board).
   The board carries single-filament thickness anchors (1/4/10 colour layers)
   over BOTH a black and a white base half, plus cross-colour recipe cells.
   Because front-lit mixing is linear in radiance, camera gain cancels when the
   substrate is measured in camera space: each filament's HD and camera-space
   opaque colour are jointly fitted from its six anchors, the white anchors
   double as the white-balance reference (white opaque == 1), and the mixed
   cells are predicted afterwards as an independent cross-check. */
(function (root) {
  'use strict';
  const CS = root.CS = root.CS || {};
  const C = CS.color;
  const B = CS.batchCalibration;
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const CODES = ['K', 'W', 'R', 'U'];

  /* Mirrors tests/generate-multicolor-td-75mm.py (metadata version 1). */
  function buildMatrixLayout() {
    const board = 75, layerHeight = 0.08, firstLayer = 0.24, baseLayers = 2;
    const baseHeight = firstLayer + layerHeight;
    const steps = [1, 4, 10];
    const mixLeft = [['W', 'R'], ['R', 'W'], ['W', 'U'], ['U', 'W'], ['R', 'U', 'R'], ['U', 'R', 'U']];
    const mixRight = [['K', 'R'], ['R', 'K'], ['K', 'U'], ['U', 'K'], ['R', 'W', 'R'], ['U', 'W', 'U']];
    const cells = [];
    for (let side = 0; side < 2; side++) {
      const base = side === 0 ? 'K' : 'W';
      const recipes = [];
      for (const f of ['W', 'K', 'R', 'U']) for (const n of steps) recipes.push({ kind: 'single', filament: f, recipe: new Array(n).fill(f), layers: n });
      for (const recipe of (side === 0 ? mixLeft : mixRight)) recipes.push({ kind: 'mixed', recipe, layers: recipe.length });
      for (let row = 0; row < 6; row++) for (let col = 0; col < 3; col++) {
        const r = recipes[row * 3 + col];
        const x = 6.75 + (side * 3 + col) * 10.5, y = 6.75 + row * 10.5;
        cells.push({ id: `${side === 0 ? 'B' : 'W'}-${row + 1}${col + 1}`, x, y, size: 9, cx: x + 4.5, cy: y + 4.5, base, ...r });
      }
    }
    const markers = [
      { x: 1.5, y: 1.5, cx: 3, cy: 3, size: 3, filament: 'W' },
      { x: 70.5, y: 1.5, cx: 72, cy: 3, size: 3, filament: 'K' },
      { x: 70.5, y: 70.5, cx: 72, cy: 72, size: 3, filament: 'K' },
      { x: 1.5, y: 70.5, cx: 3, cy: 72, size: 3, filament: 'W' }
    ];
    return {
      boardW: board, boardD: board, layerHeight, firstLayer, baseLayers, baseHeight,
      totalLayers: baseLayers + Math.max(...steps), maxHeight: firstLayer + (baseLayers + Math.max(...steps) - 1) * layerHeight,
      steps, cells, markers,
      baseSamples: { K: [[20, 3.5], [20, 71.5], [16.5, 37.5]], W: [[55, 3.5], [55, 71.5], [48, 37.5]] },
      printMode: 'multi-filament-per-layer',
      note: '黑白双基底各 18 格：单色 1/4/10 层厚度锚点 + 6 个跨色配方；四角黑白混合定位点。'
    };
  }

  /* A 2-layer black marker on the white base is mid-grey, not black, so global
     brightness thresholds cannot find it, and corner-window medians are unstable
     (background + base + dark cells compete). Instead segment the photo into
     uniform regions separated by luminance edges: markers, cells, base halves
     and background each become one region. Markers are the compact ~3 mm squares
     with strong contrast against their surrounding ring; base halves and the
     background are rejected by area/fill, cells by being 9x larger. */
  function markerCandidates(imageData) {
    const w = imageData.width, h = imageData.height, n = w * h, data = imageData.data;
    const lum = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      lum[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    }
    const edge = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w && Math.abs(lum[i + 1] - lum[i]) > 14) edge[i] = edge[i + 1] = 1;
      if (y + 1 < h && Math.abs(lum[i + w] - lum[i]) > 14) edge[i] = edge[i + w] = 1;
    }
    const label = new Int32Array(n).fill(-1), stack = new Int32Array(n), comps = [];
    const minArea = Math.max(8, Math.round(n * 0.00005)), maxArea = n * 0.004;
    for (let start = 0; start < n; start++) {
      if (edge[start] || label[start] >= 0) continue;
      const id = comps.length;
      let top = 0, area = 0, minX = w, maxX = -1, minY = h, maxY = -1, sx = 0, sy = 0, sum = 0;
      label[start] = id; stack[top++] = start;
      while (top) {
        const i = stack[--top], x = i % w, y = (i / w) | 0;
        area++; sx += x; sy += y; sum += lum[i];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const j = yy * w + xx;
          if (!edge[j] && label[j] < 0) { label[j] = id; stack[top++] = j; }
        }
      }
      comps.push({ id, area, minX, maxX, minY, maxY, cx: sx / area, cy: sy / area, mean: sum / area });
    }
    const out = [];
    for (const c of comps) {
      if (c.area < minArea || c.area > maxArea) continue;
      const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
      if (c.area / (bw * bh) <= 0.5 || bw / bh <= 0.4 || bw / bh >= 2.5) continue;
      const x0 = Math.max(0, c.minX - 3), x1 = Math.min(w - 1, c.maxX + 3);
      const y0 = Math.max(0, c.minY - 3), y1 = Math.min(h - 1, c.maxY + 3);
      let ringSum = 0, ringN = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (label[i] === c.id) continue;
        ringSum += lum[i]; ringN++;
      }
      if (!ringN) continue;
      const ring = ringSum / ringN;
      if (Math.abs(c.mean - ring) <= 25) continue;
      out.push({ area: c.area, cx: c.cx, cy: c.cy, meanY: c.mean, ring });
    }
    return out;
  }

  /* Two white markers on the black half + two black markers on the white half.
     The polarity pattern around the quadrilateral resolves any 90° rotation. */
  function detectMatrixMarkers(imageData) {
    const w = imageData.width, h = imageData.height;
    const comps = markerCandidates(imageData);
    const cornerDefs = [[0, 0], [w, 0], [w, h], [0, h]], chosen = [], used = new Set();
    for (const [cx, cy] of cornerDefs) {
      const candidates = comps.filter(c => !used.has(c) && Math.hypot(c.cx - cx, c.cy - cy) < Math.max(w, h) * 0.3)
        .sort((a, b) => Math.hypot(a.cx - cx, a.cy - cy) - Math.hypot(b.cx - cx, b.cy - cy) || b.area - a.area);
      if (!candidates.length) throw new Error('找不到四个角定位点，请让矩阵板四角完整入镜、尽量充满画面且对比清晰');
      chosen.push(candidates[0]); used.add(candidates[0]);
    }
    const tl = chosen.reduce((a, b) => a.cx + a.cy < b.cx + b.cy ? a : b);
    const br = chosen.reduce((a, b) => a.cx + a.cy > b.cx + b.cy ? a : b);
    const tr = chosen.reduce((a, b) => a.cx - a.cy > b.cx - b.cy ? a : b);
    const bl = chosen.reduce((a, b) => a.cx - a.cy < b.cx - b.cy ? a : b);
    const ordered = [tl, tr, br, bl];
    if (new Set(ordered).size !== 4) throw new Error('定位点无法组成四边形，请重新拍摄');
    return ordered.map(m => ({ ...m, bright: m.meanY > m.ring }));
  }

  const POLARITY = ['B', 'D', 'D', 'B']; // layout markers tl,tr,br,bl = W,K,K,W
  function markerHomography(layout, detected) {
    for (let rot = 0; rot < 4; rot++) {
      const ok = detected.every((m, i) => POLARITY[(i + rot) % 4] === (m.bright ? 'B' : 'D'));
      if (ok) return B.homography(detected.map((_, i) => layout.markers[(i + rot) % 4]), detected);
    }
    throw new Error('四角黑白分布与矩阵板不符：请确认拍摄的是多色矩阵板（非金字塔板），且照片未镜像');
  }

  /* Joint fit in camera space: for a fixed HD the opaque camera colour is
     linear per channel across anchors that may sit on different substrates. */
  function fitAnchors(samples) {
    const observed = samples.map(s => ({
      thickness: s.thickness, rgb: s.rgb,
      linear: s.rgb.map(v => C.srgbToLinear(v / 255)),
      base: s.substrate.map(v => C.srgbToLinear(v / 255))
    }));
    const evaluate = logHd => {
      const hd = Math.exp(logHd), T = observed.map(s => Math.pow(10, -s.thickness / hd));
      const den = T.reduce((sum, t) => sum + (1 - t) ** 2, 0);
      if (den < 1e-10) return { error: Infinity, hd, linear: [1, 1, 1], rgb: [255, 255, 255] };
      const linear = [0, 1, 2].map(c => {
        let num = 0;
        for (let i = 0; i < observed.length; i++) num += (1 - T[i]) * (observed[i].linear[c] - observed[i].base[c] * T[i]);
        return clamp(num / den, 0, 4); // camera-space opaque may exceed 1 before gain removal
      });
      let error = 0;
      for (let i = 0; i < observed.length; i++) for (let c = 0; c < 3; c++) {
        error += (C.linearToSrgb8(linear[c] * (1 - T[i]) + observed[i].base[c] * T[i]) - observed[i].rgb[c]) ** 2;
      }
      return { error: error / (observed.length * 3), hd, linear, rgb: linear.map(v => C.linearToSrgb8(v)) };
    };
    return B.searchScalar(evaluate, Math.log(0.05), Math.log(10));
  }

  /* Board roles from the current palette: darkest / lightest / reddest / bluest. */
  function matchMatrixPalette(palette) {
    if (!palette || palette.length < 4) throw new Error('矩阵标定需要当前耗材里至少有黑、白、红、蓝四类耗材');
    const lab = palette.map(p => C.hexToLab(p.hex));
    const arg = (fn, exclude = []) => lab.reduce((best, l, i) => (exclude.includes(i) || (best >= 0 && !fn(l, lab[best]))) ? best : i, -1);
    const K = arg((l, b) => l.L < b.L);
    const W = arg((l, b) => l.L > b.L);
    const R = arg((l, b) => l.a > b.a, [K, W]);
    const U = arg((l, b) => l.b < b.b, [K, W, R]);
    if (new Set([K, W, R, U]).size !== 4) throw new Error('无法从当前耗材区分黑/白/红/蓝四类，请检查耗材颜色');
    return { K, W, R, U };
  }

  function analyzeMatrixPhoto(imageData, palette, options = {}) {
    const layout = options.layout || buildMatrixLayout();
    const mapping = options.mapping || matchMatrixPalette(palette);
    const detected = detectMatrixMarkers(imageData);
    const map = markerHomography(layout, detected);
    const p0 = map(0, 0), p10 = map(10, 0);
    const radius = clamp(Math.round(Math.hypot(p10.x - p0.x, p10.y - p0.y) / 10), 2, 8);
    const baseSample = {};
    for (const code of ['K', 'W']) {
      const pts = layout.baseSamples[code].map(([x, y]) => B.sampleMedian(imageData, map, x, y, radius));
      baseSample[code] = {
        rgb: [0, 1, 2].map(c => Math.round(pts.reduce((s, p) => s + p.rgb[c], 0) / pts.length)),
        x: pts[0].x, y: pts[0].y
      };
    }
    const anchors = {}, fits = {};
    for (const code of CODES) {
      anchors[code] = layout.cells.filter(c => c.kind === 'single' && c.filament === code).map(c => {
        const s = B.sampleMedian(imageData, map, c.cx, c.cy, radius);
        return { cellId: c.id, thickness: c.layers * layout.layerHeight, rgb: s.rgb, x: s.x, y: s.y, substrate: baseSample[c.base].rgb, base: c.base };
      });
      fits[code] = fitAnchors(anchors[code]);
    }
    // White opaque is pure white by definition, so its camera-space opaque
    // colour IS the per-channel camera gain (linear space).
    const gains = fits.W.linear.map(g => clamp(g, 0.25, 4));
    const results = [];
    for (const code of CODES) {
      const k = mapping[code], fit = fits[code], samples = anchors[code];
      const spread = Math.max(...[0, 1, 2].map(c => Math.max(...samples.map(s => s.rgb[c])) - Math.min(...samples.map(s => s.rgb[c]))));
      const identifiable = spread >= 5 && Number.isFinite(fit.hd) && Number.isFinite(fit.error) && fit.error < 2500;
      const nominalHd = Number(palette[k].hd) || Number(palette[k].td) * 0.1 || 0.5;
      const hd = identifiable ? fit.hd : nominalHd;
      const sceneLinear = code === 'W' ? [1, 1, 1] : fit.linear.map((v, c) => clamp(v / gains[c], 0, 1));
      const opaqueCam = identifiable ? fit.linear : sceneLinear.map((v, c) => v * gains[c]);
      const opaque = code === 'W' ? [255, 255, 255] : sceneLinear.map(v => C.linearToSrgb8(v));
      const residuals = [];
      for (const s of samples) {
        const T = B.transmission(s.substrate, opaqueCam.map(v => C.linearToSrgb8(v)), s.rgb);
        if (T > 0.0005 && T < 0.995) residuals.push(Math.abs(Math.log10(T) + s.thickness / hd));
      }
      residuals.sort((a, b) => a - b);
      let residual = residuals.length ? residuals[(residuals.length / 2) | 0] : 1;
      if (!identifiable) residual = Math.max(residual, 0.4);
      results.push({
        index: k, code, id: palette[k].id, name: palette[k].name, brand: palette[k].brand, material: palette[k].material,
        hex: C.rgbToHex(opaque[0], opaque[1], opaque[2]), hd, td: clamp(hd * 10, 0.1, 20),
        score: clamp(1 - residual * 2, 0, 1), residual, samples,
        railSample: baseSample[code === 'W' ? 'K' : 'W'],
        fitError: fit.error, opaqueFit: identifiable
      });
    }
    // Independent cross-check: predict every mixed recipe from the fitted
    // parameters and compare with the photographed cell.
    const camLinear = {};
    for (const code of CODES) camLinear[code] = fits[code].linear;
    const checks = [];
    for (const cell of layout.cells.filter(c => c.kind === 'mixed')) {
      const s = B.sampleMedian(imageData, map, cell.cx, cell.cy, radius);
      let lin = baseSample[cell.base].rgb.map(v => C.srgbToLinear(v / 255));
      for (const f of cell.recipe) {
        const r = results.find(x => x.code === f);
        const T = Math.pow(10, -layout.layerHeight / r.hd);
        lin = lin.map((v, c) => camLinear[f][c] * (1 - T) + v * T);
      }
      const predHex = C.rgbToHex(...lin.map(v => C.linearToSrgb8(v)));
      const obsHex = C.rgbToHex(s.rgb[0], s.rgb[1], s.rgb[2]);
      checks.push({ id: cell.id, recipe: cell.recipe.join('>'), de: C.deltaE2000(C.hexToLab(predHex), C.hexToLab(obsHex)) });
    }
    const meanDE = checks.reduce((s, c) => s + c.de, 0) / Math.max(1, checks.length);
    const score = results.reduce((s, r) => s + r.score, 0) / results.length;
    return {
      layout, markers: detected, mapping, results, score,
      whiteBalance: { white: baseSample.W.rgb, gains: gains.map(g => 1 / g), cameraGains: gains, hd: fits.W.hd, residual: fits.W.error },
      matrixChecks: { meanDE, maxDE: Math.max(...checks.map(c => c.de)), cells: checks }
    };
  }

  CS.matrixCalibration = { buildMatrixLayout, detectMatrixMarkers, matchMatrixPalette, analyzeMatrixPhoto, fitAnchors };
})(typeof globalThis !== 'undefined' ? globalThis : this);