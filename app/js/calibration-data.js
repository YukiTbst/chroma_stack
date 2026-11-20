/* ChromaStack calibration data contracts (P1). Pure schema / identity helpers with
   no colour dependency so BOTH the browser and the Node profile server can load
   them. Observations are append-only; fitting produces versioned OpticalModels;
   publishing switches activeModelId atomically. Unknown future schemas are
   rejected, never silently dropped. No device fingerprints / personal data. */
(function (root) {
  const CS = root.CS = root.CS || {};
  const SCHEMA_VERSION = 2;

  function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  // Recursive key-sorted stable stringify. (A key-array replacer would whitelist
  // keys at EVERY depth and silently drop nested cell/marker geometry.)
  function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  function manifestHash(manifest) { return hashString(canonical(manifest)); }

  function emptyV2() {
    return { schemaVersion: SCHEMA_VERSION, materials: {}, models: [], activeModelId: null, observations: [], legacyIndex: {} };
  }

  /* Validate a profile-v2 calibration block. Returns {ok,error}. Unknown schema
     versions are an error (caller must refuse the write), not a silent drop. */
  function validateV2(v) {
    if (v == null) return { ok: true, value: null };
    if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'calibrationV2 must be an object' };
    if (v.schemaVersion !== SCHEMA_VERSION) return { ok: false, error: 'unknown calibration schema ' + v.schemaVersion + '; upgrade required' };
    if (v.models && !Array.isArray(v.models)) return { ok: false, error: 'models must be an array' };
    for (const m of (v.models || [])) {
      if (!m || typeof m.modelId !== 'string') return { ok: false, error: 'model missing modelId' };
      if (!m.params || typeof m.params !== 'object') return { ok: false, error: 'model missing params' };
      if (!['published', 'restricted', 'manual', 'draft'].includes(m.status)) return { ok: false, error: 'bad model status ' + m.status };
    }
    if (v.activeModelId != null && !(v.models || []).some(m => m.modelId === v.activeModelId)) return { ok: false, error: 'activeModelId not in models' };
    if (v.observations && !Array.isArray(v.observations)) return { ok: false, error: 'observations must be an array' };
    for (const o of (v.observations || [])) {
      if (!o || typeof o.sessionId !== 'string' || typeof o.manifestHash !== 'string') return { ok: false, error: 'observation missing sessionId/manifestHash' };
    }
    return { ok: true, value: v };
  }

  function makeModelId(params, sessionHashes) { return 'm-' + hashString(canonical(params) + '|' + (sessionHashes || []).join(',')); }
  function makeSessionId(manifest, photoHash) { return 's-' + hashString(manifestHash(manifest) + '|' + (photoHash || '')); }

  CS.calibrationData = { SCHEMA_VERSION, hashString, manifestHash, emptyV2, validateV2, makeModelId, makeSessionId };
})(typeof globalThis !== 'undefined' ? globalThis : this);