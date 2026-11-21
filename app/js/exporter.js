/* ChromaStack exporters: preview PNG helpers (browser), print plan JSON/Markdown,
   and slicer-ready multi-material 3MF (one assembly object, one watertight part
   per colour / contiguous layer run). */
(function (root) {
  'use strict';
  const CS = root.CS = root.CS || {};
  const C = CS.color;

  const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const round = (v, d = 4) => {
    const p = Math.pow(10, d);
    return Math.round(v * p) / p;
  };

  function samplePlane(plan, ew, eh) {
    if (ew === plan.w && eh === plan.h) {
      // Native export must be the exact plan shown by the web layer/3D views.
      // Do not run another regional vote or cleanup at identical resolution.
      return {
        ew, eh,
        flatMask: new Uint8Array(plan.flatMask),
        flatFilament: new Uint16Array(plan.flatFilament),
        familyId: new Int16Array(plan.familyId),
        printMask: plan.printMask ? new Uint8Array(plan.printMask) : null,
        // F08: native export must carry the coordinated region recipes too, else
        // buildLayerMasks falls back to pre-coordination family recipes.
        regionOf: plan.regionOf ? new Int32Array(plan.regionOf) : null,
        regionRecipes: plan.regionRecipes || null,
        structureCleanup: null,
        changeStats: { sourcePixels: 0, changedPixels: 0, changedPercent: 0 }
      };
    }
    // Nearest-centre downsampling can turn one source pixel into a new island,
    // even after the engine removed every such island. Vote over the actual
    // source footprint instead. Protected/direct strokes win a tie so a thin
    // continuous outline is not erased merely by its alignment to the grid.
    const x0 = new Int32Array(ew), x1 = new Int32Array(ew);
    const y0 = new Int32Array(eh), y1 = new Int32Array(eh);
    for (let x = 0; x < ew; x++) {
      x0[x] = Math.min(plan.w - 1, Math.floor(x * plan.w / ew));
      x1[x] = Math.min(plan.w, Math.max(x0[x] + 1, Math.floor((x + 1) * plan.w / ew)));
    }
    for (let y = 0; y < eh; y++) {
      y0[y] = Math.min(plan.h - 1, Math.floor(y * plan.h / eh));
      y1[y] = Math.min(plan.h, Math.max(y0[y] + 1, Math.floor((y + 1) * plan.h / eh)));
    }
    const flatMask = new Uint8Array(ew * eh);
    const flatFilament = new Uint16Array(ew * eh);
    const familyId = new Int16Array(ew * eh);
    const printMask = plan.printMask ? new Uint8Array(ew * eh) : null;
    const lab = new Float32Array(ew * eh * 3);
    // A coarse cell inherits the manual lock when any source pixel in its
    // footprint is painted: export cleanup must not absorb a user lock.
    const coarseLock = plan.manualMask ? new Uint8Array(ew * eh) : null;
    const hasSilhouette = !!(plan.background && plan.background.enabled);
    let sourcePixels = 0, changedPixels = 0;
    const canCleanup = !!(!hasSilhouette && plan.structureCleanup && plan.structureCleanup.minAreaPx > 1 && !plan.structureCleanup.edgeOnly &&
      plan.predicted && plan.families && plan.palette && CS.engine && CS.engine.mergeSmallRegions);
    for (let y = 0; y < eh; y++) {
      for (let x = 0; x < ew; x++) {
        const di = y * ew + x;
        const centerX = Math.min(plan.w - 1, Math.floor((x + 0.5) * plan.w / ew));
        const centerY = Math.min(plan.h - 1, Math.floor((y + 0.5) * plan.h / eh));
        const centerI = centerY * plan.w + centerX;
        const centerKey = plan.printMask && !plan.printMask[centerI] ? 0 : (plan.flatMask[centerI] ? plan.flatFilament[centerI] + 1 : -(plan.familyId[centerI] + 2));
        const votes = new Map();
        for (let yy = y0[y]; yy < y1[y]; yy++) {
          for (let xx = x0[x]; xx < x1[x]; xx++) {
            const si = yy * plan.w + xx;
            const key = plan.printMask && !plan.printMask[si] ? 0 : (plan.flatMask[si] ? plan.flatFilament[si] + 1 : -(plan.familyId[si] + 2));
            const vote = votes.get(key) || { key, count: 0, protected: 0, sumL: 0, sumA: 0, sumB: 0 };
            vote.count++;
            const sourcePred = plan.predicted && plan.predicted[si];
            if (sourcePred && sourcePred.lab) {
              vote.sumL += sourcePred.lab.L; vote.sumA += sourcePred.lab.a; vote.sumB += sourcePred.lab.b;
            }
            if ((plan.lineProtectMask && plan.lineProtectMask[si]) || (plan.lineDirectMask && plan.lineDirectMask[si])) vote.protected++;
            votes.set(key, vote);
          }
        }
        let best = null;
        for (const vote of votes.values()) {
          if (!best || vote.count > best.count ||
            (vote.count === best.count && vote.protected > best.protected) ||
            (vote.count === best.count && vote.protected === best.protected && vote.key === centerKey)) best = vote;
        }
        if (best.key === 0) {
          if (printMask) printMask[di] = 0;
          flatMask[di] = 0; flatFilament[di] = 0xffff; familyId[di] = -1;
        } else {
          if (printMask) printMask[di] = 1;
          if (best.key > 0) {
            flatMask[di] = 1; flatFilament[di] = best.key - 1; familyId[di] = -1;
          } else {
            flatMask[di] = 0; flatFilament[di] = 0xffff; familyId[di] = -best.key - 2;
          }
        }
        // Cleanup colour must describe the region that actually won the vote,
        // not a potentially unrelated centre pixel from a minority colour.
        lab[di * 3] = best.sumL / best.count;
        lab[di * 3 + 1] = best.sumA / best.count;
        lab[di * 3 + 2] = best.sumB / best.count;
        // How many real source pixels this coarse cell re-assigns to a
        // different category: an explicit downsample-difference measure.
        for (let yy = y0[y]; yy < y1[y]; yy++) {
          for (let xx = x0[x]; xx < x1[x]; xx++) {
            const si = yy * plan.w + xx;
            if (plan.printMask && !plan.printMask[si]) continue;
            if (coarseLock && plan.manualMask[si]) coarseLock[di] = 1;
            sourcePixels++;
            const key = plan.flatMask[si] ? plan.flatFilament[si] + 1 : -(plan.familyId[si] + 2);
            if (key !== best.key) changedPixels++;
          }
        }
      }
    }
    let structureCleanup = null;
    if (canCleanup) {
      // Voting avoids sampling bias, but even a perfect sampler can split a
      // thin region at a coarser grid. Re-apply only the already-requested
      // nozzle-scale cleanup on the actual export plane, never on raw/off plans.
      const pixelSize = plan.widthMm / ew;
      const featureMm = (Number(plan.lineWidthMm) || 0.42) * 2;
      const minAreaPx = Math.max(2, Math.round(Math.PI * (featureMm / 2) ** 2 / (pixelSize * pixelSize)));
      structureCleanup = CS.engine.mergeSmallRegions(flatMask, flatFilament, familyId, lab, plan.families, plan.palette, ew, eh, minAreaPx, null, null, coarseLock);
      for (let i = 0; i < flatMask.length; i++) if (!flatMask[i]) flatFilament[i] = 0xffff;
    }
    let regionOf = null;
    if (plan.regionOf && plan.regionRecipes) {
      regionOf = new Int32Array(ew * eh).fill(-1);
      for (let dy = 0; dy < eh; dy++) for (let dx = 0; dx < ew; dx++) {
        const sx = Math.min(plan.w - 1, Math.floor((dx + 0.5) * plan.w / ew));
        const sy = Math.min(plan.h - 1, Math.floor((dy + 0.5) * plan.h / eh));
        regionOf[dy * ew + dx] = plan.regionOf[sy * plan.w + sx];
      }
    }
    return {
      ew, eh, flatMask, flatFilament, familyId, printMask, structureCleanup,
      regionOf, regionRecipes: plan.regionRecipes || null,
      changeStats: {
        sourcePixels, changedPixels,
        changedPercent: sourcePixels ? +(changedPixels / sourcePixels * 100).toFixed(2) : 0
      }
    };
  }

  function buildLayerMasks(plan, plane, z) {
    const { ew, eh, flatMask, flatFilament, familyId, printMask } = plane;
    const K = plan.palette.length;
    const masks = new Array(K);
    for (let f = 0; f < K; f++) masks[f] = new Uint8Array(ew * eh);
    const n = ew * eh;
    for (let i = 0; i < n; i++) {
      if (printMask && !printMask[i]) continue;
      let fi = -1;
      // P5: coordinated spatial regions are the single material source; export
      // must not fall back to family/flat labels and cut same-material neighbours.
      if (plane.regionRecipes && plane.regionOf) {
        const rr = plane.regionRecipes[plane.regionOf[i]];
        if (rr) {
          if (z < plan.gradStartLayer) fi = plan.foundationIndex;
          else { const li = z - plan.gradStartLayer; fi = li < rr.length ? rr[li] : -1; }
          if (fi >= 0) masks[fi][i] = 1;
          continue;
        }
      }
      if (flatMask[i]) {
        if (z < (plan.flatBaseLayers || 0)) fi = plan.foundationIndex;
        else if (z < plan.flatLayers) fi = flatFilament[i];
      } else {
        if (z < plan.gradStartLayer) fi = plan.foundationIndex;
        else {
          const f = familyId[i];
          if (f >= 0) {
            const li = z - plan.gradStartLayer;
            if (li >= 0 && li < plan.families[f].recipe.length) fi = plan.families[f].recipe[li];
          } else if (plan.equalHeight && z < plan.commonTopLayer) {
            // Equal-height envelope/support columns are solid foundation up to the
            // common top, not AIR (review F04: pillars must not export lower).
            fi = plan.foundationIndex;
          }
        }
      }
      if (fi >= 0) masks[fi][i] = 1;
    }
    return masks;
  }

  function masksEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function buildPrisms(plan, plane) {
    const K = plan.palette.length;
    const prisms = Array.from({ length: K }, () => []);
    const active = new Array(K).fill(null);
    const activeStart = new Int32Array(K);
    for (let z = 0; z < plan.maxLayers; z++) {
      const masks = buildLayerMasks(plan, plane, z);
      for (let f = 0; f < K; f++) {
        const mask = masks[f];
        let any = false;
        for (let i = 0; i < mask.length; i++) if (mask[i]) { any = true; break; }
        if (!any) {
          if (active[f]) { prisms[f].push({ mask: active[f], z0: activeStart[f], z1: z }); active[f] = null; }
          continue;
        }
        if (active[f] && masksEqual(active[f], mask)) continue;
        if (active[f]) prisms[f].push({ mask: active[f], z0: activeStart[f], z1: z });
        active[f] = mask;
        activeStart[f] = z;
      }
    }
    for (let f = 0; f < K; f++) {
      if (active[f]) prisms[f].push({ mask: active[f], z0: activeStart[f], z1: plan.maxLayers });
    }
    return prisms;
  }

  function traceLoops(mask, w, h) {
    const edges = [];
    const outgoing = new Map();
    const key = (x, y) => y * (w + 1) + x;
    const add = (x0, y0, x1, y1, ox, oy) => {
      const e = { x0, y0, x1, y1, out: { x: ox, y: oy }, used: false };
      edges.push(e);
      const k = key(x0, y0);
      let arr = outgoing.get(k);
      if (!arr) { arr = []; outgoing.set(k, arr); }
      arr.push(e);
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        if (y === 0 || !mask[(y - 1) * w + x]) add(x, y, x + 1, y, 0, -1);
        if (x === w - 1 || !mask[y * w + x + 1]) add(x + 1, y, x + 1, y + 1, 1, 0);
        if (y === h - 1 || !mask[(y + 1) * w + x]) add(x + 1, y + 1, x, y + 1, 0, 1);
        if (x === 0 || !mask[y * w + x - 1]) add(x, y + 1, x, y, -1, 0);
      }
    }
    const loops = [];
    for (const start of edges) {
      if (start.used) continue;
      const pts = [], outs = [];
      let cur = start;
      let guard = 0;
      while (cur && !cur.used && guard++ < edges.length + 8) {
        cur.used = true;
        pts.push({ x: cur.x0, y: cur.y0 });
        outs.push(cur.out);
        const cands = (outgoing.get(key(cur.x1, cur.y1)) || []).filter(e => !e.used);
        if (!cands.length) break;
        const inAng = Math.atan2(cur.y1 - cur.y0, cur.x1 - cur.x0);
        let next = null, bestTurn = Infinity;
        for (const c of cands) {
          const ang = Math.atan2(c.y1 - c.y0, c.x1 - c.x0);
          let turn = ang - inAng;
          while (turn < 0) turn += Math.PI * 2;
          while (turn >= Math.PI * 2) turn -= Math.PI * 2;
          if (turn < 1e-7) turn = Math.PI * 2;
          if (turn < bestTurn) { bestTurn = turn; next = c; }
        }
        cur = next;
        if (cur === start) break;
      }
      if (pts.length >= 4) loops.push({ pts, outs });
    }
    return loops;
  }

  function simplifyLoop(loop) {
    const pts = loop.pts, outs = loop.outs;
    const n = pts.length;
    if (n <= 4) return loop;
    const keepPts = [], keepOuts = [];
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
      const cross = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
      if (Math.abs(cross) > 1e-9) { keepPts.push(cur); keepOuts.push(outs[i]); }
    }
    if (keepPts.length < 4) return loop;
    return { pts: keepPts, outs: keepOuts };
  }

  function loopArea(loop) {
    let a = 0;
    const pts = loop.pts;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  function pointInLoop(pt, loop) {
    const pts = loop.pts;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function validateLocalEdges(indices, startIdx) {
    const edges = new Map();
    for (let i = startIdx; i < indices.length; i += 3) {
      const tri = [indices[i], indices[i + 1], indices[i + 2]];
      for (let k = 0; k < 3; k++) {
        const a = tri[k], b = tri[(k + 1) % 3];
        const key = a < b ? a + ',' + b : b + ',' + a;
        const n = (edges.get(key) || 0) + 1;
        edges.set(key, n);
        if (n > 2) return false;
      }
    }
    for (const n of edges.values()) if (n !== 2) return false;
    return true;
  }


  function simplifyOpen(pts, tol) {
    const n = pts.length;
    if (n <= 2) return pts.slice();
    const keep = new Uint8Array(n); keep[0] = 1; keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const p = pts[a], q = pts[b];
      const dx = q.x - p.x, dy = q.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      let maxD = -1, maxI = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(dy * (pts[i].x - p.x) - dx * (pts[i].y - p.y)) / len;
        if (d > maxD) { maxD = d; maxI = i; }
      }
      if (maxD > tol && maxI > a) {
        keep[maxI] = 1;
        stack.push([a, maxI], [maxI, b]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  }

  function simplifyClosed(pts, tol) {
    const n = pts.length;
    if (n < 6 || !(tol > 0)) return pts;
    const half = Math.floor(n / 2);
    const a = pts.slice(0, half + 1);
    const b = pts.slice(half).concat([pts[0]]);
    const sa = simplifyOpen(a, tol);
    const sb = simplifyOpen(b, tol);
    const out = sa.slice(0, -1).concat(sb.slice(0, -1));
    return out.length >= 3 ? out : pts;
  }

  function meshPrismMarch(mask, w, h, pixelSize, z0, z1, positions, indices) {
    const earcutFn = (root.earcut && (root.earcut.default || root.earcut)) || CS.earcut;
    if (typeof earcutFn !== 'function') throw new Error('earcut 未加载');
    const startPos = positions.length / 3;
    const startIdx = indices.length;
    const get = (x, y) => (x >= 0 && x < w && y >= 0 && y < h) ? mask[y * w + x] : 0;
    const pt = (x, y) => ({ x, y, key: Math.round(x * 2) + ',' + Math.round(y * 2) });
    const segs = [];
    const addSeg = (a, b) => segs.push({ a, b });
    for (let y = -1; y < h; y++) {
      for (let x = -1; x < w; x++) {
        const a = get(x, y), b = get(x + 1, y), c = get(x + 1, y + 1), d = get(x, y + 1);
        if (!a && !b && !c && !d) continue;
        if (a && b && c && d) continue;
        const code = (a ? 8 : 0) | (b ? 4 : 0) | (c ? 2 : 0) | (d ? 1 : 0);
        const L = pt(x, y + 0.5), T = pt(x + 0.5, y), R = pt(x + 1, y + 0.5), B = pt(x + 0.5, y + 1);
        // Bit order: a=NW(8), b=NE(4), c=SE(2), d=SW(1).
        switch (code) {
          case 1: addSeg(B, L); break;              // SW only
          case 2: addSeg(R, B); break;              // SE only
          case 3: addSeg(L, R); break;              // bottom half
          case 4: addSeg(T, R); break;              // NE only
          case 5: addSeg(T, R); addSeg(B, L); break; // NE + SW diagonal
          case 6: addSeg(T, B); break;              // right half
          case 7: addSeg(T, L); break;              // missing NW
          case 8: addSeg(L, T); break;              // NW only
          case 9: addSeg(T, B); break;              // left half
          case 10: addSeg(L, T); addSeg(R, B); break; // NW + SE diagonal
          case 11: addSeg(T, R); break;             // missing NE
          case 12: addSeg(L, R); break;             // top half
          case 13: addSeg(R, B); break;             // missing SE
          case 14: addSeg(B, L); break;             // missing SW
          default: break;
        }
      }
    }
    if (!segs.length) return false;
    const adj = new Map();
    segs.forEach((s, i) => {
      for (const p of [s.a, s.b]) {
        let arr = adj.get(p.key);
        if (!arr) { arr = []; adj.set(p.key, arr); }
        arr.push(i);
      }
    });
    const used = new Uint8Array(segs.length);
    const loops = [];
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      const start = segs[i].a;
      let current = start;
      let edge = i;
      const pts = [start];
      let broken = false;
      for (let guard = 0; guard < segs.length + 8; guard++) {
        used[edge] = 1;
        const s = segs[edge];
        const next = s.a.key === current.key ? s.b : s.a;
        if (next.key === start.key) break;
        pts.push(next);
        const cands = (adj.get(next.key) || []).filter(e => !used[e]);
        if (!cands.length) { broken = true; break; }
        edge = cands[0];
        current = next;
      }
      if (broken || pts.length < 3) continue;
      // remove exact collinear points
      const out = [];
      for (let k = 0; k < pts.length; k++) {
        const p0 = pts[(k - 1 + pts.length) % pts.length], p1 = pts[k], p2 = pts[(k + 1) % pts.length];
        const cross = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
        if (Math.abs(cross) > 1e-9) out.push(p1);
      }
      if (out.length >= 3) loops.push(simplifyClosed(out, 0.35));
    }
    if (!loops.length) return false;
    // containment depth: even = outer, odd = hole
    const infos = loops.map(pts => {
      let area = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        area += p.x * q.y - q.x * p.y;
      }
      return { pts, area: area / 2, depth: 0, parent: -1 };
    });
    for (let i = 0; i < infos.length; i++) {
      const li = infos[i];
      for (let j = 0; j < infos.length; j++) {
        if (i === j) continue;
        const lj = infos[j];
        if (Math.abs(lj.area) > Math.abs(li.area) && pointInLoop(li.pts[0], { pts: lj.pts })) li.depth++;
      }
    }
    const outers = [], holes = [];
    for (let i = 0; i < infos.length; i++) {
      if (infos[i].depth % 2 === 0) outers.push(i); else holes.push(i);
    }
    for (const hi of holes) {
      let parent = -1;
      for (const oi of outers) {
        if (infos[oi].depth !== infos[hi].depth - 1) continue;
        if (pointInLoop(infos[hi].pts[0], { pts: infos[oi].pts })) {
          if (parent < 0 || Math.abs(infos[oi].area) < Math.abs(infos[parent].area)) parent = oi;
        }
      }
      infos[hi].parent = parent;
    }
    const X = (x) => (x + 0.5) * pixelSize - w * pixelSize / 2;
    const Y = (y) => h * pixelSize / 2 - (y + 0.5) * pixelSize;
    const vmap = new Map();
    // Vertices are scoped per cap/wall group: two contour groups that only
    // touch at a point must not weld their walls into a 4-face vertical edge.
    const addVertex = (x, y, z, scope) => {
      const xi = Math.round(x * 100000), yi = Math.round(y * 100000), zi = Math.round(z * 100000);
      const key = xi + ',' + yi + ',' + zi + (scope ? ',' + scope : '');
      let idx = vmap.get(key);
      if (idx === undefined) { idx = positions.length / 3; vmap.set(key, idx); positions.push(x, y, z); }
      return idx;
    };
    const addTri = (a, b, c) => { if (a !== b && b !== c && a !== c) indices.push(a, b, c); };
    const addTriOriented = (p0, p1, p2, outward, scope) => {
      const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
      const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * outward[0] + ny * outward[1] + nz * outward[2] < 0) { const t = p1; p1 = p2; p2 = t; }
      addTri(addVertex(...p0, scope), addVertex(...p1, scope), addVertex(...p2, scope));
    };
    const addQuad = (p0, p1, p2, p3, outward, scope) => {
      const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
      const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * outward[0] + ny * outward[1] + nz * outward[2] < 0) { const t = p1; p1 = p3; p3 = t; }
      const a = addVertex(...p0, scope), b = addVertex(...p1, scope), c = addVertex(...p2, scope), d = addVertex(...p3, scope);
      addTri(a, b, c); addTri(a, c, d);
    };
    // caps
    for (const oi of outers) {
      const outer = infos[oi];
      const groupHoles = holes.filter(hi => infos[hi].parent === oi);
      const flat = [], holeIndex = [];
      for (const p of outer.pts) flat.push(p.x, p.y);
      for (const hi of groupHoles) {
        holeIndex.push(flat.length / 2);
        for (const p of infos[hi].pts) flat.push(p.x, p.y);
      }
      const tris = earcutFn(flat, holeIndex, 2);
      for (let i = 0; i < tris.length; i += 3) {
        const ia = tris[i] * 2, ib = tris[i + 1] * 2, ic = tris[i + 2] * 2;
        const p0 = [X(flat[ia]), Y(flat[ia + 1]), z1];
        const p1 = [X(flat[ib]), Y(flat[ib + 1]), z1];
        const p2 = [X(flat[ic]), Y(flat[ic + 1]), z1];
        addTriOriented(p0, p1, p2, [0, 0, 1], 'g' + oi);
        addTriOriented([p0[0], p0[1], z0], [p1[0], p1[1], z0], [p2[0], p2[1], z0], [0, 0, -1], 'g' + oi);
      }
    }
    // walls
    for (let li = 0; li < infos.length; li++) {
      const pts = infos[li].pts;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
        const dx = q.x - p.x, dy = q.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        let nx = dy / len, ny = -dx / len;
        const plus = get(Math.round(mx + nx * 0.3), Math.round(my + ny * 0.3));
        const minus = get(Math.round(mx - nx * 0.3), Math.round(my - ny * 0.3));
        let ox = nx, oy = ny;
        if (plus && !minus) { ox = -nx; oy = -ny; }
        else if (minus && !plus) { ox = nx; oy = ny; }
        else {
          const nIn = pointInLoop({ x: mx + nx * 0.3, y: my + ny * 0.3 }, { pts });
          const isOuter = infos[li].depth % 2 === 0;
          if (isOuter) { ox = nIn ? -nx : nx; oy = nIn ? -ny : ny; }
          else { ox = nIn ? nx : -nx; oy = nIn ? ny : -ny; }
        }
        const w0 = [X(p.x), Y(p.y), z0];
        const w1 = [X(q.x), Y(q.y), z0];
        const w2 = [X(q.x), Y(q.y), z1];
        const w3 = [X(p.x), Y(p.y), z1];
        const scope = infos[li].depth % 2 === 0 ? 'g' + li : 'g' + (infos[li].parent >= 0 ? infos[li].parent : li);
        addQuad(w0, w1, w2, w3, [ox, -oy, 0], scope);
      }
    }
    return validateLocalEdges(indices, startIdx);
  }

  function meshPrism(mask, w, h, pixelSize, z0, z1, positions, indices, forceTiling, depth = 0) {
    const startPos = positions.length / 3;
    const startIdx = indices.length;
    if (forceTiling) return meshPrismTiling(mask, w, h, pixelSize, z0, z1, positions, indices);
    if (meshPrismMarch(mask, w, h, pixelSize, z0, z1, positions, indices) && validateLocalEdges(indices, startIdx)) return 'march';
    positions.length = startPos * 3;
    indices.length = startIdx;
    return meshPrismLegacy(mask, w, h, pixelSize, z0, z1, positions, indices, depth);
  }

  function meshPrismLegacy(mask, w, h, pixelSize, z0, z1, positions, indices, depth = 0) {
    const earcutFn = (root.earcut && (root.earcut.default || root.earcut)) || CS.earcut;
    if (typeof earcutFn !== 'function') throw new Error('earcut 未加载');
    // Never morph the mask here: a 3x3 close would seal 1-px white gaps and
    // bold thin strokes. If the traced skeleton turns out non-manifold the
    // caller rebuilds this prism with exact per-cell tiling instead.
    const rawLoops = traceLoops(mask, w, h).map(simplifyLoop).filter(l => Math.abs(loopArea(l)) > 1e-9);
    if (!rawLoops.length) return;
    const outers = [], holes = [];
    for (const loop of rawLoops) (loopArea(loop) > 0 ? outers : holes).push(loop);
    if (!outers.length) return;
    const groups = outers.map(o => ({ outer: o, holes: [], area: Math.abs(loopArea(o)) }));
    for (const hole of holes) {
      let best = null;
      for (const g of groups) {
        if (pointInLoop(hole.pts[0], g.outer) && (!best || g.area < best.area)) best = g;
      }
      if (best) best.holes.push(hole);
    }
    const startPos = positions.length / 3;
    const startIdx = indices.length;
    const vmap = new Map();
    const addVertex = (x, y, z, scope) => {
      const xi = Math.round(x * 100000), yi = Math.round(y * 100000), zi = Math.round(z * 100000);
      const key = xi + ',' + yi + ',' + zi + (scope ? ',' + scope : '');
      let idx = vmap.get(key);
      if (idx === undefined) {
        idx = positions.length / 3;
        vmap.set(key, idx);
        positions.push(x, y, z);
      }
      return idx;
    };
    const addTri = (a, b, c) => {
      if (a === b || b === c || a === c) return;
      indices.push(a, b, c);
    };
    const addQuad = (p0, p1, p2, p3, outward, scope) => {
      // Ensure the quad winds outward: use triangle p0,p1,p2 and flip if needed.
      const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
      const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const dot = nx * outward[0] + ny * outward[1] + nz * outward[2];
      if (dot < 0) { const tmp = p1; p1 = p3; p3 = tmp; }
      const a = addVertex(p0[0], p0[1], p0[2], scope);
      const b = addVertex(p1[0], p1[1], p1[2], scope);
      const c = addVertex(p2[0], p2[1], p2[2], scope);
      const d = addVertex(p3[0], p3[1], p3[2], scope);
      addTri(a, b, c); addTri(a, c, d);
    };
    const X = (x) => (x - w / 2) * pixelSize;
    const Y = (y) => (h / 2 - y) * pixelSize;
    const zBottom = z0;
    const zTop = z1;
    const addTriOriented = (p0, p1, p2, outward, scope) => {
      const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
      const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * outward[0] + ny * outward[1] + nz * outward[2] < 0) { const t = p1; p1 = p2; p2 = t; }
      const a = addVertex(p0[0], p0[1], p0[2], scope);
      const b = addVertex(p1[0], p1[1], p1[2], scope);
      const c = addVertex(p2[0], p2[1], p2[2], scope);
      addTri(a, b, c);
    };
    // Triangulate caps once and reuse for top and bottom. Holes are grouped
    // with their containing outer ring; no T-junctions, no internal faces.
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const flat = [], holeIndex = [];
      for (const p of group.outer.pts) flat.push(p.x, p.y);
      for (const hole of group.holes) {
        holeIndex.push(flat.length / 2);
        for (const p of hole.pts) flat.push(p.x, p.y);
      }
      const tris = earcutFn(flat, holeIndex, 2);
      for (let i = 0; i < tris.length; i += 3) {
        const ia = tris[i] * 2, ib = tris[i + 1] * 2, ic = tris[i + 2] * 2;
        const p0 = [X(flat[ia]), Y(flat[ia + 1]), zTop];
        const p1 = [X(flat[ib]), Y(flat[ib + 1]), zTop];
        const p2 = [X(flat[ic]), Y(flat[ic + 1]), zTop];
        addTriOriented(p0, p1, p2, [0, 0, 1], 'g' + gi);
        addTriOriented([p0[0], p0[1], zBottom], [p1[0], p1[1], zBottom], [p2[0], p2[1], zBottom], [0, 0, -1], 'g' + gi);
      }
    }
    // Walls follow the same simplified boundary segments used by the caps.
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const loops = [group.outer, ...group.holes];
      for (const loop of loops) {
        const pts = loop.pts;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i], q = pts[(i + 1) % pts.length], out = loop.outs[i];
          const w0 = [X(p.x), Y(p.y), zBottom];
          const w1 = [X(q.x), Y(q.y), zBottom];
          const w2 = [X(q.x), Y(q.y), zTop];
          const w3 = [X(p.x), Y(p.y), zTop];
          addQuad(w0, w1, w2, w3, [out.x, -out.y, 0], 'g' + gi);
        }
      }
    }
    // Complex pixel masks can contain pinch points where two boundary runs
    // meet. Verify 2-manifold edges; if not, use a guaranteed-watertight
    // per-cell tiling for this prism (a little heavier, but exact).
    const edgeCounts = new Map();
    let nonManifold = false;
    for (let i = startIdx; i < indices.length; i += 3) {
      const tri = [indices[i], indices[i + 1], indices[i + 2]];
      for (let k = 0; k < 3; k++) {
        const a = tri[k], b = tri[(k + 1) % 3];
        const key = a < b ? a + ',' + b : b + ',' + a;
        const n = (edgeCounts.get(key) || 0) + 1;
        edgeCounts.set(key, n);
        if (n > 2) { nonManifold = true; break; }
      }
      if (nonManifold) break;
    }
    if (!nonManifold) {
      for (const n of edgeCounts.values()) if (n !== 2) { nonManifold = true; break; }
    }
    if (nonManifold) {
      // F-OUTLINE-01: never dilate the mask to make it meshable. Growing the mask by
      // even 1px thickens thin lines inside the same material (1px->3px, 2px->4px) and
      // overlaps neighbouring materials at the same layer/XY, breaking the
      // one-material-per-voxel contract and the "footprint bit-identical" guarantee.
      // Exact per-cell tiling keeps the footprint identical and is guaranteed
      // watertight (heavier for large organic masks, but correct).
      positions.length = startPos * 3;
      indices.length = startIdx;
      return meshPrismTiling(mask, w, h, pixelSize, z0, z1, positions, indices);
    }
    return 'earcut';
  }

  /* Exact per-cell tiling used when the contour skeleton cannot form a
     manifold solid. The footprint stays bit-identical to the mask. Vertices
     are keyed per grid corner AND per diagonal group, so cells that only
     touch at a point never share the corner column and their walls cannot
     weld into a 4-face non-manifold edge. */
  function meshPrismTiling(mask, w, h, pixelSize, z0, z1, positions, indices) {
    const X = x => (x - w / 2) * pixelSize;
    const Y = y => (h / 2 - y) * pixelSize;
    const at = (x, y) => (x >= 0 && x < w && y >= 0 && y < h) ? mask[y * w + x] : 0;
    const vmap = new Map();
    const vert = (cx, cy, z, g) => {
      const key = Math.round(X(cx) * 100000) + ',' + Math.round(Y(cy) * 100000) + ',' + Math.round(z * 100000) + ',' + g;
      let idx = vmap.get(key);
      if (idx === undefined) {
        idx = positions.length / 3;
        vmap.set(key, idx);
        positions.push(X(cx), Y(cy), z);
      }
      return idx;
    };
    const tri = (a, b, c) => { if (a !== b && b !== c && a !== c) indices.push(a, b, c); };
    const p = i => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const quad = (a, b, c, d, outward) => {
      const [ax, ay, az] = p(a), [bx, by, bz] = p(b), [cx2, cy2, cz] = p(c), [dx, dy, dz] = p(d);
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx2 - ax, vy = cy2 - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * outward[0] + ny * outward[1] + nz * outward[2] < 0) { tri(a, c, b); tri(a, d, c); }
      else { tri(a, b, c); tri(a, c, d); }
    };
    // Diagonal group of corner (cx,cy) as seen from cell (x,y).
    const groupAt = (cx, cy, x, y) => {
      const nw = at(cx - 1, cy - 1), ne = at(cx, cy - 1), sw = at(cx - 1, cy), se = at(cx, cy);
      if (nw && se && !ne && !sw) return (x === cx - 1 && y === cy - 1) ? 1 : 2;
      if (ne && sw && !nw && !se) return (x === cx && y === cy - 1) ? 1 : 2;
      return 0;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const gTL = groupAt(x, y, x, y), gTR = groupAt(x + 1, y, x, y);
      const gBR = groupAt(x + 1, y + 1, x, y), gBL = groupAt(x, y + 1, x, y);
      const TL1 = vert(x, y, z1, gTL), TR1 = vert(x + 1, y, z1, gTR);
      const BR1 = vert(x + 1, y + 1, z1, gBR), BL1 = vert(x, y + 1, z1, gBL);
      const TL0 = vert(x, y, z0, gTL), TR0 = vert(x + 1, y, z0, gTR);
      const BR0 = vert(x + 1, y + 1, z0, gBR), BL0 = vert(x, y + 1, z0, gBL);
      quad(BL1, BR1, TR1, TL1, [0, 0, 1]);
      quad(BL0, TL0, TR0, BR0, [0, 0, -1]);
      if (!at(x, y - 1)) quad(TL0, TR0, TR1, TL1, [0, 1, 0]);
      if (!at(x, y + 1)) quad(BL0, BR0, BR1, BL1, [0, -1, 0]);
      if (!at(x - 1, y)) quad(TL0, BL0, BL1, TL1, [-1, 0, 0]);
      if (!at(x + 1, y)) quad(TR0, BR0, BR1, TR1, [1, 0, 0]);
    }
    return 'fallback';
  }

  /* The one place that decides the physical export grid. Preview, plan summary
     and the 3MF must all report the same numbers. */
  function exportReport(plan) {
    const grid = exportGridFor(plan);
    if (!grid.downscaled) return { grid, change: { sourcePixels: 0, changedPixels: 0, changedPercent: 0 } };
    const plane = samplePlane(plan, grid.width, grid.height);
    return { grid, change: plane.changeStats };
  }

  function exportGridFor(plan, exportMax) {
    // F-OUTLINE-02: protected thin lines must export at the native preview grid.
    // Downsampling a line-art plan lets the protected-stroke vote widen a 1px line to
    // a full coarse cell (2x physical width) and swallow narrow white gaps, so the
    // preview and the 3MF would disagree. Organic plans keep the 1280 long-side cap
    // (meshing a huge photo grid is slow with no printable gain). An explicit
    // exportMax override is always honoured.
    const lineArt = !!(plan.lineApplied && (plan.lineProtectMask || plan.lineDirectMask));
    const longSide = Math.max(plan.w, plan.h);
    const max = exportMax != null
      ? Math.max(80, Math.min(1024, Number(exportMax) || 300))
      : (lineArt ? longSide : (longSide > 1280 ? 1280 : longSide));
    const scale = Math.min(1, max / longSide);
    const ew = Math.max(1, Math.round(plan.w * scale));
    const eh = Math.max(1, Math.round(plan.h * scale));
    return { width: ew, height: eh, scale, downscaled: scale < 0.999 };
  }

  function build3MFParts(plan, options = {}) {
    if (!plan) throw new Error('没有可导出的方案');
    // Native resolution is the correctness default: the web preview and 3MF
    // must share the same per-pixel recipes and exposed top colours. Export
    // fidelity is capped at a 1280 long side (~0.117 mm/px at 150 mm width,
    // which already matches the A1's XY positioning limit): a 2560 analysis
    // grid is for preview/layer inspection, and meshing it would block the
    // page for minutes and multiply the file size with no printable gain.
    const grid = exportGridFor(plan, options.exportMax);
    const ew = grid.width, eh = grid.height;
    const plane = samplePlane(plan, ew, eh);
    const pixelSize = plan.widthMm / ew;
    const prisms = buildPrisms(plan, plane);

    const used = [];
    const palette = plan.palette;
    for (let f = 0; f < palette.length; f++) if (prisms[f].length) used.push(f);

    const objects = [];
    const componentMeta = [];
    let nextId = 2;
    // One watertight object per prism (colour + contiguous layer range).
    // Do not merge these into one mesh per colour: coincident horizontal caps
    // between stacked prisms would be welded by some loaders and become
    // non-manifold. Separate objects are the format Bambu Studio/OrcaSlicer
    // accept without the slow assembly/component path.
    for (const f of used) {
      for (const prism of prisms[f]) {
        const positions = [];
        const indices = [];
        meshPrism(prism.mask, ew, eh, pixelSize, prism.z0 * plan.layerHeight, prism.z1 * plan.layerHeight, positions, indices);
        if (!indices.length) continue;
        // Bake the plate offset into the mesh. Native Bambu Studio 3MFs keep
        // build items transform-free and store objects in plate coordinates;
        // this also survives loaders that ignore <assemble> in the config.
        for (let i = 0; i < positions.length; i += 3) {
          positions[i] += 128;
          positions[i + 1] += 128;
        }
        const objectId = nextId++;
        const name = `${palette[f].name} · L${prism.z0 + 1}-${prism.z1}`;
        objects.push({ id: objectId, filament: f, positions, indices, name });
        componentMeta.push({ id: objectId, name, colorIdx: f + 1, triangles: indices.length / 3, vertices: positions.length / 3 });
      }
    }
    if (!objects.length) throw new Error('没有可导出的几何体（检查纯色区/渐变区层数）');
    const assemblyId = nextId++;

    // Encode the model XML in bounded chunks: at 1280+ grids the full string
    // exceeds V8's maximum string length ("Invalid string length"), so each
    // object is joined+encoded before the next one is appended.
    const encoder = new TextEncoder();
    const byteParts = [];
    let textLines = [];
    const flushText = () => {
      if (!textLines.length) return;
      byteParts.push(encoder.encode(textLines.join('\n') + '\n'));
      textLines = [];
    };
    const pushLine = s => textLines.push(s);
    pushLine('<?xml version="1.0" encoding="UTF-8"?>');
    pushLine('<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">');
    pushLine(' <metadata name="Application">ChromaStack</metadata>');
    pushLine(' <metadata name="BambuStudio:3mfVersion">1</metadata>');
    pushLine(` <metadata name="slic3rpe:layer_height">${plan.layerHeight}</metadata>`);
    pushLine(' <resources>');
    pushLine('  <basematerials id="1">');
    for (const p of palette) pushLine(`   <base name="${escapeXml(p.name)}" displaycolor="#${p.hex.replace('#', '').toUpperCase()}FF" />`);
    pushLine('  </basematerials>');
    for (const obj of objects) {
      pushLine(`  <object id="${obj.id}" type="model" pid="1" pindex="${obj.filament}" name="${escapeXml(obj.name)}">`);
      pushLine('   <mesh>');
      pushLine('    <vertices>');
      for (let i = 0; i < obj.positions.length; i += 3) {
        pushLine(`     <vertex x="${round(obj.positions[i], 4)}" y="${round(obj.positions[i + 1], 4)}" z="${round(obj.positions[i + 2], 4)}" />`);
      }
      pushLine('    </vertices>');
      pushLine('    <triangles>');
      for (let i = 0; i < obj.indices.length; i += 3) {
        // Triangle-level colour is what Bambu Studio's standard-3MF colour
        // parser reads. Object-level pid/pindex alone is treated as plain
        // geometry, and the whole model falls back to the slicer's default
        // two filaments (the "why only 2 filaments?" symptom).
        pushLine(`     <triangle v1="${obj.indices[i]}" v2="${obj.indices[i + 1]}" v3="${obj.indices[i + 2]}" pid="1" pindex="${obj.filament}" />`);
      }
      pushLine('    </triangles>');
      pushLine('   </mesh>');
      pushLine('  </object>');
      flushText();
    }
    pushLine(`  <object id="${assemblyId}" type="model" name="ChromaStack_Model">`);
    pushLine('   <components>');
    for (const obj of objects) pushLine(`    <component objectid="${obj.id}" />`);
    pushLine('   </components>');
    pushLine('  </object>');
    pushLine(' </resources>');
    pushLine(' <build>');
    pushLine(`  <item objectid="${assemblyId}" />`);
    pushLine(' </build>');
    pushLine('</model>');
    flushText();
    let modelBytes = null;
    {
      const total = byteParts.reduce((s, b) => s + b.length, 0);
      modelBytes = new Uint8Array(total);
      let off = 0;
      for (const b of byteParts) { modelBytes.set(b, off); off += b.length; }
    }

    const assemblyFaces = objects.reduce((s, obj) => s + obj.indices.length / 3, 0);
    const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
 <object id="${assemblyId}">
  <metadata key="name" value="ChromaStack Model"/>
  <metadata key="extruder" value="1"/>
  <metadata face_count="${assemblyFaces}"/>
${objects.map(obj => `  <part id="${obj.id}" subtype="normal_part">
   <metadata key="name" value="${escapeXml(obj.name)}"/>
   <metadata key="extruder" value="${obj.filament + 1}"/>
   <mesh_stat face_count="${obj.indices.length / 3}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
  </part>`).join('\n')}
 </object>
 <plate>
  <metadata key="plater_id" value="1"/>
  <metadata key="plater_name" value=""/>
  <metadata key="locked" value="false"/>
  <metadata key="filament_map_mode" value="Auto For Flush"/>
  <model_instance>
   <metadata key="object_id" value="${assemblyId}"/>
   <metadata key="instance_id" value="0"/>
   <metadata key="identify_id" value="1"/>
  </model_instance>
 </plate>
 <assemble>
  <assemble_item object_id="${assemblyId}" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 0" offset="0 0 0" />
 </assemble>
</config>`;

    // Minimal Bambu/Orca project profile. Without it Bambu Studio reports
    // "3mf 文件配置无效，仅加载几何数据" and drops every part-to-extruder
    // assignment. ChromaStack is not a printer preset on purpose: the studio
    // keeps the user's current machine and only takes the filament colours,
    // layer height and infill from here.
    const projectSettings = {
      layer_height: String(plan.layerHeight),
      initial_layer_print_height: String(plan.layerHeight),
      wall_loops: '2',
      sparse_infill_density: '100%',
      printer_model: 'ChromaStack',
      printer_settings_id: 'ChromaStack 0.4 nozzle',
      nozzle_diameter: ['0.4'],
      printable_height: '256',
      filament_colour: palette.map(p => p.hex),
      filament_type: palette.map(() => 'PLA'),
      filament_settings_id: palette.map(() => 'Generic PLA @ChromaStack 0.4 nozzle'),
      filament_vendor: palette.map(p => /Bambu/i.test(p.brand || '') ? 'Bambu Lab' : 'Generic')
    };

    const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="config" ContentType="text/xml"/>
 <Default Extension="json" ContentType="application/json"/>
</Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
    const meta = {
      app: 'ChromaStack', engine: plan.engine, widthMm: plan.widthMm, heightMm: plan.heightMm,
      layerHeight: plan.layerHeight, flatLayers: plan.flatLayers, gradStartLayer: plan.gradStartLayer,
      gradTopLayer: plan.gradTopLayer, reliefMm: plan.reliefMm,
      background: plan.background || { enabled: false }, palette: palette.map(p => ({ name: p.name, hex: p.hex, td: p.td })),
      stats: { meanDE: plan.stats.meanDE, p90: plan.stats.p90, toolChanges: plan.stats.toolChanges, smoothLevel: plan.smoothLevel || 0,
        smoothMm: plan.smoothMm ?? null, lineWidthMm: plan.lineWidthMm ?? null, smoothRadiusPx: plan.smoothRadiusPx ?? null,
        heightMergeDeltaE: plan.heightMergeDeltaE || 0, heightShortenedFamilies: plan.stats.heightShortenedFamilies || 0,
        edgeClean: plan.edgeClean || 0, edgePixelPercent: +(plan.edgePixelPercent || 0).toFixed(1),
        supportAddedPixels: plan.stats.supportAddedPixels || 0, supportAddedLayers: plan.stats.supportAddedLayers || [],
        heightMergedFamilies: plan.stats.heightMergedFamilies || 0, heightSavedLayers: plan.stats.heightSavedLayers || 0,
        lineMode: plan.lineMode || 'auto', lineApplied: !!plan.lineApplied,
        lineStrokePercent: +((plan.lineInfo && plan.lineInfo.strokePercent) || 0).toFixed(2),
        lineDirectPercent: +((plan.lineInfo && plan.lineInfo.directPercent) || 0).toFixed(2) },
      exportGrid: [ew, eh], exportDownscaled: grid.downscaled, exportChange: plane.changeStats,
      triangles: componentMeta.reduce((s, c) => s + c.triangles, 0)
    };
    const files = [
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rels },
      { name: '3D/3dmodel.model', data: modelBytes },
      { name: 'Metadata/model_settings.config', data: modelSettings },
      { name: 'Metadata/project_settings.config', data: JSON.stringify(projectSettings, null, 2) },
      { name: 'Metadata/chromastack.json', data: JSON.stringify(meta, null, 2) }
    ];
    return { files, meta, objects: componentMeta, ew, eh, pixelSize, exportDownscaled: grid.downscaled, exportChange: plane.changeStats };
  }

  function build3MFBytes(plan, options) {
    const out = build3MFParts(plan, options);
    return { bytes: CS.zip.createZip(out.files), meta: out.meta, objects: out.objects, ew: out.ew, eh: out.eh, pixelSize: out.pixelSize, exportDownscaled: out.exportDownscaled, exportChange: out.exportChange };
  }

  async function build3MFBytesAsync(plan, options) {
    const out = build3MFParts(plan, options);
    const bytes = CS.zip.createZipAsync ? await CS.zip.createZipAsync(out.files) : CS.zip.createZip(out.files);
    return { bytes, meta: out.meta, objects: out.objects, ew: out.ew, eh: out.eh, pixelSize: out.pixelSize, exportDownscaled: out.exportDownscaled, exportChange: out.exportChange };
  }

  function build3MFBlob(plan, options) {
    const out = build3MFBytes(plan, options);
    return { blob: new Blob([out.bytes], { type: 'model/3mf' }), meta: out.meta, ew: out.ew, eh: out.eh, exportDownscaled: out.exportDownscaled, exportChange: out.exportChange };
  }

  async function build3MFBlobAsync(plan, options) {
    const out = await build3MFBytesAsync(plan, options);
    return { blob: new Blob([out.bytes], { type: 'model/3mf' }), meta: out.meta };
  }

  function planSummary(plan) {
    // #99: the plan package must carry the FINAL coordinated material, not only the
    // pre-coordination colour-family segmentation. Build the region map summary and
    // the per-region final recipes (authoritative regionRecipes == filamentAt).
    const regionRecipes = plan.regionRecipes || null;
    const regionOf = plan.regionOf || null;
    let regionMap = null, coordination = null;
    const changedFamilies = new Set();
    if (regionOf) {
      const regionCount = new Set(); const regionPixels = {}; const regionMember = {};
      for (let i = 0; i < plan.n; i++) { const r = regionOf[i]; if (r < 0) continue; regionCount.add(r); regionPixels[r] = (regionPixels[r] || 0) + 1; if (regionMember[r] == null) regionMember[r] = i; }
      regionMap = { regionCount: regionCount.size, coordinatedRegions: regionRecipes ? Object.keys(regionRecipes).length : 0 };
      if (regionRecipes && plan.coordination) {
        const regions = Object.keys(regionRecipes).map(k => {
          const r = +k, rr = regionRecipes[r], m = regionMember[r], fam = m != null ? plan.familyId[m] : -1;
          if (fam >= 0 && plan.families[fam] && plan.families[fam].recipe.join(',') !== rr.join(',')) changedFamilies.add(fam);
          return {
            regionId: r, pixels: regionPixels[r] || 0, familyId: fam,
            predictedHex: m != null && plan.predicted[m] ? plan.predicted[m].hex : null,
            layers: rr.length, topMm: +((plan.gradStartLayer + rr.length) * plan.layerHeight).toFixed(3),
            recipeBottomToTop: rr.map(x => plan.palette[x].name)
          };
        }).sort((a, b) => b.pixels - a.pixels);
        coordination = { ...plan.coordination, regions };
      }
    }
    // F04: dominant FINAL predicted hex per family (post-coordination), so the plan
    // package family colour is not the stale pre-coordination recipe prediction.
    const familyFinalHex = plan.families.map(() => null);
    if (plan.predicted && plan.familyId) {
      const counts = plan.families.map(() => ({}));
      for (let i = 0; i < plan.n; i++) {
        if (plan.printMask && !plan.printMask[i]) continue;
        const f = plan.familyId[i]; if (f < 0 || !counts[f]) continue;
        const hx = plan.predicted[i] && plan.predicted[i].hex; if (!hx) continue;
        const k = hx.toLowerCase(); counts[f][k] = (counts[f][k] || 0) + 1;
      }
      for (let f = 0; f < counts.length; f++) {
        const keys = Object.keys(counts[f]); if (!keys.length) continue;
        keys.sort((a, b) => counts[f][b] - counts[f][a]);
        familyFinalHex[f] = keys[0];
      }
    }
    return {
      app: 'ChromaStack',
      engine: plan.engine,
      lut: plan.lutKey,
      physical: { widthMm: +plan.widthMm.toFixed(2), heightMm: +plan.heightMm.toFixed(2), pixelSizeMm: +plan.pixelSize.toFixed(4) },
      exportGrid: (() => {
        const g = exportGridFor(plan);
        return { width: g.width, height: g.height, sourceWidth: plan.w, sourceHeight: plan.h, downscaled: g.downscaled };
      })(),
      diagnostics: plan.diagnostics || null,
      layers: { layerHeight: plan.layerHeight, flatLayers: plan.flatLayers, flatBaseLayers: plan.flatBaseLayers || 0, gradientStartLayer: plan.gradStartLayer, gradientTopLayer: plan.gradTopLayer, maxLayers: plan.maxLayers, flatTopMm: +plan.flatTopMm.toFixed(3), gradientTopMm: +plan.gradTopMm.toFixed(3), actualGradientTopMm: +(plan.actualGradTopMm || plan.gradTopMm).toFixed(3), reliefMm: +plan.reliefMm.toFixed(3), variableHeight: !!plan.variableHeight },
      palette: plan.palette.map((p, i) => ({ slot: i + 1, key: p.key || ('slot:' + (i + 1)), name: p.name, hex: p.hex, td: p.td, hdMm: +(p.hd || 0).toFixed(3), brand: p.brand, material: p.material })),
      foundation: plan.foundation.name,
      background: plan.background || { enabled: false },
      stats: {
        meanDeltaE00: +plan.stats.meanDE.toFixed(2), medianDeltaE00: plan.stats.median, p90DeltaE00: plan.stats.p90,
        maxDeltaE00: +plan.stats.maxDE.toFixed(2), under5Percent: +plan.stats.under5.toFixed(1),
        flatPercent: +plan.stats.flatPercent.toFixed(1), gradientPercent: +plan.stats.gradPercent.toFixed(1),
        families: plan.stats.familyCount, toolChangeLowerBound: plan.stats.toolChanges,
        outOfGamutPercent: +(plan.stats.outOfGamutPercent || 0).toFixed(1), variableHeight: !!plan.variableHeight, smoothLevel: plan.smoothLevel || 0,
        smoothMm: plan.smoothMm ?? null, lineWidthMm: plan.lineWidthMm ?? null, smoothRadiusPx: plan.smoothRadiusPx ?? null, flatSmoothRadiusPx: plan.flatSmoothRadiusPx ?? null,
        structureCleanupPixels: plan.stats.structureCleanupPixels || 0, structureCleanupComponents: plan.stats.structureCleanupComponents || 0,
        structureCleanupMinAreaPx: plan.stats.structureCleanupMinAreaPx || 0, structureCleanupEdgeOnly: !!plan.stats.structureCleanupEdgeOnly,
        vectorFlat: !!plan.vectorFlat, vectorFlatFamilies: plan.vectorFlatFamilies || 0, vectorFlatPixels: plan.vectorFlatPixels || 0,
        vectorFlatIslandPixels: plan.vectorFlatIslandPixels || 0, vectorFlatBoundaryPixels: plan.vectorFlatBoundaryPixels || 0,
        mergeDeltaE: plan.mergeDeltaE || 0, mergedGroups: plan.stats.mergedGroups || 0, sharedBasePercent: +(plan.stats.sharedBasePercent || 0).toFixed(1),
        heightMergeDeltaE: plan.heightMergeDeltaE || 0, heightShortenedFamilies: plan.stats.heightShortenedFamilies || 0,
        edgeClean: plan.edgeClean || 0, edgePixelPercent: +(plan.edgePixelPercent || 0).toFixed(1),
        supportAddedPixels: plan.stats.supportAddedPixels || 0, supportAddedLayers: plan.stats.supportAddedLayers || [],
        heightMergedFamilies: plan.stats.heightMergedFamilies || 0, heightSavedLayers: plan.stats.heightSavedLayers || 0,
        lineProtect: plan.lineMode || 'auto', lineApplied: !!plan.lineApplied,
        lineStrokePercent: +((plan.lineInfo && plan.lineInfo.strokePercent) || 0).toFixed(1),
        lineDirectPercent: +((plan.lineInfo && plan.lineInfo.directPercent) || 0).toFixed(1),
        filamentGrams: plan.palette.map((p, i) => +plan.stats.grams[i].toFixed(2))
      },
      warnings: plan.warnings,
      regionMap,
      coordination,
      families: plan.families.map((f, i) => ({
        id: i, pixels: f.pixelCount, targetHex: f.targetHex, predictedHex: f.predictedHex,
        finalPredictedHex: familyFinalHex[i] || f.predictedHex,
        coordinated: changedFamilies.has(i),
        deltaE00: +f.deltaE.toFixed(2), layers: f.recipe.length, topMm: +((plan.gradStartLayer + f.recipe.length) * plan.layerHeight).toFixed(3),
        recipeBottomToTop: f.recipe.map(x => plan.palette[x].name)
      })).filter(f => f.pixels > 0).sort((a, b) => b.pixels - a.pixels),
      layerSchedule: plan.stats.layerFilaments.map((arr, z) => ({
        layer: z, zMm: +(z * plan.layerHeight).toFixed(3), filaments: arr.map(x => plan.palette[x].name)
      }))
    };
  }

  function buildPlanMarkdown(plan) {
    const s = planSummary(plan);
    const lines = [];
    lines.push(`# ${plan.engine === 'lut' ? '物理 LUT' : 'TD 立体浮雕'}混合彩绘打印计划`);
    lines.push('');
    lines.push(`- 成品尺寸：${s.physical.widthMm} × ${s.physical.heightMm} mm`);
    lines.push(`- 层高：${s.layers.layerHeight} mm；纯色区 ${s.layers.flatBaseLayers || 0} 层基底 + ${s.layers.flatLayers - (s.layers.flatBaseLayers || 0)} 层纯色（共 ${s.layers.flatLayers} 层，${s.layers.flatTopMm} mm）；渐变区 ${s.layers.gradientStartLayer}–${s.layers.gradientTopLayer} 层；浮雕差 ${s.layers.reliefMm} mm`);
    lines.push(`- 颜色预测：平均 ΔE00 ${s.stats.meanDeltaE00}，P90 ${s.stats.p90DeltaE00}，ΔE00≤5 占 ${s.stats.under5Percent}%`);
    lines.push(`- 导出网格：${s.exportGrid.width}×${s.exportGrid.height}${s.exportGrid.downscaled ? `（工作网格 ${s.exportGrid.sourceWidth}×${s.exportGrid.sourceHeight}，导出时重新离散化，细节以切片预览为准）` : '（与工作网格一致）'}`);
    if (s.diagnostics) {
      const dg = s.diagnostics.groups;
      lines.push(`- 分组色差：线条 ${dg.line.meanDE}（${dg.line.pixels}px） / 纯色 ${dg.flat.meanDE}（${dg.flat.pixels}px） / 渐变 ${dg.gradient.meanDE}（${dg.gradient.pixels}px）；填洞吸收 ${s.diagnostics.fill.filledPixels}px、拒绝 ${s.diagnostics.fill.rejectedPixels}px；纯色遮盖不足 ${s.diagnostics.coverage.badPixels}px（顶色 ${s.diagnostics.coverage.topLayers} 层）。`);
    }
    lines.push(`- 纯色区占比 ${s.stats.flatPercent}%，渐变区占比 ${s.stats.gradientPercent}%，渐变配方 ${s.stats.families} 个；平滑 ${s.stats.smoothMm != null ? s.stats.smoothMm.toFixed(2) + ' mm（半径 ' + (s.stats.smoothRadiusPx || 0) + 'px，线宽 ' + (s.stats.lineWidthMm || 0.42).toFixed(2) + 'mm）' : (s.stats.smoothLevel || 0) + '/4'}；层序合并 ${s.stats.mergeDeltaE || 0} ΔE，${s.stats.mergedGroups || 0} 组共享底层（${s.stats.sharedBasePercent || 0}% 渐变像素）`);
    if (s.stats.heightMergeDeltaE) {
      lines.push(`- 边缘光晕清理 ${s.stats.edgeClean || 0}/3，抗锯齿带 ${s.stats.edgePixelPercent || 0}% 像素。`);
    if (s.stats.vectorFlat) lines.push(`- 矢量化色块直印：${s.stats.vectorFlatFamilies} 个色族 / ${(s.stats.vectorFlatPixels / (plan.w * plan.h) * 100).toFixed(1)}% 像素改为纯色，清理 ${s.stats.vectorFlatIslandPixels || 0} px 边缘小岛、归并 ${s.stats.vectorFlatBoundaryPixels || 0} px 抗锯齿边界。`);
    lines.push(`- 悬空检查：${s.stats.supportAddedPixels ? '发现 '+s.stats.supportAddedPixels+' 个新增无支撑像素（第 '+s.stats.supportAddedLayers.join('、')+' 层）' : '无新增面积，所有层都有下层支撑'}。`);
    lines.push(`- 高度去重 ${s.stats.heightMergeDeltaE} ΔE：${s.stats.heightShortenedFamilies} 个色族改用更短配方，${s.stats.heightMergedFamilies} 个重复色族合并，最高降低 ${s.stats.heightSavedLayers} 层。`);
    }
    lines.push(`- 线稿保护：${s.stats.lineProtect}${s.stats.lineApplied ? '（已启用）' : '（未启用）'}；保护细线 ${s.stats.lineStrokePercent}% 像素，其中直接纯色 ${s.stats.lineDirectPercent}%。`);
    lines.push(`- 层内换色下界：约 ${s.stats.toolChangeLowerBound} 次（切片器/擦料塔会改变实际值）`);
    lines.push('');
    lines.push('## AMS 槽位');
    lines.push('');
    lines.push('| 槽位 | 耗材 | 颜色 | TD | 推算 HD | 预估用量 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    s.palette.forEach((p, i) => {
      lines.push(`| ${i + 1} | ${p.brand} ${p.material} ${p.name} | ${p.hex} | ${p.td} | ${p.hdMm} mm | ${s.stats.filamentGrams[i]} g |`);
    });
    lines.push('');
    lines.push('## 层叠结构');
    lines.push('');
    lines.push(`- 纯色区：0–${s.layers.flatBaseLayers || 0} 层用基底耗材垫底，其后到 ${s.layers.flatLayers} 层为该区域最近的槽位颜色。`);
    lines.push(`- 渐变区：0–${s.layers.gradientStartLayer} 层为基底（${s.foundation}），随后各色块按 1–${s.layers.gradientTopLayer - s.layers.gradientStartLayer} 层配方叠色；${s.layers.variableHeight ? '短线配方形成低台阶，最长配方到 ' + s.layers.actualGradientTopMm + ' mm。' : '所有渐变块等高。'}
- 纯色区顶面 ${s.layers.flatTopMm} mm，渐变区最高 ${s.layers.actualGradientTopMm} mm；最高浮雕差 ${s.layers.reliefMm} mm。`);
    lines.push('- 3MF 是一个多 part 对象：每个“颜色 × 连续层区间”是一个水密 part，已写入 extruder 编号；导入 Bambu Studio 若提示“配置无效，仅加载几何数据”，点确认即可。');
    if (s.coordination && s.coordination.regions && s.coordination.regions.length) {
      lines.push('');
      lines.push('## 同层材料协调（最终配方）');
      lines.push('');
      lines.push(`- 协调改动 ${s.coordination.changedRegions} 个空间区域，内部材料边界 ${(+s.coordination.boundaryBefore).toFixed(1)}→${(+s.coordination.boundaryAfter).toFixed(1)} mm·层，色差预算 ${s.coordination.colorBudget} ΔE。上方“层叠结构”的色族配方为协调前分割；下表为协调后最终配方，与导出 3MF / 3D / 逐层图一致。`);
      lines.push('');
      lines.push('| 区域 | 像素 | 层数 | 顶高 mm | 最终配方（底→顶） |');
      lines.push('| --- | --- | --- | --- | --- |');
      s.coordination.regions.forEach(r => lines.push(`| ${r.regionId} | ${r.pixels} | ${r.layers} | ${r.topMm} | ${r.recipeBottomToTop.join(' / ')} |`));
    }
    lines.push('');
    lines.push('## 层内耗材（下界）');
    lines.push('');
    lines.push('| 层 | Z (mm) | 该层出现的耗材 |');
    lines.push('| --- | --- | --- |');
    s.layerSchedule.forEach(l => lines.push(`| ${l.layer} | ${l.zMm} | ${l.filaments.join(' / ')} |`));
    lines.push('');
    if (s.warnings.length) {
      lines.push('## 注意');
      lines.push('');
      s.warnings.forEach(w => lines.push('- ' + w));
      lines.push('');
    }
    lines.push('## 切片建议');
    lines.push('');
    lines.push('- 使用 0.4 mm 喷嘴；LUT 校准线宽为 0.42 mm，层高 0.08 mm。');
    lines.push('- 100% 填充，关闭顶/底壳的“仅一层”之类的省料选项；保证叠色层完整。');
    lines.push('- 先用小样确认实际颜色；不同批次、温度、层高与线宽都会影响混色。');
    lines.push('- 若使用平滑/模糊皮肤，请关闭，以免破坏颜色边界。');
    return lines.join('\n');
  }

  CS.exporter = {
    build3MFBytes, build3MFBytesAsync, build3MFBlob, build3MFBlobAsync, planSummary, buildPlanMarkdown, samplePlane, buildPrisms,
    traceLoops, simplifyLoop, loopArea, pointInLoop, meshPrism, exportGridFor, exportReport, buildLayerMasks
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
