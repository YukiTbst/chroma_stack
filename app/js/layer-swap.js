/* ChromaStack layerSwap (逐层换色) — R1 core. One global material sequence S[z]; every
   printed pixel is a prefix of S up to its integer stop height H[p]. Single-layer-single-
   material, nested occupancy, non-uniform first layer via d[z]/Z[k], measured-substrate OR
   modeled-support boundary (never both). Non-adjacent repeat segments are first-class.
   Reuses the shared optics kernel and effective material params (no nominal bypass).
   Contract: spec v1.1 §3/§5/§6/§11/§13. */
(function (root) {
  'use strict';
  const CS = root.CS = root.CS || {};
  const C = CS.color, O = CS.optics;
  const SOLVER = 'ls-r1-1';

  function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); }

  // segments -> layerMaterial / thickness / cumulative Z. segments is the single source.
  function expandSegments(segments, firstMm, restMm) {
    const layerMaterial = [], layerThicknessMm = [], layerZMm = [0];
    const segOfLayer = [];
    segments.forEach((sg, si) => {
      for (let j = 0; j < sg.layerCount; j++) {
        layerMaterial.push(sg.materialId);
        segOfLayer.push(si);
        layerThicknessMm.push(layerMaterial.length === 1 ? firstMm : restMm);
        layerZMm.push(layerZMm[layerZMm.length - 1] + layerThicknessMm[layerThicknessMm.length - 1]);
      }
    });
    return { layerMaterial, layerThicknessMm, layerZMm, segOfLayer };
  }

  // Prefix table. boundary may be a measured substrate reflectance (linearRgb) that already
  // represents the first b physical layers (supportStartLayers): P[b]=boundary and only
  // S[b:k] is simulated; allowed stop heights >= b. Never double-count the base (P2-04).
  function prefixTable(model, layerMaterial, layerThicknessMm, boundary, fromK, cached) {
    const b = (boundary && boundary.supportStartLayers) || 0;
    const P = cached ? cached.slice(0, fromK) : [];
    if (!cached) {
      for (let k = 0; k <= Math.min(b, layerMaterial.length); k++) P[k] = O.predictStack(model, [], boundary, null);
    }
    for (let k = Math.max(1, fromK); k <= layerMaterial.length; k++) {
      if (k <= b) { P[k] = O.predictStack(model, [], boundary, null); continue; }
      const stack = [];
      for (let z = b; z < k; z++) stack.push({ materialId: layerMaterial[z], thicknessMm: layerThicknessMm[z] });
      P[k] = O.predictStack(model, stack, boundary, null);
    }
    return P;
  }

  function materialAt(plan, p, z) {
    if (plan.printMask && !plan.printMask[p]) return -1;
    if (z >= plan.topLayer[p]) return -1;
    return plan.layerMaterial[z];
  }

  function anchorHas(a, p, w) {
    if (a.mask) return !!a.mask[p];
    if (a.region) { const x = p % w, y = (p / w) | 0; return x >= a.region.x0 && x < a.region.x1 && y >= a.region.y0 && y < a.region.y1; }
    return false;
  }
  function segmentLayerRange(plan, segmentId) {
    let start = 0;
    for (let i = 0; i < plan.segments.length; i++) {
      const c = plan.segments[i].layerCount;
      if (plan.segments[i].segmentId === segmentId) return [start, start + c];
      start += c;
    }
    return null;
  }
  // Hard constraints INTERSECT (order-independent); weight anchors stay separate (P2-02).
  function rangeFor(plan, p, w) {
    let lo = plan.minLayers, hi = plan.maxLayers; const conflicts = [];
    for (const a of plan.anchors || []) {
      if (!anchorHas(a, p, w)) continue;
      if (a.type === 'fixedHeight') {
        const v = a.value;
        if (v < plan.minLayers || v > plan.maxLayers) conflicts.push({ anchor: a, reason: 'fixedHeight out of range' });
        lo = Math.max(lo, v); hi = Math.min(hi, v);
      } else if (a.type === 'topSegment') {
        const r = segmentLayerRange(plan, a.segmentId);
        if (!r) { conflicts.push({ anchor: a, reason: 'segment missing' }); continue; }
        lo = Math.max(lo, r[0] + 1); hi = Math.min(hi, r[1]);
      }
    }
    if (lo > hi) conflicts.push({ p, reason: 'hard constraints intersect empty' });
    return { lo, hi, conflicts };
  }

  function buildPlan(image, opts) {
    const w = image.width, h = image.height, n = w * h;
    const firstMm = opts.firstLayerMm != null ? opts.firstLayerMm : 0.2;
    const restMm = opts.layerMm != null ? opts.layerMm : 0.08;
    if (!(firstMm > 0) || !(restMm > 0)) throw new Error('layerSwap: layer thickness must be > 0');
    // SAME effective params as spatialMix: tdR/G/B->hdR/G/B normalization + active optical
    // model (calibrationV2). No nominal-parameter prediction bypass (review P1-01).
    const eff = CS.engine.effectivePalette(opts.palette, opts, restMm);
    const palette = eff.palette;
    const matIndex = new Map();
    palette.forEach((p, i) => { if (p.id != null && p.id !== '') matIndex.set(p.id, i); if (p.name != null) matIndex.set(p.name, i); });
    const model = { materials: {} };
    for (const p of palette) { if (p.id != null && p.id !== '') model.materials[p.id] = p; if (p.name != null) model.materials[p.name] = p; }
    const segments = (opts.segments || []).map((s, i) => ({ segmentId: s.segmentId != null ? s.segmentId : i, materialId: s.materialId, layerCount: Math.max(1, Math.min(40, Math.round(s.layerCount || 1))), locked: !!s.locked }));
    const exp = expandSegments(segments, firstMm, restMm);
    const L = exp.layerMaterial.length;
    if (L > 240) throw new Error('layerSwap: total layers exceed resource cap 240');
    // map materialId -> palette index for export
    const layerMaterialIdx = exp.layerMaterial.map(id => matIndex.get(id));
    const unknown = exp.layerMaterial.filter((id, i) => layerMaterialIdx[i] == null);
    if (unknown.length) throw new Error('layerSwap: segment references unknown material: ' + [...new Set(unknown)].join(', '));
    const boundary = opts.boundary || { linearRgb: { r: 1, g: 1, b: 1 } };
    const baseStart = (boundary && boundary.supportStartLayers) || 0;
    const P = prefixTable(model, exp.layerMaterial, exp.layerThicknessMm, boundary, 1, null);
    const conflicts = [];
    let minLayers = Math.max(1, Math.round(opts.minLayers != null ? opts.minLayers : 1), baseStart);
    const maxLayers = L;
    if (minLayers > maxLayers) { conflicts.push({ reason: 'minLayers exceeds total layers', minLayers, maxLayers }); minLayers = maxLayers; }
    const printMask = opts.printMask || null;
    // target Lab
    const target = new Array(n);
    for (let i = 0; i < n; i++) { const p = i * 4; target[i] = C.rgb255ToLab({ r: image.data[p], g: image.data[p + 1], b: image.data[p + 2] }); }
    const anchors = opts.anchors || [];
    const prefs = Object.assign({ hue: 0, luma: 0, smooth: 1 }, opts.prefs || {});
    const plan = {
      printStrategy: 'layerSwap', schemaVersion: 2, palette, segments,
      layerMaterial: layerMaterialIdx, layerMaterialId: exp.layerMaterial, segOfLayer: exp.segOfLayer,
      layerThicknessMm: exp.layerThicknessMm, layerZMm: exp.layerZMm,
      maxLayers, minLayers, printMask, topLayer: new Int16Array(n),
      prefixPrediction: P.map((pp, k) => ({ k, lab: pp.lab, linearRgb: pp.linearRgb, zMm: exp.layerZMm[k], warnings: pp.warnings })),
      anchors, prefs, w, h, widthMm: opts.widthMm || 150, heightMm: (opts.widthMm || 150) * h / w,
      pixelSize: (opts.widthMm || 150) / w, layerHeight: restMm, firstLayerMm: firstMm,
      lineWidthMm: opts.lineWidthMm != null ? opts.lineWidthMm : 0.42,
      boundary, baseStart, solverVersion: SOLVER, seed: opts.seed != null ? opts.seed : 1,
      modelRef: eff.modelRef, effectiveParamsHash: eff.effectiveParamsHash, opticalModel: opts.opticalModel || null,
      stats: {}, fitMetrics: null, structuralDiagnostics: null, conflicts, fixInfeasible: false
    };
    // edge weights from target gradient (low at strong edges)
    const edgeW = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      const x = p % w, y = (p / w) | 0; let g = 0;
      if (x + 1 < w) g = Math.max(g, C.deltaE2000(target[p], target[p + 1]));
      if (y + 1 < h) g = Math.max(g, C.deltaE2000(target[p], target[p + w]));
      edgeW[p] = g > 12 ? 0.15 : 1.0;
    }
    const weightOf = p => { let wt = 1; for (const a of anchors) if (a.type === 'weight' && anchorHas(a, p, w)) wt = Math.max(wt, a.value || 3); return wt; };
    // Optional luminance preference (auxiliary, never a hard monotonic constraint).
    const lumaW = 0.3 * (prefs.luma || 0);
    const dE = (p, k) => C.deltaE2000(target[p], P[k].lab) + lumaW * Math.abs(target[p].L - P[k].lab.L);
    // per-pixel top-3 candidates + independent nearest
    const top3 = new Int16Array(n * 3);
    const H = new Int16Array(n);
    const ranges = new Array(n);
    for (let p = 0; p < n; p++) {
      const r = rangeFor(plan, p, w); ranges[p] = r;
      if (r.conflicts.length) plan.conflicts.push(...r.conflicts.map(c => ({ p, ...c })));
      const lo = Math.max(minLayers, r.lo), hi = Math.min(maxLayers, r.hi);
      if (lo > hi) {
        // Unsatisfiable anchor: keep the conflict reported, clamp preview height to a legal
        // value so P[H] stays defined (never silently pretend the lock was satisfied).
        const hc = Math.min(maxLayers, Math.max(minLayers, r.lo));
        H[p] = hc; top3[p * 3] = hc; top3[p * 3 + 1] = hc; top3[p * 3 + 2] = hc;
        continue;
      }
      let best = lo, bd = Infinity; const cand = [];
      for (let k = lo; k <= hi; k++) { const e = dE(p, k); cand.push([e, k]); if (e < bd) { bd = e; best = k; } }
      cand.sort((a, b) => a[0] - b[0]);
      H[p] = best;
      top3[p * 3] = cand[0] ? cand[0][1] : best; top3[p * 3 + 1] = cand[1] ? cand[1][1] : best; top3[p * 3 + 2] = cand[2] ? cand[2][1] : best;
    }
    // ICM spatial consistency (deterministic multi-pass, energy non-increasing)
    const LAMBDA = 0.6 * (prefs.smooth != null ? prefs.smooth : 1), CAP = 0.48, SCALE = 0.24;
    const rho = dz => Math.min(Math.abs(dz), CAP) / SCALE;
    let stopReason = 'icm-passes';
    for (let pass = 0; pass < 3; pass++) {
      let changed = 0;
      for (let p = 0; p < n; p++) {
        const r = ranges[p]; const lo = Math.max(minLayers, r.lo), hi = Math.min(maxLayers, r.hi);
        if (lo > hi) continue;
        const x = p % w, y = (p / w) | 0;
        const nb = []; if (x > 0) nb.push(p - 1); if (x + 1 < w) nb.push(p + 1); if (y > 0) nb.push(p - w); if (y + 1 < h) nb.push(p + w);
        const cands = new Set([H[p], top3[p * 3], top3[p * 3 + 1], top3[p * 3 + 2]]);
        for (const q of nb) cands.add(H[q]);
        let bk = H[p], be = Infinity;
        for (const k of cands) {
          if (k < lo || k > hi) continue;
          let e = weightOf(p) * dE(p, k);
          for (const q of nb) e += LAMBDA * Math.min(edgeW[p], edgeW[q]) * rho(exp.layerZMm[k] - exp.layerZMm[H[q]]);
          if (e < be) { be = e; bk = k; }
        }
        if (bk !== H[p]) { H[p] = bk; changed++; }
      }
      if (!changed) { stopReason = 'icm-converged'; break; }
    }
    plan.topLayer = H;
    // Fix-heights mode: validate against the NEW sequence + hard anchors BEFORE applying;
    // if incompatible flag it so the app keeps the previous valid plan (P1-05).
    if (opts.fixTopLayer && opts.fixTopLayer.length === n) {
      let ok = true;
      for (let p = 0; p < n; p++) {
        const v = opts.fixTopLayer[p], r = ranges[p];
        if (v < minLayers || v > maxLayers || v < r.lo || v > r.hi) { ok = false; break; }
      }
      if (ok) plan.topLayer = Int16Array.from(opts.fixTopLayer);
      else { plan.fixInfeasible = true; conflicts.push({ reason: 'fixed heights incompatible with new sequence/anchors' }); }
    }
    plan.stopReason = stopReason;
    // Finished-mix preview = P[H]. labToRgb01 already returns sRGB — do NOT re-encode (P1-02).
    // AIR (printMask=0) pixels transparent so preview/stats/geometry agree (P1-06).
    const preview = new Uint8ClampedArray(n * 4);
    for (let p = 0; p < n; p++) {
      if (printMask && !printMask[p]) { preview[p * 4 + 3] = 0; continue; }
      const rgb = C.labToRgb01(P[plan.topLayer[p]].lab);
      preview[p * 4] = Math.round(rgb.r * 255);
      preview[p * 4 + 1] = Math.round(rgb.g * 255);
      preview[p * 4 + 2] = Math.round(rgb.b * 255);
      preview[p * 4 + 3] = 255;
    }
    plan.preview = preview;
    plan.flatMask = printMask ? Uint8Array.from(printMask) : new Uint8Array(n).fill(1);
    plan.fitMetrics = computeMetrics(plan, target, edgeW, w, h);
    plan.structuralDiagnostics = structural(plan, w, h);
    plan.inputHash = hashStr(JSON.stringify({
      w, h, segments, firstMm, restMm, minLayers, baseStart,
      effectiveParamsHash: eff.effectiveParamsHash, modelRef: eff.modelRef,
      boundary: boundary.linearRgb || boundary.supportStack || null, prefs,
      anchors: anchors.map(a => ({ type: a.type, region: a.region, value: a.value, segmentId: a.segmentId })),
      printMaskSample: printMask ? Array.from(printMask.filter((_, i) => i % 131 === 0)) : null,
      seed: plan.seed, sample: target.filter((_, i) => i % 97 === 0).map(t => [t.L | 0, t.a | 0, t.b | 0])
    }));
    return plan;
  }

  function computeMetrics(plan, target, edgeW, w, h) {
    const n = w * h, P = plan.prefixPrediction, H = plan.topLayer, pm = plan.printMask;
    let sum = 0, mx = 0, rsum = 0, rn = 0, cnt = 0; const errs = [];
    const region = (plan.anchors.find(a => a.type === 'weight') || {}).region;
    for (let p = 0; p < n; p++) {
      if (pm && !pm[p]) continue; // AIR excluded from stats (P1-06)
      const e = C.deltaE2000(target[p], P[H[p]].lab); errs.push(e); sum += e; cnt++; if (e > mx) mx = e;
      if (region) { const x = p % w, y = (p / w) | 0; if (x >= region.x0 && x < region.x1 && y >= region.y0 && y < region.y1) { rsum += e; rn++; } }
    }
    errs.sort((a, b) => a - b);
    let jump = 0, jn = 0, iso = 0;
    for (let p = 0; p < n; p++) {
      if (pm && !pm[p]) continue;
      const x = p % w, y = (p / w) | 0;
      if (edgeW[p] > 0.5 && x + 1 < w && edgeW[p + 1] > 0.5 && (!pm || pm[p + 1])) { jump += Math.abs(plan.layerZMm[H[p]] - plan.layerZMm[H[p + 1]]); jn++; }
      let big = 0, nb = 0;
      if (x > 0 && (!pm || pm[p - 1])) { nb++; if (Math.abs(plan.layerZMm[H[p]] - plan.layerZMm[H[p - 1]]) > 0.16) big++; }
      if (x + 1 < w && (!pm || pm[p + 1])) { nb++; if (Math.abs(plan.layerZMm[H[p]] - plan.layerZMm[H[p + 1]]) > 0.16) big++; }
      if (y > 0 && (!pm || pm[p - w])) { nb++; if (Math.abs(plan.layerZMm[H[p]] - plan.layerZMm[H[p - w]]) > 0.16) big++; }
      if (y + 1 < h && (!pm || pm[p + w])) { nb++; if (Math.abs(plan.layerZMm[H[p]] - plan.layerZMm[H[p + w]]) > 0.16) big++; }
      if (edgeW[p] > 0.5 && nb && big >= 3) iso++;
    }
    return { meanDE: cnt ? sum / cnt : 0, p90: errs.length ? errs[Math.floor(errs.length * 0.9)] : 0, maxDE: mx, regionDE: rn ? rsum / rn : null, flatJumpMm: jn ? jump / jn : 0, isolatedJumps: iso, printedPixels: cnt };
  }

  // Per-layer manufacturability audit at the configured nozzle line width (P2-04).
  function structural(plan, w, h) {
    const out = []; const H = plan.topLayer, n = w * h, pm = plan.printMask;
    const minCells = Math.max(1, Math.round((plan.lineWidthMm || 0.42) / plan.pixelSize));
    for (let z = 0; z < plan.maxLayers; z++) {
      let occ = 0, narrow = 0, single = 0;
      for (let p = 0; p < n; p++) {
        if (H[p] <= z || (pm && !pm[p])) continue; occ++;
        const x = p % w, y = (p / w) | 0; let nb = 0;
        if (x > 0 && H[p - 1] > z) nb++; if (x + 1 < w && H[p + 1] > z) nb++; if (y > 0 && H[p - w] > z) nb++; if (y + 1 < h && H[p + w] > z) nb++;
        if (nb < 2) narrow++; if (nb === 0) single++;
      }
      out.push({ layer: z, occupied: occ, narrowCells: narrow, isolatedCells: single, minCellsForNozzle: minCells });
    }
    return out;
  }

  // F-05: fixed-order integer segment-length optimization. Baseline ALWAYS retained;
  // baseline/candidates/application share the SAME hard constraints (incl. fixTopLayer) and
  // scoring (P2-01). Budget spread over ALL adjacent boundaries, both directions.
  function optimizeSegmentLengths(image, plan, opts) {
    const o = opts || {};
    const maxTrials = o.maxTrials != null ? o.maxTrials : 2 * Math.max(1, plan.segments.length - 1);
    const base = plan.segments.map(s => ({ ...s }));
    const baseline = { segments: base, metrics: plan.fitMetrics, isBaseline: true };
    const trials = [];
    const seen = new Set([base.map(s => s.layerCount).join(',')]);
    const push = (counts) => {
      const key = counts.join(','); if (seen.has(key)) return; seen.add(key);
      if (trials.length >= maxTrials) return;
      const segs = base.map((s, i) => ({ ...s, layerCount: counts[i] }));
      const total = segs.reduce((a, s) => a + s.layerCount, 0);
      const thick = plan.firstLayerMm + (total - 1) * plan.layerHeight;
      if (o.maxThicknessMm != null && thick > o.maxThicknessMm) return;
      if (segs.some((s, i) => s.locked && s.layerCount !== base[i].layerCount)) return;
      const p2 = buildPlan(image, { ...optsToPlan(plan, o), segments: segs });
      if (p2.fixInfeasible) return; // discard conflicting candidates
      trials.push({ segments: segs, counts: key, metrics: p2.fitMetrics, thicknessMm: thick });
    };
    const counts0 = base.map(s => s.layerCount);
    for (const dir of [1, -1]) for (let i = 0; i < base.length - 1; i++) {
      const c = counts0.slice(); c[i] += dir; c[i + 1] -= dir;
      if (c[i] < 1 || c[i + 1] < 1) continue; push(c);
    }
    let best = baseline;
    for (const t of trials) if (t.metrics.meanDE < best.metrics.meanDE) best = t;
    return { baseline, trials, best, stopReason: trials.length >= maxTrials ? 'budget' : 'exhausted-local' };
  }
  function optsToPlan(plan, o) {
    return {
      palette: plan.palette, firstLayerMm: plan.firstLayerMm, layerMm: plan.layerHeight,
      boundary: plan.boundary, minLayers: plan.minLayers, anchors: plan.anchors, prefs: plan.prefs,
      printMask: plan.printMask, widthMm: plan.widthMm, seed: plan.seed, lineWidthMm: plan.lineWidthMm,
      opticalModel: (o && o.opticalModel) || plan.opticalModel || null,
      fixTopLayer: (o && o.fixTopLayer) || null
    };
  }

  // §13.2 change list. Adjacent same-material segments are NOT a swap (kind 'continue');
  // only segments reached by some printed pixel produce entries (P1-06 / P2-04).
  function changeList(plan) {
    const pm = plan.printMask; let maxH = 0;
    for (let p = 0; p < plan.topLayer.length; p++) if ((!pm || pm[p]) && plan.topLayer[p] > maxH) maxH = plan.topLayer[p];
    const out = []; let start = 0; let prevLast = 0; let prevMat = null;
    plan.segments.forEach((sg, i) => {
      const c = sg.layerCount;
      const mat = plan.layerMaterialId[start];
      if (start < maxH) {
        const kind = i === 0 ? 'first-load' : (mat === prevMat ? 'continue' : 'change');
        out.push({ segmentId: sg.segmentId, materialId: mat, kind, startLayer1: start + 1, bottomZmm: plan.layerZMm[start], topZmm: plan.layerZMm[start + 1], prevSegmentLastLayer1: i === 0 ? null : prevLast });
      }
      prevMat = mat; prevLast = start + c; start += c;
    });
    return out;
  }

  CS.layerSwap = { buildPlan, optimizeSegmentLengths, changeList, materialAt, expandSegments, prefixTable, segmentLayerRange, SOLVER };
})(typeof globalThis !== 'undefined' ? globalThis : this);