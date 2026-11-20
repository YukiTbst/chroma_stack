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

  const clampTd = value => Math.min(20, Math.max(0.1, Number(value) || 5));

  /* A scalar TD edit means "uniform coverage on all three channels". Returns
     the whole quadruple so no stale per-channel calibration can keep
     overriding the new value. */
  function uniformTd(value) {
    const td = clampTd(value);
    return { td, tdR: td, tdG: td, tdB: td };
  }

  /* Applies a stored calibration record onto a palette entry. Records without
     per-channel data are scalar calibration, so any channels carried over from
     another profile must be replaced rather than left to win at build time. */
  function applyRecord(p, saved) {
    if (!saved) return Object.assign({}, p, uniformTd(p.td));
    const out = Object.assign({}, p, { hex: saved.hex || p.hex, td: clampTd(saved.td || p.td || 5) });
    if (saved.tdR != null || saved.tdG != null || saved.tdB != null) {
      out.tdR = clampTd(saved.tdR != null ? saved.tdR : out.td);
      out.tdG = clampTd(saved.tdG != null ? saved.tdG : out.td);
      out.tdB = clampTd(saved.tdB != null ? saved.tdB : out.td);
    } else {
      Object.assign(out, uniformTd(out.td));
    }
    return out;
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
        ...(p.tdR != null || p.tdG != null || p.tdB != null
          ? { tdR: p.tdR != null ? p.tdR : p.td, tdG: p.tdG != null ? p.tdG : p.td, tdB: p.tdB != null ? p.tdB : p.td }
          : {}),
        source: (calibrations[key] && calibrations[key].source) || 'manual'
      });
    }
    return {
      calibrations,
      lutTdOverrides: clone(state.lutTdOverrides || {}),
      lutHexOverrides: clone(state.lutHexOverrides || {}),
      ...(state.calibrationV2 ? { calibrationV2: clone(state.calibrationV2) } : {})
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

  CS.settings = { KEY, filamentKey, snapshot, save, load, clear, uniformTd, applyRecord };
})(typeof globalThis !== 'undefined' ? globalThis : this);