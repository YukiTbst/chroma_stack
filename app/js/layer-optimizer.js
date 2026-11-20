/* ChromaStack same-layer material continuity coordination (P4). Decision units are
   SPATIAL regions (connected, locks split out), not global colour families. Each
   region keeps several feasible near-color candidate stacks; the optimizer chooses
   a combination that reduces internal material boundary / per-layer material
   activation WITHIN a fixed per-region colour budget, using ABSOLUTE Z. It never
   erodes hard constraints (locks / neutrality / line members are checked by the
   caller before candidates are offered). With no beneficial feasible move it
   returns the baseline unchanged. Heuristic — not a global-optimum claim. */
(function (root) {
  const CS = root.CS = root.CS || {};
  const C = CS.color, O = CS.optics;

  function coordinateLayers(input) {
    const { model, boundaryLinear, layerThicknessMm, regions, lambdaB = 1, lambdaA = 0.2, colorBudget = 2, maxPasses = 3 } = input;
    const lh = layerThicknessMm;
    const L = regions[0].stack.length;
    const predLab = stack => O.predictStack(model, stack.map(m => ({ materialId: m, layerCount: 1 })), { linearRgb: boundaryLinear }, lh).lab;
    const de = (stack, lab) => C.deltaE2000(predLab(stack), lab);
    const feasible = (r, stack) => !r.locked && stack.length === L && de(stack, r.lab) <= colorBudget;
    const colorCost = assign => regions.reduce((s, r, i) => s + r.area * de(assign[i], r.lab), 0);
    const boundaryCost = assign => {
      let b = 0;
      for (const r of regions) for (const e of (r.edges || [])) {
        if (e.to <= r.id) continue; // count each internal edge once
        const s = assign[e.to];
        const a = assign[r.id];
        for (let z = 0; z < L; z++) if (a[z] !== s[z]) b += e.sharedMm * lh;
      }
      return b;
    };
    const activationCost = assign => {
      let a = 0;
      for (let z = 0; z < L; z++) { const set = new Set(); for (const st of assign) set.add(st[z]); a += set.size; }
      return a;
    };
    const J = assign => colorCost(assign) + lambdaB * boundaryCost(assign) + lambdaA * activationCost(assign);
    const assign = regions.map(r => r.stack.slice());
    const baseline = assign.map(s => s.slice());
    const baseJ = J(baseline), baseB = boundaryCost(baseline);
    const cand = regions.map(r => (r.candidates || []).filter(s => feasible(r, s)));
    let improved = false;
    for (let pass = 0; pass < maxPasses; pass++) {
      let changed = false;
      for (let i = 0; i < regions.length; i++) {
        let best = null, bestJ = J(assign);
        for (const s of cand[i]) {
          const old = assign[i]; assign[i] = s;
          const j = J(assign);
          assign[i] = old;
          if (j < bestJ - 1e-9) { bestJ = j; best = s; }
        }
        if (best) { assign[i] = best; changed = true; }
      }
      // pairwise moves escape single-region local minima
      for (const r of regions) for (const e of (r.edges || [])) {
        const i = r.id, j = e.to; if (j <= i) continue;
        let best = null, bestJ = J(assign);
        for (const sa of cand[i]) for (const sb of cand[j]) {
          const oi = assign[i], oj = assign[j]; assign[i] = sa; assign[j] = sb;
          const jj = J(assign);
          assign[i] = oi; assign[j] = oj;
          if (jj < bestJ - 1e-9) { bestJ = jj; best = [sa, sb]; }
        }
        if (best) { assign[i] = best[0]; assign[j] = best[1]; changed = true; }
      }
      if (!changed) break;
      improved = true;
    }
    // final exact feasibility re-check; any violation -> revert to baseline
    const ok = regions.every((r, i) => feasible(r, assign[i]));
    const finalAssign = ok ? assign : baseline;
    return {
      assignment: finalAssign, improved: improved && ok,
      baselineJ: baseJ, finalJ: J(finalAssign),
      boundaryBefore: baseB, boundaryAfter: boundaryCost(finalAssign),
      reverted: !ok
    };
  }

  /* Spatial region graph from a plan: 4-connected components of same surface key,
     locked pixels split into their own region; edge weight = shared boundary mm. */
  function buildRegionGraph(plan, pixelSize, lockedMask) {
    const n = plan.n, w = plan.w, h = plan.h;
    const key = i => plan.flatMask[i] ? ('f' + plan.flatFilament[i]) : ('g' + plan.familyId[i]);
    const regionOf = new Int32Array(n).fill(-1);
    const regions = [];
    for (let s = 0; s < n; s++) {
      if (regionOf[s] !== -1 || !plan.printMask[s]) continue;
      const lock = lockedMask && lockedMask[s];
      const k = key(s) + (lock ? '|L' : '');
      const id = regions.length; const stack = [s]; regionOf[s] = id;
      const members = [s];
      while (stack.length) {
        const i = stack.pop(); const x = i % w, y = (i / w) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (regionOf[j] !== -1 || !plan.printMask[j]) continue;
          const lj = lockedMask && lockedMask[j];
          if (key(j) + (lj ? '|L' : '') !== k) continue;
          regionOf[j] = id; stack.push(j); members.push(j);
        }
      }
      regions.push({ id, members, locked: !!lock, area: members.length * pixelSize * pixelSize });
    }
    const edgeMap = new Map();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!plan.printMask[i]) continue;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const xx = x + dx, yy = y + dy; if (xx >= w || yy >= h) continue;
        const j = yy * w + xx; if (!plan.printMask[j]) continue;
        const a = regionOf[i], b = regionOf[j]; if (a === b || a < 0 || b < 0) continue;
        const ek = Math.min(a, b) + '-' + Math.max(a, b);
        edgeMap.set(ek, (edgeMap.get(ek) || 0) + pixelSize);
      }
    }
    for (const r of regions) r.edges = [];
    for (const [ek, mm] of edgeMap) {
      const [a, b] = ek.split('-').map(Number);
      regions[a].edges.push({ to: b, sharedMm: mm });
      regions[b].edges.push({ to: a, sharedMm: mm });
    }
    return { regions, regionOf };
  }

  CS.layerOptimizer = { coordinateLayers, buildRegionGraph };
})(typeof globalThis !== 'undefined' ? globalThis : this);