/* Server-backed calibration profiles. All filament calibration data lives on
   the ChromaStack server (one JSON document per profile); the browser only
   persists which profile is active, plus an offline mirror used when the
   server cannot be reached. Phone and desktop therefore share calibrations. */
(function (root) {
  'use strict';
  const CS = root.CS = root.CS || {};
  const ACTIVE_KEY = 'chromastack.active-profile.v1';
  const MIRROR_KEY = 'chromastack.offline-mirror.v1';
  const LEGACY_KEY = 'chromastack.filament-calibrations.v1';
  const BASE_KEY = 'chromastack.api-base';
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const emptyData = () => ({ calibrations: {}, lutTdOverrides: {}, lutHexOverrides: {} });

  function apiBase() {
    let base = null;
    try { base = root.localStorage.getItem(BASE_KEY); } catch (e) { /* private mode */ }
    if (!base) {
      // Local dev servers have no /api backend; use the deployed one so the
      // local page shares the same profiles. Override via localStorage key.
      const host = root.location && root.location.hostname;
      base = (host === 'localhost' || host === '127.0.0.1' || host === '[::1]')
        ? 'http://example.com/chromastack/api/' : 'api/';
    }
    return base.replace(/\/+$/, '') + '/';
  }

  function lsGet(key) { try { return root.localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, value) { try { root.localStorage.setItem(key, value); return true; } catch (e) { return false; } }
  function lsRemove(key) { try { root.localStorage.removeItem(key); } catch (e) { /* ignore */ } }

  async function api(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(apiBase() + path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        cache: 'no-store'
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || ('HTTP ' + res.status));
      return payload;
    } finally { clearTimeout(timer); }
  }

  const state = {
    activeId: null,
    profiles: [],
    online: false,
    initialized: false,
    lastData: emptyData(),
    pending: null,        // latest snapshot waiting to be pushed
    timer: null,
    saving: false,
    onStatus: null        // (status, detail) => void ; status: synced|syncing|offline
  };

  function emit(status, detail) {
    if (typeof state.onStatus === 'function') {
      try { state.onStatus(status, detail); } catch (e) { /* UI errors must not break sync */ }
    }
  }

  function writeMirror(data) {
    lsSet(MIRROR_KEY, JSON.stringify({ profileId: state.activeId, data, updatedAt: Date.now() }));
  }

  function readMirror() {
    try {
      const raw = lsGet(MIRROR_KEY);
      if (!raw) return null;
      const m = JSON.parse(raw);
      return m && m.data && typeof m.data === 'object' ? m : null;
    } catch (e) { return null; }
  }

  function readLegacy() {
    try {
      const raw = lsGet(LEGACY_KEY);
      if (!raw) return null;
      const payload = JSON.parse(raw);
      return payload && payload.version === 1 && payload.data && typeof payload.data === 'object' ? payload.data : null;
    } catch (e) { return null; }
  }

  function setActive(id) {
    state.activeId = id;
    if (id) lsSet(ACTIVE_KEY, id); else lsRemove(ACTIVE_KEY);
  }

  async function refreshList() {
    const res = await api('GET', 'profiles');
    state.profiles = res.profiles || [];
    return state.profiles;
  }

  async function ensureProfile(name, data) {
    const p = await api('POST', 'profiles', { name, data: data || emptyData() });
    state.profiles.push({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt });
    return p;
  }

  /* Load the active profile from the server. Handles first-run creation and
     migration of the old browser-only calibration store. Falls back to the
     offline mirror (or legacy data) when the server is unreachable. */
  async function init() {
    const pointer = lsGet(ACTIVE_KEY);
    const legacy = readLegacy();
    try {
      await refreshList();
      let created = null;
      if (legacy) {
        const name = state.profiles.length ? '本地导入 ' + new Date().toISOString().slice(0, 10) : '默认标定';
        created = await ensureProfile(name, legacy);
        lsRemove(LEGACY_KEY);
      }
      if (!state.profiles.length) created = await ensureProfile('默认标定', emptyData());
      let active = state.profiles.find(p => p.id === pointer) || null;
      if (!active && created) active = state.profiles.find(p => p.id === created.id);
      if (!active) active = state.profiles[0];
      const full = await api('GET', 'profiles/' + active.id);
      setActive(active.id);
      state.online = true;
      state.initialized = true;
      state.lastData = full.data || emptyData();
      writeMirror(state.lastData);
      emit('synced', full.name);
      return clone(state.lastData);
    } catch (e) {
      state.online = false;
      state.initialized = true;
      state.activeId = pointer;
      const mirror = readMirror();
      let data = null;
      if (legacy) data = legacy;                       // still awaiting migration
      else if (mirror && (!pointer || mirror.profileId === pointer)) data = mirror.data;
      else if (mirror) data = mirror.data;
      state.lastData = clone(data || emptyData());
      emit('offline', String(e && e.message || e));
      return clone(state.lastData);
    }
  }

  async function pushPending(keepalive) {
    if (state.pending == null || state.saving) return;
    if (!state.activeId) {
      // Offline at init: try to (re)establish a profile before pushing.
      try {
        await refreshList();
        if (!state.profiles.length) await ensureProfile('默认标定', emptyData());
        const pointer = lsGet(ACTIVE_KEY);
        const active = state.profiles.find(p => p.id === pointer) || state.profiles[0];
        setActive(active.id);
      } catch (e) { emit('offline', String(e && e.message || e)); return; }
    }
    const data = state.pending;
    state.pending = null;
    state.saving = true;
    emit('syncing');
    try {
      const res = await fetch(apiBase() + 'profiles/' + state.activeId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
        keepalive: !!keepalive
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const p = await res.json().catch(() => null);
      state.online = true;
      state.lastData = clone(data);
      writeMirror(data);
      const meta = state.profiles.find(x => x.id === state.activeId);
      if (meta && p) { meta.name = p.name; meta.updatedAt = p.updatedAt; }
      emit('synced', p && p.name);
    } catch (e) {
      state.online = false;
      if (state.pending == null) state.pending = data; // retry on next save/flush
      emit('offline', String(e && e.message || e));
    } finally {
      state.saving = false;
      // Only auto-retry while online; offline edits wait for the next user
      // save or an explicit flush (profile switch / page hide).
      if (state.pending != null && state.online && !keepalive) schedulePush();
    }
  }

  function schedulePush() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { state.timer = null; pushPending(false); }, 600);
  }

  /* Called by CS.settings.save on every calibration change. Debounced PUT;
     the mirror is written synchronously so nothing is lost on crash/offline. */
  function save(data) {
    state.pending = clone(data);
    writeMirror(state.pending);
    schedulePush();
    return true;
  }

  function flush(keepalive) {
    clearTimeout(state.timer);
    state.timer = null;
    return pushPending(keepalive);
  }

  async function switchTo(id) {
    await flush(false);
    const full = await api('GET', 'profiles/' + id);
    setActive(id);
    state.online = true;
    state.lastData = full.data || emptyData();
    state.pending = null;
    writeMirror(state.lastData);
    emit('synced', full.name);
    return clone(state.lastData);
  }

  async function create(name, data) {
    const p = await ensureProfile(name, data);
    state.online = true;
    return p;
  }

  async function rename(id, name) {
    const p = await api('PUT', 'profiles/' + id, { name });
    const meta = state.profiles.find(x => x.id === id);
    if (meta) { meta.name = p.name; meta.updatedAt = p.updatedAt; }
    return p;
  }

  /* Delete a profile; guarantees at least one remains and returns the data of
     the profile that should become active. */
  async function remove(id) {
    await api('DELETE', 'profiles/' + id);
    state.profiles = state.profiles.filter(p => p.id !== id);
    if (!state.profiles.length) await ensureProfile('默认标定', emptyData());
    if (state.activeId === id) {
      const next = state.profiles[0];
      const full = await api('GET', 'profiles/' + next.id);
      setActive(next.id);
      state.lastData = full.data || emptyData();
      state.pending = null;
      writeMirror(state.lastData);
      return { activeId: next.id, data: clone(state.lastData) };
    }
    return { activeId: state.activeId, data: null };
  }

  /* Reset calibration content of the active profile (keeps the profile). */
  async function clearActive() {
    const data = emptyData();
    state.pending = null;
    clearTimeout(state.timer);
    if (state.activeId && state.online) {
      await api('PUT', 'profiles/' + state.activeId, { data });
    }
    state.lastData = data;
    writeMirror(data);
    emit('synced');
  }

  CS.profiles = {
    ACTIVE_KEY, MIRROR_KEY, LEGACY_KEY, BASE_KEY,
    init, save, flush, switchTo, create, rename, remove, clearActive,
    list: () => state.profiles.slice(),
    activeId: () => state.activeId,
    isOnline: () => state.online,
    cachedData: () => clone(state.lastData),
    set onStatus(fn) { state.onStatus = fn; },
    get onStatus() { return state.onStatus; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);