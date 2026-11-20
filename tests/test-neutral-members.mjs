/* R3: the neutral constraint must cover real source pixels, not only family
   centers. A source pixel that independently satisfies matchGamut's neutral
   lock (all-K/W candidate within +5 ΔE of its own best recipe) must not be
   assigned — by assignFamilies, smoothing or edge merge — to a chromatic
   recipe, and must not keep a worse colour than its feasible neutral
   candidate. Budget-unmet grays may stay chromatic but must be risk-flagged.
   Ground truth is the engine's own matchGamut called on the exact source Lab.
   Run: node tests/test-neutral-members.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
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
const P = E.buildUserPalette(palette);
const neutralIdx = new Set(P.map((p, i) => [p, i]).filter(([p]) => Math.hypot(p.lab.a, p.lab.b) < 8).map(([, i]) => i));
const recipeNeutral = seq => seq.every(i => neutralIdx.has(i));
const gamutFor = vh => E.buildTdGamut(P, P[1], 0.08, 6, vh);

const base = {
  engine: 'td', palette, widthMm: 30, flatTopMm: 1.6, reliefMm: 0.16,
  variableHeight: true, layerHeight: 0.08, gradLayers: 6, foundationIndex: 1,
  stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.02,
  smoothMm: 0, lineWidthMm: 0.42, smoothLevel: 0, mergeDeltaE: 0,
  heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false,
  lineProtect: 'off', families: 16, backgroundMode: 'off'
};

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

function grayGradient(w, h, v0, v1) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = v0 + Math.round(x * (v1 - v0) / (w - 1));
    data.set([v, v, v, 255], (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}

/* Per-source-pixel audit against the engine's own matchGamut on exact Lab. */
function auditPlan(plan, image, opts, label) {
  const gamut = gamutFor(opts.variableHeight !== false);
  const w = image.width, h = image.height;
  const cache = new Map();
  const matchOf = lab => {
    const key = lab.L.toFixed(3) + '|' + lab.a.toFixed(3) + '|' + lab.b.toFixed(3);
    if (!cache.has(key)) cache.set(key, E.matchGamut(lab, gamut));
    return cache.get(key);
  };
  let sourceNeutral = 0, demanded = 0, violations = 0, worst = null, ex575757 = null;
  for (let i = 0; i < w * h; i++) {
    if (plan.printMask && !plan.printMask[i]) continue;
    if (plan.flatMask[i]) continue;
    const f = plan.familyId[i];
    if (f < 0) continue;
    const src = C.rgb255ToLab({ r: image.data[i * 4], g: image.data[i * 4 + 1], b: image.data[i * 4 + 2] });
    if (Math.hypot(src.a, src.b) >= 8) continue;
    sourceNeutral++;
    const fam = plan.families[f];
    const m = matchOf(src);
    const de = C.deltaE2000(src, fam.predictedLab);
    if (image.data[i * 4] === 87 && image.data[i * 4 + 1] === 87 && image.data[i * 4 + 2] === 87) {
      ex575757 = { de: +de.toFixed(2), neutralDe: m ? +m.deltaE.toFixed(2) : null, neutral: recipeNeutral(fam.recipe), locked: m ? !!m.neutralLocked : null };
    }
    if (m && m.neutralLocked) {
      demanded++;
      if (!recipeNeutral(fam.recipe) || de > m.deltaE + 0.5) {
        violations++;
        if (!worst || de - m.deltaE > worst.gap) worst = { hex: C.labToHex(src), family: fam.targetHex, de: +de.toFixed(2), neutralDe: +m.deltaE.toFixed(2), gap: de - m.deltaE, recipe: fam.recipe.join(',') };
      }
    }
  }
  const na = plan.diagnostics.neutralAudit;
  console.log(`${label}: sourceNeutral ${sourceNeutral}, demanded ${demanded}, violations ${violations}, audit ${na ? JSON.stringify({ missed: na.feasibleMissed, budgetUnmet: na.budgetUnmet, chromatic: na.chromaticOnNeutral }) : 'MISSING'}${worst ? ', worst ' + JSON.stringify(worst) : ''}${ex575757 ? ', #575757 ' + JSON.stringify(ex575757) : ''}`);
  check(`${label} audit present`, !!na);
  check(`${label} no feasible neutral candidate missed`, !!na && na.feasibleMissed === 0, `feasibleMissed=${na && na.feasibleMissed}`);
  check(`${label} every demanded source pixel keeps a neutral recipe within budget`, violations === 0, `${violations}/${demanded} violated`);
  check(`${label} budget-unmet chromatic grays are risk-flagged`, !na || na.budgetUnmet === 0 || plan.warnings.some(x => x.includes('中性') && x.includes('风险')), `budgetUnmet=${na && na.budgetUnmet}`);
  return { demanded, violations, ex575757 };
}

/* 1. variable-height grayscale gradient (review's independent sample shape) */
{
  const image = grayGradient(160, 120, 60, 130);
  const plan = E.buildPlan(image, base);
  const r = auditPlan(plan, image, base, 'vh-gradient');
  check('vh-gradient sample exercises the member gap', r.demanded > 0, `demanded=${r.demanded}`);
  if (r.ex575757 && r.ex575757.locked) {
    check('#575757 does not keep a worse chromatic recipe', r.ex575757.neutral && r.ex575757.de <= r.ex575757.neutralDe + 0.5, JSON.stringify(r.ex575757));
  }
}

/* 2. equal-height (sticker) configuration: same guarantee, fixed-length gamut */
{
  const image = grayGradient(160, 120, 60, 130);
  const opts = { ...base, variableHeight: false };
  const plan = E.buildPlan(image, opts);
  auditPlan(plan, image, opts, 'equal-height');
}

/* 3. smoothing + edge merge active beside a saturated field: constrained
      members must not migrate into the chromatic family at the boundary. */
{
  const w = 160, h = 120;
  const image = grayGradient(w, h, 60, 130);
  for (let y = 0; y < h; y++) for (let x = 110; x < w; x++) image.data.set([200, 30, 30, 255], (y * w + x) * 4);
  const opts = { ...base, smoothMm: 0.8, smoothLevel: 2, edgeClean: 2 };
  const plan = E.buildPlan(image, opts);
  auditPlan(plan, image, opts, 'smooth+edge');
}

console.log(failures ? `R3: ${failures} acceptance failures` : 'all R3 neutral-member checks passed');
process.exit(failures ? 1 : 0);