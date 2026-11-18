/* Multi-colour TD matrix photo analysis (100 mm, 10-layer, six filaments).
   The board carries single-filament thickness anchors (1/2/4/8 colour layers)
   over BOTH a black and a white base half, plus cross-colour recipe cells.
   Because front-lit mixing is linear in radiance, camera gain cancels when the
   substrate is measured in camera space: each filament's HD and camera-space
   opaque colour are jointly fitted from its eight anchors, the white anchors
   double as the white-balance reference (white opaque == 1), and the mixed
   cells are predicted afterwards as an independent cross-check. */
(function (root) {
  'use strict';
  const CS = root.CS = root.CS || {};
  const C = CS.color;
  const B = CS.batchCalibration;
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const CODES = ['K', 'W', 'O', 'Y', 'C', 'M'];

  /* Mirrors tests/generate-multicolor-td-100mm-6color.py (metadata version 2). */
  function buildMatrixLayout() {
    const board = 100, layerHeight = 0.08, firstLayer = 0.24, baseLayers = 2;
    const baseHeight = firstLayer + layerHeight;
    const steps = [1, 2, 4, 8];
    const filaments = ['K', 'W', 'O', 'Y', 'C', 'M'];
    const mixBlack = [['W', 'O'], ['O', 'W'], ['W', 'M'], ['M', 'W'], ['W', 'Y'], ['Y', 'W'], ['W', 'C'], ['C', 'W']];
    const mixWhite = [['O', 'Y'], ['Y', 'O'], ['C', 'M'], ['M', 'C'], ['O', 'M'], ['M', 'O'], ['Y', 'C'], ['C', 'Y']];
    const margin = 8, seamGap = 2, pitch = 10.5, size = 9;
    const cells = [];
    for (let side = 0; side < 2; side++) {
      const base = side === 0 ? 'K' : 'W';
      const mixes = side === 0 ? mixBlack : mixWhite;
      for (let row = 0; row < 4; row++) for (let col = 0; col < 8; col++) {
        const x = margin + col * pitch;
        // White half starts 2 mm below the base seam so the first row still has
        // a white substrate strip above it for local sampling.
        const y = (side === 0 ? margin : board / 2 + seamGap) + row * pitch;
        const cell = { id: `${side === 0 ? 'B' : 'W'}-${row + 1}${col + 1}`, x, y, size, cx: x + size / 2, cy: y + size / 2, base };
        if (col < 6) {
          const f = filaments[col];
          Object.assign(cell, { kind: 'single', filament: f, recipe: new Array(steps[row]).fill(f), layers: steps[row] });
        } else {
          const recipe = mixes[row * 2 + (col - 6)];
          Object.assign(cell, { kind: 'mixed', recipe, layers: recipe.length });
        }
        cells.push(cell);
      }
    }
    const markers = [
      { x: 1.5, y: 1.5, cx: 3, cy: 3, size: 3, filament: 'W' },
      { x: 95.5, y: 1.5, cx: 97, cy: 3, size: 3, filament: 'W' },
      { x: 95.5, y: 95.5, cx: 97, cy: 97, size: 3, filament: 'K' },
      { x: 1.5, y: 95.5, cx: 3, cy: 97, size: 3, filament: 'K' }
    ];
    return {
      boardW: board, boardD: board, layerHeight, firstLayer, baseLayers, baseHeight,
      totalLayers: baseLayers + Math.max(...steps), maxHeight: firstLayer + (baseLayers + Math.max(...steps) - 1) * layerHeight,
      steps, cells, markers,
      baseSamples: { K: [[20, 4], [80, 4], [50, 17.75]], W: [[20, 96], [80, 96], [50, 82.25]] },
      printMode: 'multi-filament-per-layer',
      note: '100mm 黑白双基底六色板：每色 1/2/4/8 层锚点 + 16 个跨色配方；四角黑白混合定位点（上黑下白基底）。'
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
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      raw[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    }
    // Real prints carry layer-line texture and JPEG noise whose per-pixel
    // gradients reach ~20; a 5x5 box blur collapses them while marker/base
    // steps (>=50) survive, so edges are measured on the smoothed luminance.
    const tmp = new Float32Array(n), lum = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      const row = y * w;
      for (let x = -2; x <= 2; x++) acc += raw[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / 5;
        acc += raw[row + Math.min(w - 1, x + 3)] - raw[row + Math.max(0, x - 2)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -2; y <= 2; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        lum[y * w + x] = acc / 5;
        acc += tmp[Math.min(h - 1, y + 3) * w + x] - tmp[Math.max(0, y - 2) * w + x];
      }
    }
    // Edge strength compares disjoint 5-px window means 6 px apart on the
    // smoothed luminance: a marker/base step keeps its full magnitude while
    // layer-line texture and JPEG noise average out inside each window.
    const edge = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x >= 3 && x + 3 < w && Math.abs(lum[i + 3] - lum[i - 3]) > 25) edge[i] = 1;
      if (y >= 3 && y + 3 < h && Math.abs(lum[i + 3 * w] - lum[i - 3 * w]) > 25) edge[i] = 1;
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
      // The edge band sits inside each region's blurred skirt and reaches ~7 px
      // past the true boundary, so the ring must reach 14 px out and ignore band
      // pixels (label -1) to measure the surrounding region, not the shoulder.
      const x0 = Math.max(0, c.minX - 14), x1 = Math.min(w - 1, c.maxX + 14);
      const y0 = Math.max(0, c.minY - 14), y1 = Math.min(h - 1, c.maxY + 14);
      let ringSum = 0, ringN = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (label[i] === c.id || label[i] < 0) continue;
        ringSum += lum[i]; ringN++;
      }
      if (ringN < 20) continue;
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
    // Hand-held photos leave margin around the board, so markers can sit far
    // from the image corners; nearest-wins plus the content gate keep clutter
    // out even with a generous radius.
    const cornerDefs = [[0, 0], [w, 0], [w, h], [0, h]], chosen = [], used = new Set();
    for (const [cx, cy] of cornerDefs) {
      const candidates = comps.filter(c => !used.has(c) && Math.hypot(c.cx - cx, c.cy - cy) < Math.max(w, h) * 0.45)
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

  const POLARITY = ['B', 'B', 'D', 'D']; // markers tl,tr,br,bl = W,W,K,K
  /* The polarity pattern is a palindrome, so it cannot tell a rotated photo
     from a mirrored one (slicer flip or front camera). Enumerate all eight
     dihedral pairings, keep those matching polarity, then let the content
     decide: within each single-filament anchor group the luminance must move
     with thickness towards the filament's own colour. Opaque filaments (black)
     show almost no spread and are skipped instead of voting with noise. */
  function chooseMarkerMap(layout, detected, imageData) {
    let best = null;
    for (let rot = 0; rot < 4; rot++) for (const mirror of [false, true]) {
      const idx = i => mirror ? (rot - i + 4) % 4 : (i + rot) % 4;
      if (!detected.every((m, i) => POLARITY[idx(i)] === (m.bright ? 'B' : 'D'))) continue;
      const map = B.homography(detected.map((_, i) => layout.markers[idx(i)]), detected);
      // Score = differential transmission validity: under the correct pairing
      // T(d) = (Y_white - Y_black)/(Y_baseWhite - Y_baseBlack) lands in (0,1)
      // and decreases with thickness. Wrong pairings scramble the halves and
      // produce out-of-range or non-monotone T. Palette-independent.
      const WGT = [0.2126, 0.7152, 0.0722];
      let score = 0;
      for (const code of CODES) {
        const cells = layout.cells.filter(c => c.kind === 'single' && c.filament === code);
        const pairs = [];
        for (const d of [...new Set(cells.map(c => c.layers))]) {
          const kc = cells.find(c => c.layers === d && c.base === 'K');
          const wc = cells.find(c => c.layers === d && c.base === 'W');
          const ks = B.sampleMedian(imageData, map, kc.cx, kc.cy, 3).rgb;
          const ws = B.sampleMedian(imageData, map, wc.cx, wc.cy, 3).rgb;
          const kb = B.sampleMedian(imageData, map, kc.cx, kc.y - 0.75, 3).rgb;
          const wb = B.sampleMedian(imageData, map, wc.cx, wc.y - 0.75, 3).rgb;
          const mask = [0, 1, 2].filter(c => ks[c] > 2 && ks[c] < 254 && ws[c] > 2 && ws[c] < 254);
          if (!mask.length) continue;
          const ly = rgb => {
            let num = 0, den = 0;
            for (const c of mask) { num += WGT[c] * C.srgbToLinear(rgb[c] / 255); den += WGT[c]; }
            return num / den;
          };
          const db = ly(wb) - ly(kb), dy = ly(ws) - ly(ks);
          if (db < 0.05) continue;
          const T = dy / db;
          if (T > 0.002 && T < 0.998) pairs.push({ d, T });
        }
        pairs.sort((a, b) => a.d - b.d);
        score += pairs.length;
        for (let i = 1; i < pairs.length; i++) if (pairs[i].T < pairs[i - 1].T) score += 1;
      }
      if (!best || score > best.score) best = { map, score, rot, mirror };
    }
    if (!best) throw new Error('四角黑白分布与矩阵板不符：请确认拍摄的是多色矩阵板（非金字塔板）');
    if (best.score < 5) throw new Error('定位点已找到，但格内颜色与矩阵板配方不符：请确认照片未裁切、板面干净且光线均匀');
    return best;
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

  /* Differential transmission estimator. At equal thickness the two halves
     differ only by what the substrate contributes:
       Y_white(d) - Y_black(d) = T(d) * (Y_baseWhite - Y_baseBlack)
     so T(d) follows from luminance differences alone — opaque colour, gloss
     veil and camera gain all cancel. Regressing log10 T against d gives HD
     without fitting any of the corrupted unknowns. The opaque colour is then
     solved from the 4/10-layer anchors (thin cells carry gloss/chroma noise),
     with clipped channels censored from the linear solve. */
  function fitMatrixAnchors(anchorsByCode) {
    const WGT = [0.2126, 0.7152, 0.0722];
    const data = {};
    for (const code of CODES) data[code] = anchorsByCode[code].map(s => ({
      d: s.thickness, half: s.base, rgb: s.rgb,
      o: s.rgb.map(v => C.srgbToLinear(v / 255)),
      b: s.substrate.map(v => C.srgbToLinear(v / 255)),
      ok: s.rgb.map(v => v > 2 && v < 254)
    }));
    const hd = {}, fits = {};
    for (const code of CODES) {
      const rows = data[code];
      let sdd = 0, sdt = 0, slopeMin = 0;
      for (const d of [...new Set(rows.map(r => r.d))]) {
        const k = rows.find(r => r.d === d && r.half === 'K');
        const w = rows.find(r => r.d === d && r.half === 'W');
        if (!k || !w) continue;
        // Both halves must be compared over the same unclipped channels,
        // otherwise a clipped red channel on one side breaks the difference.
        const mask = [0, 1, 2].filter(c => k.ok[c] && w.ok[c]);
        if (!mask.length) continue;
        const ly = lin => {
          let num = 0, den = 0;
          for (const c of mask) { num += WGT[c] * lin[c]; den += WGT[c]; }
          return num / den;
        };
        const db = ly(w.b) - ly(k.b);
        const dy = ly(w.o) - ly(k.o);
        if (db < 0.05) continue;
        if (Math.abs(dy) < 0.006) {
          // Below the noise floor the pair only bounds T from above, i.e. the
          // slope from below — vital for opaque filaments whose thin-cell
          // signal is chroma noise and would otherwise set HD arbitrarily.
          slopeMin = Math.max(slopeMin, -Math.log10(0.006 / db) / d);
          continue;
        }
        const T = clamp(dy / db, 0.002, 0.998);
        sdd += d * d; sdt += d * -Math.log10(T);
      }
      const slopeLS = sdd > 1e-9 ? sdt / sdd : 0;
      hd[code] = clamp(1 / Math.max(slopeLS, slopeMin, 1e-6), 0.05, 10);
      const thick = rows.filter(r => r.d >= 0.3);
      const use = thick.length >= 2 ? thick : rows;
      const T = use.map(r => Math.pow(10, -r.d / hd[code]));
      const linear = [0, 1, 2].map(c => {
        let num = 0, den = 0, low = 0, high = 0, n = 0;
        for (let i = 0; i < use.length; i++) {
          n++;
          if (use[i].rgb[c] <= 2) low++;
          if (use[i].rgb[c] >= 254) high++;
          if (!use[i].ok[c]) continue;
          num += (1 - T[i]) * (use[i].o[c] - use[i].b[c] * T[i]);
          den += (1 - T[i]) ** 2;
        }
        if (den > 1e-10) return clamp(num / den, 0, 4);
        // Fully censored channel: clipped low means the filament reflects
        // nothing there (blue has no red); clipped high only bounds it below.
        if (low === n) return 0;
        if (high === n) return 1;
        return 0.5;
      });
      let error = 0;
      for (let i = 0; i < use.length; i++) for (let c = 0; c < 3; c++) {
        error += (C.linearToSrgb8(linear[c] * (1 - T[i]) + use[i].b[c] * T[i]) - use[i].rgb[c]) ** 2;
      }
      fits[code] = { hd: hd[code], linear, error: error / (use.length * 3), rgb: linear.map(v => C.linearToSrgb8(v)) };
    }
    return { fits, illumination: { K: 1, W: 1 } };
  }

  /* Board roles from the current palette: darkest/lightest plus four chromatic
     roles matched by hue (orange/yellow/cyan/magenta). */
  function hueOf(hex) {
    const c = C.hexToRgb01(hex);
    const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b), d = max - min;
    if (d < 1e-6) return 0;
    let h;
    if (max === c.r) h = ((c.g - c.b) / d) % 6;
    else if (max === c.g) h = (c.b - c.r) / d + 2;
    else h = (c.r - c.g) / d + 4;
    return (h * 60 + 360) % 360;
  }

  function matchMatrixPalette(palette) {
    if (!palette || palette.length < 6) throw new Error('矩阵标定需要当前耗材里至少有黑、白、橙、黄、青、品红六类耗材');
    const lab = palette.map(p => C.hexToLab(p.hex));
    const hues = palette.map(p => hueOf(p.hex));
    const sats = palette.map(p => {
      const c = C.hexToRgb01(p.hex);
      const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
      return mx < 1e-6 ? 0 : (mx - mn) / mx;
    });
    const K = lab.reduce((best, l, i) => l.L < lab[best].L ? i : best, 0);
    const W = lab.reduce((best, l, i) => l.L > lab[best].L ? i : best, 0);
    const used = new Set([K, W]);
    const out = { K, W };
    const targets = { O: 25, Y: 55, C: 200, M: 325 };
    const circ = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
    for (const role of ['O', 'Y', 'C', 'M']) {
      let best = -1, bestD = 1e9;
      for (let i = 0; i < palette.length; i++) {
        if (used.has(i) || sats[i] < 0.15) continue;
        const d = circ(hues[i], targets[role]);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0 || bestD > 45) throw new Error('无法从当前耗材区分橙/黄/青/品红四类（需要饱和度足够、色相接近的耗材）');
      out[role] = best;
      used.add(best);
    }
    if (new Set(Object.values(out)).size !== 6) throw new Error('无法从当前耗材区分黑/白/橙/黄/青/品红六类，请检查耗材颜色');
    return out;
  }

  function analyzeMatrixPhoto(imageData, palette, options = {}) {
    const layout = options.layout || buildMatrixLayout();
    const mapping = options.mapping || matchMatrixPalette(palette);
    const detected = detectMatrixMarkers(imageData);
    const orient = chooseMarkerMap(layout, detected, imageData);
    const map = orient.map;
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
    // Each anchor needs a local substrate strip, but the photo may be mirrored
    // or rotated, so "above in board coordinates" can land on the other base
    // half. Sample both gaps and keep whichever is closer to the measured base
    // colour of the cell's own half.
    const labBase = {
      K: C.hexToLab(C.rgbToHex(baseSample.K.rgb[0], baseSample.K.rgb[1], baseSample.K.rgb[2])),
      W: C.hexToLab(C.rgbToHex(baseSample.W.rgb[0], baseSample.W.rgb[1], baseSample.W.rgb[2]))
    };
    const subDe = (rgb, base) => C.deltaE2000(labBase[base], C.hexToLab(C.rgbToHex(rgb[0], rgb[1], rgb[2])));
    const substrateOf = (c) => {
      const a = B.sampleMedian(imageData, map, c.cx, c.y - 0.75, 3);
      const b = B.sampleMedian(imageData, map, c.cx, c.y + 9.75, 3);
      return subDe(a.rgb, c.base) <= subDe(b.rgb, c.base) ? a.rgb : b.rgb;
    };
    // Under-extruded single/thin layers leave sparse patches in the middle of a
    // square where the white substrate shows through, which biases a centre
    // median toward the substrate (inflating T and HD). Sample a ring just
    // inside the square's border instead: it is well filled and avoids the
    // bevel highlight at the very rim.
    const sampleCell = (cell) => {
      const inset = 0.4, band = 0.5, step = 0.2;
      const n = Math.round(cell.size / step);
      const ch = [[], [], []];
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
        const u = cell.size * i / n, v = cell.size * j / n;
        const d = Math.min(u, v, cell.size - u, cell.size - v);
        if (d < inset || d > inset + band) continue;
        const pt = map(cell.x + u, cell.y + v);
        const x = Math.round(pt.x), y = Math.round(pt.y);
        if (x < 0 || y < 0 || x >= imageData.width || y >= imageData.height) continue;
        const p = (y * imageData.width + x) * 4;
        for (let c = 0; c < 3; c++) ch[c].push(imageData.data[p + c]);
      }
      const ctr = map(cell.cx, cell.cy);
      if (!ch[0].length) return B.sampleMedian(imageData, map, cell.cx, cell.cy, radius);
      const rgb = ch.map(a => { a.sort((p, q) => p - q); return a[(a.length / 2) | 0]; });
      return { rgb, x: ctr.x, y: ctr.y };
    };
    const anchors = {};
    for (const code of CODES) {
      anchors[code] = layout.cells.filter(c => c.kind === 'single' && c.filament === code).map(c => {
        const s = sampleCell(c);
        return { cellId: c.id, thickness: c.layers * layout.layerHeight, rgb: s.rgb, x: s.x, y: s.y, substrate: substrateOf(c), base: c.base };
      });
    }
    const joint = fitMatrixAnchors(anchors);
    const fits = joint.fits, illum = joint.illumination;
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
        const kk = illum[s.base];
        const o = s.rgb.map(v => C.srgbToLinear(v / 255) / kk);
        const b = s.substrate.map(v => C.srgbToLinear(v / 255));
        let num = 0, den = 0;
        for (let c = 0; c < 3; c++) {
          if (s.rgb[c] <= 2 || s.rgb[c] >= 254) continue; // censored channel
          num += (o[c] - fit.linear[c]) * (b[c] - fit.linear[c]); den += (b[c] - fit.linear[c]) ** 2;
        }
        const T = den > 1e-10 ? clamp(num / den, 0, 1) : 1;
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
      const s = sampleCell(cell);
      const sub = { rgb: substrateOf(cell) };
      let lin = sub.rgb.map(v => C.srgbToLinear(v / 255));
      for (const f of cell.recipe) {
        const r = results.find(x => x.code === f);
        const T = Math.pow(10, -layout.layerHeight / r.hd);
        lin = lin.map((v, c) => camLinear[f][c] * (1 - T) + v * T);
      }
      const predHex = C.rgbToHex(...lin.map(v => C.linearToSrgb8(v * illum[cell.base])));
      const obsHex = C.rgbToHex(s.rgb[0], s.rgb[1], s.rgb[2]);
      checks.push({ id: cell.id, recipe: cell.recipe.join('>'), de: C.deltaE2000(C.hexToLab(predHex), C.hexToLab(obsHex)) });
    }
    const meanDE = checks.reduce((s, c) => s + c.de, 0) / Math.max(1, checks.length);
    const score = results.reduce((s, r) => s + r.score, 0) / results.length;
    return {
      layout, markers: detected, mapping, results, score,
      orientation: { rot: orient.rot, mirror: orient.mirror, score: orient.score },
      illumination: illum,
      quality: {
        blackBase: baseSample.K.rgb, whiteBase: baseSample.W.rgb,
        gainsMax: Math.max(...gains), whiteFitError: fits.W.error
      },
      whiteBalance: { white: baseSample.W.rgb, gains: gains.map(g => 1 / g), cameraGains: gains, hd: fits.W.hd, residual: fits.W.error },
      matrixChecks: { meanDE, maxDE: Math.max(...checks.map(c => c.de)), cells: checks }
    };
  }

  CS.matrixCalibration = { buildMatrixLayout, detectMatrixMarkers, markerCandidates, matchMatrixPalette, analyzeMatrixPhoto, fitAnchors, fitMatrixAnchors };
})(typeof globalThis !== 'undefined' ? globalThis : this);