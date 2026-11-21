/* ChromaStack planning engine.
   - Hybrid segmentation: solid direct-color regions + local layered color regions.
   - LUT engine: pre-calibrated Bambu PLA Basic 5-layer LUTs from Lumina Studio.
   - TD engine: arbitrary filaments, Beer-Lambert hiding distance, local stack search.
   Sets globalThis.CS.engine. No dependencies outside CS.color. */
(function (root) {
  'use strict';
  const CS = root.CS = root.CS || {};
  const C = CS.color;
  const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function imageToLab(imageData) {
    const data = imageData.data, n = imageData.width * imageData.height;
    const lab = new Float32Array(n * 3);
    const alpha = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = data[p] / 255, g = data[p + 1] / 255, b = data[p + 2] / 255;
      const l = C.rgb01ToLab({ r, g, b });
      lab[i * 3] = l.L; lab[i * 3 + 1] = l.a; lab[i * 3 + 2] = l.b;
      alpha[i] = data[p + 3];
    }
    return { lab, alpha };
  }

  function labAt(lab, i) { return { L: lab[i * 3], a: lab[i * 3 + 1], b: lab[i * 3 + 2] }; }

  function localStd(lab, w, h, radius) {
    const sw = w + 1, stride = sw;
    const n = w * h;
    const sum = [new Float64Array(stride * (h + 1)), new Float64Array(stride * (h + 1)), new Float64Array(stride * (h + 1))];
    const sq = [new Float64Array(stride * (h + 1)), new Float64Array(stride * (h + 1)), new Float64Array(stride * (h + 1))];
    for (let y = 0; y < h; y++) {
      let rowS0 = 0, rowS1 = 0, rowS2 = 0, rowQ0 = 0, rowQ1 = 0, rowQ2 = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const v0 = lab[i], v1 = lab[i + 1], v2 = lab[i + 2];
        rowS0 += v0; rowS1 += v1; rowS2 += v2;
        rowQ0 += v0 * v0; rowQ1 += v1 * v1; rowQ2 += v2 * v2;
        const p = (y + 1) * stride + (x + 1);
        const q = y * stride + (x + 1);
        sum[0][p] = sum[0][q] + rowS0;
        sum[1][p] = sum[1][q] + rowS1;
        sum[2][p] = sum[2][q] + rowS2;
        sq[0][p] = sq[0][q] + rowQ0;
        sq[1][p] = sq[1][q] + rowQ1;
        sq[2][p] = sq[2][q] + rowQ2;
      }
    }
    const out = new Float32Array(n);
    const r = radius;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        const xa = x0, xb = x1 + 1, ya = y0, yb = y1 + 1;
        const p00 = ya * stride + xa, p10 = ya * stride + xb, p01 = yb * stride + xa, p11 = yb * stride + xb;
        const area = (xb - xa) * (yb - ya);
        let variance = 0;
        for (let ch = 0; ch < 3; ch++) {
          const s = sum[ch][p11] - sum[ch][p01] - sum[ch][p10] + sum[ch][p00];
          const q = sq[ch][p11] - sq[ch][p01] - sq[ch][p10] + sq[ch][p00];
          const mean = s / area;
          variance += Math.max(0, q / area - mean * mean);
        }
        out[y * w + x] = Math.sqrt(variance);
      }
    }
    return out;
  }

  function erode(mask, w, h, radius) {
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let ok = 1;
        for (let dy = -radius; dy <= radius && ok; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) { ok = 0; break; }
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) { ok = 0; break; }
            if (!mask[yy * w + xx]) { ok = 0; break; }
          }
        }
        out[y * w + x] = ok;
      }
    }
    return out;
  }

  function dilate(mask, w, h, radius) {
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let ok = 0;
        for (let dy = -radius; dy <= radius && !ok; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            if (mask[yy * w + xx]) { ok = 1; break; }
          }
        }
        out[y * w + x] = ok;
      }
    }
    return out;
  }

  function removeSmallComponents(mask, w, h, minArea, fillValue, gate, stats) {
    const out = new Uint8Array(mask);
    const seen = new Uint8Array(mask.length);
    const stack = new Int32Array(mask.length);
    const target = fillValue ? 0 : 1; // remove flat islands (=>0) or fill holes (=>1)
    for (let start = 0; start < mask.length; start++) {
      if (seen[start] || out[start] !== target) continue;
      let top = 0; stack[top++] = start; seen[start] = 1;
      const cells = [];
      while (top) {
        const idx = stack[--top]; cells.push(idx);
        const x = idx % w, y = (idx / w) | 0;
        if (x > 0) { const j = idx - 1; if (!seen[j] && out[j] === target) { seen[j] = 1; stack[top++] = j; } }
        if (x + 1 < w) { const j = idx + 1; if (!seen[j] && out[j] === target) { seen[j] = 1; stack[top++] = j; } }
        if (y > 0) { const j = idx - w; if (!seen[j] && out[j] === target) { seen[j] = 1; stack[top++] = j; } }
        if (y + 1 < h) { const j = idx + w; if (!seen[j] && out[j] === target) { seen[j] = 1; stack[top++] = j; } }
      }
      if (cells.length < minArea) {
        // Hole filling may only absorb pixels whose original colour is already
        // within tolerance of the flat colour they will receive. A small but
        // genuinely different patch must stay gradient, not be recoloured.
        let allowed = true;
        if (fillValue && gate) {
          for (const idx of cells) if (!gate[idx]) { allowed = false; break; }
        }
        if (allowed) {
          for (const idx of cells) out[idx] = fillValue ? 1 : 0;
          if (stats && fillValue) stats.filled += cells.length;
        } else if (stats && fillValue) {
          stats.rejected += cells.length;
        }
      }
    }
    return out;
  }

  function maskComponents(mask, w, h) {
    const n = w * h, seen = new Uint8Array(n), stack = new Int32Array(n), components = [];
    for (let start = 0; start < n; start++) {
      if (!mask[start] || seen[start]) continue;
      let top = 0, cells = [];
      seen[start] = 1; stack[top++] = start;
      while (top) {
        const i = stack[--top]; cells.push(i);
        const x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if ((!dx && !dy) || (dx && dy)) continue; // physical 4-connectivity, never corner-only contact
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (mask[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
          }
        }
      }
      components.push({ cells, area: cells.length });
    }
    for (const comp of components) {
      comp.boundary = comp.cells.filter(i => {
        const x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h || !mask[yy * w + xx]) return true;
        }
        return false;
      });
    }
    return components.sort((a, b) => b.area - a.area);
  }

  // Exact squared Euclidean distance transform (Felzenszwalb/Huttenlocher).
  // Used for rounded, bubble-like envelopes instead of hand-drawn straight bridges.
  function distanceField(source, w, h) {
    const n = w * h, INF = 1e20, dist = new Float64Array(n), out = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      let last = -INF;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (source[i]) last = x;
        dist[i] = last < -INF / 2 ? INF : (x - last) ** 2;
      }
      last = INF;
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (source[i]) last = x;
        if (last < INF / 2) dist[i] = Math.min(dist[i], (last - x) ** 2);
      }
    }
    const v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1), f = new Float64Array(Math.max(w, h));
    const transform = (len, get, put) => {
      for (let i = 0; i < len; i++) f[i] = get(i);
      let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < len; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
          k--;
          s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < len; q++) {
        while (z[k + 1] < q) k++;
        put(q, (q - v[k]) ** 2 + f[v[k]]);
      }
    };
    for (let x = 0; x < w; x++) {
      transform(h, y => dist[y * w + x], (y, value) => { out[y * w + x] = Math.sqrt(value); });
    }
    return out;
  }

  function maskAtDistance(dist, radius, w, h) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) if (dist[i] <= radius) mask[i] = 1;
    return mask;
  }

  function connectionRadius(dist, w, h) {
    if (maskComponents(maskAtDistance(dist, 0, w, h), w, h).length <= 1) return 0;
    const maxDim = Math.max(w, h);
    let lo = 0, hi = 1;
    while (hi < maxDim && maskComponents(maskAtDistance(dist, hi, w, h), w, h).length > 1) { lo = hi; hi *= 2; }
    while (hi - lo > 1) {
      const mid = Math.ceil((lo + hi) / 2);
      if (maskComponents(maskAtDistance(dist, mid, w, h), w, h).length <= 1) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  function findEnclosedHoles(mask, w, h) {
    const inverted = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) inverted[i] = mask[i] ? 0 : 1;
    const components = maskComponents(inverted, w, h);
    const holeMap = new Int32Array(mask.length).fill(-1), holes = [];
    for (const comp of components) {
      const touchesBorder = comp.cells.some(i => {
        const x = i % w, y = (i / w) | 0;
        return x === 0 || x === w - 1 || y === 0 || y === h - 1;
      });
      if (touchesBorder) continue;
      const id = comp.cells[0];
      let sx = 0, sy = 0;
      for (const i of comp.cells) { holeMap[i] = id; sx += i % w; sy += (i / w) | 0; }
      holes.push({ id, area: comp.area, cx: sx / comp.area, cy: sy / comp.area });
    }
    return { holeMap, holes };
  }

  function envelopePrintMask(source, w, h, envelopeMm, pixelSize, lineWidthMm, deletedHoles) {
    const px = pixelSize > 0 ? pixelSize : 0.1;
    const marginPx = clamp(envelopeMm / (2 * px), 0.5, 24);
    const dist = distanceField(source, w, h);
    const connectPx = connectionRadius(dist, w, h);
    let mask = maskAtDistance(dist, connectPx + marginPx, w, h);
    // A small majority relaxation turns the distance-field contour into a soft,
    // pressure-fit outline rather than a polygonal bridge. Restore every source
    // pixel afterwards so smoothing can never erase original artwork.
    mask = smoothBinaryMask(mask, w, h, clamp(Math.round(marginPx / 2), 1, 4), 2, null, 0);
    for (let i = 0; i < mask.length; i++) if (source[i]) mask[i] = 1;
    if (maskComponents(mask, w, h).length > 1) {
      const reconnect = distanceField(mask, w, h);
      mask = maskAtDistance(reconnect, connectionRadius(reconnect, w, h), w, h);
    }
    const { holeMap, holes } = findEnclosedHoles(mask, w, h);
    const deleted = deletedHoles instanceof Set ? deletedHoles : new Set(deletedHoles || []);
    for (let i = 0; i < mask.length; i++) {
      const id = holeMap[i];
      if (id >= 0 && !deleted.has(id)) mask[i] = 1;
    }
    return {
      mask,
      componentsBefore: maskComponents(source, w, h).length,
      componentsAfter: maskComponents(mask, w, h).length,
      bridges: 0, connectionRadiusMm: connectPx * px,
      holes, holeMap
    };
  }

  // Build a printable silhouette from a near-solid background. Colour alone is
  // not enough: white faces and highlights must survive. Only pixels connected
  // to the image border through the selected colour can become empty space.
  function buildPrintMask(lab, w, h, options, pixelSize) {
    const n = w * h;
    let printMask = new Uint8Array(n).fill(1);
    const requested = options.backgroundMode;
    const enabled = requested === 'auto' || requested === 'pick';
    if (!enabled) return { printMask, sourcePrintMask: printMask, background: { enabled: false, mode: 'off', printPixels: n, removedPixels: 0 } };
    let tolerance = clamp(Number(options.backgroundTolerance) || 8, 1, 40);
    let seed = null;
    if (requested === 'pick' && options.backgroundColor) seed = C.hexToLab(options.backgroundColor);
    if (!seed) {
      // Dominant Lab bin on the outer frame, robust to a character touching
      // one part of the border and to slightly off-white PNG backgrounds.
      const bins = new Map();
      const add = (i) => {
        const L = lab[i * 3], a = lab[i * 3 + 1], b = lab[i * 3 + 2];
        const key = `${Math.round(L / 4)},${Math.round(a / 4)},${Math.round(b / 4)}`;
        const bin = bins.get(key) || { count: 0, L: 0, a: 0, b: 0 };
        bin.count++; bin.L += L; bin.a += a; bin.b += b; bins.set(key, bin);
      };
      for (let x = 0; x < w; x++) { add(x); add((h - 1) * w + x); }
      for (let y = 1; y + 1 < h; y++) { add(y * w); add(y * w + w - 1); }
      let best = null;
      for (const bin of bins.values()) if (!best || bin.count > best.count) best = bin;
      seed = best && best.count ? { L: best.L / best.count, a: best.a / best.count, b: best.b / best.count } : { L: 100, a: 0, b: 0 };
    }
    // Dark JPEG/WebP backgrounds often contain coloured compression speckles
    // just above the old ΔE8 boundary. Give automatic mode a stronger floor on
    // dark artwork only; manual colour picking always honors the exact input.
    if (requested === 'auto' && seed.L < 45) tolerance = Math.max(tolerance, 12);
    const similar = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (C.deltaE2000(labAt(lab, i), seed) <= tolerance) similar[i] = 1;
    }
    const background = new Uint8Array(n);
    const stack = new Int32Array(n);
    let top = 0;
    const seedBorder = (i) => {
      if (similar[i] && !background[i]) { background[i] = 1; stack[top++] = i; }
    };
    for (let x = 0; x < w; x++) { seedBorder(x); seedBorder((h - 1) * w + x); }
    for (let y = 1; y + 1 < h; y++) { seedBorder(y * w); seedBorder(y * w + w - 1); }
    while (top) {
      const i = stack[--top], x = i % w, y = (i / w) | 0;
      if (x > 0) seedBorder(i - 1);
      if (x + 1 < w) seedBorder(i + 1);
      if (y > 0) seedBorder(i - w);
      if (y + 1 < h) seedBorder(i + w);
    }
    let removedPixels = 0;
    for (let i = 0; i < n; i++) {
      if (background[i]) { printMask[i] = 0; removedPixels++; }
    }
    const sourcePrintMask = new Uint8Array(printMask);
    let envelope = { componentsBefore: removedPixels < n ? 1 : 0, componentsAfter: removedPixels < n ? 1 : 0, bridges: 0 };
    const envelopeEnabled = options.backgroundEnvelope !== false;
    const envelopeMm = clamp(Number(options.backgroundEnvelopeMm) || 1.5, 0.2, 10);
    if (envelopeEnabled && removedPixels > 0 && removedPixels < n) {
      const px = pixelSize > 0 ? pixelSize : (Number(options.widthMm) || 150) / w;
      envelope = envelopePrintMask(printMask, w, h, envelopeMm, px, Number(options.lineWidthMm) || 0.42, new Set(options.backgroundDeletedHoles || []));
      printMask = envelope.mask;
      removedPixels = 0;
      for (let i = 0; i < n; i++) if (!printMask[i]) removedPixels++;
    }
    const info = {
      enabled: true, mode: requested, colorHex: C.labToHex(seed), tolerance,
      removedPixels, printPixels: n - removedPixels, failed: false,
      envelope: envelopeEnabled, envelopeMm,
      componentsBefore: envelope.componentsBefore, componentsAfter: envelope.componentsAfter, bridges: 0,
      connectionRadiusMm: envelope.connectionRadiusMm || 0,
      holes: envelope.holes || [], deletedHoles: (envelope.holes || []).filter(h => (options.backgroundDeletedHoles || []).includes(h.id)).length
    };
    if (removedPixels === n) {
      // Never turn a valid image into an empty print. The UI surfaces this as a
      // failed recognition instead of silently producing an empty 3MF.
      printMask.fill(1);
      info.printPixels = n; info.removedPixels = 0; info.failed = true;
      info.componentsBefore = 1; info.componentsAfter = 1;
    } else if (!envelopeEnabled) {
      const actualComponents = maskComponents(printMask, w, h).length;
      info.componentsBefore = actualComponents; info.componentsAfter = actualComponents;
    }
    return { printMask, sourcePrintMask, background: info, holeMap: envelope.holeMap || null };
  }

  function buildLutPalette(lut, extra) {
    return lut.palette.map((p, i) => {
      const hex = (extra && extra.hexOverrides && extra.hexOverrides[i]) || p.hex;
      const td = (extra && extra.tdOverrides && extra.tdOverrides[i]) || p.td || 5;
      const rgb = C.hexToRgb(hex);
      return {
        index: i, key: paletteKey(p), name: p.name, hex, brand: p.brand || 'BambuLab', material: p.material || 'PLA Basic',
        td, tdR: td, tdG: td, tdB: td, hd: td * 0.1, hdR: td * 0.1, hdG: td * 0.1, hdB: td * 0.1, rgb,
        lin: { r: C.srgbToLinear(rgb.r / 255), g: C.srgbToLinear(rgb.g / 255), b: C.srgbToLinear(rgb.b / 255) },
        lab: C.hexToLab(hex), fromLut: true
      };
    });
  }

  function buildUserPalette(list) {
    return list.map((p, i) => {
      const hex = p.hex || '#808080';
      const td = Number(p.td) || 5;
      const tdR = Number(p.tdR) || td, tdG = Number(p.tdG) || td, tdB = Number(p.tdB) || td;
      const rgb = C.hexToRgb(hex);
      return {
        index: i, id: p.id || '', key: paletteKey(p), name: p.name || ('耗材 ' + (i + 1)), hex, brand: p.brand || '', material: p.material || 'PLA',
        td, tdR, tdG, tdB, hd: td * 0.1, hdR: tdR * 0.1, hdG: tdG * 0.1, hdB: tdB * 0.1, rgb,
        lin: { r: C.srgbToLinear(rgb.r / 255), g: C.srgbToLinear(rgb.g / 255), b: C.srgbToLinear(rgb.b / 255) },
        lab: C.hexToLab(hex), fromLut: false
      };
    });
  }

  function nearestPalette(lab, palette) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i].lab;
      const dl = lab.L - p.L, da = lab.a - p.a, db = lab.b - p.b;
      const d = dl * dl + da * da + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function autoStdThreshold(stds) {
    const values = [];
    const n = stds.length;
    const step = Math.max(1, Math.floor(n / 30000));
    for (let i = 0; i < n; i += step) values.push(stds[i]);
    values.sort((a, b) => a - b);
    if (!values.length) return 3;
    return clamp(values[Math.floor(values.length * 0.55)], 1.2, 8);
  }

  function labDistSq(lab, i, j) {
    const dl = lab[i * 3] - lab[j * 3];
    const da = lab[i * 3 + 1] - lab[j * 3 + 1];
    const db = lab[i * 3 + 2] - lab[j * 3 + 2];
    return dl * dl + da * da + db * db;
  }

  // Line-art detector and thin-stroke map.
  //
  // A 1-2 px outline has no area for a meaningful layer stack, and a colour
  // blind majority filter will happily erase it in favour of the surrounding
  // fill. Stickers and meme line art need the opposite treatment: keep thin
  // dark strokes continuous, optionally print them as one direct colour.
  // Photos, mosaics and impressionist work normally fail the pure-paper gate,
  // so the automatic mode leaves them alone.
  function buildStrokeInfo(lab, alpha, w, h, opts) {
    const lineWidthMm = opts && Number(opts.lineWidthMm) > 0 ? Number(opts.lineWidthMm) : 0.42;
    const pixelSizeMm = opts && Number(opts.pixelSize) > 0 ? Number(opts.pixelSize) : (150 / w);
    const lineWidthPx = Math.max(0.5, lineWidthMm / pixelSizeMm);
    const strokeR = clamp(Math.round(1.7 * lineWidthPx), 1, 12);
    const fringeR = clamp(Math.round(1.7 * lineWidthPx), 1, 12);
    const repairR = clamp(Math.round(2.2 * lineWidthPx), 1, 12);
    const growPx = clamp(Math.round(0.8 * lineWidthPx), 1, 4);
    const n = w * h;
    const dark = new Uint8Array(n);
    const chromatic = new Uint8Array(n);
    const darkCore = new Uint8Array(n);
    const ink = new Uint8Array(n);
    const stroke = new Uint8Array(n);
    let darkCount = 0, veryDark = 0, pureWhite = 0, edgeCount = 0;
    for (let i = 0; i < n; i++) {
      const L = lab[i * 3], a = lab[i * 3 + 1], b = lab[i * 3 + 2];
      const isDark = L < 80;
      dark[i] = isDark ? 1 : 0;
      darkCore[i] = L < 24 ? 1 : 0;
      // Strong line-art mode also supports saturated yellow/blue/red strokes.
      // Distance-to-non-ink below still rejects the centre of large fills.
      chromatic[i] = (!isDark && Math.hypot(a, b) >= 18 && L < 96) ? 1 : 0;
      ink[i] = (isDark || chromatic[i]) ? 1 : 0;
      if (isDark) darkCount++;
      if (L < 48) veryDark++;
      if (L > 96 && Math.hypot(a, b) < 5) pureWhite++;
      if (i % w !== w - 1 && labDistSq(lab, i, i + 1) > 196) edgeCount++;
      if (i < n - w && labDistSq(lab, i, i + w) > 196) edgeCount++;
    }
    // Distance from every pixel to the nearest non-dark pixel. A dark run
    // whose centre is within 3 px of a light/filled area is a stroke, not a
    // broad shadow, so it is safe to protect or direct-print.
    const dist = new Int16Array(n).fill(-1);
    const queue = new Int32Array(n);
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) {
      if (!dark[i] || alpha[i] < 8) { dist[i] = 0; queue[tail++] = i; }
    }
    while (head < tail) {
      const i = queue[head++];
      const d = dist[i] + 1;
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && dist[i - 1] < 0) { dist[i - 1] = d; queue[tail++] = i - 1; }
      if (x + 1 < w && dist[i + 1] < 0) { dist[i + 1] = d; queue[tail++] = i + 1; }
      if (y > 0 && dist[i - w] < 0) { dist[i - w] = d; queue[tail++] = i - w; }
      if (y + 1 < h && dist[i + w] < 0) { dist[i + w] = d; queue[tail++] = i + w; }
    }
    // Chromatic strokes get their own distance map. Combining them with dark
    // ink would make a black line next to a coloured fill lose its protection.
    const chromaDist = new Int16Array(n).fill(-1), chromaQueue = new Int32Array(n);
    head = 0; tail = 0;
    for (let i = 0; i < n; i++) {
      if (!chromatic[i] || alpha[i] < 8) { chromaDist[i] = 0; chromaQueue[tail++] = i; }
    }
    while (head < tail) {
      const i = chromaQueue[head++], d = chromaDist[i] + 1;
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && chromaDist[i - 1] < 0) { chromaDist[i - 1] = d; chromaQueue[tail++] = i - 1; }
      if (x + 1 < w && chromaDist[i + 1] < 0) { chromaDist[i + 1] = d; chromaQueue[tail++] = i + 1; }
      if (y > 0 && chromaDist[i - w] < 0) { chromaDist[i - w] = d; chromaQueue[tail++] = i - w; }
      if (y + 1 < h && chromaDist[i + w] < 0) { chromaDist[i + w] = d; chromaQueue[tail++] = i + w; }
    }
    let thinDark = 0;
    for (let i = 0; i < n; i++) {
      if ((dark[i] && dist[i] > 0 && dist[i] <= strokeR) || (chromatic[i] && chromaDist[i] > 0 && chromaDist[i] <= strokeR)) {
        stroke[i] = 1; thinDark++;
      }
    }
    const edgeFraction = edgeCount / n;
    const whiteFraction = pureWhite / n;
    const darkFraction = darkCount / n;
    const veryDarkFraction = veryDark / n;
    const strokeFraction = thinDark / n;
    const score = clamp(
      0.35 * Math.min(1, edgeFraction / 0.10) +
      0.25 * Math.min(1, strokeFraction / 0.02) +
      0.20 * Math.min(1, whiteFraction / 0.25) +
      0.20 * Math.min(1, veryDarkFraction / 0.04), 0, 1);
    const active = whiteFraction > 0.08 && edgeFraction > 0.015 && strokeFraction > 0.004 && score >= 0.45;
    return {
      stroke, dark, darkCore, ink, dist, score, active,
      edgeFraction, whiteFraction, darkFraction, veryDarkFraction, strokeFraction,
      radii: { strokeR, fringeR, repairR, growPx, lineWidthPx }
    };
  }

  function repairLineGaps(lab, lineInfo, flatMask, nearest, familyId, lineDirect, lineProtectMask, w, h, printMask, families, palette, manualLock, stds, stdT) {
    if (!lineProtectMask) return;
    const addFlat = new Uint8Array(flatMask), addNearest = new Uint16Array(nearest), addFamily = new Int16Array(familyId);
    const addDirect = lineDirect ? new Uint8Array(lineDirect) : null, addProtect = new Uint8Array(lineProtectMask);
    const directions = [[1, 0], [0, 1], [1, 1], [1, -1], [-1, 1], [-1, -1], [-1, 0], [0, -1]];
    const repairR = lineInfo.radii ? lineInfo.radii.repairR : 4;
    const find = (x, y, dx, dy) => {
      for (let step = 1; step <= repairR; step++) {
        const xx = x + dx * step, yy = y + dy * step;
        if (xx < 0 || xx >= w || yy < 0 || yy >= h) return -1;
        const j = yy * w + xx;
        if (lineProtectMask[j]) return j;
      }
      return -1;
    };
    // Direction continuity: a real break has stroke ink continuing behind the
    // endpoint along the bridge axis. Two parallel hatch lines fail this —
    // behind each line lies fill, not more of the same stroke — so "black on
    // both sides" alone can never bridge the gap between them. The support
    // pixel must also match the endpoint colour, or a dark fill would count
    // as ink evidence.
    const continues = (j, dx, dy, ref) => {
      const jx = j % w, jy = (j / w) | 0;
      for (let t = 1; t <= 3; t++) {
        const xx = jx + dx * t, yy = jy + dy * t;
        if (xx < 0 || xx >= w || yy < 0 || yy >= h) return false;
        const k = yy * w + xx;
        if ((lineInfo.ink[k] || lineProtectMask[k]) && C.deltaE2000(labAt(lab, k), ref) <= 12) return true;
      }
      return false;
    };
    // Colour a protected endpoint would print. Direct strokes keep their
    // assigned filament even before the flat mask is finalised.
    const colorOf = (j) => {
      if ((lineDirect && lineDirect[j]) || (lineProtectMask[j] && flatMask[j])) return palette[nearest[j]].lab;
      if (familyId[j] >= 0) return families[familyId[j]].predictedLab;
      return palette[nearest[j]].lab;
    };
    // A gap pixel may only join the stroke when it belongs to the same colour
    // family: neutral strokes absorb neutral mid-tones, colour strokes absorb
    // hue-compatible pixels. Real skin/fill crossing a black line stays skin.
    const gapCompatible = (own, stroke) => {
      if (own.L > stroke.L + 60) return false;
      const sc = Math.hypot(stroke.a, stroke.b), oc = Math.hypot(own.a, own.b);
      if (sc < 8) return oc < 8;
      if (oc < 8) return false;
      const dot = (own.a * stroke.a + own.b * stroke.b) / (sc * oc);
      return dot >= 0.90 && oc <= sc * 1.6 + 4;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if ((manualLock && manualLock[i]) || lineProtectMask[i] || (!lineInfo.ink[i] && lab[i * 3] >= 90) || (printMask && !printMask[i])) continue;
        // A locally stable pixel is fill or a smooth gradient, not a structural
        // gap — even when the flat mask excluded it (area/residual gates). The
        // same stds/stdT the flat gate uses decides stability; no new knob.
        if (stds && stds[i] <= stdT) continue;
        for (const [dx, dy] of directions) {
          const a = find(x, y, dx, dy), b = find(x, y, -dx, -dy);
          if (a < 0 || b < 0) continue;
          const ca = colorOf(a), cb = colorOf(b);
          // Two different strokes must not be joined through unrelated pixels.
          if (C.deltaE2000(ca, cb) > 12) continue;
          // Same-stroke evidence: ink must continue behind both endpoints
          // along this axis, not merely exist on both sides of the pixel.
          if (!continues(a, dx, dy, ca) || !continues(b, -dx, -dy, cb)) continue;
          const own = labAt(lab, i);
          if (!gapCompatible(own, ca)) continue;
          // Never overwrite a confident fill pixel with the stroke material.
          if (flatMask[i] && nearest[i] !== nearest[a] && nearest[i] !== nearest[b] && C.deltaE2000(own, ca) > 15) continue;
          const stepA = Math.max(Math.abs(a % w - x), Math.abs(((a / w) | 0) - y));
          const stepB = Math.max(Math.abs(b % w - x), Math.abs(((b / w) | 0) - y));
          let source = stepA <= stepB ? a : b;
          const la = ca.L, lb = cb.L;
          if (la < lb) source = a; else if (lb < la) source = b;
          addFlat[i] = flatMask[source]; addNearest[i] = nearest[source]; addFamily[i] = familyId[source]; addProtect[i] = 1;
          if (addDirect && (lineDirect[a] || lineDirect[b])) addDirect[i] = 1;
          break;
        }
      }
    }
    flatMask.set(addFlat); nearest.set(addNearest); familyId.set(addFamily); lineProtectMask.set(addProtect);
    if (lineDirect && addDirect) lineDirect.set(addDirect);
  }

  function chooseStrokeFilament(targetLab, palette) {
    let best = -1, bestScore = Infinity;
    const targetC = Math.hypot(targetLab.a, targetLab.b);
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i].lab;
      const pC = Math.hypot(p.a, p.b);
      // A neutral black outline must stay neutral; a coloured accent may use
      // a matching hue, but never a far more saturated filament (blue was
      // creeping onto dark purple hair as a bright fringe before this gate).
      if (targetC < 12 && pC > 8) continue;
      if (pC > targetC * 1.25 + 4) continue;
      if (targetC >= 12 && pC >= 12) {
        const dot = (targetLab.a * p.a + targetLab.b * p.b) / (targetC * pC);
        if (dot < 0.95) continue;
      }
      const de = C.deltaE2000(targetLab, p);
      const lift = Math.max(0, p.L - targetLab.L - 10);
      let score = de + lift * 0.9;
      if (p.L > 88 && targetLab.L < 62) score += 12;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best < 0 || bestScore > 16) return -1;
    return best;
  }

  function buildFlatMask(lab, w, h, palette, opts) {
    const n = w * h;
    const stds = localStd(lab, w, h, opts.localRadius || 2);
    const nearest = new Uint8Array(n);
    const residual = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const l = labAt(lab, i);
      const pi = nearestPalette(l, palette);
      nearest[i] = pi;
      residual[i] = C.deltaE2000(l, palette[pi].lab);
    }
    const stdT = opts.stdThreshold > 0 ? opts.stdThreshold : autoStdThreshold(stds);
    const resT = opts.residualThreshold > 0 ? opts.residualThreshold : 5;
    let mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = (stds[i] <= stdT && residual[i] <= resT) ? 1 : 0;
    const r = Math.max(1, Math.round(Math.min(w, h) / 500));
    mask = dilate(mask, w, h, r);
    mask = erode(mask, w, h, r);
    const minArea = Math.max(12, Math.round((opts.minFlatPercent || 0.6) / 100 * n));
    mask = removeSmallComponents(mask, w, h, minArea, 0);
    // Filling a hole turns it flat. That is only a segmentation-noise repair,
    // so every absorbed pixel must already be explainable by its nearest
    // filament; otherwise a real detail patch (grey shadow, skin, eye white)
    // would be silently repainted before colour matching ever sees it.
    const colorOK = new Uint8Array(n);
    for (let i = 0; i < n; i++) colorOK[i] = residual[i] <= resT ? 1 : 0;
    const fillStats = { filled: 0, rejected: 0 };
    mask = removeSmallComponents(mask, w, h, Math.max(12, Math.round(minArea * 0.6)), 1, colorOK, fillStats);
    return { mask, stds, residual, nearest, stdT, resT, fillStats };
  }

  function sampleGradientLab(lab, mask, maxSamples, exclude) {
    const n = mask.length;
    let useExclude = !!exclude;
    let count = 0;
    for (let i = 0; i < n; i++) if (!mask[i] && !(useExclude && exclude[i])) count++;
    if (count < 24) {
      // Do not let a very aggressive edge band starve the cluster sampler.
      useExclude = false;
      count = 0;
      for (let i = 0; i < n; i++) if (!mask[i]) count++;
    }
    const step = Math.max(1, Math.floor(count / maxSamples));
    const pts = new Float32Array(Math.min(count, maxSamples) * 3);
    let out = 0, seen = 0;
    for (let i = 0; i < n; i++) {
      if (mask[i]) continue;
      if (useExclude && exclude[i]) continue;
      if (seen++ % step) continue;
      if (out >= pts.length / 3) break;
      pts[out * 3] = lab[i * 3]; pts[out * 3 + 1] = lab[i * 3 + 1]; pts[out * 3 + 2] = lab[i * 3 + 2];
      out++;
    }
    return pts.subarray(0, out * 3);
  }

  // Anti-aliased transition pixels are mixtures of two real regions. They
  // should not become independent HueForge families: with a limited palette
  // they turn into yellow/red/blue fringes around every dark outline.
  // Build a band around strong Lab edges, exclude it from k-means training,
  // then snap its pixels back to families present in the nearby core.
  function buildEdgeMask(lab, w, h, level) {
    if (!(level > 0)) return null;
    const n = w * h;
    const edge = new Uint8Array(n);
    const threshold = 100; // 10 ΔE between adjacent pixels
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x + 1 < w && labDistSq(lab, i, i + 1) > threshold) edge[i] = 1;
        if (y + 1 < h && labDistSq(lab, i, i + w) > threshold) edge[i] = 1;
      }
    }
    return dilate(edge, w, h, level);
  }

  function snapEdgeFamilies(lab, flatMask, familyId, edgeMask, protect, families, w, h, radius, neutralGuard) {
    if (!edgeMask) return familyId;
    const neutralNeed = neutralGuard ? neutralGuard.need : null;
    const famNeutral = neutralGuard ? neutralGuard.famNeutral : null;
    const out = new Int16Array(familyId);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!edgeMask[i] || flatMask[i] || (protect && protect[i])) continue;
        const constrained = !!(neutralNeed && neutralNeed[i]);
        const l = labAt(lab, i);
        const curF = familyId[i];
        const curP = curF >= 0 ? families[curF].predictedLab : null;
        const curD = curP ? (l.L - curP.L) ** 2 + (l.a - curP.a) ** 2 + (l.b - curP.b) ** 2 : Infinity;
        let best = -1;
        // Search ring by ring: a boundary pixel should take the nearest core
        // family, not jump to a distant colour that happens to be closer in Lab.
        for (let r = 1; r <= radius && best < 0; r++) {
          const famCounts = new Map();
          for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
            for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
              if (Math.max(Math.abs(xx - x), Math.abs(yy - y)) !== r) continue;
              const j = yy * w + xx;
              if (j === i || flatMask[j]) continue;
              if (edgeMask[j] && !(protect && protect[j])) continue;
              const f = familyId[j];
              if (f >= 0) {
                if (constrained && famNeutral && !famNeutral[f]) continue;
                famCounts.set(f, (famCounts.get(f) || 0) + 1);
              }
            }
          }
          let localBest = -1, localD = Infinity, localCount = 0;
          for (const [f, c] of famCounts) {
            const p = families[f].predictedLab;
            const d = (l.L - p.L) ** 2 + (l.a - p.a) ** 2 + (l.b - p.b) ** 2;
            if (d < localD - 25 || (Math.abs(d - localD) <= 25 && c > localCount)) {
              localD = d; localCount = c; localBest = f;
            }
          }
          if (localBest >= 0) best = localBest;
        }
        // Do not trade a plausible edge blend for a much worse colour just
        // to get a shorter/cleaner recipe. This guard is what keeps "strong"
        // edge cleanup from making the simulated painting visibly dirtier.
        if (best >= 0) {
          const p = families[best].predictedLab;
          const d = (l.L - p.L) ** 2 + (l.a - p.a) ** 2 + (l.b - p.b) ** 2;
          if (d <= curD + 16) out[i] = best;
        }
      }
    }
    return out;
  }

  function kmeansLab(points, k, seed, iterations) {
    const count = points.length / 3;
    if (!count) return [];
    k = Math.min(k, count);
    const rand = mulberry32(seed || 1234567);
    const centers = new Float32Array(k * 3);
    const first = Math.floor(rand() * count);
    centers[0] = points[first * 3]; centers[1] = points[first * 3 + 1]; centers[2] = points[first * 3 + 2];
    const d2 = new Float64Array(count).fill(Infinity);
    for (let c = 1; c < k; c++) {
      let total = 0;
      const cl = centers[(c - 1) * 3], ca = centers[(c - 1) * 3 + 1], cb = centers[(c - 1) * 3 + 2];
      for (let i = 0; i < count; i++) {
        const dl = points[i * 3] - cl, da = points[i * 3 + 1] - ca, db = points[i * 3 + 2] - cb;
        const d = dl * dl + da * da + db * db;
        if (d < d2[i]) d2[i] = d;
        total += d2[i];
      }
      let target = rand() * total;
      let idx = 0;
      for (; idx < count - 1; idx++) { target -= d2[idx]; if (target <= 0) break; }
      centers[c * 3] = points[idx * 3]; centers[c * 3 + 1] = points[idx * 3 + 1]; centers[c * 3 + 2] = points[idx * 3 + 2];
    }
    const sums = new Float64Array(k * 3);
    const counts = new Uint32Array(k);
    for (let it = 0; it < (iterations || 10); it++) {
      sums.fill(0); counts.fill(0);
      for (let i = 0; i < count; i++) {
        let best = 0, bestD = Infinity;
        for (let c = 0; c < k; c++) {
          const dl = points[i * 3] - centers[c * 3];
          const da = points[i * 3 + 1] - centers[c * 3 + 1];
          const db = points[i * 3 + 2] - centers[c * 3 + 2];
          const d = dl * dl + da * da + db * db;
          if (d < bestD) { bestD = d; best = c; }
        }
        sums[best * 3] += points[i * 3]; sums[best * 3 + 1] += points[i * 3 + 1]; sums[best * 3 + 2] += points[i * 3 + 2];
        counts[best]++;
      }
      for (let c = 0; c < k; c++) {
        if (counts[c]) {
          centers[c * 3] = sums[c * 3] / counts[c];
          centers[c * 3 + 1] = sums[c * 3 + 1] / counts[c];
          centers[c * 3 + 2] = sums[c * 3 + 2] / counts[c];
        } else {
          const idx = Math.floor(rand() * count);
          centers[c * 3] = points[idx * 3]; centers[c * 3 + 1] = points[idx * 3 + 1]; centers[c * 3 + 2] = points[idx * 3 + 2];
        }
      }
    }
    const out = [];
    for (let c = 0; c < k; c++) out.push({ L: centers[c * 3], a: centers[c * 3 + 1], b: centers[c * 3 + 2] });
    return out;
  }

  function nearestLut(lab, lut) {
    const entries = lut.entries;
    const candidates = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const dl = lab.L - e[0], da = lab.a - e[1], db = lab.b - e[2];
      const d = dl * dl + da * da + db * db;
      if (candidates.length < 12) {
        candidates.push({ i, d });
        if (candidates.length === 12) candidates.sort((x, y) => x.d - y.d);
      } else if (d < candidates[11].d) {
        candidates[11] = { i, d };
        candidates.sort((x, y) => x.d - y.d);
      }
    }
    let best = candidates[0], bestDE = Infinity;
    for (const cand of candidates) {
      const e = entries[cand.i];
      const de = C.deltaE2000(lab, { L: e[0], a: e[1], b: e[2] });
      if (de < bestDE) { bestDE = de; best = cand; }
    }
    const e = entries[best.i];
    return { index: best.i, lab: { L: e[0], a: e[1], b: e[2] }, recipe: e.slice(3), deltaE: bestDE };
  }

  function stackTransmission(thickness, hd) {
    return CS.optics.transmission(thickness, hd);
  }

  function compositeLinear(bg, seq, palette, layerHeight) {
    // Single source of the attenuation math lives in optics.js (P1/S01).
    return CS.optics.compositeLinear(bg, seq, palette, layerHeight);
  }

  function runsInSeq(seq) {
    let runs = 0, last = -1;
    for (const s of seq) { if (s !== last) runs++; last = s; }
    return runs;
  }

  function initialSequences(targetLab, palette, foundation, layers) {
    const nearest = palette.map((p) => ({ i: p.index, de: C.deltaE2000(targetLab, p.lab) })).sort((a, b) => a.de - b.de);
    const seqs = [];
    if (nearest.length) seqs.push(new Array(layers).fill(nearest[0].i));
    if (foundation && foundation.index != null) seqs.push(new Array(layers).fill(foundation.index));
    seqs.push(new Array(layers).fill(0));
    if (palette.length > 1) seqs.push(new Array(layers).fill(palette.length - 1));
    const ramp = [];
    for (let i = 0; i < layers; i++) ramp.push(nearest[Math.min(nearest.length - 1, i % Math.max(1, nearest.length))].i);
    seqs.push(ramp);
    const rand = mulberry32(0xC0FFEE + Math.round(targetLab.L * 31));
    for (let s = 0; s < 3; s++) {
      const r = [];
      for (let i = 0; i < layers; i++) r.push(Math.floor(rand() * palette.length));
      seqs.push(r);
    }
    return seqs;
  }

  function optimizeTdStack(targetLab, palette, foundation, layerHeight, layers) {
    const bg = foundation ? foundation.lin : { r: 1, g: 1, b: 1 };
    const runPenalty = 0.35;
    const neutralF = palette.map(p => Math.hypot(p.lab.a, p.lab.b) < 8);
    const chromaFrac = seq => seq.reduce((n, i) => n + (neutralF[i] ? 0 : 1), 0) / Math.max(1, seq.length);
    let bestSeq = null, bestLab = null, bestCost = Infinity;
    const consider = (seq) => {
      const lin = compositeLinear(bg, seq, palette, layerHeight);
      const lab = C.rgb01ToLab({ r: C.linearToSrgb(lin.r), g: C.linearToSrgb(lin.g), b: C.linearToSrgb(lin.b) });
      const cost = C.deltaE2000(lab, targetLab) + runPenalty * Math.max(0, runsInSeq(seq) - 1) + neutralBias(targetLab, chromaFrac(seq));
      if (cost < bestCost) { bestCost = cost; bestSeq = seq.slice(); bestLab = lab; }
      return { lin, lab, cost };
    };
    for (const start of initialSequences(targetLab, palette, foundation, layers)) {
      let seq = start.slice();
      let cur = consider(seq);
      for (let pass = 0; pass < 4; pass++) {
        let improved = false;
        for (let pos = 0; pos < layers; pos++) {
          let localBest = null;
          for (let ci = 0; ci < palette.length; ci++) {
            if (seq[pos] === ci) continue;
            const trial = seq.slice(); trial[pos] = ci;
            const ev = consider(trial);
            if (!localBest || ev.cost < localBest.cost) localBest = { seq: trial, ...ev };
          }
          if (localBest && localBest.cost < cur.cost - 1e-6) { seq = localBest.seq; cur = localBest; improved = true; }
        }
        if (!improved) break;
      }
    }
    let beam = [{ seq: [], lin: bg, last: -1, cost: 0 }];
    const beamWidth = Math.min(220, 40 * palette.length);
    for (let step = 0; step < layers; step++) {
      const next = [];
      for (const st of beam) {
        for (let ci = 0; ci < palette.length; ci++) {
          const fg = palette[ci].lin;
          const Tr = stackTransmission(layerHeight, palette[ci].hdR != null ? palette[ci].hdR : palette[ci].hd);
          const Tg = stackTransmission(layerHeight, palette[ci].hdG != null ? palette[ci].hdG : palette[ci].hd);
          const Tb = stackTransmission(layerHeight, palette[ci].hdB != null ? palette[ci].hdB : palette[ci].hd);
          const lin = { r: fg.r * (1 - Tr) + st.lin.r * Tr, g: fg.g * (1 - Tg) + st.lin.g * Tg, b: fg.b * (1 - Tb) + st.lin.b * Tb };
          const lab = C.rgb01ToLab({ r: C.linearToSrgb(lin.r), g: C.linearToSrgb(lin.g), b: C.linearToSrgb(lin.b) });
          const seq2 = st.seq.concat([ci]);
          const cost = C.deltaE2000(lab, targetLab) + neutralBias(targetLab, chromaFrac(seq2));
          next.push({ seq: seq2, lin, last: ci, cost });
        }
      }
      next.sort((a, b) => a.cost - b.cost);
      const dedup = new Map();
      for (const st of next) {
        const qr = Math.round(st.lin.r * 40), qg = Math.round(st.lin.g * 40), qb = Math.round(st.lin.b * 40);
        const key = st.last + '|' + qr + ',' + qg + ',' + qb;
        if (!dedup.has(key)) dedup.set(key, st);
        if (dedup.size >= beamWidth) break;
      }
      beam = Array.from(dedup.values());
    }
    for (const st of beam) {
      const lab = C.rgb01ToLab({ r: C.linearToSrgb(st.lin.r), g: C.linearToSrgb(st.lin.g), b: C.linearToSrgb(st.lin.b) });
      const cost = C.deltaE2000(lab, targetLab) + runPenalty * Math.max(0, runsInSeq(st.seq) - 1) + neutralBias(targetLab, chromaFrac(st.seq));
      if (cost < bestCost) { bestCost = cost; bestSeq = st.seq.slice(); bestLab = lab; }
    }
    const lin = compositeLinear(bg, bestSeq, palette, layerHeight);
    return {
      seq: bestSeq, lin, lab: bestLab,
      deltaE: C.deltaE2000(bestLab, targetLab),
      hex: C.linearToHex(lin)
    };
  }

  function compositeLab(bg, seq, palette, layerHeight) {
    const lin = compositeLinear(bg, seq, palette, layerHeight);
    return {
      lin,
      lab: C.rgb01ToLab({ r: C.linearToSrgb(lin.r), g: C.linearToSrgb(lin.g), b: C.linearToSrgb(lin.b) })
    };
  }

  function compositeLabScaled(bg, seq, palette, layerHeight, scaleOf) {
    let cur = { r: bg.r, g: bg.g, b: bg.b };
    for (const i of seq) {
      const p = palette[i], fg = p.lin, s = scaleOf(i);
      const Tr = stackTransmission(layerHeight, (p.hdR != null ? p.hdR : p.hd) * s);
      const Tg = stackTransmission(layerHeight, (p.hdG != null ? p.hdG : p.hd) * s);
      const Tb = stackTransmission(layerHeight, (p.hdB != null ? p.hdB : p.hd) * s);
      cur = { r: fg.r * (1 - Tr) + cur.r * Tr, g: fg.g * (1 - Tg) + cur.g * Tg, b: fg.b * (1 - Tb) + cur.b * Tb };
    }
    return C.rgb01ToLab({ r: C.linearToSrgb(cur.r), g: C.linearToSrgb(cur.g), b: C.linearToSrgb(cur.b) });
  }

  /* Model sensitivity, not a measured confidence interval: perturb one
     filament's HD by ±frac and report the largest resulting ΔE00. Used as a
     diagnostic and as a tie-break only when callers opt in. */
  function recipeSensitivity(seq, palette, bg, layerHeight, frac) {
    const f = frac == null ? 0.1 : frac;
    const nominal = compositeLab(bg, seq, palette, layerHeight).lab;
    let worst = 0;
    const distinct = new Set(seq);
    for (const fi of distinct) {
      for (const s of [1 - f, 1 + f]) {
        const lab = compositeLabScaled(bg, seq, palette, layerHeight, i => i === fi ? s : 1);
        const de = C.deltaE2000(nominal, lab);
        if (de > worst) worst = de;
      }
    }
    return worst;
  }

  function paletteKey(p) {
    if (!p) return '';
    if (p.id) return 'id:' + p.id;
    return ['model', p.brand || '', p.name || '', p.material || '', String(p.hex || '').toLowerCase()].join('|');
  }

  // Enumerate the reachable color gamut for the selected filaments. With a
  // small palette this is exact (e.g. 4 colors × 6 layers = 5,460 stacks), so
  // matching is not greedy and unreachable colors become measurable gaps.
  function buildTdGamut(palette, foundation, layerHeight, maxLayers, variableHeight, opts) {
    opts = opts || {};
    const bg = foundation ? foundation.lin : { r: 1, g: 1, b: 1 };
    const K = palette.length;
    const budget = 120000;
    const entries = [];
    const seen = new Map();
    // Enumerate in a stable key order, not AMS order, so truncation and
    // candidate sets do not depend on how the palette happens to be sorted.
    const canonical = Array.from({ length: K }, (_, i) => i)
      .sort((a, b) => paletteKey(palette[a]).localeCompare(paletteKey(palette[b])));
    const neutralF = palette.map(p => Math.hypot(p.lab.a, p.lab.b) < 8);
    const chromaFracOf = seq => seq.reduce((n, i) => n + (neutralF[i] ? 0 : 1), 0) / Math.max(1, seq.length);
    const distinctOf = seq => new Set(seq).size;
    const pushSeq = (canonSeq, runs) => {
      const seq = canonSeq.map(c => canonical[c]);
      const { lin, lab } = compositeLab(bg, seq, palette, layerHeight);
      const key = Math.round(lab.L * 2) + '|' + Math.round(lab.a * 2) + '|' + Math.round(lab.b * 2)
        + (variableHeight ? '|' + seq.length : '');
      const distinct = distinctOf(seq);
      const bucket = seen.get(key);
      if (bucket) {
        // Keep up to three structurally different recipes per near-identical
        // colour bucket. In diverse mode (P3/S04) equal runs/distinct does NOT
        // mean equal stack: A-A-B and A-B-A differ per Z, so only exact duplicates
        // are dropped and layer-order diversity survives.
        const dup = opts.diverse
          ? bucket.some(idx => entries[idx].seq.join(',') === seq.join(','))
          : bucket.some(idx => entries[idx].runs === runs && entries[idx].distinct === distinct);
        if (dup) return;
        if (bucket.length >= 3) return;
        bucket.push(entries.length);
      } else {
        seen.set(key, [entries.length]);
      }
      entries.push({ seq: seq.slice(), lab, lin, length: seq.length, runs, hex: C.linearToHex(lin), chromaFrac: chromaFracOf(seq), distinct });
    };
    const permutations = (r) => {
      const out = [];
      const used = new Uint8Array(K);
      const arr = [];
      const rec = () => {
        if (arr.length === r) { out.push(arr.slice()); return; }
        for (let c = 0; c < K; c++) {
          if (used[c]) continue;
          used[c] = 1; arr.push(c); rec(); arr.pop(); used[c] = 0;
        }
      };
      rec();
      return out;
    };
    const compositions = (total, parts, cb) => {
      const arr = new Array(parts);
      const rec = (idx, remaining) => {
        if (idx === parts - 1) {
          if (remaining <= 0) return;
          arr[idx] = remaining;
          cb(arr);
          return;
        }
        const minRest = parts - idx - 1;
        for (let len = 1; len <= remaining - minRest; len++) {
          arr[idx] = len;
          rec(idx + 1, remaining - len);
        }
      };
      rec(0, total);
    };
    const buildRunSeq = (colors, lengths) => {
      const seq = [];
      for (let i = 0; i < colors.length; i++) {
        for (let l = 0; l < lengths[i]; l++) seq.push(colors[i]);
      }
      return seq;
    };
    const maxRuns = Math.min(K, 5);
    for (let r = 1; r <= maxRuns; r++) {
      if (entries.length >= budget) break;
      const quota = r <= 2 ? budget : r === 3 ? 52000 : r === 4 ? 38000 : 26000;
      let made = 0;
      const perms = permutations(r);
      const totals = variableHeight
        ? Array.from({ length: maxLayers - r + 1 }, (_, i) => r + i)
        : [maxLayers];
      for (const perm of perms) {
        if (made >= quota || entries.length >= budget) break;
        for (const total of totals) {
          if (made >= quota || entries.length >= budget) break;
          compositions(total, r, (lengths) => {
            if (made >= quota || entries.length >= budget) return;
            pushSeq(buildRunSeq(perm, lengths), r);
            made++;
          });
        }
      }
    }
    // For large heights the composition space can explode. Fill the remainder
    // with deterministic run-sampled stacks (still contiguous, never A-B-A-B).
    if (maxLayers > 10 && entries.length < budget) {
      const rand = mulberry32(0xB10C5);
      let guard = 0;
      while (entries.length < budget && guard++ < budget * 3) {
        const r = 1 + Math.floor(rand() * maxRuns);
        const colors = [];
        const used = new Uint8Array(K);
        while (colors.length < r) {
          const c = Math.floor(rand() * K);
          if (!used[c]) { used[c] = 1; colors.push(c); }
        }
        const total = variableHeight
          ? r + Math.floor(rand() * (maxLayers - r + 1))
          : maxLayers;
        // random positive composition
        const lengths = new Array(r).fill(1);
        let extra = total - r;
        while (extra > 0) {
          const i = Math.floor(rand() * r);
          lengths[i]++; extra--;
        }
        pushSeq(buildRunSeq(colors, lengths), r);
      }
    }
    if (opts.allowRepeat) {
      // P3/S03: non-contiguous repeat runs (A-B-A) that the used[] permutation
      // generator cannot produce. Bounded quota; fixed length for equal-height.
      const total = maxLayers;
      for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) {
        if (a === b || total < 3) continue;
        const mid = Math.max(1, Math.floor(total / 3));
        const comps = [[1, total - 2, 1], [mid, total - 2 * mid, mid]];
        for (const lengths of comps) {
          if (lengths.some(l => l < 1)) continue;
          pushSeq(buildRunSeq([a, b, a], lengths), 3);
        }
      }
    }
    Object.defineProperty(entries, 'neutral', {
      value: entries.filter(e => !e.chromaFrac),
      enumerable: false
    });
    return entries;
  }

  /* Scene grays are reachable with neutral black/white stacks along the L axis;
     chromatic recipes often win by a fraction of a ΔE but leave visible red/
     yellow/blue speckle around dark lines. Penalise chromatic usage in recipes
     for near-neutral targets so K/W wins ties (max ~2.2 ΔE of bias). */
  function neutralBias(targetLab, chromaFrac) {
    if (!(chromaFrac > 0)) return 0;
    const chroma = Math.hypot(targetLab.a, targetLab.b);
    if (chroma >= 16) return 0;
    return 3.5 * chromaFrac * (1 - chroma / 16);
  }

  function isNeutralEntry(g) { return !(g.chromaFrac > 0); }

  /* Single structural score term so every matcher reads the same fields and
     the complexity penalty cannot silently become dead code again. */
  function gamutPenalty(targetLab, g) {
    return 0.12 * Math.max(0, (g.runs || 1) - 1)
      + 0.25 * Math.max(0, (g.distinct || 1) - 1)
      + neutralBias(targetLab, g.chromaFrac || 0);
  }

  function gamutScore(targetLab, g) {
    return C.deltaE2000(targetLab, g.lab) + gamutPenalty(targetLab, g);
  }

  /* Small gamuts are scanned exactly; large gamuts keep a wide Lab-nearest
     shortlist (192) so a ΔE2000 optimum is not lost to the Euclidean ranking
     the way the old 28-entry list could. */
  const EXACT_SCAN_LIMIT = 6000;

  /* Max-heap top-K so recall can be widened without O(N·K) insertion sorts. */
  function topGamutEntries(gamut, keep, distOf) {
    if (gamut.length <= keep) return gamut;
    const heap = [];
    const push = (node) => {
      heap.push(node);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p].d >= heap[i].d) break;
        const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
      }
    };
    const pop = () => {
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          let l = 2 * i + 1, r = l + 1, m = i;
          if (l < heap.length && heap[l].d > heap[m].d) m = l;
          if (r < heap.length && heap[r].d > heap[m].d) m = r;
          if (m === i) break;
          const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
        }
      }
    };
    for (const g of gamut) {
      const d = distOf(g.lab);
      if (heap.length < keep) push({ g, d });
      else if (d < heap[0].d) { pop(); push({ g, d }); }
    }
    return heap.map(n => n.g);
  }

  const labDistOf = targetLab => lab => {
    const dl = targetLab.L - lab.L, da = targetLab.a - lab.a, db = targetLab.b - lab.b;
    return dl * dl + da * da + db * db;
  };
  /* ΔE94 is a cheap surrogate that ranks ΔE2000 optima far better than raw
     Lab distance, especially for saturated/out-of-gamut targets. */
  const de94Of = targetLab => lab => {
    const c1 = Math.sqrt(targetLab.a * targetLab.a + targetLab.b * targetLab.b);
    const c2 = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
    const dl = targetLab.L - lab.L, dc = c1 - c2;
    const da = targetLab.a - lab.a, db = targetLab.b - lab.b;
    const dh2 = Math.max(0, da * da + db * db - dc * dc);
    const sc = 1 + 0.045 * c1, sh = 1 + 0.015 * c1;
    const a2 = dc / sc, b2 = Math.sqrt(dh2) / sh;
    return dl * dl + a2 * a2 + b2 * b2;
  };

  function nearestGamutEntries(targetLab, gamut, keep) {
    return topGamutEntries(gamut, keep, labDistOf(targetLab));
  }
  function nearestGamutEntries94(targetLab, gamut, keep) {
    return topGamutEntries(gamut, keep, de94Of(targetLab));
  }

  function recipeIsNeutral(seq, palette) {
    for (const i of seq) {
      const p = palette[i];
      if (!p || Math.hypot(p.lab.a, p.lab.b) >= 8) return false;
    }
    return true;
  }

  /* Near-neutral targets lock onto the all-neutral (K/W) subset once it is
     within budget. The lock is a hard constraint for every later rewrite:
     refine, shared bases and height merging may not leave this set. */
  function bestNeutralFor(targetLab, gamut, length) {
    if (Math.hypot(targetLab.a, targetLab.b) >= 8) return null;
    if (!gamut || !gamut.neutral || !gamut.neutral.length) return null;
    let best = null, de = Infinity;
    for (const e of gamut.neutral) {
      if (length != null && e.length !== length) continue;
      const d = C.deltaE2000(targetLab, e.lab);
      if (d < de) { de = d; best = e; }
    }
    return best ? { entry: best, de } : null;
  }


  /* Top-K alternative recipes within a ΔE budget (used by the neighbour-
     coherence pass). neutralOnly restricts the pool to the locked K/W subset
     and scans it directly, so a neutral candidate can never be missed just
     because it was not among the Lab-nearest neighbours. */
  function matchGamutCandidates(targetLab, gamut, k, maxDE, neutralOnly) {
    const out = [];
    if (neutralOnly) {
      for (const g of (gamut.neutral || [])) {
        const de = C.deltaE2000(targetLab, g.lab);
        if (de > maxDE) continue;
        out.push({ g, de, score: de + gamutPenalty(targetLab, g) });
      }
      out.sort((a, b) => a.score - b.score || a.de - b.de);
      return out.slice(0, k);
    }
    const keep = Math.max(96, k * 16);
    let pool;
    if (gamut.length <= 3000) pool = gamut;
    else {
      const set = new Set(nearestGamutEntries(targetLab, gamut, keep));
      for (const e of nearestGamutEntries94(targetLab, gamut, 1024)) set.add(e);
      pool = set;
    }
    for (const g of pool) {
      const de = C.deltaE2000(targetLab, g.lab);
      if (de > maxDE) continue;
      out.push({ g, de, score: de + gamutPenalty(targetLab, g) });
    }
    out.sort((a, b) => a.score - b.score || a.de - b.de);
    return out.slice(0, k);
  }

  function buildFamilyAdjacency(familyId, w, h, familyCount) {
    const adj = new Array(familyCount);
    for (let i = 0; i < familyCount; i++) adj[i] = new Map();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, f = familyId[i];
      if (f < 0) continue;
      if (x + 1 < w) { const g = familyId[i + 1]; if (g >= 0 && g !== f) { adj[f].set(g, (adj[f].get(g) || 0) + 1); adj[g].set(f, (adj[g].get(f) || 0) + 1); } }
      if (y + 1 < h) { const g = familyId[i + w]; if (g >= 0 && g !== f) { adj[f].set(g, (adj[f].get(g) || 0) + 1); adj[g].set(f, (adj[g].get(f) || 0) + 1); } }
    }
    return adj;
  }

  /* Adjacent families may each pick a different recipe with nearly the same
     ΔE; that dithers colour layer by layer at boundaries. Re-pick recipes
     within a small ΔE budget so neighbouring families agree on as many layers
     as possible (greedy ICM on the family adjacency graph). */
  function refineFamilyRecipes(families, familyId, w, h, gamut, gradStartLayer, layerHeight) {
    const F = families.length;
    if (F < 2 || !gamut || !gamut.length) return 0;
    const adj = buildFamilyAdjacency(familyId, w, h, F);
    const colorAt = (rec, L) => (L < rec.length ? rec[L] : -1);
    const mismatch = (a, b) => {
      const len = Math.max(a.length, b.length);
      if (!len) return 0;
      let m = 0;
      for (let L = 0; L < len; L++) if (colorAt(a, L) !== colorAt(b, L)) m++;
      return m / len;
    };
    const opts = families.map(f => {
      const list = [{ seq: f.recipe, de: f.deltaE, lab: f.predictedLab, hex: f.predictedHex }];
      for (const c of matchGamutCandidates(f.targetLab, gamut, 5, f.deltaE + 2, !!f.neutralLocked)) {
        list.push({ seq: c.g.seq, de: c.de, lab: c.g.lab, hex: c.g.hex });
      }
      return list;
    });
    let changedTotal = 0;
    for (let pass = 0; pass < 2; pass++) {
      let changed = 0;
      for (let fi = 0; fi < F; fi++) {
        if (adj[fi].size === 0) continue;
        // Member-level neutral families reproduce one exact source pixel's best
        // K/W candidate; neighbour coherence must not drift them onto a different
        // (worse) neutral stack. They still vote as neighbours for other families.
        if (families[fi].neutralMember) continue;
        let best = null, bestCost = Infinity;
        for (const opt of opts[fi]) {
          let s = 0, wsum = 0;
          for (const [g, wgt] of adj[fi]) { s += wgt * mismatch(opt.seq, families[g].recipe); wsum += wgt; }
          const coh = wsum ? s / wsum : 0;
          const cost = opt.de + 2.0 * coh;
          if (cost < bestCost) { bestCost = cost; best = opt; }
        }
        if (best && best.seq !== families[fi].recipe) {
          const f = families[fi];
          f.recipe = best.seq.slice();
          f.deltaE = best.de;
          f.predictedLab = best.lab;
          f.predictedHex = best.hex;
          f.layers = f.recipe.length;
          f.topLayer = gradStartLayer + f.recipe.length;
          f.topMm = f.topLayer * layerHeight;
          if (f.neutralLocked) f.neutral = true;
          changed++;
        }
      }
      changedTotal += changed;
      if (!changed) break;
    }
    return changedTotal;
  }

  /* Pool scan shared by matchGamut and the member-level neutral constraint:
     returns the best-SCORE entry and its ΔE (before any neutral lock). Small
     gamuts are scanned exactly; larger ones use a union of Lab-nearest and
     ΔE94-nearest pools so saturated/out-of-gamut targets are not lost to the
     Euclidean ranking alone. The final choice still uses ΔE2000. */
  function scanGamutBest(targetLab, gamut) {
    if (!gamut || !gamut.length) return null;
    let pool;
    if (gamut.length <= EXACT_SCAN_LIMIT) pool = gamut;
    else {
      const set = new Set(nearestGamutEntries(targetLab, gamut, 512));
      for (const e of nearestGamutEntries94(targetLab, gamut, 4096)) set.add(e);
      pool = set;
    }
    let g = null, bestScore = Infinity, bestDE = Infinity;
    for (const e of pool) {
      const de = C.deltaE2000(targetLab, e.lab);
      const score = de + gamutPenalty(targetLab, e);
      if (score < bestScore) { bestScore = score; bestDE = de; g = e; }
    }
    return g ? { g, bestDE } : null;
  }

  function matchGamut(targetLab, gamut) {
    const raw = scanGamutBest(targetLab, gamut);
    if (!raw) return null;
    let g = raw.g, bestDE = raw.bestDE;
    let neutralLocked = false;
    // Hard preference: for near-neutral targets an all-neutral K/W stack within
    // 5 ΔE of the best recipe wins, so grey scenes never dither into colour
    // speckle. The lock is sticky for every later rewrite.
    const nb = bestNeutralFor(targetLab, gamut);
    if (nb && nb.de <= bestDE + 5) { g = nb.entry; bestDE = nb.de; neutralLocked = true; }
    return {
      seq: g.seq.slice(), lab: g.lab, lin: g.lin, hex: g.hex,
      deltaE: bestDE, length: g.length, runs: g.runs,
      neutral: isNeutralEntry(g), neutralLocked
    };
  }

  /* R3 — member-level neutral constraint. A family center can sit outside the
     neutral lock while individual source pixels inside that family each satisfy
     it (a grey ramp shares one chromatic center, yet member #575757 has a feasible
     K/W stack within +5 ΔE of its OWN best recipe). markNeutralMembers flags every
     such source pixel; reconcileNeutralMembers then moves it onto the family that
     reproduces its exact best neutral candidate. Demand is decided per source Lab:
       · best neutral ≤ 5 ΔE  ⇒ locked unconditionally (best recipe ΔE ≥ 0);
       · otherwise estimate the best-recipe ΔE from a quantised Lab cell and only
         fall back to an exact matchGamut inside the ambiguous ±5 band, so a smooth
         ramp cannot flip the lock at the boundary while real photos stay cheap.
     Caches are shared across the early and late passes. */
  function neutralOfCache(l, gamut, nbCache) {
    const ek = l.L.toFixed(3) + '|' + l.a.toFixed(3) + '|' + l.b.toFixed(3);
    let nb = nbCache.get(ek);
    if (nb === undefined) {
      const raw = bestNeutralFor(l, gamut);
      nb = raw ? { entry: raw.entry, de: raw.de, seqKey: raw.entry.seq.join(',') } : null;
      nbCache.set(ek, nb);
    }
    return nb;
  }

  /* Exact neutral-lock demand for one source Lab. nb is its best K/W candidate.
     A best neutral within 5 ΔE is always locked (best recipe ΔE ≥ 0). Otherwise
     the best-recipe ΔE is estimated from a quantised Lab cell; only the ambiguous
     ±5 band falls back to an exact matchGamut, so a smooth ramp cannot flip the
     lock at the boundary while real photos stay cheap. */
  function neutralDemanded(l, nb, gamut, caches) {
    if (!nb) return false;
    if (nb.de <= 5) return true;
    const { cellCache, exactCache } = caches;
    const ck = Math.round(l.L) + '|' + Math.round(l.a) + '|' + Math.round(l.b);
    let cell = cellCache.get(ck);
    if (!cell) {
      const cl = { L: Math.round(l.L), a: Math.round(l.a), b: Math.round(l.b) };
      const raw = scanGamutBest(cl, gamut);
      const cnb = bestNeutralFor(cl, gamut);
      cell = { chosenDE: raw ? raw.bestDE : Infinity };
      cellCache.set(ck, cell);
    }
    // gap = nb.de - cellChosenDE; the exact gap differs by at most ~3.5 ΔE
    // (unit-cell Lab shift plus a possible best-entry switch), so only the
    // middle band needs an exact decision.
    const gap = nb.de - cell.chosenDE;
    if (gap <= 1.5) return true;
    if (gap > 8.5) return false;
    const ek = l.L.toFixed(3) + '|' + l.a.toFixed(3) + '|' + l.b.toFixed(3);
    let m = exactCache.get(ek);
    if (m === undefined) { m = matchGamut(l, gamut); exactCache.set(ek, m); }
    return !!(m && m.neutralLocked);
  }

  function markNeutralMembers(lab, flatMask, printMask, lineProtectMask, familyId, families, palette, gamut, w, h, need, caches) {
    const n = w * h;
    const F = families.length;
    const famNeutral = new Uint8Array(F);
    const famSeqKey = new Array(F);
    for (let f = 0; f < F; f++) {
      famNeutral[f] = recipeIsNeutral(families[f].recipe, palette) ? 1 : 0;
      famSeqKey[f] = families[f].recipe ? families[f].recipe.join(',') : '';
    }
    for (let i = 0; i < n; i++) {
      need[i] = 0;
      if (flatMask[i] || (printMask && !printMask[i])) continue;
      // Line-protected pixels are governed by the stroke/repair subsystem (R2),
      // which may intentionally repaint an AA gap to the stroke colour; the
      // gradient neutral-member constraint must not undo that.
      if (lineProtectMask && lineProtectMask[i]) continue;
      const f = familyId[i];
      if (f < 0) continue;
      const l = labAt(lab, i);
      if (Math.hypot(l.a, l.b) >= 8) continue;
      const nb = neutralOfCache(l, gamut, caches.nbCache);
      if (!nb) continue;
      // Already sitting on its exact best neutral recipe: nothing to constrain.
      if (famNeutral[f] && famSeqKey[f] === nb.seqKey) continue;
      if (neutralDemanded(l, nb, gamut, caches)) need[i] = 1;
    }
  }

  /* Move every flagged source pixel onto the family reproducing its exact best
     neutral candidate, reusing an existing neutral family with that recipe or
     creating one. New families are flagged neutralMember so refine / height
     merging cannot drift them onto a different (worse) neutral stack. */
  function reconcileNeutralMembers(lab, need, familyId, families, palette, gamut, gradStartLayer, layerHeight, w, h, nbCache) {
    const n = w * h;
    const byRecipe = new Map();
    for (let f = 0; f < families.length; f++) {
      const fam = families[f];
      if (fam.recipe && recipeIsNeutral(fam.recipe, palette)) byRecipe.set(fam.recipe.join(','), f);
    }
    let moved = 0, created = 0;
    for (let i = 0; i < n; i++) {
      if (!need[i]) continue;
      const f = familyId[i];
      if (f < 0) continue;
      const l = labAt(lab, i);
      const ek = l.L.toFixed(3) + '|' + l.a.toFixed(3) + '|' + l.b.toFixed(3);
      let nb = nbCache ? nbCache.get(ek) : undefined;
      if (nb === undefined) {
        const raw = bestNeutralFor(l, gamut);
        nb = raw ? { entry: raw.entry, de: raw.de, seqKey: raw.entry.seq.join(',') } : null;
        if (nbCache) nbCache.set(ek, nb);
      }
      if (!nb) continue;
      if (families[f].recipe && families[f].recipe.join(',') === nb.seqKey) continue;
      let idx = byRecipe.get(nb.seqKey);
      if (idx === undefined) {
        const seq = nb.entry.seq.slice();
        idx = families.length;
        families.push({
          targetLab: { L: l.L, a: l.a, b: l.b }, targetHex: C.labToHex(l),
          predictedLab: nb.entry.lab, predictedHex: nb.entry.hex,
          recipe: seq, deltaE: nb.de, pixelCount: 0,
          neutralLocked: true, neutral: true, neutralMember: true,
          layers: seq.length, topLayer: gradStartLayer + seq.length,
          topMm: (gradStartLayer + seq.length) * layerHeight
        });
        byRecipe.set(nb.seqKey, idx);
        created++;
      }
      familyId[i] = idx;
      moved++;
    }
    return { moved, created };
  }

  /* R3 acceptance audit over the FINAL plan: every source-neutral gradient pixel
     is compared against its own feasible neutral candidate. feasibleMissed counts
     demanded pixels still on a chromatic (or worse-than-budget neutral) recipe and
     must be 0 after reconcile; budgetUnmet counts grays that legitimately stay
     chromatic because no K/W stack is within +5 ΔE — those are risk-flagged. */
  function auditNeutralMembers(lab, flatMask, printMask, lineProtectMask, familyId, families, palette, gamut, w, h, caches) {
    const n = w * h;
    const F = families.length;
    const famNeutral = new Uint8Array(F);
    for (let f = 0; f < F; f++) famNeutral[f] = recipeIsNeutral(families[f].recipe, palette) ? 1 : 0;
    let sourceNeutral = 0, chromaticOnNeutral = 0, feasibleMissed = 0, budgetUnmet = 0;
    const examples = [];
    for (let i = 0; i < n; i++) {
      if (flatMask[i] || (printMask && !printMask[i])) continue;
      if (lineProtectMask && lineProtectMask[i]) continue;
      const f = familyId[i];
      if (f < 0) continue;
      const l = labAt(lab, i);
      if (Math.hypot(l.a, l.b) >= 8) continue;
      sourceNeutral++;
      const fam = families[f];
      const neutralRecipe = !!famNeutral[f];
      if (!neutralRecipe) chromaticOnNeutral++;
      const nb = neutralOfCache(l, gamut, caches.nbCache);
      const de = C.deltaE2000(l, fam.predictedLab);
      if (neutralDemanded(l, nb, gamut, caches)) {
        if (!neutralRecipe || (nb && de > nb.de + 0.5)) {
          feasibleMissed++;
          if (examples.length < 5) examples.push({ hex: C.labToHex(l), family: fam.targetHex, recipe: fam.recipe.join(','), de: +de.toFixed(2), neutralDe: nb ? +nb.de.toFixed(2) : null });
        }
      } else if (!neutralRecipe) {
        budgetUnmet++;
      }
    }
    return { sourceNeutral, chromaticOnNeutral, feasibleMissed, budgetUnmet, examples };
  }

  function suggestFilamentForLab(targetLab, palette) {
    const all = (CS.FILAMENT_DB && CS.FILAMENT_DB.filaments) || [];
    const used = new Set((palette || []).map(p => (p.name + '|' + p.hex).toLowerCase()));
    const basics = all.filter(f => f.brand === 'BambuLab Basic' && f.material === 'PLA');
    const db = basics.length ? basics : all;
    let best = null, bestD = Infinity;
    for (const f of db) {
      if (used.has((f.name + '|' + f.hex).toLowerCase())) continue;
      const fl = C.hexToLab(f.hex);
      const d = C.deltaE2000(targetLab, fl);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best ? { name: best.name, hex: best.hex, brand: best.brand, material: best.material, deltaE: C.deltaE2000(targetLab, C.hexToLab(best.hex)) } : null;
  }

  function assignFamilies(lab, mask, predictedLabs, w, h, strokeMask) {
    const n = w * h;
    const familyId = new Int16Array(n).fill(-1);
    const counts = new Uint32Array(predictedLabs.length);
    for (let i = 0; i < n; i++) {
      if (mask[i]) continue;
      const l = labAt(lab, i);
      const onStroke = !!(strokeMask && strokeMask[i]);
      let best = -1, bestD = Infinity;
      for (let f = 0; f < predictedLabs.length; f++) {
        const p = predictedLabs[f];
        const dl = l.L - p.L, da = l.a - p.a, db = l.b - p.b;
        let d = dl * dl + da * da + db * db;
        // A dark stroke may be reproduced by a light recipe only if there is
        // no dark alternative. The quadratic lift makes that very expensive.
        if (onStroke) {
          const lift = Math.max(0, p.L - l.L - 10);
          d += 3.0 * lift * lift;
        }
        if (d < bestD) { bestD = d; best = f; }
      }
      familyId[i] = best;
      if (best >= 0) counts[best]++;
    }
    return { familyId, counts };
  }

  function meanLabForFamilies(lab, mask, familyId, familyCount) {
    const sums = new Float64Array(familyCount * 3);
    const counts = new Uint32Array(familyCount);
    for (let i = 0; i < mask.length; i++) {
      const f = familyId[i];
      if (f < 0) continue;
      sums[f * 3] += lab[i * 3]; sums[f * 3 + 1] += lab[i * 3 + 1]; sums[f * 3 + 2] += lab[i * 3 + 2];
      counts[f]++;
    }
    const centers = [];
    for (let f = 0; f < familyCount; f++) {
      if (!counts[f]) continue;
      centers.push({ L: sums[f * 3] / counts[f], a: sums[f * 3 + 1] / counts[f], b: sums[f * 3 + 2] / counts[f], count: counts[f] });
    }
    return centers;
  }

  function matchGamutPrefix(targetLab, gamut, prefix) {
    let best = null, bestScore = Infinity, bestDE = Infinity;
    const b = prefix.length;
    for (const g of gamut) {
      if (g.length < b) continue;
      let ok = true;
      for (let i = 0; i < b; i++) if (g.seq[i] !== prefix[i]) { ok = false; break; }
      if (!ok) continue;
      const de = C.deltaE2000(targetLab, g.lab);
      const score = de + gamutPenalty(targetLab, g);
      if (score < bestScore) { bestScore = score; bestDE = de; best = g; }
    }
    if (!best) return null;
    let neutralLocked = false;
    if (Math.hypot(targetLab.a, targetLab.b) < 8 && gamut.neutral && gamut.neutral.length) {
      let nBest = null, nDe = Infinity;
      for (const e of gamut.neutral) {
        let ok = true;
        for (let i = 0; i < b; i++) if (e.seq[i] !== prefix[i]) { ok = false; break; }
        if (!ok) continue;
        const de = C.deltaE2000(targetLab, e.lab);
        if (de < nDe) { nDe = de; nBest = e; }
      }
      if (nBest && nDe <= bestDE + 5) { best = nBest; bestDE = nDe; neutralLocked = true; }
    }
    return {
      seq: best.seq.slice(), lab: best.lab, lin: best.lin, hex: best.hex,
      deltaE: bestDE, length: best.length, runs: best.runs,
      neutral: isNeutralEntry(best), neutralLocked
    };
  }

  function mergeCommonBases(families, gamut, threshold, maxLayers, adj) {
    if (!(threshold > 0) || !gamut || !gamut.length) return { groups: 0, sharedPixels: 0 };
    const list = families.filter(f => f.pixelCount > 0);
    const n = list.length;
    for (const f of families) f.sharedBaseLayers = 0;
    if (n < 2) return { groups: 0, sharedPixels: 0 };
    const familyIndex = new Map();
    for (let i = 0; i < families.length; i++) familyIndex.set(families[i], i);
    // Greedy groups around a weighted target-color center. Plain union-find
    // would chain a whole smooth gradient into one giant group, which then
    // can only share a very short base. Centered groups keep the threshold
    // meaningful and let close colors share a longer common bottom. With a
    // spatial adjacency map, only families that actually touch may share.
    const groups = [];
    const sorted = list.slice().sort((a, b) => b.pixelCount - a.pixelCount);
    for (const f of sorted) {
      let best = null, bestDE = Infinity;
      const fi = familyIndex.get(f);
      for (const g of groups) {
        const de = C.deltaE2000(f.targetLab, g.centerLab);
        if (de > threshold || de >= bestDE) continue;
        if (adj) {
          const touches = g.members.some(m => {
            const mi = familyIndex.get(m);
            return adj[fi] && adj[fi].has(mi);
          });
          if (!touches) continue;
        }
        bestDE = de; best = g;
      }
      if (best) {
        const w0 = best.weight, w1 = f.pixelCount;
        const tw = w0 + w1;
        best.centerLab = {
          L: (best.centerLab.L * w0 + f.targetLab.L * w1) / tw,
          a: (best.centerLab.a * w0 + f.targetLab.a * w1) / tw,
          b: (best.centerLab.b * w0 + f.targetLab.b * w1) / tw
        };
        best.weight = tw;
        best.members.push(f);
      } else {
        groups.push({ centerLab: { L: f.targetLab.L, a: f.targetLab.a, b: f.targetLab.b }, weight: f.pixelCount, members: [f] });
      }
    }
    let mergedGroups = 0, sharedPixels = 0;
    for (const g of groups) {
      const group = g.members;
      if (group.length < 2) continue;
      const byPixels = group.slice().sort((a, b) => b.pixelCount - a.pixelCount);
      const byL = group.slice().sort((a, b) => a.targetLab.L - b.targetLab.L);
      const sources = [byPixels[0], byL[Math.floor(byL.length / 2)]]
        .filter((f, i, arr) => f && arr.indexOf(f) === i);
      let bestCandidate = null;
      for (const source of sources) {
        const maxB = Math.min(source.recipe.length, maxLayers) - 1;
        for (let b = maxB; b >= 2; b--) {
          if (bestCandidate && b <= bestCandidate.b) break;
          const base = source.recipe.slice(0, b);
          const picks = [];
          let ok = true, totalDE = 0;
          for (const f of group) {
            const m = matchGamutPrefix(f.targetLab, gamut, base);
            if (!m || m.deltaE > f.deltaE + threshold) { ok = false; break; }
            // A neutral-locked family may not acquire a chromatic base just to
            // share layers with its neighbours.
            if (f.neutralLocked && !m.neutral) { ok = false; break; }
            picks.push({ f, m });
            totalDE += m.deltaE * f.pixelCount;
          }
          if (!ok) continue;
          if (!bestCandidate || b > bestCandidate.b || (b === bestCandidate.b && totalDE < bestCandidate.totalDE)) {
            bestCandidate = { b, base, picks, totalDE };
          }
          break; // largest valid b for this source
        }
      }
      if (!bestCandidate) continue;
      mergedGroups++;
      for (const { f, m } of bestCandidate.picks) {
        f.predictedLab = m.lab;
        f.predictedHex = m.hex;
        f.recipe = m.seq;
        f.layers = m.seq.length;
        f.deltaE = m.deltaE;
        f.neutral = m.neutral;
        f.topLayer = (f.topLayer || 0); // recalculated below by caller
        f.sharedBaseLayers = bestCandidate.b;
        sharedPixels += f.pixelCount;
      }
    }
    return { groups: mergedGroups, sharedPixels };
  }

  function mergeIneffectiveHeights(families, familyId, threshold, minGap) {
    const result = { changed: 0, groups: 0, oldMax: 0, newMax: 0, savedLayers: 0, savedLayerPixels: 0, threshold: threshold || 0 };
    if (!(threshold > 0)) return result;
    const entries = [];
    for (let i = 0; i < families.length; i++) {
      const f = families[i];
      if (f.pixelCount > 0 && f.recipe && f.recipe.length) entries.push({ f, idx: i });
    }
    if (entries.length < 2) return result;
    result.oldMax = entries.reduce((m, e) => Math.max(m, e.f.recipe.length), 0);
    const minSupport = 0.75; // a short recipe must represent a sizeable area
    let changedAny = false;
    for (let pass = 0; pass < 3; pass++) {
      const sorted = entries.slice().sort((a, b) => b.f.recipe.length - a.f.recipe.length);
      let passChanged = 0;
      for (const e of sorted) {
        const f = e.f;
        if (f.recipe.length <= minGap) continue;
        if (f.neutralMember) continue; // keep the exact source-member neutral stack
        let best = null;
        for (const c of entries) {
          if (c === e) continue;
          const cand = c.f;
          if (!cand.recipe || cand.pixelCount <= 0) continue;
          if (f.recipe.length - cand.recipe.length < minGap) continue;
          if (cand.pixelCount < f.pixelCount * minSupport) continue;
          if (f.neutralLocked && !cand.neutral) continue;
          const predDE = C.deltaE2000(f.predictedLab, cand.predictedLab);
          if (predDE > threshold) continue;
          const targetDE = C.deltaE2000(f.targetLab, cand.predictedLab);
          if (targetDE > f.deltaE + threshold + 0.25) continue;
          if (!best || cand.recipe.length < best.recipe.length ||
            (cand.recipe.length === best.recipe.length && cand.pixelCount > best.pixelCount)) {
            best = cand;
          }
        }
        if (!best) continue;
        const oldLen = f.recipe.length;
        f.recipe = best.recipe.slice();
        f.layers = f.recipe.length;
        f.predictedLab = { L: best.predictedLab.L, a: best.predictedLab.a, b: best.predictedLab.b };
        f.predictedHex = best.predictedHex;
        f.deltaE = C.deltaE2000(f.targetLab, f.predictedLab);
        f.neutral = best.neutral;
        if (best.neutralLocked) f.neutralLocked = true;
        f.sharedBaseLayers = 0;
        result.savedLayerPixels += (oldLen - f.recipe.length) * f.pixelCount;
        result.savedLayers += oldLen - f.recipe.length;
        result.changed++;
        passChanged++;
        changedAny = true;
      }
      if (!passChanged) break;
    }
    // Collapse families that ended up with exactly the same recipe + colour.
    // This is what makes two spatially separate patches truly one recipe, not
    // just two identical entries in the list.
    const groups = new Map();
    for (const e of entries) {
      const f = e.f;
      if (f.pixelCount <= 0) continue;
      const key = f.recipe.join(',') + '|' + f.predictedHex;
      const arr = groups.get(key);
      if (arr) arr.push(e); else groups.set(key, [e]);
    }
    const remap = new Map();
    for (const arr of groups.values()) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => b.f.pixelCount - a.f.pixelCount);
      const canon = arr[0];
      for (let i = 1; i < arr.length; i++) {
        const f = arr[i].f;
        canon.f.pixelCount += f.pixelCount;
        if (f.neutralLocked) canon.f.neutralLocked = true;
        if (f.neutralMember) canon.f.neutralMember = true;
        f.pixelCount = 0;
        f.sharedBaseLayers = 0;
        remap.set(arr[i].idx, canon.idx);
        result.groups++;
      }
    }
    if (remap.size) {
      for (let i = 0; i < familyId.length; i++) {
        const f = familyId[i];
        if (f < 0) continue;
        const c = remap.get(f);
        if (c !== undefined) familyId[i] = c;
      }
    }
    result.newMax = entries.reduce((m, e) => Math.max(m, e.f.pixelCount > 0 ? e.f.recipe.length : 0), 0);
    result.remap = remap;
    result.changedAny = changedAny;
    return result;
  }

  function labelFamilyComponents(familyId, flatMask, w, h) {
    const n = w * h;
    const label = new Int32Array(n).fill(-1);
    const compArea = [];
    const stack = new Int32Array(n);
    for (let start = 0; start < n; start++) {
      if (label[start] !== -1 || flatMask[start] || familyId[start] < 0) continue;
      const f = familyId[start];
      const id = compArea.length;
      let top = 0; stack[top++] = start; label[start] = id;
      let area = 0;
      while (top) {
        const i = stack[--top]; area++;
        const x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (label[j] === -1 && !flatMask[j] && familyId[j] === f) { label[j] = id; stack[top++] = j; }
          }
        }
      }
      compArea.push(area);
    }
    return { label, compArea };
  }

  function forceVectorBoundaries(lab, flatMask, nearest, familyId, families, palette, w, h, minAnchorPx, protect, band, manualLock) {
    const labeled = labelFamilyComponents(familyId, flatMask, w, h);
    const label = labeled.label, compArea = labeled.compArea;
    let changed = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!band[i] || flatMask[i] || (protect && protect[i]) || (manualLock && manualLock[i])) continue;
        const l = labAt(lab, i);
        let bestKind = 0, bestIdx = -1, bestD = Infinity, bestCount = 0;
        for (let r = 1; r <= 4 && !bestKind; r++) {
          const famCounts = new Map(), flatCounts = new Map();
          for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
            for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
              if (Math.max(Math.abs(xx - x), Math.abs(yy - y)) !== r) continue;
              const j = yy * w + xx;
              if (j === i) continue;
              if (flatMask[j]) {
                const fi = nearest[j];
                if (fi !== 0xffff) flatCounts.set(fi, (flatCounts.get(fi) || 0) + 1);
                continue;
              }
              const cid = label[j];
              if (cid >= 0 && (compArea[cid] >= minAnchorPx || (protect && protect[j]))) {
                const f = familyId[j];
                famCounts.set(f, (famCounts.get(f) || 0) + 1);
              }
            }
          }
          let localKind = 0, localIdx = -1, localD = Infinity, localCount = 0;
          for (const [fi, c] of flatCounts) {
            const p = palette[fi].lab;
            const d = (l.L - p.L) ** 2 + (l.a - p.a) ** 2 + (l.b - p.b) ** 2;
            if (d < localD - 25 || (Math.abs(d - localD) <= 25 && c > localCount)) { localD = d; localCount = c; localIdx = fi; localKind = 1; }
          }
          for (const [f, c] of famCounts) {
            const p = families[f].predictedLab;
            const d = (l.L - p.L) ** 2 + (l.a - p.a) ** 2 + (l.b - p.b) ** 2;
            if (d < localD - 25 || (Math.abs(d - localD) <= 25 && c > localCount)) { localD = d; localCount = c; localIdx = f; localKind = 2; }
          }
          if (localKind) { bestKind = localKind; bestIdx = localIdx; }
        }
        if (bestKind === 1) {
          flatMask[i] = 1; nearest[i] = bestIdx; familyId[i] = -1; changed++;
        } else if (bestKind === 2) {
          familyId[i] = bestIdx; changed++;
        }
      }
    }
    return changed;
  }

  function mergeSmallFamilyComponents(familyId, flatMask, nearest, families, w, h, minAreaPx, edgeMask, protect, manualLock) {
    const n = w * h;
    const label = new Int32Array(n).fill(-1);
    const compArea = [];
    const compHasCore = [];
    const compProtected = [];
    const stack = new Int32Array(n);
    for (let start = 0; start < n; start++) {
      if (label[start] !== -1 || flatMask[start] || familyId[start] < 0) continue;
      const f = familyId[start];
      const id = compArea.length;
      let top = 0; stack[top++] = start; label[start] = id;
      let area = 0;
      let hasCore = 0, protectedComp = 0;
      while (top) {
        const i = stack[--top]; area++;
        if (edgeMask && !edgeMask[i]) hasCore = 1;
        if (protect && protect[i]) protectedComp = 1;
        const x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (label[j] === -1 && !flatMask[j] && familyId[j] === f) {
              label[j] = id; stack[top++] = j;
            }
          }
        }
      }
      compArea.push(area);
      compHasCore.push(hasCore);
      compProtected.push(protectedComp);
    }
    let mergedPixels = 0;
    for (let i = 0; i < n; i++) {
      const cid = label[i];
      if (cid < 0 || compArea[cid] >= minAreaPx) continue;
      if (manualLock && manualLock[i]) continue;
      // Only edge-only islands (no core pixel outside the anti-alias band)
      // are removed. A small but genuine fill (red ribbon, eye highlight)
      // always has a core and is preserved.
      if (compHasCore[cid] || compProtected[cid]) continue;
      const x = i % w, y = (i / w) | 0;
      const famCount = new Map();
      const flatCount = new Map();
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (j === i) continue;
          if (flatMask[j]) {
            const fi = nearest[j];
            if (fi !== 0xffff) flatCount.set(fi, (flatCount.get(fi) || 0) + 1);
            continue;
          }
          const lj = label[j];
          if (lj >= 0 && lj !== cid && compArea[lj] >= minAreaPx) {
            const f = familyId[j];
            famCount.set(f, (famCount.get(f) || 0) + 1);
          }
        }
      }
      let bestF = -1, bestN = 0;
      for (const [f, c] of famCount) if (c > bestN) { bestN = c; bestF = f; }
      let bestFlat = -1, bestFN = bestN;
      for (const [fi, c] of flatCount) if (c > bestFN) { bestFN = c; bestFlat = fi; }
      if (bestFlat >= 0) {
        flatMask[i] = 1;
        nearest[i] = bestFlat;
        familyId[i] = -1;
        mergedPixels++;
      } else if (bestF >= 0) {
        familyId[i] = bestF;
        mergedPixels++;
      }
    }
    return { label, compArea, mergedPixels };
  }

  // Final, representation-independent cleanup. Earlier stages operate on
  // either the flat mask or a gradient family, so a tiny island can survive
  // simply by crossing that boundary (or by carrying a protected-stroke bit).
  // Here a region means one actual printable assignment: flat filament or
  // gradient family. Small regions are absorbed by the closest-colour neighbour,
  // using shared border as a tie-break and stable/large targets to avoid cycles.
  function mergeSmallRegions(flatMask, nearest, familyId, lab, families, palette, w, h, minAreaPx, eligibleMask, protectedMask, manualLock) {
    const n = w * h;
    const result = { mergedPixels: 0, mergedComponents: 0, passes: 0, converged: true };
    if (!(minAreaPx > 1)) return result;
    for (let pass = 0; pass < 16; pass++) {
      const keys = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        // Positive = flat filament + 1; negative = -(family + 2).
        // The extra offset keeps both flat 0 and gradient -1 unambiguous.
        keys[i] = flatMask[i] ? nearest[i] + 1 : -(familyId[i] + 2);
      }
      const label = new Int32Array(n).fill(-1);
      const compArea = [], compEligible = [], compLab = [], compProtected = [], compSpan = [];
      const stack = new Int32Array(n);
      for (let start = 0; start < n; start++) {
        if (label[start] !== -1) continue;
        const key = keys[start], id = compArea.length;
        let top = 0, area = 0, eligible = 1, protectedComp = 0, sumL = 0, sumA = 0, sumB = 0;
        let minX = w, minY = h, maxX = -1, maxY = -1;
        stack[top++] = start; label[start] = id;
        while (top) {
          const i = stack[--top]; area++;
          sumL += lab[i * 3]; sumA += lab[i * 3 + 1]; sumB += lab[i * 3 + 2];
          if (eligibleMask && !eligibleMask[i]) eligible = 0;
          if (protectedMask && protectedMask[i]) protectedComp = 1;
          if (manualLock && manualLock[i]) eligible = 0;
          const x = i % w, y = (i / w) | 0;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const xx = x + dx; if (xx < 0 || xx >= w) continue;
              const j = yy * w + xx;
              if (label[j] === -1 && keys[j] === key) { label[j] = id; stack[top++] = j; }
            }
          }
        }
        compArea.push(area); compEligible.push(eligible); compProtected.push(protectedComp);
        compSpan.push(Math.max(maxX - minX + 1, maxY - minY + 1));
        compLab.push({ L: sumL / area, a: sumA / area, b: sumB / area });
      }
      const targets = new Int32Array(compArea.length);
      const votesByComponent = [];
      for (let i = 0; i < n; i++) {
        const cid = label[i], area = compArea[cid];
        if (area >= minAreaPx || !compEligible[cid] || (compProtected[cid] && area > 1 && compSpan[cid] >= 3)) continue;
        const x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx, nid = label[j];
            if (nid === cid) continue;
            const otherArea = compArea[nid];
            // Small components may only grow into a stable component, a
            // larger one, or a deterministic tie-break. This prevents swaps.
            if (otherArea < minAreaPx && (otherArea < area || (otherArea === area && nid > cid))) continue;
            const votes = votesByComponent[cid] || (votesByComponent[cid] = new Map());
            const vote = votes.get(nid) || { count: 0, key: keys[j], area: otherArea, nid };
            vote.count++; votes.set(nid, vote);
          }
        }
      }
      let changedPass = 0, componentsPass = 0;
      for (let cid = 0; cid < compArea.length; cid++) {
        const votes = votesByComponent[cid];
        if (!votes) continue;
        let best = null;
        for (const vote of votes.values()) {
          const fi = -vote.key - 2;
          const candidateLab = vote.key > 0 ? palette[vote.key - 1].lab : (families[fi] ? families[fi].predictedLab : compLab[cid]);
          vote.de = C.deltaE2000(compLab[cid], candidateLab);
          // Colour fidelity comes first; shared border and component size only
          // break near-colour ties. Otherwise a red accent beside a long black
          // outline would be absorbed into black merely because black is long.
          if (!best || vote.de < best.de - 0.05 ||
            (Math.abs(vote.de - best.de) <= 0.05 && vote.count > best.count) ||
            (Math.abs(vote.de - best.de) <= 0.05 && vote.count === best.count && vote.area > best.area) ||
            (Math.abs(vote.de - best.de) <= 0.05 && vote.count === best.count && vote.area === best.area && vote.nid < best.nid)) best = vote;
        }
        if (best) { targets[cid] = best.key; componentsPass++; }
      }
      for (let i = 0; i < n; i++) {
        const target = targets[label[i]];
        if (!target) continue;
        if (target > 0) {
          flatMask[i] = 1; nearest[i] = target - 1; familyId[i] = -1;
        } else {
          flatMask[i] = 0; familyId[i] = -target - 2;
        }
        changedPass++;
      }
      if (!changedPass) break;
      if (pass === 15) result.converged = false;
      result.mergedPixels += changedPass;
      result.mergedComponents += componentsPass;
      result.passes = pass + 1;
    }
    return result;
  }

  function smoothUnifiedRegions(flatMask, nearest, familyId, printMask, w, h, radius, protect, lab, families, palette, manualLock) {
    const n = w * h;
    let srcFlat = new Uint8Array(flatMask), srcNearest = new Uint16Array(nearest), srcFamily = new Int16Array(familyId);
    const passes = radius > 1 ? 2 : 1;
    const sigma2 = Math.max(0.5, (radius / 1.5) ** 2);
    let changedTotal = 0;
    for (let pass = 0; pass < passes; pass++) {
      const outFlat = new Uint8Array(srcFlat), outNearest = new Uint16Array(srcNearest), outFamily = new Int16Array(srcFamily);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (printMask && !printMask[i]) continue;
          if (manualLock && manualLock[i]) continue;
          const protectedCenter = !!(protect && protect[i]);
          const votes = new Map();
          for (let yy = Math.max(0, y - radius); yy <= Math.min(h - 1, y + radius); yy++) {
            for (let xx = Math.max(0, x - radius); xx <= Math.min(w - 1, x + radius); xx++) {
              const dx = xx - x, dy = yy - y, d2 = dx * dx + dy * dy;
              if (d2 > radius * radius) continue;
              const j = yy * w + xx;
              if (printMask && !printMask[j]) continue;
              if (protectedCenter && !(protect && protect[j])) continue;
              const key = srcFlat[j] ? srcNearest[j] + 1 : -(srcFamily[j] + 2);
              if (protectedCenter && lab) {
                const fi = key > 0 ? key - 1 : -key - 2;
                const candidate = key > 0 ? palette[fi] && palette[fi].lab : (families[fi] && families[fi].predictedLab);
                if (candidate && candidate.L > lab[i * 3] + 10) continue;
              }
              const weight = d2 === 0 ? 3 : Math.exp(-d2 / (2 * sigma2));
              votes.set(key, (votes.get(key) || 0) + weight);
            }
          }
          let best = srcFlat[i] ? srcNearest[i] + 1 : -(srcFamily[i] + 2), bestCount = 0;
          for (const [key, count] of votes) if (count > bestCount) { best = key; bestCount = count; }
          const oldKey = srcFlat[i] ? srcNearest[i] + 1 : -(srcFamily[i] + 2);
          if (best === oldKey) continue;
          if (best > 0) {
            outFlat[i] = 1; outNearest[i] = best - 1; outFamily[i] = -1;
          } else {
            outFlat[i] = 0; outFamily[i] = -best - 2;
          }
          changedTotal++;
        }
      }
      srcFlat = outFlat; srcNearest = outNearest; srcFamily = outFamily;
    }
    flatMask.set(srcFlat); nearest.set(srcNearest); familyId.set(srcFamily);
    return changedTotal;
  }

  function smoothParams(level, family) {
    if (level <= 0) return null;
    if (!family) {
      if (level <= 1) return null;
      if (level === 2) return { r: 1, passes: 1 };
      if (level === 3) return { r: 1, passes: 2 };
      return { r: 2, passes: 1 };
    }
    if (level === 1) return { r: 1, passes: 1 };
    if (level === 2) return { r: 2, passes: 1 };
    if (level === 3) return { r: 2, passes: 2 };
    return { r: 3, passes: 2 };
  }

  // Physical smoothing: the user specifies the smallest structure worth
  // printing in millimetres. A majority radius of r removes details roughly
  // 2r pixels wide, so r = smoothMm / (2 * pixelSize). This keeps the result
  // consistent when the same artwork is printed at 80 mm or 300 mm, and with
  // different nozzle widths.
  function physicalSmoothParams(smoothMm, pixelSize) {
    if (!(smoothMm > 0) || !(pixelSize > 0)) return { familyR: 0, flatR: 0, passes: 0 };
    const familyR = Math.max(0, Math.round(smoothMm / (2 * pixelSize)));
    const flatR = familyR > 0 ? Math.max(1, Math.round(familyR * 0.5)) : 0;
    return { familyR, flatR, passes: familyR > 0 ? 1 : 0 };
  }

  function smoothBinaryMask(mask, w, h, radius, passes, lab, colorTol) {
    let src = new Uint8Array(mask);
    const tol2 = colorTol ? colorTol * colorTol : 0;
    for (let pass = 0; pass < passes; pass++) {
      const out = new Uint8Array(src.length);
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
          let ones = 0, total = 0;
          for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
              const j = yy * w + xx;
              // Edge-aware pass: a white paper neighbour must not erase a
              // thin dark stroke, and a dark neighbour must not bleed into it.
              if (lab && tol2 && i !== j && labDistSq(lab, i, j) > tol2) continue;
              const wgt = (yy === y && xx === x) ? 2 : 1;
              total += wgt;
              if (src[j]) ones += wgt;
            }
          }
          out[i] = total ? (ones * 2 > total ? 1 : 0) : src[i];
        }
      }
      src = out;
    }
    return src;
  }

  function smoothFamilyMap(mask, familyId, familyCount, families, w, h, radius, passes, lab, colorTol, protect, neutralGuard) {
    let src = new Int16Array(familyId);
    const counts = new Uint32Array(familyCount);
    const tol2 = colorTol ? colorTol * colorTol : 0;
    const neutralNeed = neutralGuard ? neutralGuard.need : null;
    const famNeutral = neutralGuard ? neutralGuard.famNeutral : null;
    const touched = [];
    for (let pass = 0; pass < passes; pass++) {
      const out = new Int16Array(src);
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (mask[i] || src[i] < 0) continue;
          // Protect the stroke's coverage, not every noisy recipe inside it.
          // A protected pixel votes only with other protected stroke pixels:
          // the surrounding paper still cannot erase the line, while a long
          // outline converges to a continuous family instead of dotted stacks.
          const protectedCenter = !!(protect && protect[i]);
          const constrainedCenter = !!(neutralNeed && neutralNeed[i]);
          const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
          touched.length = 0;
          let best = src[i], bestCount = 0;
          for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
              const j = yy * w + xx;
              if (mask[j]) continue;
              if (protectedCenter && !(protect && protect[j])) continue;
              if (!protectedCenter && lab && tol2 && j !== i && labDistSq(lab, i, j) > tol2) continue;
              const f = src[j];
              if (f < 0) continue;
              if (constrainedCenter && famNeutral && !famNeutral[f]) continue;
              if (protectedCenter && lab && families && families[f] && families[f].predictedLab.L > lab[i * 3] + 10) continue;
              const wgt = (yy === y && xx === x) ? 2 : 1;
              const c = counts[f];
              if (c === 0) touched.push(f);
              counts[f] = c + wgt;
              if (c + wgt > bestCount) { bestCount = c + wgt; best = f; }
            }
          }
          for (const f of touched) counts[f] = 0;
          out[i] = bestCount ? best : src[i];
        }
      }
      src = out;
    }
    return src;
  }

  /* Sampled per-layer print audit: how many same-material islands are below a
     printable minimum area. Runs on a <=512 long-side sample so a 1280/2560
     work grid stays cheap; it is a risk screen, not a slicer simulation. */
  function auditPrintLayers(lab, w, h, opt) {
    const stride = Math.max(1, Math.ceil(Math.max(w, h) / 512));
    const aw = Math.ceil(w / stride), ah = Math.ceil(h / stride);
    const pxArea = (opt.pixelSize * stride) ** 2;
    const minAreaMm2 = Math.max(0.2, Math.PI * ((opt.lineWidthMm || 0.42) * 0.75 / 2) ** 2);
    const minPx = Math.max(1, Math.ceil(minAreaMm2 / pxArea));
    const layers = Math.min(48, Math.max(1, opt.maxLayers));
    const mat = new Int16Array(aw * ah);
    const seen = new Uint8Array(aw * ah);
    const stack = new Int32Array(aw * ah);
    let belowMinIslands = 0, worstLayer = -1, worstIslands = 0;
    for (let z = 0; z < layers; z++) {
      seen.fill(0);
      for (let y = 0; y < ah; y++) {
        const sy = Math.min(h - 1, y * stride);
        for (let x = 0; x < aw; x++) {
          const i = sy * w + Math.min(w - 1, x * stride);
          let m = -1;
          if (opt.printMask && !opt.printMask[i]) m = -1;
          else if (opt.flatMask[i]) {
            if (z < opt.flatBaseLayers) m = opt.foundationIndex;
            else if (z < opt.flatLayers) m = opt.flatFilament[i] !== 0xffff ? opt.flatFilament[i] : opt.foundationIndex;
          } else {
            const f = opt.familyId[i];
            if (z < opt.gradStartLayer) m = opt.foundationIndex;
            else if (f >= 0) {
              const fam = opt.families[f];
              const k = z - opt.gradStartLayer;
              if (fam && k < fam.recipe.length) m = fam.recipe[k];
            }
          }
          mat[y * aw + x] = m;
        }
      }
      let smallHere = 0;
      for (let start = 0; start < aw * ah; start++) {
        if (seen[start] || mat[start] < 0) continue;
        const m0 = mat[start];
        let top = 0, area = 0;
        seen[start] = 1; stack[top++] = start;
        while (top) {
          const idx = stack[--top]; area++;
          const x = idx % aw, y = (idx / aw) | 0;
          if (x > 0) { const j = idx - 1; if (!seen[j] && mat[j] === m0) { seen[j] = 1; stack[top++] = j; } }
          if (x + 1 < aw) { const j = idx + 1; if (!seen[j] && mat[j] === m0) { seen[j] = 1; stack[top++] = j; } }
          if (y > 0) { const j = idx - aw; if (!seen[j] && mat[j] === m0) { seen[j] = 1; stack[top++] = j; } }
          if (y + 1 < ah) { const j = idx + aw; if (!seen[j] && mat[j] === m0) { seen[j] = 1; stack[top++] = j; } }
        }
        if (area < minPx) smallHere++;
      }
      belowMinIslands += smallHere;
      if (smallHere > worstIslands) { worstIslands = smallHere; worstLayer = z + 1; }
    }
    return {
      grid: [aw, ah], stride, minAreaMm2: +minAreaMm2.toFixed(3),
      belowMinIslands, worstLayer, worstIslands, layersAudited: layers
    };
  }

  /* Pure layer-geometry derivation, factored out so the coverage warning can
     probe which knob actually thicken the flat colour cap for the CURRENT
     geometry. In the default coupled TD path raising flatTopMm lifts the shared
     foundation (gradStartLayer) by the same amount, so flatTopLayers stays
     colorLayers - reliefLayers and "raise the flat top" does NOT add colour
     thickness. Returns the same values the inline derivation used to compute. */
  function deriveLayerGeometry({ engine, flatTopMm, layerHeight, reliefMm, colorLayers, baseLayers, startOverride, topOverride }) {
    const flatLayers = Math.max(2, Math.round(flatTopMm / layerHeight));
    const reliefLayers = Math.round(reliefMm / layerHeight);
    let gradTopLayer, gradStartLayer, cl = colorLayers;
    if (engine === 'lut') {
      const minTop = baseLayers + cl;
      if (startOverride > 0) {
        gradStartLayer = Math.max(baseLayers, startOverride);
        gradTopLayer = gradStartLayer + cl;
      } else {
        gradTopLayer = Math.max(minTop, flatLayers + reliefLayers);
        gradStartLayer = gradTopLayer - cl;
      }
    } else if (topOverride > 0) {
      const desiredTop = clamp(Math.round(topOverride / layerHeight), 2, 240);
      gradStartLayer = startOverride > 0 ? Math.max(1, startOverride) : Math.max(1, desiredTop - cl);
      const maxTop = gradStartLayer + 24;
      gradTopLayer = clamp(desiredTop, gradStartLayer + 1, maxTop);
      cl = gradTopLayer - gradStartLayer;
    } else if (startOverride > 0) {
      gradStartLayer = Math.max(1, startOverride);
      gradTopLayer = gradStartLayer + cl;
    } else {
      gradTopLayer = Math.max(1, flatLayers + reliefLayers);
      gradStartLayer = Math.max(1, gradTopLayer - cl);
      gradTopLayer = gradStartLayer + cl;
    }
    const flatBaseLayers = Math.max(0, Math.min(gradStartLayer, flatLayers - 1));
    const flatTopLayers = Math.max(1, flatLayers - flatBaseLayers);
    return { flatLayers, gradStartLayer, gradTopLayer, flatBaseLayers, flatTopLayers, colorLayers: cl };
  }

  function buildPlan(imageData, options) {
    const w = imageData.width, h = imageData.height, n = w * h;
    const engine = options.engine === 'td' ? 'td' : 'lut';
    const layerHeight = engine === 'lut' ? (options.lutLayerHeight || 0.08) : (Number(options.layerHeight) || 0.08);
    const flatTopMm = Number(options.flatTopMm) || (engine === 'lut' ? 1.6 : 2.0);
    const reliefMm = Number(options.reliefMm) || 0;
    const pixelSize = (Number(options.widthMm) || 150) / w;
    const { lab, alpha } = imageToLab(imageData);
    const { printMask, sourcePrintMask, background, holeMap } = buildPrintMask(lab, w, h, options, pixelSize);

    let lut = null, palette = null, foundation = null, colorLayers, baseLayers, baseIndex;
    if (engine === 'lut') {
      const key = options.lutKey || 'bambu_8';
      const all = CS.LUT_DATA && CS.LUT_DATA.lut;
      lut = all && all[key];
      if (!lut) throw new Error('LUT 数据未加载');
      palette = buildLutPalette(lut, options);
      colorLayers = lut.colorLayers || 5;
      baseLayers = lut.baseLayers || 10;
      baseIndex = lut.baseIndex || 0;
      foundation = palette[baseIndex];
    } else {
      palette = buildUserPalette(options.palette || []);
      if (!palette.length) throw new Error('请至少选择一种耗材');
      colorLayers = clamp(Math.round(Number(options.gradLayers) || 6), 1, 24);
      baseLayers = 0;
      baseIndex = clamp(Math.round(Number(options.foundationIndex) || 0), 0, palette.length - 1);
      foundation = palette[baseIndex];
    }
    // F02: a published calibrationV2 model overrides palette TD/opaque so production
    // colour-solving actually uses the saved calibration, not just the shared formula.
    // F05: only 'estimated' channels are precise point values. A 'bounded' channel
    // carries just a bound and an 'unresolved' channel no information — neither may
    // be used as a point TD/opaque, so those channels keep the library value. Legacy
    // models without a per-channel state are treated as estimated (backward compat).
    // F02: coverage / cross-domain / effective source are reported, never silent.
    let opticalModelDiag = null;
    if (engine === 'td' && options.opticalModel && options.opticalModel.params) {
      const params = options.opticalModel.params;
      const chKeys = ['r', 'g', 'b'];
      const covered = [], uncovered = [];
      let partialChannels = 0, effectiveChannels = 0;
      for (const p of palette) {
        const t = params[p.id] || params[p.name];
        if (!t) { uncovered.push({ id: p.id, name: p.name }); continue; }
        const st = t.state || ['estimated', 'estimated', 'estimated'];
        const lin = { r: p.lin.r, g: p.lin.g, b: p.lin.b };
        const hd = [p.hdR, p.hdG, p.hdB];
        const used = [false, false, false];
        for (let c = 0; c < 3; c++) {
          if (st[c] === 'estimated') { lin[chKeys[c]] = t.opaque[c]; hd[c] = Math.exp(t.logHd[c]); used[c] = true; effectiveChannels++; }
          else partialChannels++;
        }
        p.lin = lin;
        p.hdR = hd[0]; p.hdG = hd[1]; p.hdB = hd[2];
        p.hd = (hd[0] + hd[1] + hd[2]) / 3;
        p.tdR = hd[0] * 10; p.tdG = hd[1] * 10; p.tdB = hd[2] * 10; p.td = p.hd * 10;
        p.lab = C.rgb01ToLab({ r: C.linearToSrgb(p.lin.r), g: C.linearToSrgb(p.lin.g), b: C.linearToSrgb(p.lin.b) });
        p.fromModel = used.some(Boolean);
        p.modelChannels = used;
        p.modelState = st.slice();
        covered.push({ id: p.id, name: p.name, state: st.slice(), used });
      }
      foundation = palette[baseIndex];
      const dom = options.opticalModel.compatibilityDomain;
      const crossDomain = (dom && dom.layerHeightMm != null && Math.abs(dom.layerHeightMm - layerHeight) > 1e-6)
        ? { modelLayerHeightMm: dom.layerHeightMm, productionLayerHeightMm: layerHeight } : null;
      opticalModelDiag = { applied: true, source: 'calibrationV2', covered, uncovered, partialChannels, effectiveChannels, crossDomain };
    }

    let flatMask, stds, residual, nearest, stdT, resT;
    const auto = buildFlatMask(lab, w, h, palette, options);
    stds = auto.stds; residual = auto.residual; nearest = auto.nearest; stdT = auto.stdT; resT = auto.resT;
    const flatFillStats = auto.fillStats || { filled: 0, rejected: 0 };
    // With sparse manual locks, always start from this run's automatic
    // segmentation: the override only supplies values at painted pixels, so
    // unpainted pixels follow the current parameters instead of freezing an
    // old full-image snapshot. A full-mask override without locks remains an
    // explicit whole-image mode (used by direct API callers and tests).
    if (options.manualMask && options.manualMask.length === n) flatMask = auto.mask;
    else if (options.maskOverride && options.maskOverride.length === n) flatMask = new Uint8Array(options.maskOverride);
    else flatMask = auto.mask;
    const smoothLevel = clamp(Math.round(Number(options.smoothLevel) || 0), 0, 4);
    const lineMode = (options.lineProtect === 'strong' || options.lineProtect === 'off') ? options.lineProtect : 'auto';
    // Detection is cheap and runs every time: the UI can explain why a
    // sticker got line protection and a photo did not.
    const lineInfo = buildStrokeInfo(lab, alpha, w, h, { pixelSize, lineWidthMm: Number(options.lineWidthMm) || 0.42 });
    const lineActive = lineMode !== 'off' && (lineMode === 'strong' || lineInfo.active);
    lineInfo.applied = lineActive;
    lineInfo.mode = lineMode;
    const edgeCleanRequested = clamp(Math.round(Number(options.edgeClean == null ? 1 : options.edgeClean) || 0), 0, 3);
    let edgeCleanLevel = edgeCleanRequested;
    let edgeMask = null;
    let edgePixelCount = 0;
    let lineProtectMask = lineActive ? new Uint8Array(lineInfo.stroke) : null;
    if (lineActive) for (let i = 0; i < n; i++) if (lineInfo.darkCore[i]) lineProtectMask[i] = 1;
    let lineDirect = null;
    if (lineActive && lineMode === 'strong') {
      lineDirect = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if ((lineInfo.stroke[i] && (lab[i * 3] < 55 || Math.hypot(lab[i * 3 + 1], lab[i * 3 + 2]) >= 12)) || lineInfo.darkCore[i]) lineDirect[i] = 1;
      }
      // Grow by a physical fraction of one line width so a 1 px source outline
      // reaches a stripe the nozzle can actually lay down. The radius is
      // derived from lineWidthMm / pixelSize, not a fixed pixel count.
      const grown = dilate(lineDirect, w, h, lineInfo.radii.growPx);
      for (let i = 0; i < n; i++) {
        if (!lineDirect[i] && grown[i] && lineInfo.ink[i]) lineDirect[i] = 1;
      }
      for (let i = 0; i < n; i++) {
        if (!lineDirect[i]) continue;
        const fi = chooseStrokeFilament(labAt(lab, i), palette);
        if (fi >= 0) nearest[i] = fi;
        else lineDirect[i] = 0;
      }
      // Anti-aliased grey fringe is part of the same stroke, even when its RGB
      // is too far from black to be accepted on its own. Inherit only from a
      // nearby accepted stroke core; never paint arbitrary grey areas black.
      const accepted = new Uint8Array(lineDirect);
      for (let i = 0; i < n; i++) {
        if (lineDirect[i] || !lineInfo.stroke[i] || !lineInfo.ink[i] || lab[i * 3] >= 90) continue;
        const x = i % w, y = (i / w) | 0;
        const votes = new Map();
        const fr = lineInfo.radii.fringeR;
        for (let yy = Math.max(0, y - fr); yy <= Math.min(h - 1, y + fr); yy++) {
          for (let xx = Math.max(0, x - fr); xx <= Math.min(w - 1, x + fr); xx++) {
            const j = yy * w + xx;
            if (!accepted[j]) continue;
            const fi = nearest[j];
            votes.set(fi, (votes.get(fi) || 0) + 1);
          }
        }
        let best = -1, count = 0;
        for (const [fi, c] of votes) if (c > count) { best = fi; count = c; }
        if (best >= 0) { lineDirect[i] = 1; nearest[i] = best; }
      }
      for (let i = 0; i < n; i++) if (lineDirect[i]) lineProtectMask[i] = 1;
    }
    const flatSmoothLevel = smoothParams(smoothLevel, false);
    const familySmoothLevel = smoothParams(smoothLevel, true);
    const lineWidthMm = Number(options.lineWidthMm) || 0.42;
    const smoothMm = options.smoothMm != null ? Math.max(0, Number(options.smoothMm) || 0) : null;
    const physSmooth = smoothMm != null ? physicalSmoothParams(smoothMm, pixelSize) : null;
    const flatSmooth = smoothMm != null
      ? (physSmooth.flatR > 0 ? { r: physSmooth.flatR, passes: physSmooth.passes } : null)
      : flatSmoothLevel;
    if (flatSmooth) {
      flatMask = smoothBinaryMask(flatMask, w, h, flatSmooth.r, flatSmooth.passes,
        lineActive ? lab : null, lineActive ? 11 : 0);
    }
    if (lineDirect) for (let i = 0; i < n; i++) if (lineDirect[i]) flatMask[i] = 1;
    // Manual brush edits win only where the user actually painted; the rest of
    // the image keeps automatic strong-line direct printing.
    let manualPaintPixels = 0;
    if (options.manualMask && options.manualMask.length === n) {
      const src = options.maskOverride && options.maskOverride.length === n ? options.maskOverride : null;
      for (let i = 0; i < n; i++) {
        if (!options.manualMask[i]) continue;
        const wantFlat = src ? !!src[i] : true;
        flatMask[i] = wantFlat ? 1 : 0;
        if (!wantFlat) {
          if (lineDirect) lineDirect[i] = 0;
          if (lineProtectMask) lineProtectMask[i] = 0;
        } else {
          nearest[i] = nearestPalette(labAt(lab, i), palette);
        }
        manualPaintPixels++;
      }
    }

    const startOverride = Math.round(Number(options.gradStartLayerOverride) || 0);
    const topOverride = Number(options.gradTopMmOverride) || 0;
    const requestedColorLayers = colorLayers;
    // P3: equal-height (flat) mode — one common top surface for every retained
    // region; relief is disabled and all regions get exactly N colour layers.
    const equalHeight = engine === 'td' && options.equalHeight === true;
    const geoInput = { engine, flatTopMm, layerHeight, reliefMm: equalHeight ? 0 : reliefMm, colorLayers: requestedColorLayers, baseLayers, startOverride, topOverride };
    let geo = deriveLayerGeometry(geoInput);
    if (equalHeight) {
      const gs = geo.gradStartLayer, N = geo.colorLayers;
      geo = { ...geo, flatLayers: gs + N, flatBaseLayers: gs, flatTopLayers: N, gradTopLayer: gs + N };
    }
    const flatLayers = geo.flatLayers;
    let gradTopLayer = geo.gradTopLayer, gradStartLayer = geo.gradStartLayer;
    colorLayers = geo.colorLayers;
    let maxLayers = Math.max(flatLayers, gradTopLayer);
    // Flat regions share the gradient foundation: the substrate filament fills
    // layers 0..flatBaseLayers-1 and the matched flat colour takes over up to
    // flatLayers. Keep at least one colour layer so the top surface always
    // matches the chosen filament.
    const flatBaseLayers = geo.flatBaseLayers;
    // Flat regions are a real finite stack: foundation below, flat colour
    // above. Predict their top surface with the same optical model as
    // gradients instead of assuming an infinitely thick filament. The
    // foundation is the same infinite backing both paths already use.
    const flatTopLayers = geo.flatTopLayers;
    const flatPred = palette.map((p, fi) => {
      if (engine !== 'td') return { lab: p.lab, hex: p.hex, deltaE: 0 };
      const c = compositeLab(foundation.lin, new Array(flatTopLayers).fill(fi), palette, layerHeight);
      return { lab: c.lab, hex: C.linearToHex(c.lin), deltaE: C.deltaE2000(p.lab, c.lab) };
    });

    let flatCount = flatMask.reduce((a, b) => a + b, 0);
    let gradCount = n - flatCount;
    // On nearly flat line art the gradient core is too small and the edge
    // band would starve the colour sampler. Keep the old behaviour there;
    // edge cleanup is for images with a real gradient area.
    if (edgeCleanRequested > 0 && gradCount >= n * 0.20) {
      edgeCleanLevel = edgeCleanRequested;
      edgeMask = buildEdgeMask(lab, w, h, edgeCleanLevel);
      for (let i = 0; i < n; i++) if (edgeMask[i]) edgePixelCount++;
    } else {
      edgeCleanLevel = 0;
    }
    // Anti-alias transition pixels must never become their own colour families:
    // even with the "edge halo" slider off, snap the 1-px transition band to
    // the adjacent family (line-protected pixels are exempt inside the helper).
    const snapMask = options.edgeSnap === false
      ? null
      : (edgeMask || (gradCount > 0 ? buildEdgeMask(lab, w, h, 1) : null));
    const variableHeight = engine === 'td' && options.variableHeight !== false && !equalHeight;
    const gamut = engine === 'td' && gradCount > 0
      ? buildTdGamut(palette, foundation, layerHeight, colorLayers, variableHeight, equalHeight ? { allowRepeat: true, diverse: true } : undefined)
      : null;
    let families = [];
    let heightMerge = null;
    let vectorInfo = null;
    let mergeResult = { groups: 0, sharedPixels: 0 };
    let structureCleanup = { mergedPixels: 0, mergedComponents: 0, passes: 0, converged: true, minAreaPx: 0, featureMm: 0, edgeOnly: false };
    let cleanupMinAreaPx = 0, cleanupEdgeOnly = false;
    let familyId = new Int16Array(n).fill(-1);
    let predicted = new Array(n);
    let familyPixels = new Uint32Array(0);
    // R3 member-level neutral constraint state (TD gradient branch only).
    let neutralNeed = null, neutralCaches = null;
    const neutralReconcile = { moved: 0, created: 0 };

    if (gradCount > 0) {
      const K = clamp(Math.round(Number(options.families) || 96), 2, 256);
      const samples = sampleGradientLab(lab, flatMask, 12000, edgeMask);
      const familyCenters = kmeansLab(samples, Math.min(K, Math.max(2, Math.floor(samples.length / 6))), 1234567, 10);

      const buildFamilies = (centers) => {
        const fams = [];
        const predLabs = [];
        for (const center of centers) {
          if (engine === 'lut') {
            const m = nearestLut(center, lut);
            const seq = m.recipe.slice().reverse();
            fams.push({
              targetLab: center, targetHex: C.labToHex(center), predictedLab: m.lab, predictedHex: C.labToHex(m.lab),
              recipe: seq, lutIndex: m.index, deltaE: m.deltaE, pixelCount: 0,
              layers: seq.length, topLayer: gradStartLayer + seq.length,
              topMm: (gradStartLayer + seq.length) * layerHeight
            });
            predLabs.push(m.lab);
          } else {
            let opt = gamut ? matchGamut(center, gamut) : null;
            if (!opt) {
              opt = optimizeTdStack(center, palette, foundation, layerHeight, colorLayers);
              opt.length = opt.seq.length;
            }
            fams.push({
              targetLab: center, targetHex: C.labToHex(center), predictedLab: opt.lab, predictedHex: opt.hex,
              recipe: opt.seq, deltaE: opt.deltaE, pixelCount: 0,
              neutralLocked: !!opt.neutralLocked,
              neutral: opt.neutral != null ? opt.neutral : recipeIsNeutral(opt.seq, palette),
              layers: opt.seq.length, topLayer: gradStartLayer + opt.seq.length,
              topMm: (gradStartLayer + opt.seq.length) * layerHeight
            });
            predLabs.push(opt.lab);
          }
        }
        return { fams, predLabs };
      };

      let built = buildFamilies(familyCenters);
      let assigned = assignFamilies(lab, flatMask, built.predLabs, w, h, lineProtectMask);
      familyId = assigned.familyId;
      familyPixels = assigned.counts;

      const refinedCenters = meanLabForFamilies(lab, flatMask, familyId, built.fams.length);
      if (refinedCenters.length >= 2) {
        const built2 = buildFamilies(refinedCenters.map(c => ({ L: c.L, a: c.a, b: c.b })));
        const assigned2 = assignFamilies(lab, flatMask, built2.predLabs, w, h, lineProtectMask);
        families = built2.fams;
        familyId = assigned2.familyId;
        familyPixels = assigned2.counts;
      } else {
        families = built.fams;
      }
      // R3: constrain real source members before any spatial pass can migrate
      // them. Family centers alone miss grey-ramp members that individually
      // satisfy the neutral lock.
      let neutralGuard = null;
      if (engine === 'td' && gamut) {
        neutralCaches = { cellCache: new Map(), exactCache: new Map(), nbCache: new Map() };
        neutralNeed = new Uint8Array(n);
        markNeutralMembers(lab, flatMask, printMask, lineProtectMask, familyId, families, palette, gamut, w, h, neutralNeed, neutralCaches);
        const early = reconcileNeutralMembers(lab, neutralNeed, familyId, families, palette, gamut, gradStartLayer, layerHeight, w, h, neutralCaches.nbCache);
        neutralReconcile.moved += early.moved; neutralReconcile.created += early.created;
        if (early.moved || early.created) {
          familyPixels = new Uint32Array(families.length);
          for (let i = 0; i < n; i++) if (!flatMask[i] && familyId[i] >= 0) familyPixels[familyId[i]]++;
        }
        neutralGuard = { need: neutralNeed, famNeutral: Uint8Array.from(families, f => recipeIsNeutral(f.recipe, palette) ? 1 : 0) };
      }
      const familySmooth = smoothMm != null
        ? (physSmooth.familyR > 0 ? { r: physSmooth.familyR, passes: physSmooth.passes } : null)
        : familySmoothLevel;
      if (familySmooth) {
        familyId = smoothFamilyMap(flatMask, familyId, families.length, families, w, h, familySmooth.r, familySmooth.passes,
          lineActive ? lab : null, lineActive ? 11 : 0, lineActive ? lineProtectMask : null, neutralGuard);
        familyPixels = new Uint32Array(families.length);
        for (let i = 0; i < n; i++) if (!flatMask[i] && familyId[i] >= 0) familyPixels[familyId[i]]++;
      }
      if (options.lineRepair !== false) {
        repairLineGaps(lab, lineInfo, flatMask, nearest, familyId, lineDirect, lineProtectMask, w, h, printMask, families, palette, options.manualMask, stds, stdT);
      }
      const lineDirectFilament = lineDirect ? new Uint16Array(nearest) : null;
      if (snapMask) {
        familyId = snapEdgeFamilies(lab, flatMask, familyId, snapMask, lineProtectMask, families, w, h, Math.max(1, edgeCleanLevel), neutralGuard);
        familyPixels = new Uint32Array(families.length);
        for (let i = 0; i < n; i++) if (!flatMask[i] && familyId[i] >= 0) familyPixels[familyId[i]]++;
      }
      for (let f = 0; f < families.length; f++) families[f].pixelCount = familyPixels[f] || 0;
      if (engine === 'td' && gamut && families.length > 1) {
        refineFamilyRecipes(families, familyId, w, h, gamut, gradStartLayer, layerHeight);
      }
      let vectorConverted = { families: 0, pixels: 0 };
      vectorInfo = vectorConverted;
      if (options.vectorFlat && gradCount > 0) {
        // Vector-like direct colour: a large, colour-uniform region whose mean
        // is already close to a real filament does not need a layer stack.
        // Judge every connected component on its own, so a small island that
        // happens to share a colour family with a large area is not converted
        // just because the family average passes.
        const fc = families.length;
        const pixelAreaMm2 = pixelSize * pixelSize;
        const minAreaMm2 = Math.max(0.4, (lineWidthMm * 2) ** 2 * 1.5);
        const vectorStd = 8;
        const tolDE = Math.max(6, resT + 2);
        const directPi = new Int16Array(fc).fill(-1);
        for (let f = 0; f < fc; f++) {
          if (!families[f].pixelCount) continue;
          // Judge the *top* colour, not the average source patch: a white
          // highlight whose first recipe layer happens to be red/blue should
          // still become direct white.
          const pp = families[f].predictedLab;
          const pi = nearestPalette(pp, palette);
          const de = C.deltaE2000(pp, palette[pi].lab);
          if (de > tolDE || de > families[f].deltaE + 3.0) continue;
          directPi[f] = pi;
        }
        const visited = new Uint8Array(n);
        const stack = new Int32Array(n);
        const cells = new Int32Array(n);
        const touched = new Set();
        let convertedPixels = 0, convertedComponents = 0;
        for (let start = 0; start < n; start++) {
          if (visited[start] || flatMask[start]) continue;
          const f0 = familyId[start];
          if (f0 < 0 || directPi[f0] < 0) continue;
          let top = 0, cnt = 0;
          let sL = 0, sA = 0, sB = 0, qL = 0, qA = 0, qB = 0;
          visited[start] = 1; stack[top++] = start;
          while (top) {
            const idx = stack[--top];
            cells[cnt++] = idx;
            const L = lab[idx * 3], a = lab[idx * 3 + 1], b = lab[idx * 3 + 2];
            sL += L; sA += a; sB += b;
            qL += L * L; qA += a * a; qB += b * b;
            const x = idx % w, y = (idx / w) | 0;
            if (x > 0) { const j = idx - 1; if (!visited[j] && !flatMask[j] && familyId[j] === f0) { visited[j] = 1; stack[top++] = j; } }
            if (x + 1 < w) { const j = idx + 1; if (!visited[j] && !flatMask[j] && familyId[j] === f0) { visited[j] = 1; stack[top++] = j; } }
            if (y > 0) { const j = idx - w; if (!visited[j] && !flatMask[j] && familyId[j] === f0) { visited[j] = 1; stack[top++] = j; } }
            if (y + 1 < h) { const j = idx + w; if (!visited[j] && !flatMask[j] && familyId[j] === f0) { visited[j] = 1; stack[top++] = j; } }
          }
          if (cnt * pixelAreaMm2 < minAreaMm2) continue;
          const vL = Math.max(0, qL / cnt - (sL / cnt) ** 2);
          const vA = Math.max(0, qA / cnt - (sA / cnt) ** 2);
          const vB = Math.max(0, qB / cnt - (sB / cnt) ** 2);
          if (Math.sqrt(vL + vA + vB) > 15) continue;
          const pi = directPi[f0];
          for (let k = 0; k < cnt; k++) {
            const idx = cells[k];
            // A painted gradient lock keeps its recipe even inside a large
            // colour-uniform region that is otherwise vector-converted.
            if (options.manualMask && options.manualMask[idx]) continue;
            flatMask[idx] = 1;
            nearest[idx] = pi;
            familyId[idx] = -1;
          }
          convertedPixels += cnt;
          convertedComponents++;
          touched.add(f0);
        }
        vectorConverted.families = touched.size;
        vectorConverted.components = convertedComponents;
        vectorConverted.pixels = convertedPixels;
        if (convertedPixels) {
          flatCount = 0;
          for (let i = 0; i < n; i++) if (flatMask[i]) flatCount++;
          gradCount = n - flatCount;
          familyPixels = new Uint32Array(families.length);
          for (let i = 0; i < n; i++) if (!flatMask[i] && familyId[i] >= 0) familyPixels[familyId[i]]++;
          for (let f = 0; f < families.length; f++) families[f].pixelCount = familyPixels[f] || 0;
        }
      }
      if (options.vectorFlat) {
        // Vector boundaries need a minimum region size. Merge tiny same-family
        // islands into a large neighbouring region/flat colour so the first
        // recipe layer does not get a fringe of red/blue speckles.
        const minAreaMm2 = (lineWidthMm * 2) ** 2 * 0.9;
        const minAreaPx = Math.max(6, Math.round(minAreaMm2 / (pixelSize * pixelSize)));
        const islands = mergeSmallFamilyComponents(familyId, flatMask, nearest, families, w, h, minAreaPx, edgeMask, lineProtectMask, options.manualMask);
        if (islands.mergedPixels) {
          if (vectorInfo) { vectorInfo.islandsMerged = (vectorInfo.islandsMerged || 0) + 1; vectorInfo.islandPixels = (vectorInfo.islandPixels || 0) + islands.mergedPixels; }
          flatCount = 0;
          for (let i = 0; i < n; i++) if (flatMask[i]) flatCount++;
          gradCount = n - flatCount;
          familyPixels = new Uint32Array(families.length);
          for (let i = 0; i < n; i++) if (!flatMask[i] && familyId[i] >= 0) familyPixels[familyId[i]]++;
          for (let f = 0; f < families.length; f++) families[f].pixelCount = familyPixels[f] || 0;
        }
        // Watershed-style vector boundary: every pixel in a wide anti-alias
        // band is claimed by the nearest *large* region or flat patch. Small
        // edge families no longer get their own recipe, so the first layer
        // has clean borders instead of red/blue speckles.
        const band = buildEdgeMask(lab, w, h, 3);
        if (band) {
          const anchorPx = Math.max(8, Math.round(((lineWidthMm * 2) ** 2) / (pixelSize * pixelSize)));
          const forced = forceVectorBoundaries(lab, flatMask, nearest, familyId, families, palette, w, h, anchorPx, lineProtectMask, band, options.manualMask);
          if (forced) {
            if (vectorInfo) vectorInfo.boundaryPixels = (vectorInfo.boundaryPixels || 0) + forced;
            flatCount = 0;
            for (let i = 0; i < n; i++) if (flatMask[i]) flatCount++;
            gradCount = n - flatCount;
            familyPixels = new Uint32Array(families.length);
            for (let i = 0; i < n; i++) if (!flatMask[i] && familyId[i] >= 0) familyPixels[familyId[i]]++;
            for (let f = 0; f < families.length; f++) families[f].pixelCount = familyPixels[f] || 0;
            // One more conservative island pass for leftovers.
            const leftovers = mergeSmallFamilyComponents(familyId, flatMask, nearest, families, w, h, anchorPx, band, lineProtectMask, options.manualMask);
            if (vectorInfo && leftovers.mergedPixels) {
              vectorInfo.islandsMerged = (vectorInfo.islandsMerged || 0) + 1;
              vectorInfo.islandPixels = (vectorInfo.islandPixels || 0) + leftovers.mergedPixels;
            }
            flatCount = 0;
            for (let i = 0; i < n; i++) if (flatMask[i]) flatCount++;
            gradCount = n - flatCount;
            familyPixels = new Uint32Array(families.length);
            for (let i = 0; i < n; i++) if (!flatMask[i] && familyId[i] >= 0) familyPixels[familyId[i]]++;
            for (let f = 0; f < families.length; f++) families[f].pixelCount = familyPixels[f] || 0;
          }
        }
      }
      // Edge snapping and vector boundary growth are deliberately local and
      // pixel-by-pixel, so they can recreate one-pixel recipe islands after
      // the first smoothing pass. Finish with the same physical-radius vote;
      // protected strokes still vote only within the stroke, never with paper.
      if (familySmooth && (edgeMask || options.vectorFlat)) {
        if (neutralGuard) neutralGuard.famNeutral = Uint8Array.from(families, f => recipeIsNeutral(f.recipe, palette) ? 1 : 0);
        familyId = smoothFamilyMap(flatMask, familyId, families.length, families, w, h, familySmooth.r, familySmooth.passes,
          lineActive ? lab : null, lineActive ? 11 : 0, lineActive ? lineProtectMask : null, neutralGuard);
        familyPixels = new Uint32Array(families.length);
        for (let i = 0; i < n; i++) if (!flatMask[i] && familyId[i] >= 0) familyPixels[familyId[i]]++;
        for (let f = 0; f < families.length; f++) families[f].pixelCount = familyPixels[f] || 0;
      }
      if (options.vectorFlat) {
        // Round, weighted neighbourhood voting smooths actual colour-region
        // contours after edge/vector reassignment, without touching background
        // or allowing paper neighbours to cut into a protected stroke.
        const contourRadius = clamp((smoothMm > 0 ? physSmooth.flatR : 0) || Math.max(1, Math.round(lineWidthMm / pixelSize)), 1, 4);
        const changed = smoothUnifiedRegions(flatMask, nearest, familyId, printMask, w, h, contourRadius, lineActive ? lineProtectMask : null, lab, families, palette, options.manualMask);
        if (vectorInfo) vectorInfo.contourPixels = (vectorInfo.contourPixels || 0) + changed;
        flatCount = 0;
        familyPixels = new Uint32Array(families.length);
        for (let i = 0; i < n; i++) {
          if (!printMask[i]) continue;
          if (flatMask[i]) flatCount++;
          else if (familyId[i] >= 0) familyPixels[familyId[i]]++;
        }
        gradCount = n - flatCount;
        for (let f = 0; f < families.length; f++) families[f].pixelCount = familyPixels[f] || 0;
      }
      const physicalCleanup = smoothMm > 0 && physSmooth.familyR > 0;
      const cleanupFeatureMm = Math.max(
        physicalCleanup ? lineWidthMm * 2 : 0,
        options.vectorFlat ? lineWidthMm * 2 : 0,
        edgeCleanLevel > 0 ? lineWidthMm * 2 : 0
      );
      if (cleanupFeatureMm > 0) {
        // A circular feature of diameter D has area π(D/2)². Use that physical
        // area for isolated-region cleanup; majority smoothing alone cannot
        // guarantee a minimum connected component, especially at mask edges.
        const minAreaPx = Math.max(2, Math.round(Math.PI * (cleanupFeatureMm / 2) ** 2 / (pixelSize * pixelSize)));
        const edgeOnly = !physicalCleanup && !options.vectorFlat && edgeCleanLevel > 0 && edgeCleanLevel < 3;
        cleanupMinAreaPx = minAreaPx; cleanupEdgeOnly = edgeOnly;
        structureCleanup = mergeSmallRegions(flatMask, nearest, familyId, lab, families, palette, w, h, minAreaPx, edgeOnly ? edgeMask : null, lineProtectMask, options.manualMask);
        structureCleanup.minAreaPx = minAreaPx;
        structureCleanup.featureMm = cleanupFeatureMm;
        structureCleanup.edgeOnly = edgeOnly;
        if (structureCleanup.mergedPixels) {
          flatCount = 0;
          familyPixels = new Uint32Array(families.length);
          for (let i = 0; i < n; i++) {
            if (flatMask[i]) flatCount++;
            else if (familyId[i] >= 0) familyPixels[familyId[i]]++;
          }
          gradCount = n - flatCount;
          for (let f = 0; f < families.length; f++) families[f].pixelCount = familyPixels[f] || 0;
          if (lineDirect) for (let i = 0; i < n; i++) {
            if (!flatMask[i] || nearest[i] !== lineDirectFilament[i]) lineDirect[i] = 0;
          }
        }
      }
      if (engine === 'td' && gamut && Number(options.mergeDeltaE) > 0) {
        const familyAdj = buildFamilyAdjacency(familyId, w, h, families.length);
        mergeResult = mergeCommonBases(families, gamut, Number(options.mergeDeltaE), colorLayers, familyAdj);
        for (const f of families) {
          if (!f.pixelCount) continue;
          f.topLayer = gradStartLayer + f.recipe.length;
          f.topMm = (gradStartLayer + f.recipe.length) * layerHeight;
        }
      }
      // User height is an upper bound. A family is never lifted just to touch
      // the requested top: colour, coverage and layer structure stay as chosen
      // by the constrained matcher.
      let heightMergeLocal = null;
      if (engine === 'td' && variableHeight) {
        const hmDE = options.heightMergeDeltaE == null ? 1.5 : Number(options.heightMergeDeltaE);
        heightMergeLocal = mergeIneffectiveHeights(families, familyId, hmDE, 4);
        heightMerge = heightMergeLocal;
        if (heightMergeLocal.changed || heightMergeLocal.groups) {
          familyPixels = new Uint32Array(families.length);
          for (let i = 0; i < n; i++) if (!flatMask[i] && familyId[i] >= 0) familyPixels[familyId[i]]++;
          for (let f = 0; f < families.length; f++) families[f].pixelCount = familyPixels[f] || 0;
          let shared = 0;
          for (const f of families) if (f.pixelCount > 0 && f.sharedBaseLayers >= 2) shared += f.pixelCount;
          mergeResult.sharedPixels = shared;
        }
      }
      // R3 safety net: shared bases, small-region merging, vector conversion and
      // height dedup can still migrate a constrained member onto another recipe.
      // Re-mark against the final families and snap every demanded source pixel
      // back to its exact best neutral candidate before the preview is assembled.
      if (engine === 'td' && gamut && neutralNeed) {
        markNeutralMembers(lab, flatMask, printMask, lineProtectMask, familyId, families, palette, gamut, w, h, neutralNeed, neutralCaches);
        const late = reconcileNeutralMembers(lab, neutralNeed, familyId, families, palette, gamut, gradStartLayer, layerHeight, w, h, neutralCaches.nbCache);
        neutralReconcile.moved += late.moved; neutralReconcile.created += late.created;
        if (late.moved || late.created) {
          // The member reassignment can recreate sub-nozzle islands after the main
          // cleanup already ran; re-converge with the same physical minimum area so
          // an isolated neutral speckle is absorbed instead of surviving as a 1-px
          // region. Large coherent neutral regions are above the minimum and stay.
          if (cleanupMinAreaPx > 1) {
            const again = mergeSmallRegions(flatMask, nearest, familyId, lab, families, palette, w, h, cleanupMinAreaPx, cleanupEdgeOnly ? edgeMask : null, lineProtectMask, options.manualMask);
            structureCleanup.mergedPixels += again.mergedPixels;
            structureCleanup.mergedComponents += again.mergedComponents;
            structureCleanup.passes += again.passes;
            structureCleanup.converged = structureCleanup.converged && again.converged;
            if (again.mergedPixels && lineDirect) for (let i = 0; i < n; i++) {
              if (!flatMask[i] || nearest[i] !== lineDirectFilament[i]) lineDirect[i] = 0;
            }
          }
          familyPixels = new Uint32Array(families.length);
          flatCount = 0;
          for (let i = 0; i < n; i++) {
            if (!printMask[i]) continue;
            if (flatMask[i]) flatCount++;
            else if (familyId[i] >= 0) familyPixels[familyId[i]]++;
          }
          gradCount = n - flatCount;
          for (let f = 0; f < families.length; f++) families[f].pixelCount = familyPixels[f] || 0;
        }
      }
      for (const f of families) {
        if (!f.pixelCount) continue;
        f.topLayer = gradStartLayer + f.recipe.length;
        f.topMm = (gradStartLayer + f.recipe.length) * layerHeight;
      }
      for (let i = 0; i < n; i++) {
        if (flatMask[i]) {
          const fp = flatPred[nearest[i]] || { lab: palette[nearest[i]].lab, hex: palette[nearest[i]].hex };
          predicted[i] = { lab: fp.lab, hex: fp.hex, filamentIndex: nearest[i] };
        }
        else { const f = familyId[i]; const fam = families[f]; predicted[i] = { lab: fam.predictedLab, hex: fam.predictedHex, family: f }; }
      }
    } else {
      // Even an all-flat plan can contain isolated direct-colour pixels (most
      // visibly after a manual mask override). Apply the same nozzle-scale
      // island cleanup here instead of skipping it with the gradient branch.
      if (smoothMm > 0 && physSmooth.familyR > 0) {
        // Same stage as the gradient branch: snapshot the line material right
        // before cleanup so the consistency check below can revoke direct bits
        // whose filament cleanup changed. The gradient branch keeps its own
        // snapshot after gap repair; this branch never repairs, so the current
        // nearest array is the correct pre-cleanup state.
        const lineDirectFilament = lineDirect ? new Uint16Array(nearest) : null;
        const featureMm = lineWidthMm * 2;
        const minAreaPx = Math.max(2, Math.round(Math.PI * (featureMm / 2) ** 2 / (pixelSize * pixelSize)));
        structureCleanup = mergeSmallRegions(flatMask, nearest, familyId, lab, families, palette, w, h, minAreaPx, null, lineProtectMask, options.manualMask);
        structureCleanup.minAreaPx = minAreaPx;
        structureCleanup.featureMm = featureMm;
        flatCount = 0;
        for (let i = 0; i < n; i++) if (flatMask[i]) flatCount++;
        gradCount = n - flatCount;
        if (lineDirect) for (let i = 0; i < n; i++) {
          if (!flatMask[i] || nearest[i] !== lineDirectFilament[i]) lineDirect[i] = 0;
        }
      }
      for (let i = 0; i < n; i++) {
        const fp = flatPred[nearest[i]] || { lab: palette[nearest[i]].lab, hex: palette[nearest[i]].hex };
        predicted[i] = { lab: fp.lab, hex: fp.hex, filamentIndex: nearest[i] };
      }
    }

    const flatFilament = new Uint16Array(n);
    flatFilament.fill(0xffff);
    for (let i = 0; i < n; i++) if (flatMask[i]) flatFilament[i] = nearest[i];

    if (background.enabled && background.envelope && !background.failed) {
      // Envelope additions are structural support, not extra artwork. Keep them
      // at the shared foundation height (gradStartLayer), with no family recipe
      // above. Original foreground pixels retain every colour and every height;
      // bridges and closing strips can therefore never become tall white walls.
      for (let i = 0; i < n; i++) {
        if (!printMask[i] || sourcePrintMask[i]) continue;
        flatMask[i] = 0;
        nearest[i] = baseIndex;
        familyId[i] = -1;
        flatFilament[i] = 0xffff;
        predicted[i] = { lab: foundation.lab, hex: foundation.hex, filamentIndex: baseIndex, supportOnly: true };
      }
    }

    const isEnvelopeSupport = (i) => background.enabled && background.envelope && !background.failed && printMask[i] && !sourcePrintMask[i];
    // Spatial regions: connected components of the same recipe family. Recipe
    // sharing may be global, but geometry, cleaning and audits speak in regions.
    const regionId = new Int32Array(n).fill(-1);
    let regionCount = 0;
    {
      const seen = new Uint8Array(n);
      const stack = new Int32Array(n);
      for (let start = 0; start < n; start++) {
        if (seen[start] || flatMask[start] || !printMask[start]) continue;
        const f = familyId[start];
        if (f < 0) continue;
        const id = regionCount++;
        let top = 0;
        seen[start] = 1; regionId[start] = id; stack[top++] = start;
        while (top) {
          const idx = stack[--top];
          const x = idx % w, y = (idx / w) | 0;
          if (x > 0) { const j = idx - 1; if (!seen[j] && !flatMask[j] && printMask[j] && familyId[j] === f) { seen[j] = 1; regionId[j] = id; stack[top++] = j; } }
          if (x + 1 < w) { const j = idx + 1; if (!seen[j] && !flatMask[j] && printMask[j] && familyId[j] === f) { seen[j] = 1; regionId[j] = id; stack[top++] = j; } }
          if (y > 0) { const j = idx - w; if (!seen[j] && !flatMask[j] && printMask[j] && familyId[j] === f) { seen[j] = 1; regionId[j] = id; stack[top++] = j; } }
          if (y + 1 < h) { const j = idx + w; if (!seen[j] && !flatMask[j] && printMask[j] && familyId[j] === f) { seen[j] = 1; regionId[j] = id; stack[top++] = j; } }
        }
      }
    }
    let supportOnlyPixels = 0;
    for (let i = 0; i < n; i++) if (isEnvelopeSupport(i)) supportOnlyPixels++;

    // From this point onward all physical quantities describe only the
    // printable silhouette. Colour recipes remain available for removed pixels
    // so no array becomes structurally invalid, but they no longer contribute
    // material, statistics, height, or exported geometry.
    flatCount = 0; gradCount = 0;
    familyPixels = new Uint32Array(families.length);
    for (let i = 0; i < n; i++) {
      if (!printMask[i]) { flatFilament[i] = 0xffff; continue; }
      if (flatMask[i]) flatCount++;
      else if (!isEnvelopeSupport(i)) {
        gradCount++;
        if (familyId[i] >= 0) familyPixels[familyId[i]]++;
      }
    }
    for (let f = 0; f < families.length; f++) families[f].pixelCount = familyPixels[f] || 0;

    const preview = new Uint8ClampedArray(n * 4);
    let sumDE = 0, sumDE2 = 0, maxDE = 0;
    let flatBadPixels = 0, flatMaxDE = 0;
    const groupStats = {
      line: { pixels: 0, sum: 0, max: 0, hist: new Uint32Array(101) },
      flat: { pixels: 0, sum: 0, max: 0, hist: new Uint32Array(101) },
      gradient: { pixels: 0, sum: 0, max: 0, hist: new Uint32Array(101) }
    };
    const hist = new Uint32Array(101);
    let under2 = 0, under5 = 0, under10 = 0, validPixels = 0, colorStatPixels = 0;
    for (let i = 0; i < n; i++) {
      if (!printMask[i]) continue; // alpha remains zero: no printed background
      validPixels++;
      if (isEnvelopeSupport(i)) {
        const rgb = C.hexToRgb(predicted[i].hex);
        preview[i * 4] = rgb.r; preview[i * 4 + 1] = rgb.g; preview[i * 4 + 2] = rgb.b; preview[i * 4 + 3] = 255;
        continue; // support is real material, but not a colour recipe sample
      }
      colorStatPixels++;
      if (flatMask[i] && engine === 'td') {
        const fd = flatPred[nearest[i]] ? flatPred[nearest[i]].deltaE : 0;
        if (fd > 3) flatBadPixels++;
        if (fd > flatMaxDE) flatMaxDE = fd;
      }
      const de = C.deltaE2000(labAt(lab, i), predicted[i].lab);
      const groupName = (lineDirect && lineDirect[i]) ? 'line' : flatMask[i] ? 'flat' : 'gradient';
      const gs = groupStats[groupName];
      gs.pixels++; gs.sum += de; if (de > gs.max) gs.max = de; gs.hist[Math.min(100, Math.round(de))]++;
      sumDE += de; sumDE2 += de * de; if (de > maxDE) maxDE = de;
      hist[Math.min(100, Math.round(de))]++;
      if (de <= 2) under2++; if (de <= 5) under5++; if (de <= 10) under10++;
      const rgb = C.hexToRgb(predicted[i].hex);
      preview[i * 4] = rgb.r; preview[i * 4 + 1] = rgb.g; preview[i * 4 + 2] = rgb.b; preview[i * 4 + 3] = 255;
    }
    let meanDE = colorStatPixels ? sumDE / colorStatPixels : 0;
    let cum = 0, p90 = 0, median = 0;
    for (let d = 0; d <= 100; d++) {
      cum += hist[d];
      if (!median && cum >= colorStatPixels * 0.5) median = d;
      if (!p90 && cum >= colorStatPixels * 0.9) { p90 = d; break; }
    }

    const maxFamilyLayers = families.reduce((m, f) => Math.max(m, f.pixelCount > 0 ? f.recipe.length : 0), 0);
    const actualGradTopLayer = gradCount > 0 ? gradStartLayer + maxFamilyLayers : flatLayers;
    gradTopLayer = gradCount > 0 ? Math.max(gradStartLayer, actualGradTopLayer) : flatLayers;
    const actualRelief = (gradTopLayer - flatLayers) * layerHeight;
    maxLayers = Math.max(flatLayers, gradTopLayer, supportOnlyPixels ? gradStartLayer : 0);

    const grams = new Float64Array(palette.length);
    const pixelArea = pixelSize * pixelSize;
    let flatPixels = 0, gradPixels = 0;
    for (let i = 0; i < n; i++) {
      if (!printMask[i]) continue;
      if (isEnvelopeSupport(i)) {
        grams[baseIndex] += pixelArea * gradStartLayer * layerHeight / 1000 * 1.24;
        continue;
      }
      if (flatMask[i]) {
        flatPixels++;
        if (flatBaseLayers > 0) grams[baseIndex] += pixelArea * flatBaseLayers * layerHeight / 1000 * 1.24;
        if (flatLayers > flatBaseLayers) grams[flatFilament[i]] += pixelArea * (flatLayers - flatBaseLayers) * layerHeight / 1000 * 1.24;
      } else {
        gradPixels++;
        grams[baseIndex] += pixelArea * gradStartLayer * layerHeight / 1000 * 1.24;
        const f = familyId[i];
        if (f >= 0) {
          const seq = families[f].recipe;
          for (let l = 0; l < seq.length; l++) grams[seq[l]] += pixelArea * layerHeight / 1000 * 1.24;
        }
      }
    }
    let toolChanges = 0;
    const layerFilaments = new Array(maxLayers);
    for (let z = 0; z < maxLayers; z++) {
      const set = new Set();
      if (z < flatBaseLayers) { if (flatCount > 0) set.add(baseIndex); }
      else if (z < flatLayers) for (let i = 0; i < n; i++) if (printMask[i] && flatMask[i]) set.add(flatFilament[i]);
      if (z < gradStartLayer) { if (gradCount > 0 || supportOnlyPixels > 0) set.add(baseIndex); }
      else if (z < gradTopLayer) {
        const li = z - gradStartLayer;
        for (let i = 0; i < n; i++) {
          if (!printMask[i] || flatMask[i]) continue;
          const f = familyId[i];
          if (f >= 0 && li < families[f].recipe.length) set.add(families[f].recipe[li]);
        }
      }
      layerFilaments[z] = Array.from(set);
      toolChanges += Math.max(0, set.size - 1);
    }

    // Support audit: every layer must be a subset of the previous footprint.
    // A new pixel at z>0 is a real unsupported island (an overhang), not just
    // a colour boundary. This lets the UI prove that the multi-part 3MF has no
    // floating geometry even when a slicer's per-part checker complains.
    let supportAddedPixels = 0;
    const supportAddedLayers = [];
    {
      const prev = new Uint8Array(n);
      const cur = new Uint8Array(n);
      for (let z = 0; z < maxLayers; z++) {
        for (let i = 0; i < n; i++) {
          let on = 0;
          if (flatMask[i]) on = z < flatLayers ? 1 : 0;
          else if (z < gradStartLayer) on = 1;
          else {
            const f = familyId[i];
            on = f >= 0 && (z - gradStartLayer) < families[f].recipe.length ? 1 : 0;
          }
          cur[i] = printMask[i] ? on : 0;
        }
        if (z > 0) {
          let added = 0;
          for (let i = 0; i < n; i++) if (cur[i] && !prev[i]) added++;
          if (added) {
            supportAddedPixels += added;
            if (supportAddedLayers.length < 12) supportAddedLayers.push(z);
          }
        }
        prev.set(cur);
      }
    }

    const foundationOpacity = stackTransmission(gradStartLayer * layerHeight, foundation.hd);
    let outGamutPixels = 0;
    for (let i = 0; i < n; i++) {
      if (!printMask[i] || flatMask[i]) continue;
      const f = familyId[i];
      if (f >= 0 && families[f].deltaE > 8) outGamutPixels++;
    }
    const gamutGaps = families
      .filter(f => f.pixelCount > 0 && f.deltaE > 8)
      .sort((a, b) => b.pixelCount - a.pixelCount)
      .slice(0, 3)
      .map(f => ({
        targetHex: f.targetHex, predictedHex: f.predictedHex, pixelCount: f.pixelCount,
        deltaE: +f.deltaE.toFixed(2), suggested: suggestFilamentForLab(f.targetLab, palette)
      }));
    const outOfGamutPercent = gradCount > 0 ? outGamutPixels / gradCount * 100 : 0;
    const sensBg = foundation ? foundation.lin : { r: 1, g: 1, b: 1 };
    let sensWorst = 0, sensHex = null, sensOver5 = 0;
    for (const f of families) {
      if (!f.pixelCount || !f.recipe || !f.recipe.length) continue;
      const se = recipeSensitivity(f.recipe, palette, sensBg, layerHeight, 0.1);
      f.sensitivity = +se.toFixed(2);
      if (se > sensWorst) { sensWorst = se; sensHex = f.targetHex; }
      if (se > 5) sensOver5++;
    }
    const groupSummary = (gs) => {
      let cum = 0, p90 = 0;
      for (let d = 0; d <= 100; d++) { cum += gs.hist[d]; if (cum >= gs.pixels * 0.9) { p90 = d; break; } }
      return {
        pixels: gs.pixels,
        meanDE: gs.pixels ? +(gs.sum / gs.pixels).toFixed(2) : 0,
        p90,
        maxDE: +gs.max.toFixed(2)
      };
    };
    let neutralAudit = null;
    if (engine === 'td' && gamut && neutralCaches) {
      neutralAudit = auditNeutralMembers(lab, flatMask, printMask, lineProtectMask, familyId, families, palette, gamut, w, h, neutralCaches);
      neutralAudit.reconciledPixels = neutralReconcile.moved;
      neutralAudit.memberFamilies = neutralReconcile.created;
    }
    const diagnostics = {
      opticalModel: opticalModelDiag,
      sensitivity: { frac: 0.1, worstDE: +sensWorst.toFixed(2), worstHex: sensHex, familiesOver5: sensOver5 },
      fill: { filledPixels: flatFillStats.filled, rejectedPixels: flatFillStats.rejected },
      manualPixels: manualPaintPixels,
      regions: { count: regionCount },
      neutralAudit,
      printAudit: auditPrintLayers(lab, w, h, {
        pixelSize, lineWidthMm: Number(options.lineWidthMm) || 0.42,
        printMask, flatMask, flatFilament, familyId, families,
        flatBaseLayers, flatLayers, gradStartLayer, foundationIndex: baseIndex, maxLayers
      }),
      coverage: {
        topLayers: flatTopLayers,
        baseLayers: flatBaseLayers,
        badPixels: flatBadPixels,
        maxDE: +flatMaxDE.toFixed(2)
      },
      groups: {
        line: groupSummary(groupStats.line),
        flat: groupSummary(groupStats.flat),
        gradient: groupSummary(groupStats.gradient)
      }
    };
    const warnings = [];
    if (opticalModelDiag) {
      const om = opticalModelDiag;
      if (om.uncovered.length) warnings.push(`标定模型未覆盖 ${om.uncovered.length} 种耗材（${om.uncovered.map(u => u.name || u.id).join('、')}），这些仍用库值 TD；请确认材料 ID 匹配或补标定。`);
      if (om.crossDomain) warnings.push(`标定模型跨域使用：模型适用层高 ${om.crossDomain.modelLayerHeightMm} mm，当前生产层高 ${om.crossDomain.productionLayerHeightMm} mm；预测可能偏差，建议在同层高重标定。`);
      if (om.partialChannels) warnings.push(`标定模型有 ${om.partialChannels} 个通道仅界限(bounded)或无信息(unresolved)，已保留库值不当点参数；这些通道预测仍依赖库 TD。`);
    }
    if (diagnostics.sensitivity.familiesOver5 > 0) {
      warnings.push(`模型敏感度：${diagnostics.sensitivity.familiesOver5} 个渐变配方在 ±10% HD 情景下色差 >5 ΔE（最大 ${diagnostics.sensitivity.worstDE}，目标 ${diagnostics.sensitivity.worstHex}）。这是仿真情景，不是实测区间；可在这些区域降低透明料层数或补充标定。`);
    }
    if (diagnostics.printAudit.belowMinIslands > 0) {
      warnings.push(`逐层小岛审计：${diagnostics.printAudit.belowMinIslands} 个小于 ${diagnostics.printAudit.minAreaMm2} mm² 的孤立材料块（第 ${diagnostics.printAudit.worstLayer} 层最多 ${diagnostics.printAudit.worstIslands} 个，${diagnostics.printAudit.stride > 1 ? '按 1/' + diagnostics.printAudit.stride + ' 采样' : '全分辨率'}）；可能打不出来或依赖支撑，切片预览请核对。`);
    }
    if (engine === 'lut' && flatTopMm < (baseLayers + colorLayers) * layerHeight - 1e-6) {
      warnings.push(`纯色区高度低于 LUT 需要的 ${((baseLayers + colorLayers) * layerHeight).toFixed(2)} mm，渐变区会自动抬高。`);
    }
    if (engine === 'td' && gradStartLayer * layerHeight < foundation.hd * Math.log10(20)) {
      warnings.push(`渐变区基底 ${(gradStartLayer * layerHeight).toFixed(2)} mm 可能不足以遮住底色（建议 ≥ ${(foundation.hd * Math.log10(20)).toFixed(2)} mm）。`);
    }
    if (flatCount === 0) warnings.push('没有识别出纯色区，整幅画都会使用层叠渐变。可降低“平整阈值”或增加纯色区耗材。');
    if (flatCount === n) warnings.push('整幅画都被识别为纯色区。可提高“平整阈值”或降低残差阈值。');
    if (engine === 'td' && flatBadPixels > Math.max(2, flatCount * 0.05)) {
      const pct = (flatBadPixels / Math.max(1, flatCount) * 100).toFixed(0);
      const topMm = (flatTopLayers * layerHeight).toFixed(2);
      const baseMm = (flatBaseLayers * layerHeight).toFixed(2);
      const totalMm = (flatLayers * layerHeight).toFixed(2);
      // R8: only advise operations that actually thicken the colour cap for THIS
      // geometry. Probe the real derivation instead of assuming "raise flatTopMm"
      // helps — in the default coupled path it lifts the shared foundation by the
      // same amount and leaves flatTopLayers (and the predicted colour) unchanged.
      const probe = over => deriveLayerGeometry({ ...geoInput, ...over }).flatTopLayers;
      const raisedGeo = deriveLayerGeometry({ ...geoInput, flatTopMm: flatTopMm + 1.6 });
      const moreColor = probe({ colorLayers: requestedColorLayers + 2 });
      const lessRelief = probe({ reliefMm: Math.max(0, reliefMm - 0.08) });
      const tips = [];
      if (moreColor > flatTopLayers) tips.push(`增加渐变层数（+2 层 → 盖色 ${moreColor} 层）`);
      if (lessRelief > flatTopLayers) tips.push(`降低浮雕差（盖色 ${lessRelief} 层）`);
      if (raisedGeo.flatTopLayers > flatTopLayers) tips.push(`提高纯色区顶高（盖色 ${raisedGeo.flatTopLayers} 层）`);
      let advice;
      if (raisedGeo.flatTopLayers <= flatTopLayers) {
        advice = `注意：当前几何下提高纯色区顶高只会同步抬高基底（${flatBaseLayers}→${raisedGeo.flatBaseLayers} 层），盖色厚度不变，不能改善颜色。`;
        advice += tips.length ? '有效操作：' + tips.join('；') + '；或换更不透明的基底耗材。' : '请换更不透明的基底耗材。';
      } else {
        advice = '有效操作：' + tips.join('；') + '；或换更不透明的基底耗材。';
      }
      warnings.push(`纯色区顶色只有 ${flatTopLayers} 层/${topMm} mm（基底 ${flatBaseLayers} 层/${baseMm} mm，纯色区总高 ${flatLayers} 层/${totalMm} mm）：约 ${pct}% 纯色像素实际遮盖后与所选耗材偏差 >3 ΔE（最大 ${flatMaxDE.toFixed(1)}）。${advice}`);
    }
    if (neutralAudit && neutralAudit.budgetUnmet > 0) {
      warnings.push(`中性色风险：${neutralAudit.budgetUnmet} 个源中性渐变像素没有落在 +5 ΔE 预算内的黑白叠层，仍用彩色配方叠色，灰阶可能偏色；可加入更中性或更不透明的耗材、或提高渐变层数改善。`);
    }
    if (palette.length > 4) warnings.push(`当前使用 ${palette.length} 个耗材槽位；单 AMS 只有 4 槽，需要多 AMS 或中途换料。`);
    if (outOfGamutPercent > 5 && gamutGaps.length) {
      const g = gamutGaps[0];
      const hint = g.suggested ? `；可加入 ${g.suggested.brand} ${g.suggested.name}（${g.suggested.hex}，ΔE≈${g.suggested.deltaE.toFixed(1)}）` : '';
      warnings.push(`当前 ${palette.length} 色无法覆盖约 ${outOfGamutPercent.toFixed(0)}% 的渐变像素（ΔE>8）${hint}。`);
    }
    if (engine === 'td' && variableHeight) warnings.push('渐变区按配方长度自然形成阶梯浮雕；“浮雕差”显示的是最高差，不是所有色块都同高。');
    if (lineInfo.active && lineMode === 'off') {
      warnings.push(`检测到线稿（细线 ${(lineInfo.strokeFraction * 100).toFixed(1)}%）：0–2 px 的线条可能被平滑吃掉；可在“区域策略”开启线稿保护。`);
    } else if (lineActive && lineMode === 'strong') {
      warnings.push('线稿保护·强：深色及高彩度细线按合适耗材直印，并与纯色区同高；相邻渐变区可能略高于线条。');
    }
    if (heightMerge && (heightMerge.changed || heightMerge.groups)) {
      const bits = [];
      if (heightMerge.changed) bits.push(`${heightMerge.changed} 个色族改用更短配方`);
      if (heightMerge.groups) bits.push(`${heightMerge.groups} 个重复色族合并`);
      const save = heightMerge.oldMax > heightMerge.newMax ? `，最高 ${heightMerge.oldMax}→${heightMerge.newMax} 层` : '';
      warnings.push(`高度去重：${bits.join('、')}${save}；相同/近似预测色不再为了不可见色差叠高。`);
    }
    if (edgeCleanRequested > 0 && edgeCleanLevel === 0) {
      warnings.push('边缘光晕清理已跳过：渐变区不足 20%，避免把细线和小面积细节吃掉。可提高渐变区比例或把该滑块调低。');
    } else if (edgeCleanLevel >= 3) {
      warnings.push('边缘光晕清理·强 3：扩大边缘带并清理全图喷嘴级孤岛，模拟成画可能变脏/偏色；建议先用 1–2 档。');
    }
    if (background.enabled) {
      if (background.failed) warnings.push('背景识别覆盖了整幅图，已自动放弃移除；请降低容差或重新取色。');
      else if (!background.removedPixels) warnings.push(`未发现与边界连通的背景色 ${background.colorHex}；轮廓保持完整矩形。`);
      else warnings.push(`背景移除：${background.colorHex}，ΔE≤${background.tolerance}，移除 ${(background.removedPixels / n * 100).toFixed(1)}% 画面，所有层均无背景材料${background.envelope ? `；包络后 ${background.componentsAfter} 个连通实体${background.bridges ? `，${background.bridges} 处低层桥接` : ''}；新增区域仅作基础支撑` : ''}。`);
    }
    if (supportAddedPixels > 0) {
      warnings.push(`悬空检查：第 ${supportAddedLayers.join('、')} 层新增 ${supportAddedPixels} 个无下层支撑的像素，建议开启支撑或检查掩膜。`);
    }
    if (options.vectorFlat && vectorInfo && vectorInfo.families > 0) {
      warnings.push(`矢量化色块直印：${vectorInfo.families} 个色族、约 ${(vectorInfo.pixels / n * 100).toFixed(1)}% 像素改为整块纯色${vectorInfo.islandPixels ? `，清理 ${vectorInfo.islandPixels} px 边缘小岛、归并 ${vectorInfo.boundaryPixels || 0} px 边界` : ''}${vectorInfo.contourPixels ? `，轮廓平滑 ${vectorInfo.contourPixels} px` : ''}；这些区域会统一到纯色区顶高。`);
    }
    if (smoothMm != null && smoothMm > 0) {
      if (physSmooth.familyR === 0) warnings.push(`平滑尺寸 ${smoothMm.toFixed(2)} mm 在当前分辨率下不足 1 像素，平滑不会生效；可提高画稿分辨率或降低成品宽度。`);
      else if (smoothMm < lineWidthMm) warnings.push(`平滑尺寸 ${smoothMm.toFixed(2)} mm 小于喷嘴线宽 ${lineWidthMm.toFixed(2)} mm，小于喷嘴的细节可能打不出来；建议 ≥ ${lineWidthMm.toFixed(2)} mm。`);
    }
    const lineDirectCount = lineDirect ? lineDirect.reduce((a, b) => a + b, 0) : 0;
    let sharedBasePixels = 0;
    for (let i = 0; i < n; i++) {
      if (!printMask[i] || flatMask[i]) continue;
      const f = familyId[i];
      if (f >= 0 && families[f].sharedBaseLayers >= 2) sharedBasePixels++;
    }

    // P4 integration: equal-height + continuity policy -> spatial same-layer
    // coordination over a frozen baseline. Heights are fixed (equal-height), so the
    // optimizer only swaps near-color stacks to reduce internal material boundary.
    let regionOf = null, regionRecipes = null, coordination = null;
    if (equalHeight && options.layerCoordination && CS.layerOptimizer && gamut) {
      const budget = options.qualityPolicy === 'continuity' ? 2.0 : 1.0;
      const graph = CS.layerOptimizer.buildRegionGraph({ n, w, h, printMask, flatMask, flatFilament, familyId }, pixelSize, options.manualMask);
      const N = colorLayers;
      const regs = graph.regions.map(r => {
        const m0 = r.members[0];
        const cur = flatMask[m0] ? new Array(N).fill(flatFilament[m0]) : (familyId[m0] >= 0 ? families[familyId[m0]].recipe.slice() : new Array(N).fill(baseIndex));
        let locked = !!r.locked;
        let sL = 0, sA = 0, sB = 0;
        for (const i of r.members) {
          if (lineProtectMask && lineProtectMask[i]) locked = true;
          sL += lab[i * 3]; sA += lab[i * 3 + 1]; sB += lab[i * 3 + 2];
        }
        const mean = { L: sL / r.members.length, a: sA / r.members.length, b: sB / r.members.length };
        const neutralSrc = Math.hypot(mean.a, mean.b) < 8;
        const cands = [cur];
        if (!locked) for (const c of matchGamutCandidates(mean, gamut, 6, budget, neutralSrc)) cands.push(c.g.seq.slice());
        return { id: r.id, lab: mean, area: r.area, locked, stack: cur, candidates: cands, edges: r.edges, members: r.members };
      });
      const model = { materials: {} };
      palette.forEach((p, i) => { model.materials[String(i)] = p; });
      const res = CS.layerOptimizer.coordinateLayers({ model, boundaryLinear: foundation.lin, layerThicknessMm: layerHeight, regions: regs, lambdaB: 1, lambdaA: 0.2, colorBudget: budget });
      regionOf = graph.regionOf; regionRecipes = {};
      let changed = 0;
      regs.forEach((r, idx) => {
        const st = res.assignment[idx];
        if (st.join(',') === r.stack.join(',')) return;
        regionRecipes[r.id] = st; changed++;
        const cl = compositeLab(foundation.lin, st, palette, layerHeight);
        const hex = C.labToHex(cl.lab); const rgb = C.hexToRgb(hex);
        for (const i of r.members) {
          predicted[i] = { lab: cl.lab, hex, family: familyId[i] };
          preview[i * 4] = rgb.r; preview[i * 4 + 1] = rgb.g; preview[i * 4 + 2] = rgb.b; preview[i * 4 + 3] = 255;
        }
      });
      coordination = { changedRegions: changed, boundaryBefore: res.boundaryBefore, boundaryAfter: res.boundaryAfter, improved: res.improved, colorBudget: budget };
      if (changed) warnings.push(`同层材料协调：${changed} 个空间区域改用近色配方，内部材料边界 ${res.boundaryBefore.toFixed(1)}→${res.boundaryAfter.toFixed(1)} mm·层；色差预算 ${budget} ΔE，线稿/中性/锁定不变。`);
      else warnings.push('同层材料协调：当前颜色预算下无可用合层收益，保留原配方。');
      // F08: recompute material stats from the FINAL coordinated material source so
      // grams / toolChanges / layerFilaments agree with export/layer/3D.
      const tmpPlan = { w, h, printMask, flatMask, flatFilament, familyId, families, regionOf, regionRecipes, gradStartLayer, flatBaseLayers, flatLayers, commonTopLayer: equalHeight ? gradTopLayer : null, equalHeight, foundationIndex: baseIndex };
      grams.fill(0); toolChanges = 0;
      for (let z = 0; z < maxLayers; z++) {
        const set = new Set();
        for (let i = 0; i < n; i++) {
          if (!printMask[i]) continue;
          const m = filamentAt(tmpPlan, i % w, (i / w) | 0, z);
          if (m >= 0) { grams[m] += pixelArea * layerHeight / 1000 * 1.24; set.add(m); }
        }
        layerFilaments[z] = [...set];
        toolChanges += Math.max(0, set.size - 1);
      }
    }
    // F08: equal-height envelope WITHOUT coordination also needs final-material stats.
    if (equalHeight && !regionRecipes) {
      const tmpPlan = { w, h, printMask, flatMask, flatFilament, familyId, families, regionOf, regionRecipes, gradStartLayer, flatBaseLayers, flatLayers, commonTopLayer: gradTopLayer, equalHeight, foundationIndex: baseIndex };
      grams.fill(0); toolChanges = 0;
      for (let z = 0; z < maxLayers; z++) {
        const set = new Set();
        for (let i = 0; i < n; i++) {
          if (!printMask[i]) continue;
          const m = filamentAt(tmpPlan, i % w, (i / w) | 0, z);
          if (m >= 0) { grams[m] += pixelArea * layerHeight / 1000 * 1.24; set.add(m); }
        }
        layerFilaments[z] = [...set];
        toolChanges += Math.max(0, set.size - 1);
      }
    }
    // F03: color-error stats must FULLY reflect the coordinated predicted colors —
    // meanDE, median/p90 (global hist), under2/5/10 and every group (line/flat/gradient),
    // not just sumDE/maxDE/gradient. Rebuild from the final predicted exactly as the
    // original pass does, skipping envelope support (real material, not a colour sample).
    if (regionRecipes) {
      sumDE = 0; sumDE2 = 0; maxDE = 0;
      under2 = 0; under5 = 0; under10 = 0;
      hist.fill(0);
      for (const k of ['line', 'flat', 'gradient']) { const g = groupStats[k]; g.pixels = 0; g.sum = 0; g.max = 0; g.hist = new Uint32Array(101); }
      let csp = 0;
      for (let i = 0; i < n; i++) {
        if (!printMask[i]) continue;
        if (isEnvelopeSupport(i)) continue;
        csp++;
        const de = C.deltaE2000(labAt(lab, i), predicted[i].lab);
        const groupName = (lineDirect && lineDirect[i]) ? 'line' : flatMask[i] ? 'flat' : 'gradient';
        const gs = groupStats[groupName];
        gs.pixels++; gs.sum += de; if (de > gs.max) gs.max = de; gs.hist[Math.min(100, Math.round(de))]++;
        sumDE += de; sumDE2 += de * de; if (de > maxDE) maxDE = de;
        hist[Math.min(100, Math.round(de))]++;
        if (de <= 2) under2++; if (de <= 5) under5++; if (de <= 10) under10++;
      }
      colorStatPixels = csp;
      meanDE = colorStatPixels ? sumDE / colorStatPixels : 0;
      let cumR = 0; median = 0; p90 = 0;
      for (let d = 0; d <= 100; d++) { cumR += hist[d]; if (!median && cumR >= colorStatPixels * 0.5) median = d; if (!p90 && cumR >= colorStatPixels * 0.9) { p90 = d; break; } }
      // diagnostics.groups was snapshotted before coordination; rebuild it from the
      // refreshed group stats so the UI/group readouts match the final colours.
      diagnostics.groups.line = groupSummary(groupStats.line);
      diagnostics.groups.flat = groupSummary(groupStats.flat);
      diagnostics.groups.gradient = groupSummary(groupStats.gradient);
    }

    return {
      engine, w, h, n, pixelSize, widthMm: w * pixelSize, heightMm: h * pixelSize,
      layerHeight, flatLayers, flatBaseLayers, gradStartLayer, gradTopLayer, actualGradTopLayer, maxGradLayers: colorLayers, maxLayers, flatTopMm: flatLayers * layerHeight,
      gradTopMm: gradTopLayer * layerHeight, actualGradTopMm: actualGradTopLayer * layerHeight, reliefMm: actualRelief, variableHeight,
      equalHeight, commonTopLayer: equalHeight ? gradTopLayer : null,
      regionOf, regionRecipes, coordination,
      palette, foundation, foundationIndex: baseIndex, lutKey: options.lutKey || (engine === 'lut' ? 'bambu_8' : null),
      flatMask, flatFilament, familyId, regionId, regionCount, families, familyPixels, nearest, residual, stds, stdT, resT,
      predicted, preview, alpha, printMask, background, holeMap, smoothLevel,
      edgeSnap: options.edgeSnap !== false, lineRepair: options.lineRepair !== false,
      vectorFlat: !!options.vectorFlat,
      vectorFlatFamilies: vectorInfo ? vectorInfo.families : 0, vectorFlatPixels: vectorInfo ? vectorInfo.pixels : 0,
      vectorFlatIslandPixels: vectorInfo ? (vectorInfo.islandPixels || 0) : 0,
      vectorFlatBoundaryPixels: vectorInfo ? (vectorInfo.boundaryPixels || 0) : 0,
      vectorFlatContourPixels: vectorInfo ? (vectorInfo.contourPixels || 0) : 0,
      smoothMode: smoothMm != null ? 'physical' : 'level', smoothMm, lineWidthMm,
      smoothRadiusPx: smoothMm != null ? physSmooth.familyR : null, flatSmoothRadiusPx: smoothMm != null ? physSmooth.flatR : null,
      structureCleanup,
      mergeDeltaE: Number(options.mergeDeltaE) || 0,
      lineMode, lineApplied: lineActive, lineProtectMask, lineDirectMask: lineDirect,
      manualMask: options.manualMask && options.manualMask.length === n ? options.manualMask : null,
      edgeClean: edgeCleanLevel, edgeCleanRequested, edgePixelPercent: n ? edgePixelCount / n * 100 : 0,
      supportAddedPixels, supportAddedLayers,
      heightMergeDeltaE: options.heightMergeDeltaE == null ? 1.5 : Number(options.heightMergeDeltaE),
      heightMerge: heightMerge ? {
        changed: heightMerge.changed, groups: heightMerge.groups,
        oldMaxLayers: heightMerge.oldMax, newMaxLayers: heightMerge.newMax,
        savedLayers: heightMerge.savedLayers, savedLayerPixels: heightMerge.savedLayerPixels,
        threshold: heightMerge.threshold
      } : null,
      lineInfo: {
        active: lineInfo.active, applied: lineActive, mode: lineMode, score: lineInfo.score,
        edgePercent: lineInfo.edgeFraction * 100, whitePercent: lineInfo.whiteFraction * 100,
        darkPercent: lineInfo.darkFraction * 100, strokePercent: lineInfo.strokeFraction * 100,
        directPercent: n ? lineDirectCount / n * 100 : 0
      },
      stats: {
        flatPixels, gradPixels, printPixels: validPixels, supportPixels: supportOnlyPixels, colorPixels: colorStatPixels, removedBackgroundPixels: background.removedPixels,
        flatPercent: colorStatPixels ? flatPixels / colorStatPixels * 100 : 0, gradPercent: colorStatPixels ? gradPixels / colorStatPixels * 100 : 0,
        supportPercent: validPixels ? supportOnlyPixels / validPixels * 100 : 0,
        meanDE, p90, median, maxDE,
        under2: colorStatPixels ? under2 / colorStatPixels * 100 : 0, under5: colorStatPixels ? under5 / colorStatPixels * 100 : 0, under10: colorStatPixels ? under10 / colorStatPixels * 100 : 0,
        toolChanges, grams: Array.from(grams), layerFilaments, foundationOpacity,
        familyCount: families.filter(f => f.pixelCount > 0).length,
        outOfGamutPercent, gamutGaps, gamutSize: gamut ? gamut.length : 0, smoothLevel,
        vectorFlat: !!options.vectorFlat,
        vectorFlatFamilies: vectorInfo ? vectorInfo.families : 0, vectorFlatPixels: vectorInfo ? vectorInfo.pixels : 0,
      vectorFlatIslandPixels: vectorInfo ? (vectorInfo.islandPixels || 0) : 0,
      vectorFlatBoundaryPixels: vectorInfo ? (vectorInfo.boundaryPixels || 0) : 0,
        smoothMode: smoothMm != null ? 'physical' : 'level', smoothMm, lineWidthMm,
        smoothRadiusPx: smoothMm != null ? physSmooth.familyR : null, flatSmoothRadiusPx: smoothMm != null ? physSmooth.flatR : null,
        structureCleanupPixels: structureCleanup.mergedPixels, structureCleanupComponents: structureCleanup.mergedComponents,
        structureCleanupMinAreaPx: structureCleanup.minAreaPx, structureCleanupEdgeOnly: structureCleanup.edgeOnly,
        mergeDeltaE: Number(options.mergeDeltaE) || 0, mergedGroups: mergeResult.groups,
        sharedBasePercent: gradCount > 0 ? sharedBasePixels / gradCount * 100 : 0,
        lineMode, lineApplied: lineActive, lineStrokePercent: lineInfo.strokeFraction * 100,
        lineDirectPercent: n ? lineDirectCount / n * 100 : 0,
        edgeClean: edgeCleanLevel, edgeCleanRequested, edgePixelPercent: n ? edgePixelCount / n * 100 : 0,
        supportAddedPixels, supportAddedLayers,
        heightMergeDeltaE: options.heightMergeDeltaE == null ? 1.5 : Number(options.heightMergeDeltaE),
        heightShortenedFamilies: heightMerge ? heightMerge.changed : 0,
        heightMergedFamilies: heightMerge ? heightMerge.groups : 0,
        heightSavedLayers: heightMerge ? Math.max(0, heightMerge.oldMax - heightMerge.newMax) : 0
      },
      warnings,
      diagnostics,
      createdAt: Date.now()
    };
  }

  // Palette suggestion for the TD engine from the filament library.
  // Black and white are structural: they set the value range and make large
  // neutral areas printable as true solids. The remaining slots chase the
  // dominant chromatic clusters of the artwork.
  function recommendPalette(imageData, library, count, brandFilter) {
    const { lab } = imageToLab(imageData);
    const w = imageData.width, h = imageData.height, n = w * h;
    const step = Math.max(1, Math.floor(n / 8000));
    const flat = [];
    for (let i = 0; i < n; i += step) { flat.push(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]); }
    const sources = (library || []).filter(f => f.td != null && (!brandFilter || f.brand === brandFilter));
    const total = Math.min(count || 4, 6);
    const chosen = [], used = new Set();
    const add = (f) => {
      if (!f || used.has(f.id) || chosen.length >= total) return false;
      used.add(f.id);
      chosen.push({ id: f.id, name: f.name, brand: f.brand, material: f.material, hex: f.hex, td: f.td });
      return true;
    };
    const white = sources.find(f => /jade white|^white$/i.test(f.name));
    const black = sources.find(f => /^black$/i.test(f.name));
    add(white);
    add(black);
    const centers = kmeansLab(Float32Array.from(flat), Math.max(total * 3, 9), 99, 8);
    const counts = new Uint32Array(centers.length);
    for (let i = 0; i < flat.length; i += 3) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const dl = flat[i] - centers[c].L, da = flat[i + 1] - centers[c].a, db = flat[i + 2] - centers[c].b;
        const d = dl * dl + da * da + db * db;
        if (d < bestD) { bestD = d; best = c; }
      }
      counts[best]++;
    }
    const chroma = (c) => Math.hypot(c.a, c.b);
    const hue = (c) => (Math.atan2(c.b, c.a) * 180 / Math.PI + 360) % 360;
    const hueDist = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
    const order = centers.map((c, i) => ({ c, count: counts[i] })).sort((a, b) => b.count - a.count);
    const chosenHues = [];
    for (const { c } of order) {
      if (chosen.length >= total) break;
      if (chroma(c) < 8) continue;
      const h = hue(c);
      if (chosenHues.some(x => hueDist(x, h) < 26)) continue;
      let best = null, bestD = Infinity;
      for (const f of sources) {
        if (used.has(f.id)) continue;
        const fl = C.hexToLab(f.hex);
        if (Math.hypot(fl.a, fl.b) < 8) continue;
        const d = C.deltaE2000(c, fl);
        if (d < bestD) { bestD = d; best = f; }
      }
      if (add(best)) chosenHues.push(h);
    }
    // fill remaining slots with the closest unused palette entries
    for (const f of sources) { if (chosen.length >= total) break; add(f); }
    return chosen;
  }

  function filamentAt(plan, x, y, z) {
    const i = y * plan.w + x;
    if (plan.printMask && !plan.printMask[i]) return -1;
    // P4/P5: coordinated spatial regions override the family/flat recipe; this is
    // the single material source consumed by preview, layer maps and export.
    if (plan.regionRecipes && plan.regionOf) {
      const rr = plan.regionRecipes[plan.regionOf[i]];
      if (rr) {
        if (z < plan.gradStartLayer) return plan.foundationIndex;
        const li = z - plan.gradStartLayer;
        return li < rr.length ? rr[li] : -1;
      }
    }
    if (plan.flatMask[i]) {
      if (z < (plan.flatBaseLayers || 0)) return plan.foundationIndex;
      return z < plan.flatLayers ? plan.flatFilament[i] : -1;
    }
    if (z < plan.gradStartLayer) return plan.foundationIndex;
    const f = plan.familyId[i];
    if (f < 0) {
      // P3/G01: equal-height envelope/support columns are solid foundation up to
      // the common top, not AIR gaps that would break the flat-surface contract.
      if (plan.equalHeight && z < plan.commonTopLayer) return plan.foundationIndex;
      return -1;
    }
    const li = z - plan.gradStartLayer;
    if (li >= 0 && li < plan.families[f].recipe.length) return plan.families[f].recipe[li];
    return -1;
  }

  CS.engine = {
    buildPlan, recommendPalette, buildLutPalette, buildUserPalette,
    imageToLab, filamentAt, compositeLinear, stackTransmission, localStd,
    autoStdThreshold, nearestLut, kmeansLab, mergeIneffectiveHeights, physicalSmoothParams,
    mergeSmallRegions, buildPrintMask, buildStrokeInfo, buildTdGamut, gamutPenalty, gamutScore, matchGamut, mergeCommonBases, buildFamilyAdjacency, recipeSensitivity
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
