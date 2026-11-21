/* m46 F04: hash contract. (1) manifestHash must be purely content-derived — a
   stored/previous manifestHash field must NOT feed back into the recomputed hash
   (buildComboBoardBlob recomputes on a manifest that already carries a hash).
   (2) validateV2 must reject two models sharing a modelId but differing content
   (identity is a content hash; same id => same content).
   Run: node tests/test-m46-hash-contract.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../app/js/color.js');
require('../app/js/optics.js');
require('../app/js/calibration-data.js');
require('../app/js/batch-calibration.js');
require('../app/js/matrix-calibration.js');
require('../app/js/zip.js');
require('../app/js/calibration-joint.js');
const CD = globalThis.CS.calibrationData;
const J = globalThis.CS.calibrationJoint;

const palette = [{ id: 'k', name: 'K', hex: '#000000' }, { id: 'w', name: 'W', hex: '#ffffff' }, { id: 'r', name: 'R', hex: '#c00d1e' }];

// (1) Hash independence from any stored identity-hash field.
const m = J.buildComboManifest(palette, { layerHeight: 0.08 });
const h0 = CD.manifestHash(m);
const stale = JSON.parse(JSON.stringify(m));
stale.manifestHash = '00000000-stale-old-hash';
assert.equal(CD.manifestHash(stale), h0, 'manifestHash must not depend on a stored manifestHash field');
const stale2 = JSON.parse(JSON.stringify(m));
stale2.hash = 'ffffffff-another-old-hash';
assert.equal(CD.manifestHash(stale2), h0, 'manifestHash must not depend on a stored hash field');
// Geometry still changes the hash (content sensitivity preserved).
const moved = JSON.parse(JSON.stringify(m)); moved.markers[0].y += 1;
assert.notEqual(CD.manifestHash(moved), h0, 'marker move must change hash');

// The blob path recomputes the hash AFTER printSettings + an existing hash field.
// That recomputed hash must equal a fresh content-only hash (no old-hash mixing).
const blob = J.buildComboBoardBlob(palette, { layerHeight: 0.08 });
const bm = blob.meta.manifest;
const contentOnly = JSON.parse(JSON.stringify(bm));
delete contentOnly.manifestHash;
assert.equal(CD.manifestHash(contentOnly), bm.manifestHash, 'blob manifest hash is content-derived, not mixed with the prior hash');

// (2) Same modelId, different content must be rejected by validateV2.
const v2 = CD.emptyV2();
v2.models = [
  { modelId: 'm-aaa', params: { k: { logHd: [0, 0, 0], opaque: [0, 0, 0] } }, status: 'published' },
  { modelId: 'm-aaa', params: { k: { logHd: [1, 1, 1], opaque: [1, 1, 1] } }, status: 'published' }
];
const r = CD.validateV2(v2);
assert.equal(r.ok, false, 'duplicate modelId with different params content must be rejected');
// Same modelId, identical content is fine (idempotent re-publish).
const v2ok = CD.emptyV2();
const same = { modelId: 'm-bbb', params: { k: { logHd: [0, 0, 0], opaque: [0, 0, 0] } }, status: 'published' };
v2ok.models = [same, JSON.parse(JSON.stringify(same))];
assert.equal(CD.validateV2(v2ok).ok, true, 'duplicate modelId with identical content is allowed');

console.log('F04 hash contract passed: content-derived manifestHash + same-id-different-content rejected');