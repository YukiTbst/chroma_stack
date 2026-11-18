/* Lightweight WebGL material-stack and relief preview. No dependencies.
   Stack mode: optical top colours + real filament side layers + X cross-section.
   Finish mode: predicted-colour heightfield. Heights are exaggerated for inspection. */
(function (root) {
  'use strict';
  const CS = root.CS = root.CS || {};
  const FRONT_YAW = Math.PI / 2 - 0.28;

  const V = {
    canvas: null,
    gl: null,
    program: null,
    loc: {},
    vbo: null,
    ibo: null,
    indexType: null,
    indexCount: 0,
    sectionCount: 0,
    vertexCount: 0,
    uint32Ext: null,
    plan: null,
    mode: 'stack',
    section: false,
    sectionPos: 0.5,
    exag: 8,
    cam: { yaw: FRONT_YAW, pitch: 0.55, dist: 260, targetY: 7, minDist: 80, maxDist: 900 },
    baseDist: 260,
    dims: { w: 150, h: 100 },
    initialized: false,
    dragging: false,
    lastX: 0,
    lastY: 0
  };

  const VS = `
attribute vec3 aPos;
attribute vec3 aColor;
attribute vec3 aNormal;
uniform mat4 uMVP;
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vColor = aColor;
  vNormal = aNormal;
  vWorld = aPos;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

  const FS = `
precision highp float;
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorld;
uniform vec3 uLight;
uniform vec3 uCam;
uniform float uClipX;
void main() {
  if (vWorld.x > uClipX) discard;
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 L = normalize(uLight);
  float diff = max(dot(n, L), 0.0);
  vec3 V = normalize(uCam - vWorld);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(n, H), 0.0), 32.0) * 0.20;
  vec3 lit = vColor * (0.42 + 0.72 * diff) + vec3(spec);
  gl_FragColor = vec4(pow(max(lit, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
}`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
    }
    return sh;
  }

  function init(canvas) {
    if (!canvas) return false;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true })
      || canvas.getContext('experimental-webgl', { antialias: true, alpha: false });
    if (!gl) return false;
    V.canvas = canvas;
    V.gl = gl;
    try {
      const vs = compile(gl, gl.VERTEX_SHADER, VS);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || 'program link failed');
      }
      V.program = program;
      V.loc.aPos = gl.getAttribLocation(program, 'aPos');
      V.loc.aColor = gl.getAttribLocation(program, 'aColor');
      V.loc.aNormal = gl.getAttribLocation(program, 'aNormal');
      V.loc.uMVP = gl.getUniformLocation(program, 'uMVP');
      V.loc.uLight = gl.getUniformLocation(program, 'uLight');
      V.loc.uCam = gl.getUniformLocation(program, 'uCam');
      V.loc.uClipX = gl.getUniformLocation(program, 'uClipX');
      V.uint32Ext = gl.getExtension('OES_element_index_uint');
      V.vbo = gl.createBuffer();
      V.ibo = gl.createBuffer();
      V.initialized = true;
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      bindControls(canvas);
      return true;
    } catch (e) {
      console.warn('3D preview unavailable', e);
      return false;
    }
  }

  function bindControls(canvas) {
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => {
      if (!V.initialized) return;
      V.dragging = true;
      V.lastX = e.clientX; V.lastY = e.clientY;
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!V.dragging || !V.initialized) return;
      const dx = e.clientX - V.lastX, dy = e.clientY - V.lastY;
      V.lastX = e.clientX; V.lastY = e.clientY;
      V.cam.yaw += dx * 0.007;
      V.cam.pitch += dy * 0.0055;
      V.cam.pitch = Math.max(0.06, Math.min(1.38, V.cam.pitch));
      render();
      e.preventDefault();
    });
    const end = (e) => {
      V.dragging = false;
      try { canvas.releasePointerCapture && canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      if (!V.initialized) return;
      V.cam.dist *= Math.exp(e.deltaY * 0.0011);
      V.cam.dist = Math.max(V.cam.minDist, Math.min(V.cam.maxDist, V.cam.dist));
      render();
      e.preventDefault();
    }, { passive: false });
  }

  function resetCamera() {
    const maxDim = Math.max(V.dims.w, V.dims.h, 20);
    V.baseDist = maxDim * 1.5;
    V.cam.dist = V.baseDist;
    V.cam.minDist = maxDim * 0.45;
    V.cam.maxDist = maxDim * 3.2;
    // Front view: image left/right stay in the same direction as the 2D views.
    V.cam.yaw = FRONT_YAW;
    V.cam.pitch = 0.55;
    V.cam.targetY = V.targetY || 6;
  }

  function setPlan(plan, exag) {
    if (!plan) return;
    const dimsChanged = !V.plan || Math.abs(V.plan.widthMm - plan.widthMm) > 1e-3 || Math.abs(V.plan.heightMm - plan.heightMm) > 1e-3;
    V.plan = plan;
    V.exag = Math.max(1, Number(exag) || 8);
    V.dims = { w: plan.widthMm, h: plan.heightMm };
    if (dimsChanged || !V.initialized) resetCamera();
    buildMesh();
    render();
  }

  function setExaggeration(exag) {
    V.exag = Math.max(1, Number(exag) || 1);
    if (V.plan) buildMesh();
    render();
  }

  function setMode(mode) {
    const next = mode === 'finish' ? 'finish' : 'stack';
    if (V.mode === next) { render(); return; }
    V.mode = next;
    if (V.plan) buildMesh();
    render();
  }

  function setSection(enabled, position) {
    const nextEnabled = !!enabled;
    const nextPos = position == null ? V.sectionPos : Math.max(0, Math.min(1, Number(position) || 0));
    if (V.section === nextEnabled && V.sectionPos === nextPos) { render(); return; }
    V.section = nextEnabled;
    V.sectionPos = nextPos;
    if (V.plan) buildMesh();
    render();
  }

  function samplePlan(plan, x, y) {
    const sx = Math.min(plan.w - 1, Math.max(0, Math.round(x)));
    const sy = Math.min(plan.h - 1, Math.max(0, Math.round(y)));
    const i = sy * plan.w + sx;
    if (plan.printMask && !plan.printMask[i]) return { top: 0, i };
    let top;
    if (plan.flatMask[i]) top = plan.flatLayers;
    else {
      const f = plan.familyId[i];
      top = plan.gradStartLayer + (f >= 0 ? plan.families[f].recipe.length : 0);
    }
    return { top, i };
  }

  function materialAt(plan, i, z) {
    if (plan.printMask && !plan.printMask[i]) return -1;
    if (plan.flatMask[i]) {
      if (z < (plan.flatBaseLayers || 0)) return plan.foundationIndex;
      return z < plan.flatLayers ? plan.flatFilament[i] : -1;
    }
    if (z < plan.gradStartLayer) return plan.foundationIndex;
    const f = plan.familyId[i];
    if (f < 0) return -1;
    const li = z - plan.gradStartLayer;
    const seq = plan.families[f].recipe;
    return li >= 0 && li < seq.length ? seq[li] : -1;
  }

  // Physical material stack: flat top cells show the optical result, while
  // every exposed vertical step is segmented into its real filament layers.
  // A clipping plane plus a full material cross-section reveals the interior.
  function sampleCell(plan, x, y, gw, gh, vertexGrid) {
    const px = vertexGrid ? (gw <= 1 ? 0 : x / (gw - 1) * (plan.w - 1)) : (x + 0.5) * plan.w / gw - 0.5;
    const py = vertexGrid ? (gh <= 1 ? 0 : y / (gh - 1) * (plan.h - 1)) : (y + 0.5) * plan.h / gh - 0.5;
    const base = samplePlan(plan, px, py);
    if (!plan.printMask || plan.printMask[base.i]) return base;
    // Nearest-centre sampling can erase a one-pixel accent or reopen a just
    // deleted pinhole. Search the covered footprint for the nearest printable
    // pixel before accepting an empty preview cell.
    const sx = Math.round(px), sy = Math.round(py);
    const rx = Math.max(0, Math.ceil(plan.w / (2 * gw)));
    const ry = Math.max(0, Math.ceil(plan.h / (2 * gh)));
    let best = -1, bestD = Infinity;
    for (let yy = Math.max(0, sy - ry); yy <= Math.min(plan.h - 1, sy + ry); yy++) {
      for (let xx = Math.max(0, sx - rx); xx <= Math.min(plan.w - 1, sx + rx); xx++) {
        const j = yy * plan.w + xx;
        if (!plan.printMask[j]) continue;
        const d = (xx - px) ** 2 + (yy - py) ** 2;
        if (d < bestD) { bestD = d; best = j; }
      }
    }
    return best >= 0 ? samplePlan(plan, best % plan.w, (best / plan.w) | 0) : base;
  }

  function buildStackMesh(gridOverride) {
    const p = V.plan, gl = V.gl;
    if (!p || !gl) return;
    const maxGrid = gridOverride || (V.uint32Ext ? 240 : 110);
    const scale = Math.min(1, maxGrid / Math.max(p.w, p.h));
    const gw = Math.max(1, Math.round(p.w * scale));
    const gh = Math.max(1, Math.round(p.h * scale));
    const W = Math.max(1, p.widthMm), H = Math.max(1, p.heightMm);
    const cw = W / gw, cd = H / gh, lh = p.layerHeight * V.exag;
    const tops = new Int32Array(gw * gh), source = new Int32Array(gw * gh);
    const positions = [], normals = [], colors = [], indices = [], sectionIndices = [];
    const palette = p.palette.map(entry => {
      const rgb = CS.color.hexToRgb(entry.hex);
      return [Math.pow(rgb.r / 255, 2.2), Math.pow(rgb.g / 255, 2.2), Math.pow(rgb.b / 255, 2.2)];
    });
    let minY = Infinity, maxY = -Infinity;
    const addQuad = (points, normal, color, section) => {
      const base = positions.length / 3;
      for (const pt of points) {
        positions.push(pt[0], pt[1], pt[2]);
        normals.push(normal[0], normal[1], normal[2]);
        colors.push(color[0], color[1], color[2]);
      }
      const target = section ? sectionIndices : indices;
      const ux = points[1][0] - points[0][0], uy = points[1][1] - points[0][1], uz = points[1][2] - points[0][2];
      const vx = points[2][0] - points[0][0], vy = points[2][1] - points[0][1], vz = points[2][2] - points[0][2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx * normal[0] + cy * normal[1] + cz * normal[2] < 0) {
        target.push(base, base + 2, base + 1, base, base + 3, base + 2);
      } else {
        target.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    };
    const layeredFace = (ax, az, bx, bz, lo, hi, i, nx, nz, section) => {
      let z = lo;
      while (z < hi) {
        const fi = materialAt(p, i, z);
        let end = z + 1;
        while (end < hi && materialAt(p, i, end) === fi) end++;
        if (fi >= 0) {
          const y0 = z * lh, y1 = end * lh;
          addQuad([[ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]], [nx, 0, nz], palette[fi], section);
        }
        z = end;
      }
    };
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const s = sampleCell(p, x, y, gw, gh);
        tops[i] = s.top; source[i] = s.i;
        const h = s.top * lh;
        minY = Math.min(minY, h); maxY = Math.max(maxY, h);
        const x0 = -W / 2 + x * cw, x1 = x0 + cw;
        const z0 = -H / 2 + y * cd, z1 = z0 + cd;
        const c = s.i * 4;
        const color = [Math.pow(p.preview[c] / 255, 2.2), Math.pow(p.preview[c + 1] / 255, 2.2), Math.pow(p.preview[c + 2] / 255, 2.2)];
        if (!p.printMask || p.printMask[s.i]) {
          addQuad([[x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1]], [0, 1, 0], color, false);
        }
      }
    }
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x, top = tops[i];
        const x0 = -W / 2 + x * cw, x1 = x0 + cw;
        const z0 = -H / 2 + y * cd, z1 = z0 + cd;
        if (x === 0) layeredFace(x0, z1, x0, z0, 0, top, i, -1, 0, false);
        if (y === 0) layeredFace(x0, z0, x1, z0, 0, top, i, 0, -1, false);
        if (x + 1 < gw) {
          const other = tops[i + 1];
          if (top > other) layeredFace(x1, z0, x1, z1, other, top, i, 1, 0, false);
          else if (other > top) layeredFace(x1, z1, x1, z0, top, other, i + 1, -1, 0, false);
        } else {
          layeredFace(x1, z0, x1, z1, 0, top, i, 1, 0, false);
        }
        if (y + 1 < gh) {
          const other = tops[i + gw];
          if (top > other) layeredFace(x1, z1, x0, z1, other, top, i, 0, 1, false);
          else if (other > top) layeredFace(x0, z1, x1, z1, top, other, i + gw, 0, -1, false);
        } else {
          layeredFace(x1, z1, x0, z1, 0, top, i, 0, 1, false);
        }
      }
    }
    V.targetY = (minY + maxY) / 2;
    if (V.cam.targetY < minY || V.cam.targetY > maxY) V.cam.targetY = V.targetY;
    V.clipX = 1e20;
    if (V.section && gw > 1) {
      const cut = Math.max(0, Math.min(gw - 2, Math.round(V.sectionPos * (gw - 1))));
      const planeX = -W / 2 + (cut + 1) * cw;
      V.clipX = planeX + cw * 1e-4;
      for (let y = 0; y < gh; y++) {
        const i = y * gw + cut;
        const z0 = -H / 2 + y * cd, z1 = z0 + cd;
        layeredFace(planeX, z0, planeX, z1, 0, tops[i], i, 1, 0, true);
      }
    }
    if (!V.uint32Ext && positions.length / 3 > 65535) {
      // Preserve stack mode on older WebGL implementations. Reducing XY density
      // keeps real material walls/section intact; at 4×4 even 24 alternating
      // layers per cell fit comfortably in a Uint16 index buffer.
      const next = Math.max(4, Math.floor(maxGrid * 0.72));
      if (next < maxGrid) {
        console.warn(`Material stack grid reduced to ${next} for 16-bit indices.`);
        buildStackMesh(next);
        return;
      }
    }
    const totalVerts = positions.length / 3;
    const data = new Float32Array(totalVerts * 9);
    let o = 0;
    for (let i = 0; i < totalVerts; i++) {
      data[o++] = positions[i * 3]; data[o++] = positions[i * 3 + 1]; data[o++] = positions[i * 3 + 2];
      data[o++] = colors[i * 3]; data[o++] = colors[i * 3 + 1]; data[o++] = colors[i * 3 + 2];
      data[o++] = normals[i * 3]; data[o++] = normals[i * 3 + 1]; data[o++] = normals[i * 3 + 2];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, V.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const allIndices = V.uint32Ext ? new Uint32Array(indices.concat(sectionIndices)) : new Uint16Array(indices.concat(sectionIndices));
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, V.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, allIndices, gl.STATIC_DRAW);
    V.indexType = V.uint32Ext ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    V.vertexCount = totalVerts;
    V.indexCount = indices.length;
    V.sectionCount = sectionIndices.length;
  }

  function buildFinishMesh(gridOverride) {
    const p = V.plan;
    if (!p) return;
    const gl = V.gl;
    if (!gl) return;
    let scale = Math.min(1, (gridOverride || 320) / Math.max(p.w, p.h));
    let gw = Math.max(2, Math.round(p.w * scale));
    let gh = Math.max(2, Math.round(p.h * scale));
    // Keep Uint16 indices valid; the slab walls use ~8*(gw+gh) vertices.
    while (gw * gh + 8 * (gw + gh) > 60000) {
      scale *= 0.94;
      gw = Math.max(2, Math.round(p.w * scale));
      gh = Math.max(2, Math.round(p.h * scale));
    }
    const W = Math.max(1, p.widthMm), H = Math.max(1, p.heightMm);
    const dx = W / (gw - 1), dz = H / (gh - 1);
    const heights = new Float32Array(gw * gh);
    const visible = new Uint8Array(gw * gh);
    const colors = new Float32Array(gw * gh * 3);
    const positions = new Float32Array(gw * gh * 3);
    const normals = new Float32Array(gw * gh * 3);
    let minY = Infinity, maxY = -Infinity;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const s = sampleCell(p, x, y, gw, gh, true);
        const h = s.top * p.layerHeight * V.exag;
        const i = y * gw + x;
        heights[i] = h;
        visible[i] = p.printMask ? p.printMask[s.i] : 1;
        minY = Math.min(minY, h); maxY = Math.max(maxY, h);
        const c = s.i * 4;
        colors[i * 3] = Math.pow(p.preview[c] / 255, 2.2);
        colors[i * 3 + 1] = Math.pow(p.preview[c + 1] / 255, 2.2);
        colors[i * 3 + 2] = Math.pow(p.preview[c + 2] / 255, 2.2);
        positions[i * 3] = (x / (gw - 1) - 0.5) * W;
        positions[i * 3 + 1] = h;
        positions[i * 3 + 2] = (y / (gh - 1) - 0.5) * H;
      }
    }
    // Surface normals from the heightfield.
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const hl = x > 0 ? heights[i - 1] : heights[i];
        const hr = x + 1 < gw ? heights[i + 1] : heights[i];
        const hu = y > 0 ? heights[i - gw] : heights[i];
        const hd = y + 1 < gh ? heights[i + gw] : heights[i];
        let nx = -(hr - hl) / (2 * dx);
        let nz = -(hu - hd) / (2 * dz);
        let ny = 1;
        const len = Math.hypot(nx, ny, nz) || 1;
        normals[i * 3] = nx / len;
        normals[i * 3 + 1] = ny / len;
        normals[i * 3 + 2] = nz / len;
      }
    }
    V.targetY = (minY + maxY) / 2;
    if (V.cam.targetY < minY || V.cam.targetY > maxY) V.cam.targetY = V.targetY;
    // Top indices (a,b,c / a,c,d) wind upward with Z increasing toward the image top.
    const idx = [];
    for (let y = 0; y < gh - 1; y++) {
      for (let x = 0; x < gw - 1; x++) {
        const a = y * gw + x, b = a + 1, c = a + gw + 1, d = a + gw;
        if (visible[a] || visible[b] || visible[c] || visible[d]) idx.push(a, d, c, a, c, b);
      }
    }
    // Slab walls (dark neutral) from z=0 to the top edge height.
    const verts = [];
    const norms = [];
    const cols = [];
    const wallColor = [0.055, 0.062, 0.068];
    const addWall = (x0, z0, h0, x1, z1, h1, nx, nz) => {
      const base = positions.length / 3 + verts.length / 3;
      verts.push(x0, h0, z0, x0, 0, z0, x1, h1, z1, x1, 0, z1);
      norms.push(nx, 0, nz, nx, 0, nz, nx, 0, nz, nx, 0, nz);
      for (let k = 0; k < 4; k++) cols.push(...wallColor);
      const ux = 0, uy = -h0, uz = 0;
      const vx = x1 - x0, vy = h1 - h0, vz = z1 - z0;
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx * nx + cz * nz < 0) idx.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
      else idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    };
    const topZ = -H / 2, bottomZ = H / 2, leftX = -W / 2, rightX = W / 2;
    for (let x = 0; x < gw - 1; x++) {
      const i0 = x, i1 = x + 1;
      if (visible[i0] || visible[i1]) addWall(positions[i0 * 3], topZ, heights[i0], positions[i1 * 3], topZ, heights[i1], 0, -1);
      const j0 = (gh - 1) * gw + x, j1 = j0 + 1;
      if (visible[j0] || visible[j1]) addWall(positions[j0 * 3], bottomZ, heights[j0], positions[j1 * 3], bottomZ, heights[j1], 0, 1);
    }
    for (let y = 0; y < gh - 1; y++) {
      const i0 = y * gw, i1 = (y + 1) * gw;
      if (visible[i0] || visible[i1]) addWall(leftX, positions[i0 * 3 + 2], heights[i0], leftX, positions[i1 * 3 + 2], heights[i1], -1, 0);
      const j0 = y * gw + gw - 1, j1 = (y + 1) * gw + gw - 1;
      if (visible[j0] || visible[j1]) addWall(rightX, positions[j0 * 3 + 2], heights[j0], rightX, positions[j1 * 3 + 2], heights[j1], 1, 0);
    }
    // Interior silhouette walls are just as important as the outer plate edge:
    // background removal can leave a character-shaped hole anywhere in the grid.
    for (let y = 0; y < gh - 1; y++) {
      for (let x = 0; x < gw - 1; x++) {
        const a = y * gw + x, b = a + 1, c = a + gw + 1, d = a + gw;
        if (visible[a] !== visible[b]) {
          const owner = visible[a] ? a : b;
          const wallX = (positions[a * 3] + positions[b * 3]) / 2;
          addWall(wallX, positions[a * 3 + 2], heights[owner], wallX, positions[(owner + gw) * 3 + 2], heights[owner + gw], visible[a] ? 1 : -1, 0);
        }
        if (visible[a] !== visible[d]) {
          const owner = visible[a] ? a : d;
          const wallZ = (positions[a * 3 + 2] + positions[d * 3 + 2]) / 2;
          addWall(positions[a * 3], wallZ, heights[owner], positions[b * 3], wallZ, heights[owner + 1], 0, visible[a] ? -1 : 1);
        }
      }
    }
    const totalVerts = positions.length / 3 + verts.length / 3;
    if (totalVerts > 65535 && !V.uint32Ext) {
      buildFinishMesh(Math.max(4, Math.floor(Math.max(gw, gh) * 0.72)));
      return;
    }
    const data = new Float32Array(totalVerts * 9);
    let o = 0;
    for (let i = 0; i < positions.length / 3; i++) {
      data[o++] = positions[i * 3]; data[o++] = positions[i * 3 + 1]; data[o++] = positions[i * 3 + 2];
      data[o++] = colors[i * 3]; data[o++] = colors[i * 3 + 1]; data[o++] = colors[i * 3 + 2];
      data[o++] = normals[i * 3]; data[o++] = normals[i * 3 + 1]; data[o++] = normals[i * 3 + 2];
    }
    for (let i = 0; i < verts.length / 3; i++) {
      data[o++] = verts[i * 3]; data[o++] = verts[i * 3 + 1]; data[o++] = verts[i * 3 + 2];
      data[o++] = cols[i * 3]; data[o++] = cols[i * 3 + 1]; data[o++] = cols[i * 3 + 2];
      data[o++] = norms[i * 3]; data[o++] = norms[i * 3 + 1]; data[o++] = norms[i * 3 + 2];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, V.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, V.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, V.uint32Ext ? new Uint32Array(idx) : new Uint16Array(idx), gl.STATIC_DRAW);
    V.indexType = V.uint32Ext ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    V.vertexCount = totalVerts;
    V.indexCount = idx.length;
    V.sectionCount = 0;
    V.clipX = 1e20;
  }

  function buildMesh() {
    if (V.mode === 'stack') buildStackMesh();
    else buildFinishMesh();
  }

  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, (2 * far * near) / (near - far), 0
    ]);
  }

  function lookAt(eye, center, up) {
    const zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    let zl = Math.hypot(zx, zy, zz) || 1;
    const z = [zx / zl, zy / zl, zz / zl];
    const x = [
      up[1] * z[2] - up[2] * z[1],
      up[2] * z[0] - up[0] * z[2],
      up[0] * z[1] - up[1] * z[0]
    ];
    let xl = Math.hypot(x[0], x[1], x[2]) || 1;
    x[0] /= xl; x[1] /= xl; x[2] /= xl;
    const y = [
      z[1] * x[2] - z[2] * x[1],
      z[2] * x[0] - z[0] * x[2],
      z[0] * x[1] - z[1] * x[0]
    ];
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
      -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
      -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
      1
    ]);
  }

  function mul4(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] = a[0 * 4 + r] * b[c * 4 + 0] + a[1 * 4 + r] * b[c * 4 + 1]
          + a[2 * 4 + r] * b[c * 4 + 2] + a[3 * 4 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }

  function resize() {
    const c = V.canvas, gl = V.gl;
    if (!c || !gl) return;
    const rect = c.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(rect.width * dpr));
    const h = Math.max(2, Math.round(rect.height * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w; c.height = h;
    }
    gl.viewport(0, 0, w, h);
  }

  function clear() {
    V.plan = null; V.indexCount = 0; V.sectionCount = 0;
    const gl = V.gl;
    if (!gl || !V.canvas) return;
    resize();
    gl.clearColor(0.07, 0.09, 0.10, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  function render() {
    const gl = V.gl;
    if (!gl || !V.plan || !V.initialized) return;
    resize();
    const w = V.canvas.width, h = V.canvas.height;
    if (w < 2 || h < 2) return;
    gl.clearColor(0.07, 0.09, 0.10, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(V.program);
    const aspect = w / h;
    const near = Math.max(0.1, V.cam.dist * 0.01);
    const far = V.cam.dist * 10 + Math.max(V.dims.w, V.dims.h) * 2;
    const proj = perspective(35 * Math.PI / 180, aspect, near, far);
    const cp = Math.cos(V.cam.pitch), sp = Math.sin(V.cam.pitch);
    const eye = [
      V.cam.dist * Math.cos(V.cam.yaw) * cp,
      V.cam.targetY + V.cam.dist * sp,
      V.cam.dist * Math.sin(V.cam.yaw) * cp
    ];
    const view = lookAt(eye, [0, V.cam.targetY, 0], [0, 1, 0]);
    const mvp = mul4(proj, view);
    gl.uniformMatrix4fv(V.loc.uMVP, false, mvp);
    gl.uniform3fv(V.loc.uLight, new Float32Array([-0.45, 0.85, 0.35]));
    gl.uniform3fv(V.loc.uCam, new Float32Array(eye));
    gl.uniform1f(V.loc.uClipX, V.mode === 'stack' && V.section ? V.clipX : 1e20);
    gl.bindBuffer(gl.ARRAY_BUFFER, V.vbo);
    const stride = 9 * 4;
    gl.enableVertexAttribArray(V.loc.aPos);
    gl.vertexAttribPointer(V.loc.aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(V.loc.aColor);
    gl.vertexAttribPointer(V.loc.aColor, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(V.loc.aNormal);
    gl.vertexAttribPointer(V.loc.aNormal, 3, gl.FLOAT, false, stride, 24);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, V.ibo);
    gl.drawElements(gl.TRIANGLES, V.indexCount, V.indexType || gl.UNSIGNED_SHORT, 0);
    if (V.sectionCount && V.mode === 'stack' && V.section) {
      gl.uniform1f(V.loc.uClipX, 1e20);
      const bytes = V.indexType === gl.UNSIGNED_INT ? 4 : 2;
      gl.drawElements(gl.TRIANGLES, V.sectionCount, V.indexType, V.indexCount * bytes);
    }
  }

  CS.view3d = {
    init, setPlan, setExaggeration, setMode, setSection, resize, render, clear, reset: () => { resetCamera(); render(); },
    isReady: () => !!V.initialized,
    getCamera: () => ({ ...V.cam }),
    _samplePlan: samplePlan,
    _sampleCell: sampleCell,
    _materialAt: materialAt,
    _buildMesh: buildMesh,
    _math: { lookAt, mul4, perspective },
    _V: V
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);