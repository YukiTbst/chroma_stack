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
  // skipIdentity omits stored identity-hash fields so a hash is purely content
  // derived: recomputing on a manifest that already carries manifestHash/hash must
  // NOT feed the old value back in (F04: full-board hash mixed prior hash values).
  const IDENTITY_KEYS = new Set(['manifestHash', 'hash']);
  function canonical(v, skipIdentity) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(x => canonical(x, skipIdentity)).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(k => !(skipIdentity && IDENTITY_KEYS.has(k))).map(k => JSON.stringify(k) + ':' + canonical(v[k], skipIdentity)).join(',') + '}';
  }
  function manifestHash(manifest) { return hashString(canonical(manifest, true)); }

  function emptyV2() {
    return { schemaVersion: SCHEMA_VERSION, materials: {}, models: [], activeModelId: null, observations: [], legacyIndex: {} };
  }

  const isFiniteNum = x => typeof x === 'number' && isFinite(x);
  // F07: model numeric params must be finite — a NaN/Infinity HD or opaque would
  // poison production colour solving and must never be saved/trusted.
  function validateModelParams(params) {
    for (const key of Object.keys(params)) {
      const t = params[key];
      if (!t || typeof t !== 'object') return 'model param ' + key + ' must be an object';
      if (t.logHd != null && (!Array.isArray(t.logHd) || t.logHd.length !== 3 || !t.logHd.every(isFiniteNum))) return 'model ' + key + ' logHd must be 3 finite numbers';
      if (t.opaque != null && (!Array.isArray(t.opaque) || t.opaque.length !== 3 || !t.opaque.every(isFiniteNum))) return 'model ' + key + ' opaque must be 3 finite numbers';
      for (const hk of ['hdR', 'hdG', 'hdB', 'hd', 'td']) if (t[hk] != null && !isFiniteNum(t[hk])) return 'model ' + key + ' ' + hk + ' must be finite';
      if (t.lin != null && (!isFiniteNum(t.lin.r) || !isFiniteNum(t.lin.g) || !isFiniteNum(t.lin.b))) return 'model ' + key + ' lin must be finite';
    }
    return null;
  }

  /* F07: validate a combination-board manifest's integrity. Thickness identity
     (layers * layerHeight), finite layer height, 4 corner markers and a content hash
     that matches the stored manifestHash — mismatched/tampered board info is rejected
     rather than trusted. */
  function validateManifest(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, error: 'manifest must be an object' };
    if (!isFiniteNum(m.layerHeight) || m.layerHeight <= 0) return { ok: false, error: 'manifest layerHeight must be finite > 0' };
    if (!Array.isArray(m.cells) || !m.cells.length) return { ok: false, error: 'manifest cells missing' };
    for (const c of m.cells) {
      if (!c || typeof c.cellId !== 'string' || !Array.isArray(c.stack) || !c.stack.length) return { ok: false, error: 'cell missing cellId/stack' };
      let layers = 0;
      for (const s of c.stack) {
        if (!s || typeof s.materialId !== 'string' || !isFiniteNum(s.layerCount) || s.layerCount <= 0) return { ok: false, error: 'cell ' + c.cellId + ' has a bad stack segment' };
        layers += s.layerCount;
      }
      if (c.thicknessMm != null && (!isFiniteNum(c.thicknessMm) || Math.abs(c.thicknessMm - layers * m.layerHeight) > 1e-6)) return { ok: false, error: 'cell ' + c.cellId + ' thickness != layers*layerHeight (board identity mismatch)' };
    }
    if (m.markers != null && (!Array.isArray(m.markers) || m.markers.length !== 4)) return { ok: false, error: 'manifest must have 4 corner markers' };
    if (typeof m.manifestHash === 'string' && manifestHash(m) !== m.manifestHash) return { ok: false, error: 'manifestHash does not match content (tampered/mismatched board)' };
    return { ok: true, value: m };
  }

  /* Validate a profile-v2 calibration block. Returns {ok,error}. Unknown schema
     versions are an error (caller must refuse the write), not a silent drop. */
  function validateV2(v) {
    if (v == null) return { ok: true, value: null };
    if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'calibrationV2 must be an object' };
    if (v.schemaVersion !== SCHEMA_VERSION) return { ok: false, error: 'unknown calibration schema ' + v.schemaVersion + '; upgrade required' };
    if (v.models && !Array.isArray(v.models)) return { ok: false, error: 'models must be an array' };
    const seenModelContent = new Map();
    for (const m of (v.models || [])) {
      if (!m || typeof m.modelId !== 'string') return { ok: false, error: 'model missing modelId' };
      if (!m.params || typeof m.params !== 'object') return { ok: false, error: 'model missing params' };
      if (!['published', 'restricted', 'manual', 'draft'].includes(m.status)) return { ok: false, error: 'bad model status ' + m.status };
      const paramErr = validateModelParams(m.params);
      if (paramErr) return { ok: false, error: paramErr };
      // F04: modelId is a content hash, so the same id must carry the same content.
      // Reusing an id with different params is a contract violation (silent identity
      // collision), not a valid second model.
      const content = canonical(m.params);
      if (seenModelContent.has(m.modelId)) {
        if (seenModelContent.get(m.modelId) !== content) return { ok: false, error: 'modelId ' + m.modelId + ' reused with different content; identity must be content-derived' };
      } else seenModelContent.set(m.modelId, content);
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

  CS.calibrationData = { SCHEMA_VERSION, hashString, manifestHash, emptyV2, validateV2, validateManifest, makeModelId, makeSessionId };
})(typeof globalThis !== 'undefined' ? globalThis : this);