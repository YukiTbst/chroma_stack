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
  const BACKUP_KEY = 'chromastack.calibration-backup.v1';
  const BASE_KEY = 'chromastack.api-base';
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const emptyData = () => ({ calibrations: {}, lutTdOverrides: {}, lutHexOverrides: {} });

  function apiBase() {
    let base = null;
    try { base = root.localStorage.getItem(BASE_KEY); } catch (e) { /* private mode */ }
    // No server coordinates are shipped in the repo: the API is same-origin
    // `api/` by default (reverse-proxy it to server/profile-api.js), and any
    // other deployment is opted into per browser via the localStorage key.
    if (!base) base = 'api/';
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
      if (!res.ok) {
        const err = new Error(payload.error || ('HTTP ' + res.status));
        err.status = res.status;
        err.payload = payload;
        throw err;
      }
      return payload;
    } finally { clearTimeout(timer); }
  }

  const state = {
    activeId: null,
    profiles: [],
    online: false,
    initialized: false,
    lastData: emptyData(),
    revision: null,      // last known server revision of the active profile
    pending: null,       // latest snapshot waiting to be pushed
    timer: null,
    saving: false,
    conflict: null,      // { data, serverRevision, name, updatedAt }
    onStatus: null       // (status, detail) => void ; status: synced|syncing|offline|conflict
  };

  function emit(status, detail) {
    if (typeof state.onStatus === 'function') {
      try { state.onStatus(status, detail); } catch (e) { /* UI errors must not break sync */ }
    }
  }

  function writeMirror(data) {
    lsSet(MIRROR_KEY, JSON.stringify({ profileId: state.activeId, revision: state.revision, data, updatedAt: Date.now() }));
  }

  function readMirror() {
    try {
      const raw = lsGet(MIRROR_KEY);
      if (!raw) return null;
      const m = JSON.parse(raw);
      return m && m.data && typeof m.data === 'object' ? m : null;
    } catch (e) { return null; }
  }

  function backupActive(reason) {
    if (!state.activeId && !state.lastData) return null;
    const backup = {
      profileId: state.activeId,
      revision: state.revision,
      data: clone(state.lastData),
      at: Date.now(),
      reason: reason || 'manual'
    };
    lsSet(BACKUP_KEY, JSON.stringify(backup));
    return backup;
  }

  function lastBackup() {
    try {
      const raw = lsGet(BACKUP_KEY);
      if (!raw) return null;
      const b = JSON.parse(raw);
      return b && b.data ? b : null;
    } catch (e) { return null; }
  }

  async function restoreBackup() {
    const backup = lastBackup();
    if (!backup) throw new Error('没有可恢复的标定备份');
    if (backup.profileId && backup.profileId !== state.activeId) throw new Error('备份属于另一个 profile');
    let revision = state.revision;
    if (revision == null) {
      const full = await api('GET', 'profiles/' + state.activeId);
      revision = full.revision || 1;
    }
    let p;
    try {
      p = await api('PUT', 'profiles/' + state.activeId, { data: backup.data, expectedRevision: revision });
    } catch (e) {
      if (e.status !== 409) throw e;
      const full = await api('GET', 'profiles/' + state.activeId);
      p = await api('PUT', 'profiles/' + state.activeId, { data: backup.data, expectedRevision: full.revision || 1 });
    }
    state.revision = p.revision || revision + 1;
    state.lastData = clone(backup.data);
    state.pending = null;
    state.conflict = null;
    writeMirror(backup.data);
    emit('synced', p.name);
    return clone(backup.data);
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
    state.profiles.push({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, revision: p.revision });
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
      state.revision = full.revision || 1;
      state.conflict = null;
      state.lastData = full.data || emptyData();
      writeMirror(state.lastData);
      emit('synced', full.name);
      return clone(state.lastData);
    } catch (e) {
      state.online = false;
      state.initialized = true;
      state.activeId = pointer;
      const mirror = readMirror();
      let data = null, revision = null, mismatch = false;
      if (legacy) data = legacy;                       // still awaiting migration
      else if (mirror && (!pointer || mirror.profileId === pointer)) {
        data = mirror.data;
        revision = mirror.revision == null ? null : mirror.revision;
      } else if (mirror && pointer) {
        // Never load a mirror that belongs to a different profile: it would
        // silently mix two calibration sets.
        mismatch = true;
      }
      state.lastData = clone(data || emptyData());
      state.revision = revision;
      emit('offline', mismatch ? '离线；本机镜像属于其他 profile，未载入' : String(e && e.message || e));
      return clone(state.lastData);
    }
  }

  function enterConflict(data, payload) {
    state.pending = clone(data);
    if (payload && payload.revision != null) state.revision = payload.revision;
    state.conflict = {
      data: clone(data),
      serverRevision: state.revision,
      name: payload && payload.name || null,
      updatedAt: payload && payload.updatedAt || 0
    };
    writeMirror(data);
    emit('conflict', state.conflict.name || '');
  }

  async function pushPending(keepalive) {
    if (state.pending == null || state.saving || state.conflict) return;
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
    // Without a known base revision a conditional write is impossible. Fetch
    // it once; if the server already holds different data, surface a conflict
    // instead of silently replacing the other device's calibration.
    if (state.revision == null) {
      try {
        const full = await api('GET', 'profiles/' + state.activeId);
        state.revision = full.revision || 1;
        if (JSON.stringify(full.data || emptyData()) !== JSON.stringify(state.pending)) {
          enterConflict(state.pending, full);
          return;
        }
      } catch (e) {
        state.online = false;
        emit('offline', String(e && e.message || e));
        return;
      }
    }
    const data = state.pending;
    const expectedRevision = state.revision;
    state.pending = null;
    state.saving = true;
    emit('syncing');
    try {
      const res = await fetch(apiBase() + 'profiles/' + state.activeId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, expectedRevision }),
        keepalive: !!keepalive
      });
      const payload = await res.json().catch(() => ({}));
      if (res.status === 409 || res.status === 428) {
        enterConflict(data, payload);
        return;
      }
      if (!res.ok) throw new Error(payload.error || ('HTTP ' + res.status));
      state.online = true;
      state.revision = payload.revision || state.revision;
      state.lastData = clone(data);
      writeMirror(data);
      const meta = state.profiles.find(x => x.id === state.activeId);
      if (meta) { meta.name = payload.name; meta.updatedAt = payload.updatedAt; meta.revision = payload.revision; }
      emit('synced', payload.name);
    } catch (e) {
      state.online = false;
      if (state.pending == null) state.pending = data; // retry on next save/flush
      emit('offline', String(e && e.message || e));
    } finally {
      state.saving = false;
      // Only auto-retry while online; offline edits wait for the next user
      // save or an explicit flush (profile switch / page hide).
      if (state.pending != null && state.online && !state.conflict && !keepalive) schedulePush();
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
    if (state.conflict) state.conflict.data = clone(data);
    state.lastData = clone(data); // cached reads must reflect offline saves too
    writeMirror(state.pending);
    if (!state.conflict) schedulePush();
    return true;
  }

  function flush(keepalive) {
    clearTimeout(state.timer);
    state.timer = null;
    return pushPending(keepalive);
  }

  async function switchTo(id) {
    if (state.conflict) throw new Error('存在未同步的 profile 冲突，请先处理');
    await flush(false);
    if (state.conflict) throw new Error('存在未同步的 profile 冲突，请先处理');
    const full = await api('GET', 'profiles/' + id);
    setActive(id);
    state.online = true;
    state.revision = full.revision || 1;
    state.lastData = full.data || emptyData();
    state.pending = null;
    state.conflict = null;
    writeMirror(state.lastData);
    emit('synced', full.name);
    return clone(state.lastData);
  }

  async function create(name, data) {
    if (state.conflict) throw new Error('存在未同步的 profile 冲突，请先处理');
    const p = await ensureProfile(name, data);
    state.online = true;
    return p;
  }

  async function rename(id, name) {
    const meta = state.profiles.find(x => x.id === id);
    const body = { name };
    if (meta && meta.revision != null) body.expectedRevision = meta.revision;
    const p = await api('PUT', 'profiles/' + id, body);
    if (meta) { meta.name = p.name; meta.updatedAt = p.updatedAt; meta.revision = p.revision; }
    if (id === state.activeId) state.revision = p.revision || state.revision;
    return p;
  }

  /* Delete a profile; guarantees at least one remains and returns the data of
     the profile that should become active. */
  async function remove(id) {
    if (state.conflict) throw new Error('存在未同步的 profile 冲突，请先处理');
    await api('DELETE', 'profiles/' + id);
    state.profiles = state.profiles.filter(p => p.id !== id);
    if (!state.profiles.length) await ensureProfile('默认标定', emptyData());
    if (state.activeId === id) {
      const next = state.profiles[0];
      const full = await api('GET', 'profiles/' + next.id);
      setActive(next.id);
      state.revision = full.revision || 1;
      state.lastData = full.data || emptyData();
      state.pending = null;
      state.conflict = null;
      writeMirror(state.lastData);
      return { activeId: next.id, data: clone(state.lastData) };
    }
    return { activeId: state.activeId, data: null };
  }

  /* Clear calibration content of the active profile (keeps the profile).
     Offline it is recorded as a pending write and only reported as synced
     after the server acknowledges it. */
  async function clearActive() {
    const data = emptyData();
    if (state.conflict) {
      state.pending = clone(data);
      state.conflict.data = clone(data);
      state.lastData = clone(data);
      writeMirror(state.pending);
      emit('conflict', state.conflict.name || '');
      return;
    }
    state.pending = clone(data);
    state.lastData = clone(data);
    writeMirror(state.pending);
    clearTimeout(state.timer);
    state.timer = null;
    if (!state.activeId || !state.online) {
      emit('offline', '本地标定已清空，等待联网同步');
      return;
    }
    await pushPending(false);
  }

  /* Resolve a revision conflict. mode 'local' overwrites the server with the
     local draft (with a fresh precondition, retried once); mode 'server'
     adopts the server data and discards the local draft. */
  async function resolveConflict(mode) {
    if (!state.conflict) return null;
    let full;
    try { full = await api('GET', 'profiles/' + state.activeId); }
    catch (e) { emit('offline', String(e && e.message || e)); throw e; }
    let rev = full.revision || 1;
    if (mode !== 'local') {
      state.revision = rev;
      state.lastData = clone(full.data || emptyData());
      state.pending = null;
      state.conflict = null;
      writeMirror(state.lastData);
      emit('synced', full.name);
      return clone(state.lastData);
    }
    const local = state.conflict.data;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const p = await api('PUT', 'profiles/' + state.activeId, { data: local, expectedRevision: rev });
        state.revision = p.revision || rev + 1;
        state.lastData = clone(local);
        state.pending = null;
        state.conflict = null;
        writeMirror(local);
        emit('synced', p.name);
        return clone(local);
      } catch (e) {
        if (e.status === 409 && attempt === 0) {
          const again = await api('GET', 'profiles/' + state.activeId);
          rev = again.revision || 1;
          continue;
        }
        emit(e.status === 409 ? 'conflict' : 'offline', String(e && e.message || e));
        throw e;
      }
    }
    return null;
  }

  CS.profiles = {
    ACTIVE_KEY, MIRROR_KEY, LEGACY_KEY, BACKUP_KEY, BASE_KEY,
    init, save, flush, switchTo, create, rename, remove, clearActive, resolveConflict, backupActive, lastBackup, restoreBackup,
    list: () => state.profiles.slice(),
    activeId: () => state.activeId,
    isOnline: () => state.online,
    cachedData: () => clone(state.lastData),
    revision: () => state.revision,
    hasConflict: () => !!state.conflict,
    conflictInfo: () => state.conflict ? {
      serverRevision: state.conflict.serverRevision,
      name: state.conflict.name,
      updatedAt: state.conflict.updatedAt
    } : null,
    set onStatus(fn) { state.onStatus = fn; },
    get onStatus() { return state.onStatus; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);