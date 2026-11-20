/* R8: the flat-coverage warning must only advise operations that actually thicken
   the colour cap for the CURRENT geometry, and must show base/top layer counts and
   thicknesses. In the default coupled TD path, raising flatTopMm lifts the shared
   foundation by the same amount, so the colour cap (flatTopLayers) and the predicted
   colour stay identical — "raise the flat top" is无效 advice and must not be offered
   as a colour fix. Any operation the warning DOES offer must change the material
   stack when applied. Ground truth is real buildPlan runs, not source inspection.
   Run: node tests/test-flat-coverage-advice.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/earcut.js');
require('../app/js/engine.js');
const C = globalThis.CS.color, E = globalThis.CS.engine;

const palette = E.buildUserPalette([
  { name: 'Black', hex: '#000000', td: 0.6 },
  { name: 'Jade White', hex: '#ffffff', td: 5 },
  { name: 'Red', hex: '#c00d1e', td: 5 }
]);
const redLab = C.hexToLab('#c00d1e');
const base = {
  engine: 'td', palette, widthMm: 60, reliefMm: 0.16, layerHeight: 0.08,
  gradLayers: 6, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5,
  minFlatPercent: 0.6, smoothMm: 0, lineWidthMm: 0.42, smoothLevel: 0,
  mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false,
  lineProtect: 'off', families: 24, backgroundMode: 'off'
};
function redBlock() {
  const w = 240, h = 240;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([192, 13, 30, 255], i * 4);
  return { width: w, height: h, data };
}
const center = 120 * 240 + 120;
const coverageWarning = p => p.warnings.find(w => w.includes('纯色区顶色只有')) || '';

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

/* ===== 1. the review's 1.6 -> 3.2 combination: geometry coupling ===== */
const p16 = E.buildPlan(redBlock(), { ...base, flatTopMm: 1.6 });
const p32 = E.buildPlan(redBlock(), { ...base, flatTopMm: 3.2 });
const de16 = C.deltaE2000(p16.predicted[center].lab, redLab);
const de32 = C.deltaE2000(p32.predicted[center].lab, redLab);
console.log('1.6mm:', p16.predicted[center].hex, 'cap', p16.flatLayers - p16.flatBaseLayers, 'base', p16.flatBaseLayers, 'ΔE', de16.toFixed(2));
console.log('3.2mm:', p32.predicted[center].hex, 'cap', p32.flatLayers - p32.flatBaseLayers, 'base', p32.flatBaseLayers, 'ΔE', de32.toFixed(2));
check('1 raising flatTopMm 1.6->3.2 keeps the same colour-cap thickness',
  (p16.flatLayers - p16.flatBaseLayers) === (p32.flatLayers - p32.flatBaseLayers),
  `cap ${p16.flatLayers - p16.flatBaseLayers} vs ${p32.flatLayers - p32.flatBaseLayers}`);
check('1 the foundation rose with the top (coupled geometry)', p32.flatBaseLayers > p16.flatBaseLayers, `base ${p16.flatBaseLayers} -> ${p32.flatBaseLayers}`);
check('1 predicted colour is unchanged by the ineffective operation',
  p16.predicted[center].hex === p32.predicted[center].hex && Math.abs(de16 - de32) < 0.01, `${p16.predicted[center].hex} ΔE ${de16.toFixed(2)} vs ${p32.predicted[center].hex} ΔE ${de32.toFixed(2)}`);
check('1 the thin cap really under-covers (warning is warranted)', de16 > 20, `ΔE ${de16.toFixed(2)}`);

/* ===== 2. the warning must show geometry and refuse the ineffective advice ===== */
const w16 = coverageWarning(p16);
console.log('warning(1.6):', w16);
check('2 coverage warning is present', !!w16);
check('2 warning shows the colour-cap layers and thickness', w16.includes(`${p16.flatLayers - p16.flatBaseLayers} 层/${((p16.flatLayers - p16.flatBaseLayers) * 0.08).toFixed(2)} mm`), w16.slice(0, 60));
check('2 warning shows the foundation layers and thickness', w16.includes(`基底 ${p16.flatBaseLayers} 层/${(p16.flatBaseLayers * 0.08).toFixed(2)} mm`));
check('2 warning flags raising flatTopMm as ineffective for this geometry', w16.includes('不能改善颜色'), 'must explicitly say raising the top does not improve colour');
check('2 warning does NOT offer raising flatTopMm as an effective tip', !w16.includes('提高纯色区顶高（盖色'), w16.includes('提高纯色区顶高（盖色') ? 'offered the无效 tip' : 'ok');

/* ===== 3. an offered operation must actually change the material stack ===== */
check('3 warning offers increasing gradient layers', w16.includes('增加渐变层数'), 'effective tip present');
const pMore = E.buildPlan(redBlock(), { ...base, flatTopMm: 1.6, gradLayers: 8 });
const capMore = pMore.flatLayers - pMore.flatBaseLayers;
const deMore = C.deltaE2000(pMore.predicted[center].lab, redLab);
console.log('gradLayers 8:', pMore.predicted[center].hex, 'cap', capMore, 'ΔE', deMore.toFixed(2));
check('3 applying the offered tip thickens the colour cap', capMore > (p16.flatLayers - p16.flatBaseLayers), `cap ${p16.flatLayers - p16.flatBaseLayers} -> ${capMore}`);
check('3 applying the offered tip improves the predicted colour', deMore < de16, `ΔE ${de16.toFixed(2)} -> ${deMore.toFixed(2)}`);
const claimed = w16.match(/增加渐变层数（\+2 层 → 盖色 (\d+) 层）/);
check('3 the warned cap thickness matches the real rebuilt stack', !!claimed && Number(claimed[1]) === capMore, `claimed ${claimed && claimed[1]} actual ${capMore}`);

/* ===== 4. a geometry where raising flatTopMm IS effective must offer it ===== */
const thinBase = { ...base, reliefMm: 0 };
const t0 = E.buildPlan(redBlock(), { ...thinBase, flatTopMm: 0.08 });
const wt = coverageWarning(t0);
const cap0 = t0.flatLayers - t0.flatBaseLayers;
console.log('thin(0.08, relief 0):', t0.predicted[center].hex, 'cap', cap0, 'warning:', wt);
check('4 thin cap warning present', !!wt);
check('4 when raising the top really thicken the cap, it is offered', wt.includes('提高纯色区顶高（盖色'), wt);
const t1 = E.buildPlan(redBlock(), { ...thinBase, flatTopMm: 1.68 });
const cap1 = t1.flatLayers - t1.flatBaseLayers;
check('4 applying that tip thickens the cap', cap1 > cap0, `cap ${cap0} -> ${cap1}`);
check('4 applying that tip improves colour', C.deltaE2000(t1.predicted[center].lab, redLab) < C.deltaE2000(t0.predicted[center].lab, redLab));

console.log(failures ? `R8: ${failures} acceptance failures` : 'all R8 coverage-advice checks passed');
process.exit(failures ? 1 : 0);