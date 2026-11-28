/* Batch filament calibration plate and perspective-corrected photo analysis. */
(function (root) {
  'use strict';
  const CS = root.CS = root.CS || {};
  const C = CS.color;
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const round = (v, d = 4) => { const p = Math.pow(10, d); return Math.round(v * p) / p; };
  const escapeXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const DEFAULT_STEPS = [0.08, 0.12, 0.16, 0.24, 0.32, 0.40, 0.50, 0.64, 0.80, 1.00];

  function buildBatchLayout(palette, options = {}) {
    const layerHeight = clamp(Number(options.layerHeight) || 0.08, 0.04, 0.2);
    const baseSize = 100, baseLayers = 2, baseHeight = baseLayers * layerHeight;
    const baseIndex = palette.reduce((best, p, i) => C.hexToLab(p.hex).L < C.hexToLab(palette[best].hex).L ? i : best, 0);
    const whiteIndex = palette.reduce((best, p, i) => C.hexToLab(p.hex).L > C.hexToLab(palette[best].hex).L ? i : best, 0);
    const order = [whiteIndex, ...palette.map((_, i) => i).filter(i => i !== whiteIndex)];
    const markers = [{ x: 2, y: 2 }, { x: 98, y: 2 }, { x: 98, y: 98 }, { x: 2, y: 98 }];
    const patches = [], bands = [], layerFilaments = new Array(baseLayers).fill(baseIndex);
    let size = baseSize, zLayer = baseLayers, previousIndex = baseIndex;
    for (const k of order) {
      const hd = Number(palette[k].hd) || Number(palette[k].td) * 0.1 || 0.5;
      const totalLayers = clamp(Math.ceil(hd * 1.2 / layerHeight), 3, 10);
      const counts = [Math.floor(totalLayers / 3), Math.floor(totalLayers / 3), Math.floor(totalLayers / 3)];
      for (let i = 0; i < totalLayers % 3; i++) counts[i]++;
      const band = { filamentIndex: k, substrateIndex: previousIndex, segments: [], totalLayers };
      for (let t = 0; t < 3; t++) {
        size = patches.length === 0 ? 92 : size - 4;
        const count = counts[t], z0 = zLayer * layerHeight, z1 = (zLayer + count) * layerHeight;
        const segment = { x0: 50 - size / 2, y0: 50 - size / 2, x1: 50 + size / 2, y1: 50 + size / 2, z0, z1 };
        band.segments.push(segment);
        for (let l = 0; l < count; l++) layerFilaments.push(k);
        zLayer += count;
        const patch = {
          filamentIndex: k, substrateIndex: previousIndex, terrace: t,
          cx: 50, cy: 50 - size / 2 + 1, size,
          thickness: band.segments.reduce((s, seg) => s + seg.z1 - seg.z0, 0),
          topLayer: zLayer
        };
        patches.push(patch);
        band.rail = patch;
      }
      band.rail.filamentIndex = k;
      bands.push(band); previousIndex = k;
    }
    return {
      boardW: baseSize, boardD: baseSize, baseHeight, baseLayers, baseIndex, whiteIndex, order,
      layerHeight, layerFilaments, bands, patches, rails: bands.map(b => b.rail), markers,
      blackReference: { cx: 50, cy: 1 }, whiteReference: bands[0].rail,
      totalLayers: layerFilaments.length, maxHeight: layerFilaments.length * layerHeight,
      printMode: 'single-filament-per-layer',
      note: '黑色薄底后逐色堆叠；每个 Z 层仅一种耗材，换色只发生在颜色段边界。'
    };
  }

  function buildBatchCalibration3MF(options = {}) {
    const palette = (options.palette || []).slice(0, 8);
    if (!palette.length) throw new Error('请至少选择一种耗材');
    const layout = options.layout || buildBatchLayout(palette, options);
    const addBox = CS.calibration.addBox;
    const basePos = [], baseIdx = [];
    addBox(basePos, baseIdx, 0, 0, 0, layout.boardW, layout.boardD, layout.baseHeight);
    const objects = [{ name: '黑色薄基底（白料测量基准）', pindex: layout.baseIndex, pos: basePos, idx: baseIdx }];
    for (let bi = 0; bi < layout.bands.length; bi++) {
      const band = layout.bands[bi], pos = [], idx = [];
      for (const s of band.segments) addBox(pos, idx, s.x0, s.y0, s.z0, s.x1, s.y1, s.z1);
      objects.push({ name: `${String(bi + 1).padStart(2, '0')} ${palette[band.filamentIndex].name} · ${band.totalLayers}层单色阶梯`, pindex: band.filamentIndex, pos, idx });
    }
    const markerPos = [], markerIdx = [];
    const markerTop = layout.bands[0].segments[layout.bands[0].segments.length - 1].z1;
    for (const m of layout.markers) addBox(markerPos, markerIdx, m.x - 1, m.y - 1, layout.baseHeight, m.x + 1, m.y + 1, markerTop);
    objects.push({ name: '白色角点（贯穿白色料带全部Z层）', pindex: layout.whiteIndex, pos: markerPos, idx: markerIdx });

    const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">', ' <metadata name="Application">ChromaStack Batch Calibration</metadata>', ' <resources>', '  <basematerials id="1">'];
    for (const p of palette) parts.push(`   <base name="${escapeXml(p.name)}" displaycolor="#${p.hex.replace('#', '').toUpperCase()}FF" />`);
    parts.push('  </basematerials>');
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i], id = i + 2;
      parts.push(`  <object id="${id}" type="model" pid="1" pindex="${o.pindex}" name="${escapeXml(o.name)}">`, '   <mesh><vertices>');
      for (let j = 0; j < o.pos.length; j += 3) parts.push(`    <vertex x="${round(o.pos[j])}" y="${round(o.pos[j + 1])}" z="${round(o.pos[j + 2])}" />`);
      parts.push('   </vertices><triangles>');
      for (let j = 0; j < o.idx.length; j += 3) parts.push(`    <triangle v1="${o.idx[j]}" v2="${o.idx[j + 1]}" v3="${o.idx[j + 2]}" />`);
      parts.push('   </triangles></mesh>', '  </object>');
    }
    const assemblyId = objects.length + 2;
    parts.push(`  <object id="${assemblyId}" type="model" name="ChromaStack_Batch_Calibration"><components>`);
    for (let i = 0; i < objects.length; i++) parts.push(`   <component objectid="${i + 2}" />`);
    parts.push('  </components></object>', ' </resources>', ` <build><item objectid="${assemblyId}" /></build></model>`);
    const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n <object id="${assemblyId}">\n  <metadata key="name" value="ChromaStack Batch Calibration"/>\n  <metadata key="extruder" value="1"/>\n${objects.map((o, i) => `  <part id="${i + 2}" subtype="normal_part"><metadata key="name" value="${escapeXml(o.name)}"/><metadata key="extruder" value="${o.pindex + 1}"/></part>`).join('\n')}\n </object>\n <plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value=""/><metadata key="locked" value="false"/><metadata key="filament_map_mode" value="Auto For Flush"/><model_instance><metadata key="object_id" value="${assemblyId}"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="1"/></model_instance></plate>\n <assemble>\n  <assemble_item object_id="${assemblyId}" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 0" offset="0 0 0" />\n </assemble>\n</config>`;
    // Colored filament slots so Bambu/Orca auto-creates AMS entries instead of leaving
    // every object uncolored for manual assignment.
    const projectSettings = {
      layer_height: String(layout.baseHeight || 0.08),
      initial_layer_print_height: String(layout.baseHeight || 0.08),
      wall_loops: '2', sparse_infill_density: '100%',
      printer_model: 'ChromaStack', printer_settings_id: 'ChromaStack 0.4 nozzle',
      nozzle_diameter: ['0.4'], printable_height: '256',
      filament_colour: palette.map(p => p.hex),
      filament_type: palette.map(() => 'PLA'),
      filament_settings_id: palette.map(() => 'Generic PLA @ChromaStack 0.4 nozzle'),
      filament_vendor: palette.map(p => /Bambu/i.test(p.brand || '') ? 'Bambu Lab' : 'Generic')
    };
    const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n <Default Extension="png" ContentType="image/png"/>\n <Default Extension="config" ContentType="text/xml"/>\n <Default Extension="json" ContentType="application/json"/>\n</Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>`;
    const files = [
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rels },
      { name: '3D/3dmodel.model', data: parts.join('\n') },
      { name: 'Metadata/model_settings.config', data: modelSettings },
      { name: 'Metadata/project_settings.config', data: JSON.stringify(projectSettings, null, 2) },
      { name: 'Metadata/chromastack-batch-calibration.json', data: JSON.stringify({ app: 'ChromaStack Batch Calibration', layout, palette, printMode: layout.printMode, note: layout.note }, null, 2) }
    ];
    return { bytes: CS.zip.createZip(files), meta: { layout, palette, printMode: layout.printMode } };
  }

  function buildBatchCalibrationBlob(options) {
    const out = buildBatchCalibration3MF(options);
    return { blob: new Blob([out.bytes], { type: 'model/3mf' }), meta: out.meta };
  }

  function detectMarkers(imageData, bright = false) {
    const w = imageData.width, h = imageData.height, n = w * h, data = imageData.data;
    const dark = new Uint8Array(n), seen = new Uint8Array(n), stack = new Int32Array(n), components = [];
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const y = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
      if (bright ? y > 180 : y < 70) dark[i] = 1;
    }
    const minArea = Math.max(8, Math.round(n * 0.000005));
    for (let start = 0; start < n; start++) {
      if (!dark[start] || seen[start]) continue;
      let top = 0, area = 0, minX = w, maxX = -1, minY = h, maxY = -1, sx = 0, sy = 0;
      seen[start] = 1; stack[top++] = start;
      while (top) {
        const i = stack[--top], x = i % w, y = (i / w) | 0;
        area++; sx += x; sy += y;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const j = yy * w + xx;
          if (dark[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
        }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1, fill = area / (bw * bh), ratio = bw / bh;
      if (area >= minArea && area < n * 0.05 && fill > 0.25 && ratio > 0.25 && ratio < 4) {
        components.push({ area, cx: sx / area, cy: sy / area, fill });
      }
    }
    const cornerDefs = [[0, 0], [w, 0], [w, h], [0, h]], chosen = [], used = new Set();
    for (const [cx, cy] of cornerDefs) {
      const candidates = components.filter(c => !used.has(c) && Math.hypot(c.cx - cx, c.cy - cy) < Math.max(w, h) * 0.3)
        .sort((a, b) => Math.hypot(a.cx - cx, a.cy - cy) - Math.hypot(b.cx - cx, b.cy - cy) || b.area - a.area);
      if (candidates.length) { chosen.push(candidates[0]); used.add(candidates[0]); }
    }
    if (chosen.length < 4) throw new Error('找不到四个定位点，请确保标定板四角完整入镜且对比清晰');
    const four = chosen;
    const tl = four.reduce((a, b) => a.cx + a.cy < b.cx + b.cy ? a : b);
    const br = four.reduce((a, b) => a.cx + a.cy > b.cx + b.cy ? a : b);
    const tr = four.reduce((a, b) => a.cx - a.cy > b.cx - b.cy ? a : b);
    const bl = four.reduce((a, b) => a.cx - a.cy < b.cx - b.cy ? a : b);
    const ordered = [tl, tr, br, bl];
    if (new Set(ordered).size !== 4) throw new Error('定位点位置无法组成四边形，请重新拍摄');
    return ordered;
  }

  function solveLinear(A, b) {
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let pivot = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[pivot][i])) pivot = r;
      [A[i], A[pivot]] = [A[pivot], A[i]]; [b[i], b[pivot]] = [b[pivot], b[i]];
      if (Math.abs(A[i][i]) < 1e-12) throw new Error('定位点共线，无法校正透视');
      const div = A[i][i];
      for (let c = i; c < n; c++) A[i][c] /= div;
      b[i] /= div;
      for (let r = 0; r < n; r++) {
        if (r === i) continue;
        const f = A[r][i];
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    return b;
  }

  function homography(src, dst) {
    const A = [], B = [];
    for (let i = 0; i < 4; i++) {
      const x = src[i].cx ?? src[i].x, y = src[i].cy ?? src[i].y;
      const u = dst[i].cx ?? dst[i].x, v = dst[i].cy ?? dst[i].y;
      A.push([-x, -y, -1, 0, 0, 0, u * x, u * y], [0, 0, 0, -x, -y, -1, v * x, v * y]);
      B.push(-u, -v);
    }
    const h = solveLinear(A, B).concat(1);
    return (x, y) => {
      const d = h[6] * x + h[7] * y + 1;
      return { x: (h[0] * x + h[1] * y + h[2]) / d, y: (h[3] * x + h[4] * y + h[5]) / d };
    };
  }

  function sampleMedian(imageData, map, cx, cy, radius = 2) {
    const w = imageData.width, h = imageData.height, data = imageData.data;
    const pt = map(cx, cy), cx0 = Math.round(pt.x), cy0 = Math.round(pt.y), channels = [[], [], []];
    for (let y = Math.max(0, cy0 - radius); y <= Math.min(h - 1, cy0 + radius); y++) {
      for (let x = Math.max(0, cx0 - radius); x <= Math.min(w - 1, cx0 + radius); x++) {
        const p = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) channels[c].push(data[p + c]);
      }
    }
    const rgb = channels.map(ch => { ch.sort((a, b) => a - b); return ch.length ? ch[(ch.length / 2) | 0] : 0; });
    return { rgb, x: pt.x, y: pt.y };
  }

  function transmission(base, fg, sample) {
    let num = 0, den = 0;
    for (let c = 0; c < 3; c++) {
      const b = C.srgbToLinear(base[c] / 255), f = C.srgbToLinear(fg[c] / 255), m = C.srgbToLinear(sample[c] / 255);
      num += (m - f) * (b - f); den += (b - f) ** 2;
    }
    return den > 1e-10 ? clamp(num / den, 0, 1) : 1;
  }

  // For a fixed HD every terrace is linear in the unknown opaque filament
  // colour. Solve that colour analytically, then search only the shared HD.
  // This avoids treating the thickest (but still transmitting) terrace as an
  // opaque reference, which otherwise biases both the colour and the HD.
  function fitBand(samples, substrate) {
    const base = substrate.map(v => C.srgbToLinear(v / 255));
    const observed = samples.map(s => ({ thickness: s.thickness, rgb: s.rgb, linear: s.rgb.map(v => C.srgbToLinear(v / 255)) }));
    const evaluate = logHd => {
      const hd = Math.exp(logHd), transmissions = observed.map(s => Math.pow(10, -s.thickness / hd));
      const den = transmissions.reduce((sum, T) => sum + (1 - T) ** 2, 0);
      if (den < 1e-10) return { error: Infinity, hd, rgb: substrate.slice() };
      const linear = base.map((b, c) => {
        let num = 0;
        for (let i = 0; i < observed.length; i++) {
          const T = transmissions[i], q = 1 - T;
          num += q * (observed[i].linear[c] - b * T);
        }
        return clamp(num / den, 0, 1);
      });
      let error = 0;
      for (let i = 0; i < observed.length; i++) {
        const T = transmissions[i];
        for (let c = 0; c < 3; c++) {
          const predicted = C.linearToSrgb8(linear[c] * (1 - T) + base[c] * T);
          error += (predicted - observed[i].rgb[c]) ** 2;
        }
      }
      return { error: error / (observed.length * 3), hd, linear, rgb: linear.map(v => C.linearToSrgb8(v)) };
    };
    return searchScalar(evaluate, Math.log(0.05), Math.log(10));
  }

  // A thin white reference on black is not itself pure white. With black at
  // zero, camera gain cancels in the ratios between white terraces: fit HD from
  // those ratios first, then recover the per-channel gain from the same curve.
  function fitWhiteReference(samples) {
    const observed = samples.map(s => ({ thickness: s.thickness, rgb: s.rgb.map(v => v / 255) }));
    const evaluate = logHd => {
      const hd = Math.exp(logHd);
      const predicted = observed.map(s => C.linearToSrgb8(1 - Math.pow(10, -s.thickness / hd)) / 255);
      const cameraGains = [0, 0, 0];
      let error = 0;
      for (let c = 0; c < 3; c++) {
        let num = 0, den = 0, energy = 0;
        for (let i = 0; i < observed.length; i++) {
          num += predicted[i] * observed[i].rgb[c];
          den += predicted[i] * predicted[i];
          energy += observed[i].rgb[c] ** 2;
        }
        const gain = den > 1e-10 ? clamp(num / den, 0.25, 4) : 1;
        cameraGains[c] = gain;
        for (let i = 0; i < observed.length; i++) error += (observed[i].rgb[c] - gain * predicted[i]) ** 2 / Math.max(1e-6, energy);
      }
      return { error, hd, cameraGains, gains: cameraGains.map(g => 1 / g) };
    };
    return searchScalar(evaluate, Math.log(0.05), Math.log(10));
  }

  function searchScalar(evaluate, min, max) {
    const steps = 220;
    let best = null, bestX = min;
    for (let i = 0; i <= steps; i++) {
      const x = min + (max - min) * i / steps, value = evaluate(x);
      if (!best || value.error < best.error) { best = value; bestX = x; }
    }
    let lo = Math.max(min, bestX - (max - min) / steps), hi = Math.min(max, bestX + (max - min) / steps);
    for (let i = 0; i < 36; i++) {
      const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
      if (evaluate(a).error <= evaluate(b).error) hi = b; else lo = a;
    }
    const refined = evaluate((lo + hi) / 2);
    return refined.error <= best.error ? refined : best;
  }

  function analyzeBatchPhoto(imageData, palette, options = {}) {
    const layout = options.layout || buildBatchLayout(palette, options);
    const markers = detectMarkers(imageData, true);
    const map = homography(layout.markers, markers);
    const blackSample = sampleMedian(imageData, map, layout.blackReference.cx, layout.blackReference.cy, 3);
    const rawBands = layout.bands.map(band => {
      const patches = layout.patches.filter(p => p.filamentIndex === band.filamentIndex && p.substrateIndex === band.substrateIndex)
        .sort((a, b) => a.terrace - b.terrace)
        .map(patch => ({ patch, sample: sampleMedian(imageData, map, patch.cx, patch.cy, 2) }));
      return { band, patches, railSample: sampleMedian(imageData, map, band.rail.cx, band.rail.cy, 3) };
    });
    const white = rawBands[0].railSample.rgb;
    const whiteFit = fitWhiteReference(rawBands[0].patches.map(p => ({ thickness: p.patch.thickness, rgb: p.sample.rgb })));
    const gains = whiteFit.gains.map(g => clamp(g, 0.25, 4));
    const correct = rgb => rgb.map((v, c) => clamp(Math.round(v * gains[c]), 0, 255));
    let substrate = correct(blackSample.rgb);
    const results = [];
    for (let bi = 0; bi < rawBands.length; bi++) {
      const { band, patches, railSample } = rawBands[bi], k = band.filamentIndex;
      const samples = patches.map(({ patch, sample }) => ({ x: sample.x, y: sample.y, thickness: patch.thickness, rgb: correct(sample.rgb), T: 0 }));
      const fit = bi === 0 ? { hd: whiteFit.hd, rgb: [255, 255, 255], error: whiteFit.error } : fitBand(samples, substrate);
      const nominalHd = Number(palette[k].hd) || Number(palette[k].td) * 0.1 || 0.5;
      const spread = samples.length > 1 ? Math.max(...samples[0].rgb.map((v, c) => Math.abs(v - samples[samples.length - 1].rgb[c]))) : 0;
      const identifiable = spread >= 5 && Number.isFinite(fit.hd) && Number.isFinite(fit.error) && fit.error < 2500;
      const hd = identifiable ? fit.hd : nominalHd;
      const opaque = identifiable ? fit.rgb : samples[samples.length - 1].rgb;
      const residuals = [];
      for (const s of samples) {
        s.T = transmission(substrate, opaque, s.rgb);
        if (s.T > 0.0005 && s.T < 0.995) residuals.push(Math.abs(Math.log10(s.T) + s.thickness / hd));
      }
      residuals.sort((a, b) => a - b);
      let residual = residuals.length ? residuals[(residuals.length / 2) | 0] : 1;
      if (!identifiable) residual = Math.max(residual, 0.4);
      results.push({
        index: k, id: palette[k].id, name: palette[k].name, brand: palette[k].brand, material: palette[k].material,
        hex: C.rgbToHex(opaque[0], opaque[1], opaque[2]), hd, td: clamp(hd * 10, 0.1, 20),
        score: clamp(1 - residual * 2, 0, 1), residual, samples, railSample,
        substrateIndex: band.substrateIndex, fitError: fit.error, opaqueFit: identifiable
      });
      // The next band physically sits on this band's finite-thickness final
      // terrace, so carry the measured terrace colour rather than the fitted
      // opaque colour forward as its substrate.
      substrate = correct(railSample.rgb);
    }
    const score = results.length ? results.reduce((s, r) => s + r.score, 0) / results.length : 0;
    return { layout, markers, results, whiteBalance: { white, gains, hd: whiteFit.hd, residual: whiteFit.error }, score };
  }

  /* P0 / C04: analysis thickness must come from the board identity (the layout
     captured when the plate was generated), never a silent 0.08 default. A missing
     identity returns null so the caller enters a pending-confirmation state. */
  function resolveAnalysisLayout(palette, persistedLayout) {
    if (persistedLayout && Number(persistedLayout.layerHeight) > 0 && Array.isArray(persistedLayout.patches)) return persistedLayout;
    return null;
  }

  CS.batchCalibration = { buildBatchLayout, buildBatchCalibration3MF, buildBatchCalibrationBlob, analyzeBatchPhoto, detectMarkers, homography, solveLinear, transmission, searchScalar, sampleMedian, resolveAnalysisLayout };
})(typeof globalThis !== 'undefined' ? globalThis : this);
