/* m48 F07 (m47 review): manifest integrity + model numeric entry validation.
   validateV2 must reject non-finite model params (NaN/Infinity in logHd/opaque/hd*).
   validateManifest must reject a board whose thickness identity or content hash does
   not match (mismatched/tampered board info must not be trusted).
   Run: node tests/test-m48-validation.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const m of ['color', 'optics', 'calibration-data', 'batch-calibration', 'matrix-calibration', 'zip', 'calibration-joint']) require('../app/js/' + m + '.js');
const CD = globalThis.CS.calibrationData, J = globalThis.CS.calibrationJoint;

const goodTheta = { k: { logHd: [Math.log(0.04), Math.log(0.04), Math.log(0.04)], opaque: [0.02, 0.02, 0.02], state: ['estimated', 'estimated', 'estimated'] } };
function v2with(params) { return { ...CD.emptyV2(), models: [{ modelId: 'm-x', params, status: 'published' }], activeModelId: 'm-x' }; }

// Finite params accepted.
assert.equal(CD.validateV2(v2with(goodTheta)).ok, true, 'finite theta model accepted');
// Non-finite params rejected.
assert.equal(CD.validateV2(v2with({ k: { logHd: [NaN, 0, 0], opaque: [0, 0, 0] } })).ok, false, 'NaN logHd rejected');
assert.equal(CD.validateV2(v2with({ k: { logHd: [0, 0, 0], opaque: [Infinity, 0, 0] } })).ok, false, 'Infinity opaque rejected');
assert.equal(CD.validateV2(v2with({ k: { logHd: [0, 0, 0], opaque: [0, 0, 0], hdR: -Infinity } })).ok, false, 'non-finite hdR rejected');
assert.equal(CD.validateV2(v2with({ k: { logHd: [0, 0], opaque: [0, 0, 0] } })).ok, false, 'wrong-length logHd rejected');

// Manifest integrity.
const palette = [{ id: 'k', name: 'K', hex: '#000000' }, { id: 'w', name: 'W', hex: '#ffffff' }, { id: 'r', name: 'R', hex: '#c00d1e' }];
const manifest = J.buildComboManifest(palette, { layerHeight: 0.08, firstLayer: 0.24 });
assert.equal(CD.validateManifest(manifest).ok, true, 'generated manifest valid');

const thickBad = JSON.parse(JSON.stringify(manifest)); thickBad.cells[0].thicknessMm += 0.5;
assert.equal(CD.validateManifest(thickBad).ok, false, 'thickness != layers*layerHeight rejected (board identity mismatch)');

const tampered = JSON.parse(JSON.stringify(manifest)); tampered.cells[0].cx += 1; // move a cell, keep old hash
assert.equal(CD.validateManifest(tampered).ok, false, 'content hash mismatch rejected (tampered board)');

const lhBad = JSON.parse(JSON.stringify(manifest)); lhBad.layerHeight = 0;
assert.equal(CD.validateManifest(lhBad).ok, false, 'zero layerHeight rejected');
const lhNaN = JSON.parse(JSON.stringify(manifest)); lhNaN.layerHeight = NaN;
assert.equal(CD.validateManifest(lhNaN).ok, false, 'NaN layerHeight rejected');

const noMarkers = JSON.parse(JSON.stringify(manifest)); noMarkers.markers = noMarkers.markers.slice(0, 3);
assert.equal(CD.validateManifest(noMarkers).ok, false, 'missing corner marker rejected');
console.log('F07 passed: non-finite model params + mismatched/tampered manifest rejected');