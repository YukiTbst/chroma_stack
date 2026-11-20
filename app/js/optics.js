/* ChromaStack shared optics — the SINGLE source of the front-lit RGB attenuation
   model used by calibration, the engine, diagnostics and tests (P1 / S01).
     T[c] = 10^(-thicknessMm / HD[c])
     out[c] = opaqueLinear[c]*(1-T[c]) + underLinear[c]*T[c]
   HD is in mm; TD = 10*HD is only this project's parameter mapping, not a physical
   law. Stacks are bottom-to-top. A boundary is either a measured substrate
   reflectance (linearRgb) or a fully-modeled support stack — never both. */
(function (root) {
  const CS = root.CS = root.CS || {};
  const C = CS.color;
  const TD_PER_HD = 10;

  function transmission(thicknessMm, hdMm) {
    if (!(thicknessMm > 0) || !(hdMm > 0)) return 1;
    return Math.pow(10, -thicknessMm / hdMm);
  }
  function hdChannel(mat, c) {
    const v = mat['hd' + c];
    if (v != null) return v;
    if (mat.hd != null) return mat.hd;
    if (mat.td != null) return mat.td / TD_PER_HD;
    return 0.5;
  }
  function opaqueLinearOf(mat) {
    if (mat.lin) return mat.lin;
    const rgb = C.hexToRgb01(mat.hex);
    return { r: C.srgbToLinear(rgb.r), g: C.srgbToLinear(rgb.g), b: C.srgbToLinear(rgb.b) };
  }
  function mixOver(fg, under, T) {
    return { r: fg.r * (1 - T.r) + under.r * T.r, g: fg.g * (1 - T.g) + under.g * T.g, b: fg.b * (1 - T.b) + under.b * T.b };
  }
  function layerT(mat, thicknessMm) {
    return { r: transmission(thicknessMm, hdChannel(mat, 'R')), g: transmission(thicknessMm, hdChannel(mat, 'G')), b: transmission(thicknessMm, hdChannel(mat, 'B')) };
  }

  /* Legacy adapter: uniform-thickness bottom-to-top sequence of palette indices.
     Kept so existing engine callers delegate here during migration. */
  function compositeLinear(bg, seq, palette, layerHeight) {
    let cur = { r: bg.r, g: bg.g, b: bg.b };
    for (let i = 0; i < seq.length; i++) {
      const p = palette[seq[i]];
      cur = mixOver(opaqueLinearOf(p), cur, layerT(p, layerHeight));
    }
    return cur;
  }
  function linearToLab(lin) {
    return C.rgb01ToLab({ r: C.linearToSrgb(lin.r), g: C.linearToSrgb(lin.g), b: C.linearToSrgb(lin.b) });
  }
  function compositeLab(bg, seq, palette, layerHeight) {
    const lin = compositeLinear(bg, seq, palette, layerHeight);
    return { lin, lab: linearToLab(lin) };
  }

  /* Full-stack contract. stack: bottom-to-top [{ materialId, layerCount }] with a
     shared layerScheduleMm, or [{ materialId, thicknessMm }]. model.materials maps
     materialId -> { lin/hex, hdR/hdG/hdB }. boundary: { linearRgb } measured
     substrate, or { supportStack } modeled support over black, or null (warn). */
  function predictStack(model, stack, boundary, layerScheduleMm) {
    const warnings = [];
    const mats = model.materials || {};
    let cur;
    if (boundary && boundary.linearRgb) cur = { ...boundary.linearRgb };
    else if (boundary && boundary.supportStack) {
      cur = { r: 0, g: 0, b: 0 };
      for (const seg of boundary.supportStack) cur = applySeg(cur, seg);
    } else { cur = { r: 0, g: 0, b: 0 }; warnings.push('missing boundary: assumed black backing'); }
    function applySeg(under, seg) {
      const mat = mats[seg.materialId];
      if (!mat) { warnings.push('unknown material ' + seg.materialId); return under; }
      const th = seg.thicknessMm != null ? seg.thicknessMm : (seg.layerCount || 1) * (layerScheduleMm || 0.08);
      return mixOver(opaqueLinearOf(mat), under, layerT(mat, th));
    }
    for (const seg of stack) cur = applySeg(cur, seg);
    return { linearRgb: cur, lab: linearToLab(cur), warnings, domain: model.compatibilityDomain || null };
  }

  CS.optics = { TD_PER_HD, transmission, hdChannel, opaqueLinearOf, compositeLinear, compositeLab, linearToLab, predictStack };
})(typeof globalThis !== 'undefined' ? globalThis : this);