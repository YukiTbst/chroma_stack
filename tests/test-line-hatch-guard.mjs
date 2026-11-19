/* R2: gap repair must not bridge the real gray fill between parallel hatch
   lines. "Both sides are black and the middle is neutral" is not evidence of
   one broken stroke: repair needs direction continuity (stroke ink continues
   behind BOTH endpoints along the bridge axis) and the gap pixel must not sit
   in a locally stable fill/gradient (even when the flat mask excluded it).
   The lineRepair=false plan is the safety control: the repaired plan may not
   add any gray direct-print/protected pixel nor worsen gray ΔE.
   Positive controls: a real broken neutral line still bridges through the
   repair path; the existing skin-band and pale-blue AA cases live in
   test-line-gap-guard.mjs and must keep passing unchanged.
   Run: node tests/test-line-hatch-guard.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/data-filaments.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
const C = globalThis.CS.color, E = globalThis.CS.engine;

const names = ['Black', 'Jade White', 'Red', 'Yellow', 'Blue'];
const palette = names.map(name => {
  const p = globalThis.CS.FILAMENT_DB.filaments.find(f => f.brand === 'BambuLab Basic' && f.material === 'PLA' && f.name === name);
  assert.ok(p, 'library filament ' + name);
  return { id: p.id, name, hex: p.hex, td: p.td, brand: p.brand, material: p.material };
});
const base = {
  engine: 'td', palette, widthMm: 150, flatTopMm: 1.6, reliefMm: 0.16,
  variableHeight: true, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1,
  stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.02,
  smoothMm: 0, lineWidthMm: 0.42, smoothLevel: 0, mergeDeltaE: 0,
  heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false,
  lineProtect: 'strong', families: 16, backgroundMode: 'off'
};

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

/* ---- hatch safety control (review isolation sample) ---- */
function hatch(period) {
  const w = 800, h = 200;
  const data = new Uint8ClampedArray(w * h * 4);
  const grayMask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const isLine = x % period === 0;
    data.set(isLine ? [0, 0, 0, 255] : [120, 120, 126, 255], i * 4);
    if (!isLine) grayMask[i] = 1;
  }
  return { image: { width: w, height: h, data }, grayMask, w, h };
}
const grayLab = C.rgb255ToLab({ r: 120, g: 120, b: 126 });
function auditHatch(period) {
  const { image, grayMask, w, h } = hatch(period);
  const control = E.buildPlan(image, { ...base, lineRepair: false });
  const repaired = E.buildPlan(image, { ...base, lineRepair: true });
  let n = 0, cDirect = 0, rDirect = 0, cProtect = 0, rProtect = 0, cSum = 0, rSum = 0;
  for (let i = 0; i < w * h; i++) {
    if (!grayMask[i]) continue;
    n++;
    if (control.lineDirectMask && control.lineDirectMask[i]) cDirect++;
    if (repaired.lineDirectMask && repaired.lineDirectMask[i]) rDirect++;
    if (control.lineProtectMask && control.lineProtectMask[i]) cProtect++;
    if (repaired.lineProtectMask && repaired.lineProtectMask[i]) rProtect++;
    cSum += C.deltaE2000(grayLab, control.predicted[i].lab);
    rSum += C.deltaE2000(grayLab, repaired.predicted[i].lab);
  }
  const cMean = cSum / n, rMean = rSum / n;
  console.log(`hatch period ${period}: gray ${n}, direct control ${cDirect} / repaired ${rDirect}, protected control ${cProtect} / repaired ${rProtect}, mean ΔE control ${cMean.toFixed(2)} / repaired ${rMean.toFixed(2)}`);
  check(`hatch${period} control has no gray direct pixels`, cDirect === 0, `control=${cDirect}`);
  check(`hatch${period} repair adds no gray direct region`, rDirect <= cDirect, `repaired=${rDirect} control=${cDirect}`);
  check(`hatch${period} repair adds no gray protected pixel`, rProtect <= cProtect, `repaired=${rProtect} control=${cProtect}`);
  check(`hatch${period} repair does not worsen gray ΔE`, rMean <= cMean + 0.5, `repaired=${rMean.toFixed(2)} control=${cMean.toFixed(2)}`);
}
auditHatch(8);   // review sample: 1 px black line every 8 px on gray fill
auditHatch(6);   // denser hatch: stability window touches the lines, so the
                 // direction-continuity gate must do the blocking here

/* ---- positive: a real broken neutral line still bridges (repair path) ----
   Mid-gray L≈40 stroke is too far from any filament for direct print, so the
   pale-gray AA gap (non-ink, L≈81) can only join via repairLineGaps. */
{
  const w = 240, h = 240;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([255, 255, 255, 255], i * 4);
  const strokeRgb = [95, 95, 95], gapRgb = [200, 200, 200];
  const rect = (x, y, ww, hh, rgb) => { for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + ww; xx++) data.set([...rgb, 255], (yy * w + xx) * 4); };
  rect(20, 100, 80, 3, strokeRgb);
  rect(100, 100, 2, 3, gapRgb);
  rect(102, 100, 80, 3, strokeRgb);
  const plan = E.buildPlan({ width: w, height: h, data }, { ...base, widthMm: 30, families: 48 });
  const gapA = 101 * w + 100, gapB = 101 * w + 101, ref = 101 * w + 98;
  const de = C.deltaE2000(plan.predicted[gapA].lab, plan.predicted[ref].lab);
  console.log(`broken neutral line: gap predicted ${plan.predicted[gapA].hex} / ${plan.predicted[gapB].hex}, stroke ${plan.predicted[ref].hex}, ΔE ${de.toFixed(2)}, protect ${plan.lineProtectMask[gapA]}/${plan.lineProtectMask[gapB]}, family ${plan.familyId[gapA]} vs ${plan.familyId[ref]}`);
  check('broken line gap joins the stroke protection', plan.lineProtectMask[gapA] === 1 && plan.lineProtectMask[gapB] === 1);
  check('broken line gap keeps the stroke family', plan.familyId[gapA] === plan.familyId[ref] && plan.familyId[gapB] === plan.familyId[ref]);
  check('broken line gap prints the stroke colour', de < 3 && C.deltaE2000(plan.predicted[gapB].lab, plan.predicted[ref].lab) < 3, `ΔE=${de.toFixed(2)}`);
}

console.log(failures ? `R2: ${failures} acceptance failures` : 'all R2 hatch-guard checks passed');
process.exit(failures ? 1 : 0);