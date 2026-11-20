/* ChromaStack joint combination calibration (P2). Fits shared per-material
   (log HD_R/G/B, opaqueLinear_R/G/B) against combination observations using the
   SAME optics.predictStack as production. Train / dev / test splits are frozen
   from the manifest; the fitter reads ONLY train. Identifiability is checked by
   parameter perturbation; publishing is atomic and refuses to overwrite the
   active model when the fit is unresolved or fails the held-out tolerance.
   Synthetic recovery here is program validity, NOT physical acceptance. */
(function (root) {
  const CS = root.CS = root.CS || {};
  const C = CS.color, O = CS.optics, CD = CS.calibrationData, B = CS.batchCalibration, M = CS.matrixCalibration;
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
    const manifest = { schemaVersion: 1, boardId: 'combo-' + ids.length, layerHeight: lh, cells, references: [{ kind: 'independent-white', linear: [1, 1, 1] }] };
    manifest.manifestHash = CD.manifestHash(manifest);
    return manifest;
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
      for (let sweep = 0; sweep < 2; sweep++) {
        for (const id of ids) {
          for (let c = 0; c < 3; c++) {
            // Bounded coordinate scan over log HD (positive by construction).
            let bx = theta[id].logHd[c], be = Infinity;
            for (let i = 0; i <= 60; i++) { const x = Math.log(0.01) + (Math.log(2) - Math.log(0.01)) * i / 60; theta[id].logHd[c] = x; const e = listLoss(modelFromTheta(theta, lh), train, noiseScale); if (e < be) { be = e; bx = x; } }
            theta[id].logHd[c] = bx;
            let bo = theta[id].opaque[c], boe = Infinity;
            for (let i = 0; i <= 40; i++) { const x = i / 40; theta[id].opaque[c] = x; const e = listLoss(modelFromTheta(theta, lh), train, noiseScale); if (e < boe) { boe = e; bo = x; } }
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
    const devDE = meanDE(model, bySplit.dev, lh), testDE = meanDE(model, bySplit.test, lh);
    const tolerance = Number(opts.tolerance) || 6;
    const publishable = !unresolved && testDE != null && testDE <= tolerance;
    const modelId = CD.makeModelId(theta, [manifest.manifestHash]);
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
    const base = v2 && v2.schemaVersion === 2 ? v2 : CD.emptyV2();
    const entry = { modelId: fitted.model.modelId, params: fitted.model.params, status: 'published', compatibilityDomain: fitted.model.compatibilityDomain, metrics: { devDE: fitted.devDE, testDE: fitted.testDE } };
    return { ...base, models: [...(base.models || []), entry], activeModelId: entry.modelId };
  }

  CS.calibrationJoint = { buildComboManifest, fitJointModel, publishModel, modelFromTheta };
})(typeof globalThis !== 'undefined' ? globalThis : this);