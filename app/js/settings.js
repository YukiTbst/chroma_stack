/* Filament-calibration persistence. Data lives on the server in calibration
   profiles (see profiles.js); the browser only keeps the active-profile
   pointer and an offline mirror. No project parameters, image or analysis
   cache is stored. Calibration follows the filament model, not a project. */
(function (root) {
  'use strict';
  const CS = root.CS = root.CS || {};
  const KEY = 'chromastack.filament-calibrations.v1'; // legacy browser-only store, migrated on first run
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

  function filamentKey(p) {
    if (p && p.id) return 'id:' + p.id;
    return ['model', p && p.brand || '', p && p.name || '', p && p.material || '', String(p && p.hex || '').toLowerCase()].join('|');
  }

  function snapshot(state) {
    const calibrations = clone(state.filamentCalibrations || {});
    for (const p of state.tdPalette || []) {
      const key = filamentKey(p);
      // Merge over the existing record so photo provenance (score, updatedAt)
      // survives; identity and measured values always follow the palette.
      calibrations[key] = Object.assign({}, calibrations[key], {
        id: p.id || '', name: p.name, brand: p.brand || '', material: p.material || 'PLA',
        hex: p.hex, td: p.td,
        source: (calibrations[key] && calibrations[key].source) || 'manual'
      });
    }
    return {
      calibrations,
      lutTdOverrides: clone(state.lutTdOverrides || {}),
      lutHexOverrides: clone(state.lutHexOverrides || {})
    };
  }

  /* Queues a debounced push to the active server profile. Returns false only
     when the profile layer is missing entirely (should not happen in app). */
  function save(state) {
    if (!CS.profiles) { CS.settingsLastError = 'profiles module missing'; return false; }
    try {
      return CS.profiles.save(snapshot(state));
    } catch (e) {
      CS.settingsLastError = String(e && e.message || e);
      return false;
    }
  }

  /* Synchronous read of the last known profile data (server load or offline
     mirror). App init uses CS.profiles.init() for the authoritative load. */
  function load() {
    return CS.profiles ? CS.profiles.cachedData() : null;
  }

  /* Clears calibration content of the active server profile. */
  function clear() {
    if (CS.profiles) CS.profiles.clearActive().catch(e => { CS.settingsLastError = String(e && e.message || e); });
  }

  CS.settings = { KEY, filamentKey, snapshot, save, load, clear };
})(typeof globalThis !== 'undefined' ? globalThis : this);