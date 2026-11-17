/* ChromaStack color science: sRGB <-> linear <-> CIELAB, DeltaE2000.
   No dependencies. Works in browser and Node (sets globalThis.CS). */
(function (root) {
  'use strict';
  const CS = root.CS = root.CS || {};

  const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);
  const srgbToLinear = (c) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const linearToSrgb = (c) => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  const srgb8ToLinear = (v) => srgbToLinear(v / 255);
  const linearToSrgb8 = (v) => Math.round(clamp(linearToSrgb(clamp(v, 0, 1)), 0, 1) * 255);

  function hexToRgb(hex) {
    let h = String(hex || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) h = '000000';
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  function hexToRgb01(hex) { const c = hexToRgb(hex); return { r: c.r / 255, g: c.g / 255, b: c.b / 255 }; }
  function rgbToHex(r, g, b) {
    const to = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    return '#' + to(r) + to(g) + to(b);
  }
  function rgb255ToHex(rgb) { return rgbToHex(rgb.r, rgb.g, rgb.b); }

  const XN = 0.95047, YN = 1.0, ZN = 1.08883;
  const EPS = 216 / 24389, KAPPA = 24389 / 27;
  function fLab(t) { return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116; }
  function fLabInv(t) { const t3 = t * t * t; return t3 > EPS ? t3 : (116 * t - 16) / KAPPA; }

  function rgb01ToLab(rgb) {
    const r = srgbToLinear(rgb.r), g = srgbToLinear(rgb.g), b = srgbToLinear(rgb.b);
    const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
    const Y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / YN;
    const Z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / ZN;
    const fx = fLab(X), fy = fLab(Y), fz = fLab(Z);
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  }
  function rgb255ToLab(rgb) { return rgb01ToLab({ r: rgb.r / 255, g: rgb.g / 255, b: rgb.b / 255 }); }
  function hexToLab(hex) { return rgb01ToLab(hexToRgb01(hex)); }

  function labToRgb01(lab) {
    const fy = (lab.L + 16) / 116, fx = fy + lab.a / 500, fz = fy - lab.b / 200;
    const X = XN * fLabInv(fx), Y = YN * fLabInv(fy), Z = ZN * fLabInv(fz);
    let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
    let g = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
    let b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
    r = linearToSrgb(clamp(r, 0, 1)); g = linearToSrgb(clamp(g, 0, 1)); b = linearToSrgb(clamp(b, 0, 1));
    return { r, g, b };
  }
  function labToHex(lab) {
    const c = labToRgb01(lab);
    return rgbToHex(c.r * 255, c.g * 255, c.b * 255);
  }

  function deltaE2000(lab1, lab2) {
    const L1 = lab1.L, a1 = lab1.a, b1 = lab1.b;
    const L2 = lab2.L, a2 = lab2.a, b2 = lab2.b;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
    const Cbar = (C1 + C2) / 2;
    const Cbar7 = Math.pow(Cbar, 7);
    const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625))); // 25^7
    const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    let h1p = Math.atan2(b1, a1p) * 180 / Math.PI;
    if (h1p < 0) h1p += 360;
    let h2p = Math.atan2(b2, a2p) * 180 / Math.PI;
    if (h2p < 0) h2p += 360;
    const dLp = L2 - L1;
    const dCp = C2p - C1p;
    let dhp = 0;
    if (C1p * C2p !== 0) {
      dhp = h2p - h1p;
      if (dhp > 180) dhp -= 360;
      else if (dhp < -180) dhp += 360;
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * Math.PI / 180);
    const Lbarp = (L1 + L2) / 2;
    const Cbarp = (C1p + C2p) / 2;
    let hbarp = h1p + h2p;
    if (C1p * C2p !== 0) {
      if (Math.abs(h1p - h2p) > 180) hbarp = (h1p + h2p < 360) ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
      else hbarp = (h1p + h2p) / 2;
    }
    const T = 1 - 0.17 * Math.cos((hbarp - 30) * Math.PI / 180)
      + 0.24 * Math.cos((2 * hbarp) * Math.PI / 180)
      + 0.32 * Math.cos((3 * hbarp + 6) * Math.PI / 180)
      - 0.20 * Math.cos((4 * hbarp - 63) * Math.PI / 180);
    const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
    const Cbarp7 = Math.pow(Cbarp, 7);
    const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 6103515625));
    const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
    const SC = 1 + 0.045 * Cbarp;
    const SH = 1 + 0.015 * Cbarp * T;
    const RT = -Math.sin(2 * dTheta * Math.PI / 180) * RC;
    const x = dLp / SL, y = dCp / SC, z = dHp / SH;
    return Math.sqrt(x * x + y * y + z * z + RT * y * z);
  }

  function mixLinear(a, b, t) {
    return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
  }
  function linearToHex(lin) { return rgbToHex(linearToSrgb8(lin.r), linearToSrgb8(lin.g), linearToSrgb8(lin.b)); }

  CS.color = {
    clamp, srgbToLinear, linearToSrgb, srgb8ToLinear, linearToSrgb8,
    hexToRgb, hexToRgb01, rgbToHex, rgb255ToHex, rgb255ToLab, hexToLab,
    rgb01ToLab, labToRgb01, labToHex, deltaE2000, mixLinear, linearToHex
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
