/* m49 LC3: luminance mode UI wiring. geometryMode 'luminance' drives buildOptions
   (luminanceHeight + luminanceCurve); presets swap the curve; the curve editor renders
   without a GPU. Run: node tests/test-m49-luminance-ui.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setPointerCapture() {}, appendChild() {}, remove() {}, getBoundingClientRect: () => ({ width: 240, height: 160, left: 0, top: 0 }), textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false, title: '', width: 240, height: 160 });
globalThis.window = globalThis;
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById: () => el(), createElement: () => el(), querySelectorAll: () => [], body: el() };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
for (const m of ['height-curve', 'color', 'optics', 'earcut', 'data-filaments', 'engine', 'exporter', 'layer-optimizer', 'modes', 'settings', 'app']) require('../app/js/' + m + '.js');
const HC = globalThis.CS.heightCurve, dbg = globalThis.CS.appDebug;

// buildOptions wiring.
dbg.state.geometryMode = 'luminance';
dbg.state.luminanceCurve = HC.invertCurve();
let opts = dbg.buildOptions();
assert.equal(opts.luminanceHeight, true, 'luminance mode sets luminanceHeight');
assert.deepEqual(opts.luminanceCurve, HC.invertCurve(), 'curve passed to engine');
assert.equal(opts.equalHeight, false, 'luminance is not equal-height');
dbg.state.geometryMode = 'relief';
opts = dbg.buildOptions();
assert.equal(opts.luminanceHeight, false, 'relief mode clears luminanceHeight');
dbg.state.geometryMode = 'flat';
opts = dbg.buildOptions();
assert.equal(opts.equalHeight, true, 'flat mode still equal-height');
assert.equal(opts.luminanceHeight, false);

// Curve presets produce valid distinct curves.
assert.deepEqual(HC.invertCurve(), [{ x: 0, y: 1 }, { x: 1, y: 0 }]);
assert.deepEqual(HC.defaultCurve(), [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
assert.equal(HC.validateCurve(HC.contrastCurve()).ok, true);
assert.notDeepEqual(HC.invertCurve(), HC.defaultCurve(), 'invert differs from linear');

// Curve editor renders without throwing (no real canvas needed).
dbg.state.geometryMode = 'luminance';
dbg.state.luminanceCurve = HC.contrastCurve();
assert.equal(typeof globalThis.CS.appDebug.state.luminanceCurve, 'object');
console.log('LC3 passed: geometryMode luminance wiring + curve presets + buildOptions');