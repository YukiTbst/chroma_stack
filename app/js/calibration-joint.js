/* ChromaStack joint combination calibration (P2). Fits shared per-material
   (log HD_R/G/B, opaqueLinear_R/G/B) against combination observations using the
   SAME optics.predictStack as production. Train / dev / test splits are frozen
   from the manifest; the fitter reads ONLY train. Identifiability is checked by
   parameter perturbation; publishing is atomic and refuses to overwrite the
   active model when the fit is unresolved or fails the held-out tolerance.
   Synthetic recovery here is program validity, NOT physical acceptance. */
(function (root) {
  const CS = root.CS = root.CS || {};
  const C = CS.color, O = CS.optics, B = CS.batchCalibration, M = CS.matrixCalibration;
  const cd = () => CS.calibrationData; // resolve lazily: never cache a possibly-unloaded dependency
  const HUBER = d => { const a = Math.abs(d); return a <= 1 ? 0.5 * a * a : a - 0.5; };

  function buildComboManifest(palette, opts = {}) {
    const lh = Number(opts.layerHeight) || 0.08;
    const ids = palette.map((p, i) => p.id || ('m' + i));
    const cells = []; let n = 0;
    const push = (type, stack, base, split) => cells.push({
      cellId: 'c' + (n++), type, stack, base, split,
      thicknessMm: stack.reduce((s, x) => s + x.layerCount, 0) * lh
    });
    for (const id of ids) for (const base of ['K', 'W']) for (const L of [1, 2, 4, 8]) push('single', [{ materialId: id, layerCount: L }], base, 'train');
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i], b = ids[(i + 1) % ids.length];
      push('pair', [{ materialId: a, layerCount: 2 }, { materialId: b, layerCount: 2 }], 'W', 'train');
      push('pair', [{ materialId: b, layerCount: 2 }, { materialId: a, layerCount: 2 }], 'W', 'train');
      push('multi', [{ materialId: a, layerCount: 1 }, { materialId: b, layerCount: 2 }, { materialId: a, layerCount: 1 }], 'K', 'train');
      push('heldout', [{ materialId: a, layerCount: 3 }, { materialId: b, layerCount: 1 }], 'W', 'test');
      push('heldout', [{ materialId: a, layerCount: 5 }], 'K', 'test');
      push('repeat', [{ materialId: a, layerCount: 2 }], 'W', 'dev');
    }
    const manifest = { schemaVersion: 1, boardId: 'combo-' + ids.length, layerHeight: lh, firstLayer: Number(opts.firstLayer) || lh, cells, references: [{ kind: 'independent-white', linear: [1, 1, 1] }] };
    // Dual-substrate layout: the differential-transmittance fitter needs paired
    // black/white anchors, so 'W' cells sit on a white half and 'K' on a black half
    // (white top / black bottom), joined by a first-layer bridge. Generation,
    // labels, sampling and fitting all read this ONE manifest.
    const cols = 10, pitch = 10, size = 8, margin = 6, halfGap = 4;
    const wCells = cells.filter(c => c.base === 'W'), kCells = cells.filter(c => c.base === 'K');
    const halfW = Math.ceil(wCells.length / cols) * pitch, halfK = Math.ceil(kCells.length / cols) * pitch;
    manifest.boardW = margin * 2 + cols * pitch;
    manifest.boardD = margin * 2 + halfW + halfGap + halfK;
    manifest.halves = { W: { y0: margin, y1: margin + halfW }, K: { y0: margin + halfW + halfGap, y1: margin + halfW + halfGap + halfK } };
    wCells.forEach((c, i) => { c.cx = margin + (i % cols) * pitch + size / 2; c.cy = manifest.halves.W.y0 + Math.floor(i / cols) * pitch + size / 2; c.size = size; });
    kCells.forEach((c, i) => { c.cx = margin + (i % cols) * pitch + size / 2; c.cy = manifest.halves.K.y0 + Math.floor(i / cols) * pitch + size / 2; c.size = size; });
    // Corner markers must sit ON the foundation halves (inside their y-range),
    // not in the empty outer margin, and use the opposite colour of their half.
    const mTop = manifest.halves.W.y0 + 2, mBot = manifest.halves.K.y1 - 2;
    manifest.markers = [
      { x: 2, y: mTop, filament: 'K' }, { x: manifest.boardW - 2, y: mTop, filament: 'K' },
      { x: manifest.boardW - 2, y: mBot, filament: 'W' }, { x: 2, y: mBot, filament: 'W' }
    ];
    manifest.baseLayers = 2; manifest.baseHeight = manifest.firstLayer + (manifest.baseLayers - 1) * lh;
    manifest.manifestHash = cd().manifestHash(manifest);
    return manifest;
  }

  function escapeXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function addBox(pos, idx, x0, y0, z0, x1, y1, z1) {
    const b = pos.length / 3;
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    for (const p of v) pos.push(p[0], p[1], p[2]);
    const q = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    for (const t of q) idx.push(b + t[0], b + t[1], b + t[2]);
  }
  /* Printable combination board: one part per contiguous material run per cell,
     over a shared foundation; the SAME manifest is embedded for later analysis. */
  function buildComboBoard3MF(palette, manifest) {
    const lh = manifest.layerHeight, baseH = manifest.baseHeight;
    const matIndex = id => palette.findIndex(p => (p.id || '') === id || p.name === id || (p.hex || '').toLowerCase() === String(id).toLowerCase());
    const blackIndex = palette.reduce((b, p, i) => C.hexToLab(p.hex).L < C.hexToLab(palette[b].hex).L ? i : b, 0);
    const whiteIndex = palette.reduce((b, p, i) => C.hexToLab(p.hex).L > C.hexToLab(palette[b].hex).L ? i : b, 0);
    const halves = manifest.halves || { W: { y0: 0, y1: manifest.boardD / 2 }, K: { y0: manifest.boardD / 2, y1: manifest.boardD } };
    const objects = [];
    // White half foundation (top), black half foundation (bottom), joined by a
    // first-layer bridge so the plate is one connected solid.
    const wp = [], wi = []; addBox(wp, wi, 0, halves.W.y0, 0, manifest.boardW, halves.W.y1, baseH);
    objects.push({ name: 'foundation-white', pindex: whiteIndex, pos: wp, idx: wi });
    const kp = [], ki = []; addBox(kp, ki, 0, halves.K.y0, 0, manifest.boardW, halves.K.y1, baseH);
    objects.push({ name: 'foundation-black', pindex: blackIndex, pos: kp, idx: ki });
    const brp = [], bri = []; addBox(brp, bri, 0, halves.W.y1, 0, manifest.boardW, halves.K.y0, manifest.firstLayer);
    objects.push({ name: 'bridge', pindex: blackIndex, pos: brp, idx: bri });
    for (const cell of manifest.cells) {
      let z = baseH;
      const x0 = cell.cx - cell.size / 2, y0 = cell.cy - cell.size / 2;
      for (const seg of cell.stack) {
        const z1 = z + seg.layerCount * lh;
        const pos = [], idx = []; addBox(pos, idx, x0, y0, z, x0 + cell.size, y0 + cell.size, z1);
        const mi = matIndex(seg.materialId);
        if (mi < 0) throw new Error('组合板材料未映射: ' + seg.materialId);
        objects.push({ name: cell.cellId + ' ' + seg.materialId, pindex: mi, pos, idx });
        z = z1;
      }
    }
    // Corner markers use the OPPOSITE colour of their half so they stay detectable.
    for (const code of ['K', 'W']) {
      const mp = [], mi = [];
      for (const m of manifest.markers.filter(m => m.filament === code)) addBox(mp, mi, m.x - 1, m.y - 1, baseH, m.x + 1, m.y + 1, baseH + 2 * lh);
      if (mp.length) objects.push({ name: 'markers-' + code, pindex: code === 'K' ? blackIndex : whiteIndex, pos: mp, idx: mi });
    }
    const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">', ' <metadata name="Application">ChromaStack Combo Calibration</metadata>', ' <resources>', '  <basematerials id="1">'];
    for (const p of palette) parts.push(`   <base name="${escapeXml(p.name)}" displaycolor="#${p.hex.replace('#', '').toUpperCase()}FF" />`);
    parts.push('  </basematerials>');
    objects.forEach((o, i) => {
      parts.push(`  <object id="${i + 2}" type="model" pid="1" pindex="${o.pindex}" name="${escapeXml(o.name)}">`, '   <mesh><vertices>');
      for (let j = 0; j < o.pos.length; j += 3) parts.push(`    <vertex x="${o.pos[j].toFixed(3)}" y="${o.pos[j + 1].toFixed(3)}" z="${o.pos[j + 2].toFixed(3)}" />`);
      parts.push('   </vertices><triangles>');
      for (let j = 0; j < o.idx.length; j += 3) parts.push(`    <triangle v1="${o.idx[j]}" v2="${o.idx[j + 1]}" v3="${o.idx[j + 2]}" pid="1" pindex="${o.pindex}" />`);
      parts.push('   </triangles></mesh>', '  </object>');
    });
    const aid = objects.length + 2;
    parts.push(`  <object id="${aid}" type="model" name="ChromaStack_Combo_Calibration"><components>`);
    objects.forEach((o, i) => parts.push(`   <component objectid="${i + 2}" />`));
    parts.push('  </components></object>', ' </resources>', ` <build><item objectid="${aid}" /></build></model>`);
    const config = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n <object id="${aid}">\n  <metadata key="name" value="ChromaStack Combo Calibration"/>\n  <metadata key="extruder" value="1"/>\n${objects.map((o, i) => `  <part id="${i + 2}" subtype="normal_part"><metadata key="name" value="${escapeXml(o.name)}"/><metadata key="extruder" value="${o.pindex + 1}"/></part>`).join('\n')}\n </object>\n <plate>\n  <metadata key="plater_id" value="1"/>\n  <metadata key="plater_name" value=""/>\n  <metadata key="locked" value="false"/>\n  <metadata key="filament_map_mode" value="Auto For Flush"/>\n  <model_instance>\n   <metadata key="object_id" value="${aid}"/>\n   <metadata key="instance_id" value="0"/>\n   <metadata key="identify_id" value="1"/>\n  </model_instance>\n </plate>\n <assemble>\n  <assemble_item object_id="${aid}" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 0" offset="0 0 0" />\n </assemble>\n</config>`;
    const ct = `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n <Default Extension="config" ContentType="text/xml"/>\n <Default Extension="json" ContentType="application/json"/>\n</Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>`;
    const ps = manifest.printSettings || { nozzleDiameter: 0.4, lineWidth: 0.42, layerHeight: manifest.layerHeight, initialLayerHeight: manifest.firstLayer, amsSlots: palette.map((p, i) => i + 1), filaments: palette };
    // JSON project profile (same convention as the main exporter): without it Bambu
    // reports "配置无效，仅加载几何" and drops part-to-extruder assignments.
    const projectSettings = JSON.stringify({
      layer_height: String(ps.layerHeight),
      initial_layer_print_height: String(ps.initialLayerHeight),
      wall_loops: '2',
      top_shell_layers: '3',
      bottom_shell_layers: '2',
      sparse_infill_density: '15%',
      brim_type: 'outer_only',
      brim_width: '3',
      printer_model: 'ChromaStack',
      printer_settings_id: 'ChromaStack ' + ps.nozzleDiameter + ' nozzle',
      nozzle_diameter: [String(ps.nozzleDiameter)],
      line_width: String(ps.lineWidth),
      printable_height: '180',
      filament_colour: palette.map(p => p.hex),
      filament_type: palette.map(() => 'PLA'),
      filament_settings_id: palette.map(() => 'Generic PLA @ChromaStack ' + ps.nozzleDiameter + ' nozzle'),
      filament_vendor: palette.map(p => /Bambu/i.test(p.brand || '') ? 'Bambu Lab' : 'Generic')
    }, null, 2);
    const files = [
      { name: '[Content_Types].xml', data: ct }, { name: '_rels/.rels', data: rels },
      { name: '3D/3dmodel.model', data: parts.join('\n') },
      { name: 'Metadata/model_settings.config', data: config },
      { name: 'Metadata/project_settings.config', data: projectSettings },
      { name: 'Metadata/chromastack-combo-calibration.json', data: JSON.stringify({ app: 'ChromaStack Combo Calibration', manifest, palette }, null, 2) }
    ];
    return { bytes: CS.zip.createZip(files), meta: { manifest, palette } };
  }
  function buildComboBoardBlob(palette, opts = {}) {
    const manifest = buildComboManifest(palette, opts);
    manifest.printSettings = {
      nozzleDiameter: Number(opts.nozzleDiameter) || 0.4,
      lineWidth: Number(opts.lineWidth) || 0.42,
      layerHeight: manifest.layerHeight,
      initialLayerHeight: manifest.firstLayer,
      amsSlots: palette.map((p, i) => i + 1),
      filaments: palette.map(p => ({ name: p.name, hex: p.hex }))
    };
    manifest.manifestHash = cd().manifestHash(manifest);
    const out = buildComboBoard3MF(palette, manifest);
    return { blob: new Blob([out.bytes], { type: 'model/3mf' }), meta: out.meta };
  }

  function modelFromTheta(theta, lh) {
    const materials = {};
    for (const id of Object.keys(theta)) {
      const t = theta[id];
      materials[id] = { lin: { r: t.opaque[0], g: t.opaque[1], b: t.opaque[2] }, hdR: Math.exp(t.logHd[0]), hdG: Math.exp(t.logHd[1]), hdB: Math.exp(t.logHd[2]) };
    }
    return { materials, compatibilityDomain: { layerHeightMm: lh } };
  }
  function cellLoss(model, cell, obs, noiseScale) {
    const pred = O.predictStack(model, cell.stack, { linearRgb: { r: obs.substrateLinear[0], g: obs.substrateLinear[1], b: obs.substrateLinear[2] } }, model.compatibilityDomain.layerHeightMm).linearRgb;
    const p = [pred.r, pred.g, pred.b];
    let s = 0, n = 0;
    for (let c = 0; c < 3; c++) {
      if (obs.channelsOk && !obs.channelsOk[c]) continue;
      s += HUBER((p[c] - obs.observedLinear[c]) / noiseScale); n++;
    }
    return { sum: s, n, pred: p };
  }
  function listLoss(model, list, noiseScale) {
    let s = 0, n = 0;
    for (const o of list) { const r = cellLoss(model, o.cell, o, noiseScale); s += r.sum; n += r.n; }
    return n ? s / n : Infinity;
  }
  function meanDE(model, list, lh) {
    if (!list.length) return null;
    let s = 0;
    for (const o of list) {
      const pred = O.predictStack(model, o.cell.stack, { linearRgb: { r: o.substrateLinear[0], g: o.substrateLinear[1], b: o.substrateLinear[2] } }, lh).linearRgb;
      const a = O.linearToLab(pred), b = O.linearToLab({ r: o.observedLinear[0], g: o.observedLinear[1], b: o.observedLinear[2] });
      s += C.deltaE2000(a, b);
    }
    return s / list.length;
  }

  function fitJointModel(observations, manifest, opts = {}) {
    const lh = manifest.layerHeight;
    const noiseScale = Math.max(0.01, Number(opts.noiseScale) || 0.02);
    const bySplit = { train: [], dev: [], test: [] };
    for (const o of observations) {
      const cell = manifest.cells.find(c => c.cellId === o.cellId);
      if (!cell) continue;
      (bySplit[cell.split] || bySplit.train).push({ ...o, cell });
    }
    const train = bySplit.train;
    // Single-material initialisation from the train anchors (reuse per-channel fitter).
    const anchorsByCode = {};
    for (const o of train) {
      if (o.cell.type !== 'single') continue;
      const id = o.cell.stack[0].materialId;
      (anchorsByCode[id] = anchorsByCode[id] || []).push({ thickness: o.cell.thicknessMm, base: o.cell.base, rgb: o.observedLinear.map(v => C.linearToSrgb8(v)), substrate: o.substrateLinear.map(v => C.linearToSrgb8(v)) });
    }
    const initFit = M.fitMatrixAnchors(anchorsByCode, Object.keys(anchorsByCode));
    const ids = [...new Set(manifest.cells.flatMap(c => c.stack.map(s => s.materialId)))];
    const baseTheta = {};
    for (const id of ids) {
      const f = initFit.fits[id];
      const hd = [f && f.hdR != null ? f.hdR : 0.5, f && f.hdG != null ? f.hdG : 0.5, f && f.hdB != null ? f.hdB : 0.5];
      const op = f && f.linear ? f.linear.map(v => v == null ? 0.5 : Math.min(1, v)) : [0.5, 0.5, 0.5];
      baseTheta[id] = { logHd: hd.map(h => Math.log(Math.min(2, Math.max(0.01, h)))), opaque: op.slice() };
    }
    const clone = t => JSON.parse(JSON.stringify(t));
    const starts = [clone(baseTheta), clone(baseTheta), clone(baseTheta)];
    for (const id of ids) { starts[1][id].logHd = starts[1][id].logHd.map(v => v + Math.log(1.5)); starts[2][id].logHd = starts[2][id].logHd.map(v => v + Math.log(0.6)); }
    let best = null;
    for (const start of starts) {
      const theta = clone(start);
      for (let sweep = 0; sweep < 4; sweep++) {
        for (const id of ids) {
          for (let c = 0; c < 3; c++) {
            // Bounded coordinate scan over log HD (positive by construction).
            let bx = theta[id].logHd[c], be = Infinity;
            for (let i = 0; i <= 80; i++) { const x = Math.log(0.01) + (Math.log(2) - Math.log(0.01)) * i / 80; theta[id].logHd[c] = x; const e = listLoss(modelFromTheta(theta, lh), train, noiseScale); if (e < be) { be = e; bx = x; } }
            theta[id].logHd[c] = bx;
            let bo = theta[id].opaque[c], boe = Infinity;
            for (let i = 0; i <= 50; i++) { const x = i / 50; theta[id].opaque[c] = x; const e = listLoss(modelFromTheta(theta, lh), train, noiseScale); if (e < boe) { boe = e; bo = x; } }
            theta[id].opaque[c] = bo;
          }
        }
      }
      const loss = listLoss(modelFromTheta(theta, lh), train, noiseScale);
      if (!best || loss < best.loss) best = { theta, loss };
    }
    const theta = best.theta;
    const model = modelFromTheta(theta, lh);
    // Identifiability: perturbing a constrained parameter must raise the loss.
    const identifiability = {};
    for (const id of ids) {
      identifiability[id] = [0, 1, 2].map(c => {
        const save = theta[id].logHd[c];
        theta[id].logHd[c] = save + Math.log(1.2);
        const up = listLoss(modelFromTheta(theta, lh), train, noiseScale);
        theta[id].logHd[c] = save - Math.log(1.2);
        const dn = listLoss(modelFromTheta(theta, lh), train, noiseScale);
        theta[id].logHd[c] = save;
        return (Math.min(up, dn) - best.loss) > 1e-4 ? 'constrained' : 'weak';
      });
    }
    const unresolved = ids.some(id => (initFit.fits[id] ? initFit.fits[id].channelState : ['unresolved', 'unresolved', 'unresolved']).some(s => s === 'unresolved'));
    // F05: per-channel state from JOINT identifiability (constrained => estimated).
    // When the joint fit cannot constrain a channel, the matrix init state tells a
    // bound (bounded) apart from no information (unresolved). Train-derived only, so
    // corrupting held-out observations never changes it. Carried in params[id].state.
    const channelStates = {};
    for (const id of ids) {
      const ist = (initFit.fits[id] && initFit.fits[id].channelState) || ['unresolved', 'unresolved', 'unresolved'];
      channelStates[id] = [0, 1, 2].map(c => identifiability[id][c] === 'constrained' ? 'estimated' : (ist[c] === 'unresolved' ? 'unresolved' : 'bounded'));
      theta[id].state = channelStates[id].slice();
    }
    const devDE = meanDE(model, bySplit.dev, lh), testDE = meanDE(model, bySplit.test, lh);
    const tolerance = Number(opts.tolerance) || 6;
    const publishable = !unresolved && testDE != null && testDE <= tolerance;
    const modelId = cd().makeModelId(theta, [manifest.manifestHash]);
    return {
      model: { modelId, params: theta, status: publishable ? 'published' : 'restricted', compatibilityDomain: { layerHeightMm: lh }, trainLoss: best.loss },
      trainLoss: best.loss, devDE, testDE, identifiability, unresolved, publishable,
      splits: { train: train.length, dev: bySplit.dev.length, test: bySplit.test.length }
    };
  }

  /* Atomic publish: returns a NEW v2 block with the model appended and activeModelId
     switched, or null (caller keeps the old active model) when not publishable. */
  function publishModel(v2, fitted) {
    if (!fitted || !fitted.publishable) return null;
    const base = v2 && v2.schemaVersion === 2 ? v2 : cd().emptyV2();
    const entry = { modelId: fitted.model.modelId, params: fitted.model.params, status: 'published', compatibilityDomain: fitted.model.compatibilityDomain, metrics: { devDE: fitted.devDE, testDE: fitted.testDE } };
    return { ...base, models: [...(base.models || []), entry], activeModelId: entry.modelId };
  }

  /* Analyse a printed combo board photo: locate the 4 corner markers (dark on the
     white half, bright on the black half), build the manifest->pixel homography,
     sample each cell's top colour and its half's substrate, then joint-fit. */
  function components(mask, w, h, minArea, maxArea) {
    const seen = new Uint8Array(w * h), out = [];
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || seen[s]) continue;
      const stack = [s]; seen[s] = 1; let area = 0, sx = 0, sy = 0, minX = w, maxX = 0, minY = h, maxY = 0;
      while (stack.length) {
        const i = stack.pop(); area++; const x = i % w, y = (i / w) | 0; sx += x; sy += y;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx; if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
      if (area >= minArea && area <= maxArea) out.push({ cx: sx / area, cy: sy / area, area, fill: area / ((maxX - minX + 1) * (maxY - minY + 1)) });
    }
    return out;
  }
  function analyzeComboPhoto(imageData, manifest, palette, opts = {}) {
    const w = imageData.width, h = imageData.height, d = imageData.data;
    const lum = i => 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    const dark = new Uint8Array(w * h), bright = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) { const y = lum(i); dark[i] = y < 70 ? 1 : 0; bright[i] = y > 120 ? 1 : 0; }
    // Auto-detect the 4 corner pads as small isolated squares (area window excludes
    // the large colour cells). Not hardcoded to any one photo.
    const top = components(dark, w, h, 60, 2000).filter(c => c.cy < h * 0.5 && c.fill > 0.6);
    const bot = components(bright, w, h, 60, 2000).filter(c => c.cy > h * 0.5 && c.fill > 0.6);
    let TL, TR, BL, BR;
    if (opts.markers) { ({ TL, TR, BL, BR } = opts.markers); }
    else {
      if (top.length < 2 || bot.length < 2) throw new Error('找不到四个角定位点（上黑下白）');
      TL = top.reduce((a, b) => a.cx < b.cx ? a : b); TR = top.reduce((a, b) => a.cx > b.cx ? a : b);
      BL = bot.reduce((a, b) => a.cx < b.cx ? a : b); BR = bot.reduce((a, b) => a.cx > b.cx ? a : b);
    }
    const imgCorners = [TL, TR, BR, BL];
    const pxPerMm = Math.hypot(TR.cx - TL.cx, TR.cy - TL.cy) / (manifest.boardW - 4);
    const r = Math.max(2, Math.round(pxPerMm * 1.5));
    // Auto-select board<->photo orientation (identity/mirrorX/mirrorY/rot180) by
    // thick-anchor hue-class agreement, so a mirrored/rotated capture still aligns.
    const M = manifest.markers;
    const perms = { identity: [M[0], M[1], M[2], M[3]], mirrorX: [M[1], M[0], M[3], M[2]], mirrorY: [M[3], M[2], M[1], M[0]], rot180: [M[2], M[3], M[0], M[1]] };
    const thick = manifest.cells.filter(c => c.type === 'single' && c.stack[0].layerCount >= 4);
    let bestOrient = 'identity', bestScore = -1, map = null;
    for (const [name, bc] of Object.entries(perms)) {
      const mp = CS.batchCalibration.homography(bc, imgCorners);
      let score = 0;
      for (const c of thick) { const s = CS.batchCalibration.sampleMedian(imageData, mp, c.cx, c.cy, r); if (hueClass(s.rgb) === c.stack[0].materialId) score++; }
      if (score > bestScore) { bestScore = score; bestOrient = name; map = mp; }
    }
    const observations = manifest.cells.map(cell => {
      const s = CS.batchCalibration.sampleMedian(imageData, map, cell.cx, cell.cy, r);
      // Substrate ROI must be NARROWER than the ~16px inter-cell gap so the window
      // never reaches into a neighbouring colour cell (review F3/三.1).
      const rSub = Math.max(2, Math.round(pxPerMm * 0.5));
      const gap = cell.size / 2 + 1;
      const sL = CS.batchCalibration.sampleMedian(imageData, map, cell.cx - gap, cell.cy, rSub);
      const sR = CS.batchCalibration.sampleMedian(imageData, map, cell.cx + gap, cell.cy, rSub);
      const sub = [0, 1, 2].map(c => Math.round((sL.rgb[c] + sR.rgb[c]) / 2));
      return {
        cellId: cell.cellId,
        observedLinear: s.rgb.map(v => C.srgbToLinear(v / 255)),
        substrateLinear: sub.map(v => C.srgbToLinear(v / 255)),
        channelsOk: s.rgb.map(v => v > 2 && v < 254)
      };
    });
    const fit = fitJointModel(observations, manifest, opts);
    return { observations, markers: { TL, TR, BL, BR }, pxPerMm, orientation: bestOrient, anchorMatch: bestScore + '/' + thick.length, fit };
  }
  function hueClass(rgb) {
    const [r, g, b] = rgb.map(v => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    if (sat < 0.12) return mx < 0.3 ? 'k' : 'w';
    let hue;
    if (mx === r) hue = 60 * (((g - b) / (mx - mn)) % 6);
    else if (mx === g) hue = 60 * ((b - r) / (mx - mn) + 2);
    else hue = 60 * ((r - g) / (mx - mn) + 4);
    if (hue < 0) hue += 360;
    if (hue >= 15 && hue < 45) return 'o';
    if (hue >= 45 && hue < 75) return 'y';
    if (hue >= 180 && hue < 230) return 'c';
    if (hue >= 290 && hue < 345) return 'm';
    return '?';
  }
  /* Relative-calibration white-balance: with no independent reference card, use the
     thickest white-on-white anchor as a neutral-white reference to derive per-channel
     camera gain, then divide it out of every observation/substrate so the fit runs in
     consistent scene space. This is an explicit assumption (white-as-neutral), valid
     for relative calibration only. Returns gain to re-apply when rendering. */
  function normalizeWhite(observations, manifest) {
    const ref = observations.find(o => {
      const c = manifest.cells.find(x => x.cellId === o.cellId);
      return c && c.base === 'W' && c.stack.length === 1 && c.stack[0].materialId === 'w' && c.stack[0].layerCount === 8;
    });
    const gain = ref ? ref.observedLinear.map(v => Math.max(0.2, v)) : [1, 1, 1];
    // Do NOT silently clip: keep raw normalized values and mark channels that exceed
    // the white reference as censored (channelsOk=false) so the fit treats them as
    // bounds/invalid, not precise measurements (review 三.2).
    const norm = observations.map(o => {
      const ol = o.observedLinear.map((v, c) => v / gain[c]);
      const sl = o.substrateLinear.map((v, c) => v / gain[c]);
      return {
        ...o, observedLinear: ol, substrateLinear: sl,
        channelsOk: o.channelsOk.map((ok, c) => ok && ol[c] <= 1.0 && ol[c] >= 0),
        clipped: o.channelsOk.map((ok, c) => ok && ol[c] > 1.0)
      };
    });
    return { observations: norm, gain };
  }

  CS.calibrationJoint = { buildComboManifest, fitJointModel, publishModel, modelFromTheta, buildComboBoard3MF, buildComboBoardBlob, analyzeComboPhoto, normalizeWhite };
})(typeof globalThis !== 'undefined' ? globalThis : this);