import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/data-lut.js');
require('../app/js/data-filaments.js');
require('../app/js/engine.js');
const { engine } = globalThis.CS;

const palette = [
  { name: 'Black', hex: '#000000', td: 0.6, brand: 'BambuLab Basic', material: 'PLA' },
  { name: 'Jade White', hex: '#ffffff', td: 5, brand: 'BambuLab Basic', material: 'PLA' },
  { name: 'Red', hex: '#c00d1e', td: 5, brand: 'BambuLab Basic', material: 'PLA' },
  { name: 'Yellow', hex: '#fce300', td: 6, brand: 'BambuLab Basic', material: 'PLA' },
  { name: 'Blue', hex: '#00358e', td: 4, brand: 'BambuLab Basic', material: 'PLA' }
];
const base = {
  engine: 'td', palette, foundationIndex: 1, widthMm: 150, flatTopMm: 1.6, reliefMm: 0.16,
  gradLayers: 6, gradTopMmOverride: 1.76, families: 96, layerHeight: 0.08,
  stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.6, smoothLevel: 2, mergeDeltaE: 4
};

function makeLineArt(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  const set = (x, y, r, g, b) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const p = (y * w + x) * 4;
    data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
  };
  for (let i = 0; i < w * h; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 255; data[i * 4 + 3] = 255; }
  // Thin black diagonal stroke (1 px), the case that majority smoothing eats,
  // plus a grey anti-alias fringe that should inherit the black stroke core.
  for (let t = 0; t < 150; t++) { set(30 + t, 160 - t, 8, 8, 10); set(30 + t, 161 - t, 80, 80, 80); }
  // A parallel red accent a few pixels away.
  for (let t = 0; t < 120; t++) { set(46 + t, 172 - t, 170, 20, 30); set(47 + t, 172 - t, 170, 20, 30); }
  // Saturated thin strokes must also be direct-printable in strong mode.
  for (let t = 0; t < 60; t++) { set(20 + t, 25, 245, 227, 0); set(20 + t, 35, 0, 90, 220); }
  // A closed outline so the detector also sees a normal sticker contour.
  const x0 = 150, y0 = 40, x1 = 225, y1 = 120;
  for (let x = x0; x <= x1; x++) { set(x, y0, 5, 5, 5); set(x, y1, 5, 5, 5); }
  for (let y = y0; y <= y1; y++) { set(x0, y, 5, 5, 5); set(x1, y, 5, 5, 5); }
  for (let y = 70; y < 95; y++) for (let x = 175; x < 200; x++) set(x, y, 190, 20, 32);
  return { width: w, height: h, data };
}

function makePhotoLike(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4;
    const t = x / w, u = y / h;
    data[p] = Math.round(40 + 150 * t + 30 * Math.sin(u * 5));
    data[p + 1] = Math.round(80 + 90 * u);
    data[p + 2] = Math.round(120 + 80 * (1 - t));
    data[p + 3] = 255;
  }
  return { width: w, height: h, data };
}

let failures = 0;
const check = (ok, msg) => {
  if (!ok) { failures++; console.error('FAIL', msg); }
  else console.log('ok  ', msg);
};

const art = makeLineArt(240, 180);
const plans = {};
for (const mode of ['off', 'auto', 'strong']) {
  plans[mode] = engine.buildPlan(art, { ...base, lineProtect: mode });
  const p = plans[mode];
  console.log(mode, { dE: +p.stats.meanDE.toFixed(2), p90: p.stats.p90, flat: +p.stats.flatPercent.toFixed(1), direct: +p.lineInfo.directPercent.toFixed(1), applied: p.lineApplied });
}
check(plans.off.lineInfo.active, 'line art is detected');
check(plans.auto.lineApplied, 'auto line protection applies to line art');
check(plans.auto.edgeClean === 0, 'edge cleanup is skipped on nearly-flat line art (gradient < 20%)');
check(plans.strong.lineApplied && plans.strong.lineInfo.directPercent > 0, 'strong mode promotes dark strokes to direct colour');
check(plans.auto.stats.meanDE <= plans.off.stats.meanDE + 0.25, 'auto line protection does not worsen colour error');
check(plans.auto.familyId && plans.auto.lineDirectMask == null, 'auto keeps strokes in layered families (no direct mask)');
check(plans.strong.flatMask && plans.strong.lineInfo.directPercent > 0, 'strong strokes are part of the flat/direct mask');
const yellowAt = 25 * art.width + 30, blueAt = 35 * art.width + 30;
check(plans.strong.flatMask[yellowAt] && plans.strong.flatFilament[yellowAt] === 3, 'thin yellow stroke is direct Yellow in strong mode');
check(plans.strong.flatMask[blueAt] && plans.strong.flatFilament[blueAt] === 4, 'thin blue stroke is direct Blue in strong mode');
const fillCenter = 80 * art.width + 190;
check(!plans.strong.lineDirectMask[fillCenter], 'large saturated fill centre is not misclassified as a thin stroke');
const fringeAt = 161 * art.width + 30;
check(plans.strong.flatMask[fringeAt] && plans.strong.flatFilament[fringeAt] === 0, 'grey anti-alias fringe inherits the nearby black stroke core');
const srcLab = engine.imageToLab(art).lab;
let lifted = 0, strokePixels = 0;
for (let i = 0; i < art.width * art.height; i++) {
  if (!plans.auto.lineProtectMask[i]) continue;
  strokePixels++;
  if (plans.auto.predicted[i].lab.L > srcLab[i * 3] + 30) lifted++;
}
check(strokePixels > 0 && lifted === 0, 'protected strokes are never lifted more than 30 L by a light recipe');

const photo = makePhotoLike(240, 160);
const photoPlan = engine.buildPlan(photo, { ...base, lineProtect: 'auto' });
console.log('photo', { active: photoPlan.lineInfo.active, applied: photoPlan.lineApplied, dE: +photoPlan.stats.meanDE.toFixed(2) });
check(photoPlan.lineInfo.active === false, 'smooth gradient/photo-like image is not classified as line art');
check(photoPlan.lineApplied === false, 'auto mode does not change photo-like image');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall line-protection checks passed');
