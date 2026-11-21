/* m46 F02: applying a saved opticalModel must NOT be silent. buildPlan reports
   coverage (which palette materials the model hit / missed), cross-domain use
   (model layer height vs production), partial channels (bounded/unresolved kept
   library) and the effective source, via diagnostics.opticalModel + warnings.
   Run: node tests/test-m46-optical-diagnostics.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const m of ['color', 'optics', 'data-filaments', 'earcut', 'engine', 'zip', 'exporter', 'layer-optimizer']) require('../app/js/' + m + '.js');
const E = globalThis.CS.engine;

const palette = E.buildUserPalette([
  { id: 'k', name: 'Black', hex: '#000000', td: 0.6 },
  { id: 'w', name: 'Jade White', hex: '#ffffff', td: 5 },
  { id: 'r', name: 'Red', hex: '#c00d1e', td: 5 }
]);
function img(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([255, 255, 255, 255], i * 4);
  for (let y = 10; y < 50; y++) for (let x = 10; x < 50; x++) d.set([192, 13, 30, 255], (y * w + x) * 4);
  return { width: w, height: h, data: d };
}
const base = { engine: 'td', palette, widthMm: 40, flatTopMm: 1.6, reliefMm: 0.16, layerHeight: 0.08, gradLayers: 5, foundationIndex: 1, stdThreshold: 0, residualThreshold: 5, minFlatPercent: 0.1, smoothMm: 0, lineWidthMm: 0.42, mergeDeltaE: 0, heightMergeDeltaE: 1.5, edgeClean: 0, vectorFlat: false, lineProtect: 'off', families: 16, backgroundMode: 'off' };
const th = (hd, op, state) => ({ logHd: hd.map(Math.log), opaque: op, state });

// No model => no opticalModel diagnostics (nothing silently claimed).
{
  const plan = E.buildPlan(img(80, 60), { ...base });
  assert.ok(!plan.diagnostics.opticalModel, 'no model => no opticalModel diagnostics');
}

// Partial coverage: model hits k and r, misses w.
{
  const model = { params: { k: th([0.05, 0.05, 0.05], [0.02, 0.02, 0.02], ['estimated', 'estimated', 'estimated']), r: th([0.4, 0.1, 0.1], [0.7, 0.05, 0.05], ['estimated', 'estimated', 'estimated']) }, compatibilityDomain: { layerHeightMm: 0.08 } };
  const plan = E.buildPlan(img(80, 60), { ...base, opticalModel: model });
  const om = plan.diagnostics.opticalModel;
  assert.ok(om && om.applied, 'opticalModel diagnostics present when applied');
  assert.equal(om.source, 'calibrationV2', 'effective source reported');
  assert.ok(om.covered.some(c => c.id === 'k') && om.covered.some(c => c.id === 'r'), 'covered lists hit materials');
  assert.ok(om.uncovered.some(c => c.id === 'w'), 'uncovered lists the missed material (w)');
  assert.ok(plan.warnings.some(w => /未覆盖|覆盖/.test(w) && /Jade White|w/.test(w)), 'warns about uncovered material');
}

// Cross-domain: model fitted at 0.06 but production runs 0.08.
{
  const model = { params: { k: th([0.05, 0.05, 0.05], [0.02, 0.02, 0.02], ['estimated', 'estimated', 'estimated']) }, compatibilityDomain: { layerHeightMm: 0.06 } };
  const plan = E.buildPlan(img(80, 60), { ...base, opticalModel: model });
  const om = plan.diagnostics.opticalModel;
  assert.ok(om.crossDomain && Math.abs(om.crossDomain.modelLayerHeightMm - 0.06) < 1e-9 && Math.abs(om.crossDomain.productionLayerHeightMm - 0.08) < 1e-9, 'cross-domain layer heights recorded');
  assert.ok(plan.warnings.some(w => /跨域|层高/.test(w)), 'warns about cross-domain use');
}

// Partial channels: bounded/unresolved kept library => reported, not silent.
{
  const model = { params: { r: th([0.4, 0.1, 0.1], [0.7, 0.05, 0.05], ['estimated', 'bounded', 'unresolved']) }, compatibilityDomain: { layerHeightMm: 0.08 } };
  const plan = E.buildPlan(img(80, 60), { ...base, opticalModel: model });
  const om = plan.diagnostics.opticalModel;
  const rc = om.covered.find(c => c.id === 'r');
  assert.deepEqual(rc.state, ['estimated', 'bounded', 'unresolved'], 'per-channel state recorded');
  assert.deepEqual(rc.used, [true, false, false], 'per-channel usage recorded');
  assert.ok(om.partialChannels >= 2, 'counts non-estimated channels kept at library');
  assert.ok(plan.warnings.some(w => /界限|无信息|库值/.test(w)), 'warns that bounded/unresolved channels keep library values');
}
console.log('F02 optical-model diagnostics passed: coverage + cross-domain + partial channels + source');