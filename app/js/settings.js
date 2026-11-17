/* Versioned filament-calibration persistence. No project parameters, image or
   analysis cache is stored. Calibration follows the filament model, not a project. */
(function (root) {
  'use strict';
  const CS = root.CS = root.CS || {};
  const KEY = 'chromastack.filament-calibrations.v1';
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

  function filamentKey(p) {
    if (p && p.id) return 'id:' + p.id;
    return ['model', p && p.brand || '', p && p.name || '', p && p.material || '', String(p && p.hex || '').toLowerCase()].join('|');
  }

  function snapshot(state) {
    const calibrations = clone(state.filamentCalibrations || {});
    for (const p of state.tdPalette || []) {
      const key = filamentKey(p);
      calibrations[key] = {
        id: p.id || '', name: p.name, brand: p.brand || '', material: p.material || 'PLA',
        hex: p.hex, td: p.td,
        source: (calibrations[key] && calibrations[key].source) || 'manual'
      };
    }
    return {
      calibrations,
      lutTdOverrides: clone(state.lutTdOverrides || {}),
      lutHexOverrides: clone(state.lutHexOverrides || {})
    };
  }

  function save(state) {
    try {
      if (!root.localStorage) return false;
      root.localStorage.setItem(KEY, JSON.stringify({ version: 1, data: snapshot(state) }));
      return true;
    } catch (e) {
      CS.settingsLastError = String(e && e.message || e);
      return false;
    }
  }

  function load() {
    try {
      if (!root.localStorage) return null;
      const raw = root.localStorage.getItem(KEY);
      if (!raw) return null;
      const payload = JSON.parse(raw);
      if (!payload || payload.version !== 1 || !payload.data || typeof payload.data !== 'object') return null;
      return payload.data;
    } catch (e) {
      CS.settingsLastError = String(e && e.message || e);
      return null;
    }
  }

  function clear() {
    try { if (root.localStorage) root.localStorage.removeItem(KEY); }
    catch (e) { CS.settingsLastError = String(e && e.message || e); }
  }

  CS.settings = { KEY, filamentKey, snapshot, save, load, clear };
})(typeof globalThis !== 'undefined' ? globalThis : this);
