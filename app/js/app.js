/* ChromaStack UI controller. Classic script; expects CS.color, CS.engine, CS.exporter, CS.zip. */
(function () {
  'use strict';
  const CS = window.CS;
  const C = CS.color;
  const E = CS.engine;
  const X = CS.exporter;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const fmt = (v, d = 1) => Number(v).toFixed(d);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Working-grid long side. The nozzle sets the line width, but the motion
  // system can place boundaries far finer than a pixel, so the grid is a
  // user-selectable quality lever shared by preview, layers, 3D and 3MF.
  const WORK_RESOLUTIONS = [640, 1280, 2560];
  let workMax = WORK_RESOLUTIONS[0];

  // GPU5: derive the asset version from this script's own ?v= tag so worker URLs
  // (and their importScripts deps) are cache-busted in lockstep with every deploy.
  // A bare worker URL would let returning users keep a stale cached CPU worker.
  const ASSET_V = (() => {
    try {
      const s = document.querySelector('script[src*="js/app.js"]');
      const m = s && s.src.match(/[?&]v=([^&]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  })();
  const workerUrl = (f) => 'js/' + f + (ASSET_V ? '?v=' + ASSET_V : '');

  const state = {
    imageData: null,
    imageName: '',
    workingCanvas: null,
    previewSrc: '',
    plan: null,
    engine: 'td',
    lutKey: 'bambu_8',
    widthMm: 150,
    flatTopMm: 1.6,
    reliefMm: 0.16,
    gradStartOverride: null,
    gradTopMmOverride: null,
    variableHeight: true,
    geometryMode: 'relief',
    qualityPolicy: 'color',
    luminanceCurve: (globalThis.CS && CS.heightCurve) ? CS.heightCurve.invertCurve() : [{ x: 0, y: 1 }, { x: 1, y: 0 }],
    layerHeight: 0.08,
    gradLayers: 6,
    stdThreshold: 0,
    residualThreshold: 5,
    minFlatPercent: 0.6,
    backgroundMode: 'off',
    backgroundColor: '#ffffff',
    backgroundTolerance: 8,
    backgroundEnvelope: true,
    backgroundEnvelopeMm: 1.5,
    backgroundPick: false,
    backgroundHolePick: false,
    backgroundHoleIds: new Set(),
    smoothMm: 0.8,
    lineWidthMm: 0.42,
    smoothLevel: 2,
    mergeDeltaE: 4,
    heightMergeDeltaE: 1.5,
    edgeClean: 1,
    vectorFlat: false,
    lineProtect: 'strong',
    families: 192,
    foundationIndex: 1,
    tdPalette: [],
    lutTdOverrides: {},
    lutHexOverrides: {},
    filamentCalibrations: {},
    batchLayout: null,
    batchPalette: null,
    batchPhotoResult: null,
    view: 'sim',
    layer: 0,
    exaggeration: 8,
    threeMode: 'stack',
    section3D: false,
    sectionPosition: 50,
    brushOn: false,
    brushMode: 'flat',
    brushSize: 18,
    overrideMask: null,
    // Sparse persistent manual locks: positions and painted values are stored
    // independently of any automatic segmentation, so parameter changes never
    // freeze unpainted pixels and never forget a painted lock.
    lockMask: null,
    lockValue: null,
    useMode: 'custom',
    edgeSnap: true,
    lineRepair: true,
    undo: [],
    analyzing: false,
    pending: false,
    analysisRequest: 0,
    dirty: false,
    editVersion: 0,
    appliedVersion: 0,
    planMs: 0,
    libraryFilter: 'BambuLab Basic',
    librarySearch: '',
    toastTimer: null
  };

  let resizeTimer = null;
  let storageWarned = false;
  let imageLoadSerial = 0;
  let view3dPlanRef = null;
  let view3dExag = 8;
  let section3DTimer = null;

  function update3DModeUI() {
    const stack = state.threeMode === 'stack';
    $('threeTitle').textContent = stack ? '3D 材料堆叠' : '3D 成品混色';
    $('threeSubtitle').textContent = stack ? '顶面光学混色 · 侧面真实耗材' : '最终颜色 · 平滑浮雕表面';
    document.querySelectorAll('#threeMode button').forEach(b => b.classList.toggle('active', b.dataset.mode === state.threeMode));
    $('section3D').disabled = !stack;
    $('section3D').checked = stack && state.section3D;
    $('sectionPosition').disabled = !stack || !state.section3D;
    $('sectionValue').textContent = stack && state.section3D ? state.sectionPosition + '%' : '关';
  }

  /* ---------------- init ---------------- */
  async function init() {
    state.tdPalette = defaultTdPalette();
    CS.profiles.onStatus = updateProfileStatus;
    restoreSettings(await CS.profiles.init());
    syncControlsFromState();
    bindEvents();
    renderProfileBar();
    updateBackgroundUI();
    const ok3d = !!(CS.view3d && CS.view3d.init($('threeCanvas')));
    if (!ok3d) {
      const tab = document.querySelector('#viewTabs button[data-view="three"]');
      if (tab) { tab.disabled = true; tab.textContent = '3D 不可用'; }
    }
    $('exaggeration').addEventListener('input', (e) => {
      state.exaggeration = clamp(Number(e.target.value) || 1, 1, 16);
      $('exagValue').textContent = state.exaggeration + '×';
      if (state.view === 'three' && CS.view3d.isReady()) {
        CS.view3d.setExaggeration(state.exaggeration);
        view3dExag = state.exaggeration;
      }
      CS.settings.save(state);
    });
    $('reset3D').addEventListener('click', () => { if (CS.view3d.isReady()) CS.view3d.reset(); });
    document.querySelectorAll('#threeMode button').forEach(btn => btn.addEventListener('click', () => {
      state.threeMode = btn.dataset.mode === 'finish' ? 'finish' : 'stack';
      if (CS.view3d.isReady()) CS.view3d.setMode(state.threeMode);
      update3DModeUI();
      CS.settings.save(state);
    }));
    $('section3D').addEventListener('change', e => {
      state.section3D = !!e.target.checked;
      if (CS.view3d.isReady()) CS.view3d.setSection(state.section3D, state.sectionPosition / 100);
      update3DModeUI();
      CS.settings.save(state);
    });
    $('sectionPosition').addEventListener('input', e => {
      state.sectionPosition = clamp(Number(e.target.value) || 0, 0, 100);
      update3DModeUI();
      CS.settings.save(state);
      clearTimeout(section3DTimer);
      section3DTimer = setTimeout(() => {
        if (state.view === 'three' && CS.view3d.isReady()) CS.view3d.setSection(state.section3D, state.sectionPosition / 100);
      }, 45);
    });
    update3DModeUI();
    updateEngineUI();
    renderPalette();
    renderSection(null);
    renderLegend(null);
    updateMetrics(null);
    CS.settings.save(state);
    window.addEventListener('pagehide', () => { CS.settings.save(state); CS.profiles.flush(true); });
    autoLoadSample();
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => renderStage(), 80);
    });
    ro.observe($('canvasStage'));
  }

  function defaultTdPalette() {
    const db = (CS.FILAMENT_DB && CS.FILAMENT_DB.filaments) || [];
    const pick = (name) => db.find(f => f.brand === 'BambuLab Basic' && f.material === 'PLA' && f.name === name);
    const defs = [
      pick('Black'), pick('Jade White'), pick('Red'), pick('Yellow'), pick('Blue')
    ].filter(Boolean).map(f => ({ id: f.id, name: f.name, hex: f.hex, td: f.td, brand: f.brand, material: f.material }));
    if (defs.length >= 4) return defs;
    return [
      { name: 'Black', hex: '#000000', td: 0.6, brand: 'BambuLab Basic', material: 'PLA' },
      { name: 'Jade White', hex: '#ffffff', td: 5, brand: 'BambuLab Basic', material: 'PLA' },
      { name: 'Red', hex: '#c00d1e', td: 5, brand: 'BambuLab Basic', material: 'PLA' },
      { name: 'Yellow', hex: '#fce300', td: 6, brand: 'BambuLab Basic', material: 'PLA' },
      { name: 'Blue', hex: '#00358e', td: 4, brand: 'BambuLab Basic', material: 'PLA' }
    ];
  }

  function applyCalibrationRecord(p) {
    const saved = state.filamentCalibrations[CS.settings.filamentKey(p)];
    return CS.settings.applyRecord(p, saved);
  }

  function restoreSettings(saved) {
    state.filamentCalibrations = saved && saved.calibrations && typeof saved.calibrations === 'object' ? saved.calibrations : {};
    state.lutTdOverrides = saved && saved.lutTdOverrides && typeof saved.lutTdOverrides === 'object' ? saved.lutTdOverrides : {};
    state.lutHexOverrides = saved && saved.lutHexOverrides && typeof saved.lutHexOverrides === 'object' ? saved.lutHexOverrides : {};
    state.calibrationV2 = saved && saved.calibrationV2 && typeof saved.calibrationV2 === 'object' ? saved.calibrationV2 : null;
    state.tdPalette = state.tdPalette.map(applyCalibrationRecord);
    state.backgroundHoleIds.clear();
    state.backgroundPick = false; state.backgroundHolePick = false;
    state.dirty = false; state.pending = false; state.analyzing = false;
  }

  function syncControlsFromState() {
    const values = {
      lutSelect: state.lutKey, widthMm: state.widthMm, flatTopMm: state.flatTopMm, reliefMm: state.reliefMm,
      gradStartLayer: state.gradStartOverride == null ? 16 : state.gradStartOverride,
      gradTopMm: state.gradTopMmOverride == null ? 1.76 : state.gradTopMmOverride,
      layerHeight: state.layerHeight, gradLayers: state.gradLayers,
      stdThreshold: state.stdThreshold, residualThreshold: state.residualThreshold, minFlatPercent: state.minFlatPercent,
      smoothMm: state.smoothMm, lineWidthMm: state.lineWidthMm, mergeDeltaE: state.mergeDeltaE,
      heightMergeDeltaE: state.heightMergeDeltaE, edgeClean: state.edgeClean, families: state.families,
      backgroundMode: state.backgroundMode, backgroundTolerance: state.backgroundTolerance, backgroundEnvelopeMm: state.backgroundEnvelopeMm,
      sectionPosition: state.sectionPosition, exaggeration: state.exaggeration
    };
    for (const [id, value] of Object.entries(values)) if ($(id)) $(id).value = String(value);
    $('variableHeight').checked = state.variableHeight && state.geometryMode === 'relief';
    $('variableHeight').disabled = state.engine === 'lut' || state.geometryMode !== 'relief';
    if ($('geometryMode')) $('geometryMode').value = state.geometryMode;
    if ($('qualityPolicy')) $('qualityPolicy').value = state.qualityPolicy;
    if ($('luminanceCurveField')) $('luminanceCurveField').hidden = state.geometryMode !== 'luminance';
    if (state.geometryMode === 'luminance') renderCurveEditor();
    $('vectorFlat').checked = state.vectorFlat;
    $('backgroundEnvelope').checked = state.backgroundEnvelope;
    $('section3D').checked = state.section3D;
    $('lineProtect').value = state.lineProtect;
    if ($('useMode')) $('useMode').value = state.useMode;
    updateEngineUI();
    renderPalette();
    $('foundationSelect').value = String(clamp(state.foundationIndex, 0, Math.max(0, (state.engine === 'lut' ? currentLutPalette() : state.tdPalette).length - 1)));
    $('stdValue').textContent = state.stdThreshold > 0 ? state.stdThreshold.toFixed(1) : '自动';
    $('resValue').textContent = state.residualThreshold.toFixed(1) + ' ΔE';
    $('areaValue').textContent = state.minFlatPercent.toFixed(1) + '%';
    $('mergeValue').textContent = state.mergeDeltaE > 0 ? state.mergeDeltaE.toFixed(1) : '关';
    $('heightMergeValue').textContent = state.heightMergeDeltaE > 0 ? state.heightMergeDeltaE.toFixed(1) : '关';
    $('edgeCleanValue').textContent = ['关', '轻 1', '中 2', '强 3'][state.edgeClean];
    $('familiesValue').textContent = String(state.families);
    $('lineWidthHint').textContent = `平滑 ≥ ${(state.lineWidthMm * 2).toFixed(2)} mm`;
    $('exagValue').textContent = state.exaggeration + '×';
    update3DModeUI(); updateBackgroundUI(); updateDirtyUI();
  }

  function resetSettings() {
    if (!window.confirm('重置当前 profile 的耗材标定值并清除服务器上的标定数据？其他打印参数保持不变。')) return;
    const backup = CS.profiles.backupActive('reset');
    const db = (CS.FILAMENT_DB && CS.FILAMENT_DB.filaments) || [];
    for (const p of state.tdPalette) {
      const base = db.find(f => (p.id && f.id === p.id) || (f.name === p.name && f.brand === p.brand && f.material === p.material));
      if (base) p.hex = base.hex;
      Object.assign(p, CS.settings.uniformTd(base ? base.td : p.td));
    }
    state.lutTdOverrides = {}; state.lutHexOverrides = {}; state.filamentCalibrations = {};
    state.calibrationV2 = null; // lifecycle: reset clears the v2 model too (m44 item 4)
    state.plan = null;
    CS.settings.clear();
    syncControlsFromState();
    // F01: resetting calibration changes TD values, not the image segmentation —
    // keep the user's manual region locks + undo history (markDirty(false)).
    markDirty(false);
    toast(backup ? '已重置当前 profile 的标定；其他参数未改动（已保留可恢复备份）' : '已重置当前 profile 的标定；其他参数未改动');
  }

  /* ---------------- calibration profiles (server-backed) ---------------- */
  function updateProfileStatus(status, detail) {
    const el = $('profileSyncStatus');
    if (el) {
      el.style.cursor = '';
      if (status === 'syncing') { el.textContent = '同步中…'; el.className = 'tiny sync-syncing'; el.title = ''; }
      else if (status === 'synced') {
        el.textContent = '已同步 ' + new Date().toTimeString().slice(0, 5);
        el.className = 'tiny sync-ok';
        el.title = detail ? 'Profile：' + detail : '标定已保存到服务器';
      } else if (status === 'conflict') {
        el.textContent = '冲突 · 本机改动未上传';
        el.className = 'tiny sync-off';
        el.title = '另一台设备已保存更新的标定。点击选择保留本机或改用服务器版本';
        el.style.cursor = 'pointer';
      } else {
        el.textContent = '离线 · 修改暂存本机';
        el.className = 'tiny sync-off';
        el.title = detail || '无法连接标定服务器';
      }
    }
    const online = CS.profiles.isOnline();
    for (const id of ['btnNewProfile', 'btnRenameProfile', 'btnDeleteProfile']) if ($(id)) $(id).disabled = !online;
    if ($('profileSelect')) $('profileSelect').disabled = !online;
  }

  /* A revision conflict needs a user decision: overwrite the server with the
     local draft, or adopt the server version and discard the local one. */
  async function resolveProfileConflict() {
    if (!CS.profiles.hasConflict()) return;
    const useLocal = window.confirm('标定 profile 已在另一台设备更新。\n\n确定：用本机版本覆盖服务器。\n取消：改用服务器版本（丢弃本机未上传的改动）。');
    try {
      const data = await CS.profiles.resolveConflict(useLocal ? 'local' : 'server');
      if (data) {
        adoptProfileData(data);
        toast(useLocal ? '已用本机标定覆盖服务器' : '已采用服务器标定');
      }
    } catch (e) {
      toast('处理冲突失败：' + (e.message || e));
    }
  }

  function renderProfileBar() {
    const sel = $('profileSelect');
    if (!sel) return;
    const list = CS.profiles.list();
    sel.innerHTML = list.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    sel.value = CS.profiles.activeId() || '';
    updateProfileStatus(CS.profiles.isOnline() ? 'synced' : 'offline');
  }

  async function restoreCalibrationBackup() {
    const b = CS.profiles.lastBackup();
    if (!b) { toast('没有可恢复的标定备份'); return; }
    if (!window.confirm(`恢复 ${new Date(b.at).toLocaleString()} 的标定备份？会覆盖当前 profile 的标定。`)) return;
    try {
      const data = await CS.profiles.restoreBackup();
      if (!data) { toast('备份恢复遇到冲突：另一台设备已更新标定，请点击同步状态选择保留本机或服务器版本'); return; }
      adoptProfileData(data);
      toast('已恢复上次标定备份');
    } catch (e) {
      toast('恢复失败：' + (e.message || e));
    }
  }

  function adoptProfileData(data) {
    restoreSettings(data);
    syncControlsFromState();
    renderProfileBar();
    markDirty(false);
  }

  async function switchProfile(id) {
    if (!id || id === CS.profiles.activeId()) { renderProfileBar(); return; }
    try {
      adoptProfileData(await CS.profiles.switchTo(id));
      toast('已切换标定 profile，点击计算应用到当前画面');
    } catch (e) {
      toast('切换 profile 失败：' + (e.message || e));
      renderProfileBar();
    }
  }

  async function createProfile() {
    const name = window.prompt('新 profile 名称（例如：A1 mini · PLA Basic）', '');
    if (name == null) return;
    if (!name.trim()) { toast('名称不能为空'); return; }
    try {
      const p = await CS.profiles.create(name.trim(), CS.settings.snapshot(state));
      adoptProfileData(await CS.profiles.switchTo(p.id));
      toast(`已新建并切换到「${p.name}」，复制了当前标定作为起点`);
    } catch (e) { toast('新建 profile 失败：' + (e.message || e)); }
  }

  async function renameProfile() {
    const id = CS.profiles.activeId();
    const meta = CS.profiles.list().find(p => p.id === id);
    if (!meta) return;
    const name = window.prompt('重命名 profile', meta.name);
    if (name == null) return;
    if (!name.trim()) { toast('名称不能为空'); return; }
    try {
      await CS.profiles.rename(id, name.trim());
      renderProfileBar();
      toast('已重命名');
    } catch (e) { toast('重命名失败：' + (e.message || e)); }
  }

  async function deleteProfile() {
    const id = CS.profiles.activeId();
    const meta = CS.profiles.list().find(p => p.id === id);
    if (!meta) return;
    if (!window.confirm(`删除 profile「${meta.name}」及其全部标定参数？此操作不可恢复。`)) return;
    try {
      const res = await CS.profiles.remove(id);
      if (res.data) adoptProfileData(res.data);
      renderProfileBar();
      toast('已删除 profile');
    } catch (e) { toast('删除失败：' + (e.message || e)); }
  }

  /* ---------------- image loading ---------------- */
  function autoLoadSample() {
    loadImageURL('samples/landscape.jpg', '油画风景', 'samples/landscape-thumb.jpg', true);
  }

  function loadImageURL(src, name, previewSrc, isSample) {
    const loadId = ++imageLoadSerial;
    const img = new Image();
    img.onload = () => {
      if (loadId !== imageLoadSerial) return;
      try { setImage(img, name, previewSrc); }
      catch (e) {
        console.warn(e);
        if (isSample) {
          makeSyntheticSample();
          toast('本地文件模式无法读取示例像素，已载入测试色块；用启动脚本可加载示例图。');
        } else {
          toast('图片读取失败：' + (e.message || e));
        }
      }
    };
    img.onerror = () => {
      if (loadId !== imageLoadSerial) return;
      if (isSample) makeSyntheticSample();
      else toast('图片加载失败');
    };
    img.src = src;
  }

  function setImage(source, name, previewSrc) {
    const sw = source.width || source.naturalWidth;
    const sh = source.height || source.naturalHeight;
    if (!sw || !sh) throw new Error('图片尺寸为空');
    // Downsample large images to the working grid, but also give small line-art
    // images a high-quality working raster instead of hard-cutting staircases.
    const scale = Math.min(1.8, workMax / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    // Transparent PNGs are composited on white (the printed foundation).
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    // Progressive halving keeps thin black linework intact at 1x imports;
    // one-shot bilinear at 2x+ reduction breaks 1-px strokes into noise.
    drawDownscaled(ctx, source, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    state.workingCanvas = canvas;
    state.imageData = imageData;
    state.sourceImage = source;
    state.imageName = name || '未命名';
    state.plan = null;
    state.layer = 0;
    clearManualEdits();
    state.previewSrc = previewSrc || (canvas.toDataURL ? canvas.toDataURL('image/jpeg', 0.86) : '');
    const thumb = $('previewThumb');
    thumb.src = state.previewSrc;
    thumb.hidden = false;
    $('dropzoneInner').hidden = true;
    $('dropZone').classList.add('has-image');
    $('dropZone').classList.remove('drag');
    $('stageEmpty').hidden = true;
    $('imageMeta').textContent = `${sw}×${sh}px 原图`;
    setExportEnabled(false);
    state.editVersion++;
    state.dirty = false;
    state.backgroundPick = false;
    state.backgroundHolePick = false;
    state.backgroundHoleIds.clear();
    updateDirtyUI();
    updateBackgroundUI();
    analyze();
  }

  function makeSyntheticSample() {
    imageLoadSerial++;
    state.sourceImage = null; // not re-renderable at another resolution
    const c = document.createElement('canvas');
    c.width = 720; c.height = 480;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 300);
    g.addColorStop(0, '#1d5c66'); g.addColorStop(.55, '#d98c5b'); g.addColorStop(1, '#f2c98a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 720, 480);
    // sun
    ctx.fillStyle = '#e8552f';
    ctx.beginPath(); ctx.arc(520, 116, 48, 0, Math.PI * 2); ctx.fill();
    // clouds
    ctx.fillStyle = 'rgba(255,241,214,.55)';
    ctx.beginPath(); ctx.ellipse(150, 92, 92, 16, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(610, 66, 72, 12, 0, 0, Math.PI * 2); ctx.fill();
    // mountains
    ctx.fillStyle = '#6b4b55';
    ctx.beginPath(); ctx.moveTo(0, 300); ctx.lineTo(130, 160); ctx.lineTo(240, 300); ctx.fill();
    ctx.fillStyle = '#9a634f';
    ctx.beginPath(); ctx.moveTo(160, 300); ctx.lineTo(330, 130); ctx.lineTo(470, 300); ctx.fill();
    ctx.fillStyle = '#4d3b48';
    ctx.beginPath(); ctx.moveTo(380, 300); ctx.lineTo(560, 178); ctx.lineTo(720, 300); ctx.fill();
    // snow caps
    ctx.fillStyle = '#f6e7cd';
    ctx.beginPath(); ctx.moveTo(330, 130); ctx.lineTo(300, 184); ctx.lineTo(332, 174); ctx.lineTo(355, 190); ctx.closePath(); ctx.fill();
    // lake
    const lg = ctx.createLinearGradient(0, 300, 0, 480);
    lg.addColorStop(0, '#2c6b70'); lg.addColorStop(.6, '#17464f'); lg.addColorStop(1, '#0d2d35');
    ctx.fillStyle = lg; ctx.fillRect(0, 300, 720, 180);
    // reflections
    ctx.globalAlpha = .28;
    for (let i = 0; i < 26; i++) {
      const x = 380 + Math.sin(i * 1.7) * 160;
      const y = 310 + i * 5;
      ctx.fillStyle = i % 3 === 0 ? '#f0a04b' : '#e4d9b8';
      ctx.fillRect(x, y, 30 + (i % 4) * 12, 2);
    }
    ctx.globalAlpha = 1;
    // pines
    ctx.fillStyle = '#0b2425';
    for (let i = 0; i < 7; i++) {
      const x = 30 + i * 34, base = 316 + (i % 3) * 9, hh = 80 + (i % 4) * 22;
      ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x + 18, base - hh); ctx.lineTo(x + 36, base); ctx.closePath(); ctx.fill();
      ctx.fillRect(x + 15, base, 6, 18);
    }
    // flat foreground blocks (good direct-color candidates)
    ctx.fillStyle = '#c00d1e'; ctx.fillRect(22, 404, 190, 52);
    ctx.fillStyle = '#f4ee2a'; ctx.fillRect(226, 414, 130, 42);
    ctx.fillStyle = '#000000'; ctx.fillRect(372, 404, 140, 52);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(528, 414, 170, 42);
    setImage(c, '测试色块', c.toDataURL('image/jpeg', 0.86));
  }

  /* ---------------- analysis ---------------- */
  function buildOptions() {
    // Sparse manual locks: only pixels the user actually painted override the
    // fresh automatic mask. Positions (lockMask) and values (lockValue) are
    // stored independently, so a paint that matches the current automatic
    // value still locks the pixel, and unpainted pixels always follow the
    // current parameters instead of a stale full-image snapshot.
    const n = state.imageData ? state.imageData.width * state.imageData.height : 0;
    const locks = n > 0 && state.lockMask && state.lockMask.length === n ? state.lockMask : null;
    const manualMask = locks || undefined;
    const mask = locks ? state.lockValue : undefined;
    if (state.engine === 'lut') {
      return {
        engine: 'lut', lutKey: state.lutKey, widthMm: state.widthMm,
        flatTopMm: state.flatTopMm, reliefMm: state.reliefMm, gradStartLayerOverride: state.gradStartOverride,
        families: state.families, stdThreshold: state.stdThreshold,
        residualThreshold: state.residualThreshold, minFlatPercent: state.minFlatPercent, smoothLevel: state.smoothLevel, smoothMm: state.smoothMm, lineWidthMm: state.lineWidthMm, mergeDeltaE: state.mergeDeltaE,
        lineProtect: state.lineProtect, edgeClean: state.edgeClean, vectorFlat: state.vectorFlat,
        maskOverride: mask || undefined,
        manualMask: manualMask || undefined,
        edgeSnap: state.edgeSnap !== false, lineRepair: state.lineRepair !== false,
        backgroundMode: state.backgroundMode, backgroundColor: state.backgroundColor, backgroundTolerance: state.backgroundTolerance,
        backgroundEnvelope: state.backgroundEnvelope, backgroundEnvelopeMm: state.backgroundEnvelopeMm,
        backgroundDeletedHoles: Array.from(state.backgroundHoleIds),
        tdOverrides: state.lutTdOverrides[state.lutKey], hexOverrides: state.lutHexOverrides[state.lutKey]
      };
    }
    return {
      engine: 'td', palette: state.tdPalette, widthMm: state.widthMm,
      flatTopMm: state.flatTopMm, reliefMm: state.reliefMm, gradStartLayerOverride: state.gradStartOverride, gradTopMmOverride: state.gradTopMmOverride, variableHeight: state.variableHeight, layerHeight: state.layerHeight,
      equalHeight: state.geometryMode === 'flat', qualityPolicy: state.qualityPolicy,
      luminanceHeight: state.geometryMode === 'luminance', luminanceCurve: state.luminanceCurve,
      layerCoordination: state.geometryMode === 'flat' && state.qualityPolicy !== 'color',
      opticalModel: (state.calibrationV2 && state.calibrationV2.activeModelId)
        ? (state.calibrationV2.models || []).find(m => m.modelId === state.calibrationV2.activeModelId) || null
        : null,
      gradLayers: state.gradLayers, foundationIndex: state.foundationIndex,
      families: state.families, stdThreshold: state.stdThreshold,
      residualThreshold: state.residualThreshold, minFlatPercent: state.minFlatPercent, smoothLevel: state.smoothLevel, smoothMm: state.smoothMm, lineWidthMm: state.lineWidthMm, mergeDeltaE: state.mergeDeltaE,
      lineProtect: state.lineProtect, heightMergeDeltaE: state.heightMergeDeltaE, edgeClean: state.edgeClean, vectorFlat: state.vectorFlat,
      maskOverride: mask || undefined,
      manualMask: manualMask || undefined,
      edgeSnap: state.edgeSnap !== false, lineRepair: state.lineRepair !== false,
      backgroundMode: state.backgroundMode, backgroundColor: state.backgroundColor, backgroundTolerance: state.backgroundTolerance,
      backgroundEnvelope: state.backgroundEnvelope, backgroundEnvelopeMm: state.backgroundEnvelopeMm,
      backgroundDeletedHoles: Array.from(state.backgroundHoleIds)
    };
  }

  function updateBackgroundUI() {
    const mode = $('backgroundMode'), status = $('backgroundStatus'), pick = $('btnPickBackground'), hole = $('btnBackgroundHole');
    if (!mode || !status || !pick || !hole) return;
    mode.value = state.backgroundMode;
    $('backgroundEnvelope').checked = state.backgroundEnvelope;
    pick.disabled = !state.imageData || state.analyzing;
    pick.classList.toggle('active', state.backgroundPick);
    const b = state.plan && state.plan.background;
    hole.disabled = !state.imageData || state.analyzing || state.dirty || state.backgroundMode === 'off' || !state.backgroundEnvelope || !b || !b.envelope || !(b.holes && b.holes.length);
    hole.classList.toggle('active', state.backgroundHolePick);
    $('stageCanvas').classList.toggle('pick-background', state.backgroundPick || state.backgroundHolePick);
    if (state.backgroundHolePick) status.textContent = '点击包络内部的封闭区域，切换删除 / 恢复；外轮廓保持连通。';
    else if (state.backgroundPick) status.textContent = '请在原图上点击要移除的背景颜色。';
    else if (state.backgroundMode === 'off') status.textContent = state.dirty ? '已关闭背景移除，点击计算恢复完整矩形。' : '未启用，保留完整矩形。';
    else if (state.dirty || !b || !b.enabled) status.textContent = state.backgroundMode === 'pick'
      ? `已选择 ${state.backgroundColor}，ΔE≤${state.backgroundTolerance}；点击计算生成轮廓。`
      : `自动边框主色，ΔE≤${state.backgroundTolerance}；点击计算生成轮廓。`;
    else if (b.failed) status.textContent = '识别覆盖整幅图，已自动取消；请降低容差或重新取色。';
    else if (!b.removedPixels) status.textContent = `${b.colorHex} 未发现边界连通背景，仍保留矩形。`;
    else status.textContent = `${b.colorHex} · ΔE≤${b.tolerance} · 已移除 ${(b.removedPixels / state.plan.n * 100).toFixed(1)}%，保留 ${(b.printPixels / state.plan.n * 100).toFixed(1)}% 轮廓` +
      (b.envelope ? ` · ${b.componentsAfter} 个连通实体${b.bridges ? ` / ${b.bridges} 处桥接` : ''}` : ' · 原始未包络') +
      (b.deletedHoles ? ` · 删除 ${b.deletedHoles} 处内部区域` : '');
  }

  function updateDirtyUI() {
    const busy = state.analyzing, dirty = state.dirty;
    const main = $('btnAnalyze'), stage = $('btnAnalyzeStage');
    if (main) {
      main.disabled = busy || !state.imageData;
      main.textContent = busy ? '计算中…' : (dirty ? '应用全部修改并计算' : '重新计算');
      main.classList.toggle('dirty', dirty && !busy);
    }
    if (stage) {
      stage.disabled = busy || !state.imageData;
      stage.textContent = busy ? '计算中…' : (dirty ? '应用并计算' : '计算');
      stage.classList.toggle('dirty', dirty && !busy);
      stage.title = dirty ? '有未应用的参数或耗材修改；点击后统一计算' : '按当前参数重新计算';
    }
    if ($('dirtyHint')) $('dirtyHint').hidden = !dirty || busy;
    if (dirty) $('smoothValue').textContent = '待计算';
    updateBackgroundUI();
  }

  function markDirty(clearMask) {
    if (clearMask) {
      clearManualEdits();
    }
    state.editVersion++;
    state.dirty = true;
    setExportEnabled(false);
    updateDirtyUI();
    if (!CS.settings.save(state) && !storageWarned) {
      storageWarned = true;
      toast('本地保存不可用，当前修改仅在本页面保留');
    }
  }

  let activeWorker = null;
  function runPlanInWorker(image, options, request) {
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker(workerUrl('compute-worker.js')); } catch (e) { reject(e); return; }
      activeWorker = worker;
      let settled = false;
      let timer = null;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { worker.terminate(); } catch (e) { /* ignore */ }
        if (activeWorker === worker) activeWorker = null;
        fn(arg);
      };
      timer = setTimeout(() => finish(reject, new Error('后台计算超时')), 180000);
      worker.onmessage = (e) => {
        const d = e.data || {};
        if (d.id !== request) { finish(resolve, null); return; }
        if (d.ok) finish(resolve, d.plan);
        else finish(reject, new Error(d.error || '后台计算失败'));
      };
      worker.onerror = (e) => finish(reject, new Error((e && e.message) || '后台计算失败'));
      const copy = new Uint8ClampedArray(image.data);
      worker.postMessage({ id: request, width: image.width, height: image.height, data: copy.buffer, options }, [copy.buffer]);
    });
  }

  async function buildPlanSmart(image, options, request) {
    if (typeof Worker !== 'undefined' && location.protocol !== 'file:') {
      try {
        const plan = await runPlanInWorker(image, options, request);
        if (plan) return plan;
      } catch (e) {
        if (request !== state.analysisRequest) return null;
        console.warn('后台计算失败，回退主线程', e);
      }
    }
    if (request !== state.analysisRequest) return null;
    return await E.buildPlanAsync(image, options);
  }

  function analyze() {
    if (!state.imageData) return;
    const request = ++state.analysisRequest;
    if (state.analyzing) { state.pending = true; updateDirtyUI(); return; }
    state.analyzing = true;
    state.pending = false;
    const image = state.imageData;
    const version = state.editVersion;
    const options = buildOptions();
    updateDirtyUI();
    showProgress('正在分析画面并匹配耗材…');
    setTimeout(async () => {
      const t0 = Date.now();
      try {
        if (request !== state.analysisRequest) return;
        const plan = await buildPlanSmart(image, options, request);
        if (!plan || request !== state.analysisRequest) return;
        state.plan = plan;
        state.appliedVersion = version;
        state.dirty = state.editVersion !== version;
        state.planMs = Date.now() - t0;
        state.layer = clamp(state.layer, 0, Math.max(0, plan.maxLayers - 1));
        updateAfterPlan();
        updateDirtyUI();
        rebaseBrushCanvas(plan);
      } catch (err) {
        if (request !== state.analysisRequest) return;
        console.error(err);
        state.plan = null;
        state.dirty = true;
        setExportEnabled(false);
        toast('分析失败：' + (err.message || err));
        renderSection(null);
        updateMetrics(null);
        renderLegend(null);
        renderStage();
      } finally {
        state.analyzing = false;
        hideProgress();
        updateDirtyUI();
        // Only an explicit analyze call (including a newly selected image) can
        // queue work. Run it in this same turn: no timer can later consume a
        // parameter edit as an unintended automatic calculation.
        if (state.pending) { state.pending = false; analyze(); }
      }
    }, 24);
  }

  function updateAfterPlan() {
    const p = state.plan;
    if (!p) return;
    view3dPlanRef = null;
    $('imageMeta').textContent = `${p.widthMm.toFixed(0)} × ${p.heightMm.toFixed(0)} mm · ${p.w} × ${p.h} px`;
    setExportEnabled(!state.dirty);
    renderPalette();
    updateStructureFields();
    renderSection(p);
    updateFamilyList(p);
    updateMetrics(p);
    updateLayerControl(p);
    renderLegend(p);
    updateBackgroundUI();
    renderStage();
    $('planTime').textContent = `${p.w}×${p.h} px · ${p.maxLayers} 层`;
  }

  /* ---------------- palette ---------------- */
  function currentLutPalette() {
    if (state.plan && state.plan.engine === 'lut') return state.plan.palette;
    const lut = CS.LUT_DATA && CS.LUT_DATA.lut[state.lutKey];
    if (!lut) return [];
    return E.buildLutPalette(lut, { tdOverrides: state.lutTdOverrides[state.lutKey], hexOverrides: state.lutHexOverrides[state.lutKey] });
  }

  function renderPalette() {
    const list = $('paletteList');
    const isLut = state.engine === 'lut';
    const palette = isLut ? currentLutPalette() : state.tdPalette;
    list.innerHTML = '';
    palette.forEach((p, i) => {
      const item = document.createElement('div');
      item.className = 'palette-item';
      if (isLut) {
        item.innerHTML = `
          <span class="swatch-wrap" style="background:${esc(p.hex)}"></span>
          <div class="palette-info"><strong>${esc(p.name)}</strong><small>${esc(p.brand || 'BambuLab')} · ${esc(p.material || 'PLA Basic')}</small></div>
          <div class="palette-td"><input value="${p.td != null ? p.td : ''}" disabled aria-label="TD"><span>TD</span></div>
          <span class="palette-note">LUT</span>`;
      } else {
        const tdR = p.tdR != null ? p.tdR : (p.td != null ? p.td : 5);
        const tdG = p.tdG != null ? p.tdG : (p.td != null ? p.td : 5);
        const tdB = p.tdB != null ? p.tdB : (p.td != null ? p.td : 5);
        const hasTri = p.tdR != null || p.tdG != null || p.tdB != null;
        item.innerHTML = `
          <span class="swatch-wrap"><input type="color" value="${esc(p.hex || '#808080')}" data-hex="${i}" aria-label="颜色"></span>
          <div class="palette-info"><strong>${esc(p.name || ('耗材 ' + (i + 1)))}</strong><small>${esc(p.brand || '自定义')} · ${hasTri ? '逐通道 TD（标定值）' : '单值 TD（未逐通道标定）'}</small></div>
          <div class="palette-td triple">
            <div><input type="number" value="${(Number(tdR) || 5).toFixed(1)}" min="0.1" max="20" step="0.1" data-tdr="${i}" aria-label="TD R"><span>R</span></div>
            <div><input type="number" value="${(Number(tdG) || 5).toFixed(1)}" min="0.1" max="20" step="0.1" data-tdg="${i}" aria-label="TD G"><span>G</span></div>
            <div><input type="number" value="${(Number(tdB) || 5).toFixed(1)}" min="0.1" max="20" step="0.1" data-tdb="${i}" aria-label="TD B"><span>B</span></div>
          </div>
          <button class="icon-btn" data-remove="${i}" title="移除">×</button>`;
      }
      list.appendChild(item);
    });
    $('paletteCount').textContent = `${palette.length} 槽`;
    $('btnRecommend').disabled = isLut || !state.imageData;
    $('paletteHint').textContent = isLut
      ? 'LUT 模式锁定为校准配色；切换到 TD 浮雕可使用任意耗材与 TD。'
      : 'TD 为逐通道透光距离（R/G/B），标定后自动写入；手动修改 TD 会把三个通道设为同一值。HD ≈ TD × 0.1。';
    fillFoundationSelect();
  }

  function fillFoundationSelect() {
    const sel = $('foundationSelect');
    if (!sel) return;
    const palette = state.engine === 'lut' ? currentLutPalette() : state.tdPalette;
    const cur = clamp(state.foundationIndex, 0, Math.max(0, palette.length - 1));
    sel.innerHTML = palette.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
    sel.value = String(cur);
    state.foundationIndex = cur;
  }

  function addFilamentToTd(entry) {
    if (state.tdPalette.length >= 8) { toast('最多 8 个耗材槽位'); return false; }
    const dup = state.tdPalette.some(p => (p.id && p.id === entry.id) || (p.name === entry.name && p.hex === entry.hex));
    if (dup) { toast('这个耗材已经在配色里了'); return false; }
    state.tdPalette.push(applyCalibrationRecord({ id: entry.id, name: entry.name, hex: entry.hex, td: entry.td, brand: entry.brand, material: entry.material }));
    return true;
  }

  function quickAddFilament(name) {
    const entry = CS.FILAMENT_DB.filaments.find(f => f.brand === 'BambuLab Basic' && f.material === 'PLA' && f.name === name);
    if (!entry) { toast('耗材库里没有 ' + name); return; }
    const ok = addFilamentToTd(entry);
    if (!ok) return;
    if (state.engine === 'lut') setEngine('td', false);
    clearManualEdits();
    renderPalette();
    markDirty(false);
    toast(`已加入 ${entry.name}（TD ${entry.td}）`);
  }

  function applyGamutSuggestion() {
    const btn = $('btnApplyGamut');
    const hex = btn.dataset.suggestHex;
    const name = btn.dataset.suggestName;
    if (!hex || !name) return;
    let entry = CS.FILAMENT_DB.filaments.find(f => f.name === name && f.hex.toLowerCase() === hex.toLowerCase());
    if (!entry) entry = { id: 'suggest-' + hex, name, hex, td: 5, brand: btn.dataset.suggestBrand || '自定义', material: btn.dataset.suggestMaterial || 'PLA' };
    const ok = addFilamentToTd(entry);
    if (!ok) return;
    if (state.engine === 'lut') setEngine('td', false);
    clearManualEdits();
    renderPalette();
    markDirty(false);
    toast(`已加入 ${entry.name}；点击计算后统一应用`);
  }

  function recommendPalette() {
    if (!state.imageData) { toast('先导入画稿'); return; }
    const list = E.recommendPalette(state.imageData, CS.FILAMENT_DB.filaments, 4, 'BambuLab Basic');
    if (!list.length) { toast('耗材库没有可用数据'); return; }
    state.tdPalette = list;
    state.foundationIndex = Math.max(0, list.findIndex(p => /white|jade/i.test(p.name)));
    if (state.engine === 'lut') setEngine('td', false);
    clearManualEdits();
    renderPalette();
    markDirty(false);
    toast(`已按画面推荐 ${list.length} 个拓竹 PLA Basic 配色`);
  }

  /* ---------------- engine / fields ---------------- */
  function setEngine(engine, doAnalyze = true) {
    if (state.engine === engine) return;
    state.engine = engine;
    clearManualEdits();
    updateEngineUI();
    renderPalette();
    if (doAnalyze) markDirty(false);
  }

  function updateEngineUI() {
    const isLut = state.engine === 'lut';
    document.querySelectorAll('#engineSwitch button').forEach(b => b.classList.toggle('active', b.dataset.engine === state.engine));
    $('lutField').style.display = isLut ? '' : 'none';
    $('tdLayerField').style.display = isLut ? 'none' : '';
    $('variableField').style.display = isLut ? 'none' : '';
    $('mergeField').style.display = isLut ? 'none' : '';
    $('layerHeight').disabled = isLut;
    $('gradTopMm').disabled = isLut;
    if (isLut) $('layerHeight').value = '0.08';
    else $('layerHeight').value = String(state.layerHeight);
    $('engineHint').textContent = isLut
      ? '使用拓竹 PLA Basic 实测色卡，5 层配方直接匹配，无需先标定。'
      : '用你实际有的耗材，在局部叠出 HueForge 式变高渐变；矩形纯色区仍然整块直印。';
    $('engineBadge').textContent = isLut ? '物理 LUT · 免标定' : 'TD 浮雕 · 自定义耗材';
    $('paletteHint').textContent = isLut
      ? 'LUT 模式锁定为校准配色；切换到 TD 浮雕可使用任意耗材与 TD。'
      : 'TD 为透光距离；HD ≈ TD × 0.1。色域视图会标出当前耗材无法覆盖的区域。';
    $('btnRecommend').disabled = isLut || !state.imageData;
  }

  function updateStructureFields() {
    const p = state.plan;
    if (!p) {
      $('structureLine').innerHTML = '<div><b>纯色区</b><span>0 → —</span></div><div><b>渐变区</b><span>— → —</span></div><div><b>浮雕差</b><span>—</span></div>';
      return;
    }
    const h = p.layerHeight;
    $('structureLine').innerHTML = `
      <div><b>纯色区</b><span>0–${p.flatBaseLayers || 0} 层基底 + ${p.flatBaseLayers || 0}–${p.flatLayers} 层纯色</span></div>
      <div><b>渐变区</b><span>${p.gradStartLayer} → ${p.gradTopLayer} 层</span></div>
      <div><b>浮雕差</b><span>${p.reliefMm >= 0 ? '+' : ''}${fmt(p.reliefMm, 2)} mm</span></div>`;
    $('readoutLayers').textContent = `${p.maxLayers} 层`;
    $('readoutStart').textContent = `${p.gradStartLayer} 层 / ${fmt(p.gradStartLayer * h, 2)} mm`;
    $('gradStartLayer').value = String(p.gradStartLayer);
    $('gradTopMm').value = p.gradTopMm.toFixed(2);
    $('gradLayers').value = String(p.maxGradLayers || p.gradLayers || state.gradLayers);
    $('reliefMm').value = p.reliefMm.toFixed(2);
    $('startMm').textContent = (p.gradStartLayer * h).toFixed(2) + ' mm';
    const total = p.stats.grams.reduce((a, b) => a + b, 0);
    $('readoutGrams').textContent = `${fmt(total, 1)} g`;
  }

  /* ---------------- section drawing ---------------- */
  function renderSection(p) {
    const svg = $('sectionSvg');
    if (!p) {
      svg.innerHTML = `<rect x="0" y="0" width="300" height="170" fill="#f1e8d8"/>
        <text x="150" y="82" text-anchor="middle" fill="#8d8170" font-size="10">导入画稿后显示高度剖面</text>
        <line x1="30" y1="148" x2="270" y2="148" stroke="#c9bba4" stroke-width="1"/>`;
      return;
    }
    const maxH = Math.max(p.actualGradTopMm || p.gradTopMm, p.flatTopMm, 0.8);
    const baseline = 148, top = 28, scale = (baseline - top) / maxH;
    const y = (mm) => baseline - mm * scale;
    const fh = p.flatTopMm, sh = p.gradStartLayer * p.layerHeight;
    const fams = p.families.filter(f => f.pixelCount > 0).sort((a, b) => a.recipe.length - b.recipe.length || b.pixelCount - a.pixelCount);
    let flatCount = new Uint32Array(p.palette.length);
    for (let i = 0; i < p.flatMask.length; i++) if (p.flatMask[i]) flatCount[p.flatFilament[i]]++;
    let dom = 0;
    for (let i = 1; i < flatCount.length; i++) if (flatCount[i] > flatCount[dom]) dom = i;
    const flatHex = p.palette[dom] ? p.palette[dom].hex : '#d8c8a9';
    let out = `<rect x="0" y="0" width="300" height="170" fill="#f1e8d8"/>
      <line x1="26" y1="${baseline}" x2="274" y2="${baseline}" stroke="#bfae95" stroke-width="1"/>
      <line x1="26" y1="${y(fh)}" x2="274" y2="${y(fh)}" stroke="#b49a76" stroke-width="1" stroke-dasharray="3 3"/>
      <rect x="42" y="${y(fh)}" width="88" height="${fh * scale}" fill="${flatHex}" stroke="rgba(0,0,0,.18)"/>
      <text x="86" y="${y(fh) - 7}" text-anchor="middle" fill="#5b5145" font-size="8">纯色 ${fh.toFixed(2)} mm</text>`;
    const gx0 = 160, gw = 108;
    if (p.variableHeight && fams.length > 1) {
      const picks = [];
      if (fams.length <= 4) picks.push(...fams);
      else for (let i = 0; i < 4; i++) picks.push(fams[Math.round(i * (fams.length - 1) / 3)]);
      const colW = gw / picks.length;
      picks.forEach((fam, idx) => {
        const x0 = gx0 + idx * colW;
        out += `<rect x="${x0}" y="${y(sh)}" width="${colW - 1.5}" height="${sh * scale}" fill="${esc(p.foundation.hex)}" stroke="rgba(0,0,0,.1)" stroke-width=".4"/>`;
        fam.recipe.forEach((fi, li) => {
          const z0 = sh + li * p.layerHeight, z1 = z0 + p.layerHeight;
          out += `<rect x="${x0}" y="${y(z1)}" width="${colW - 1.5}" height="${Math.max(0.5, (z1 - z0) * scale)}" fill="${esc(p.palette[fi].hex)}" stroke="rgba(0,0,0,.08)" stroke-width=".3"/>`;
        });
        const topZ = sh + fam.recipe.length * p.layerHeight;
        out += `<line x1="${x0}" y1="${y(topZ)}" x2="${x0 + colW - 1.5}" y2="${y(topZ)}" stroke="rgba(30,42,48,.45)" stroke-width=".7"/>`;
      });
      out += `<text x="214" y="20" text-anchor="middle" fill="#7d8b84" font-size="7">阶梯渐变 · 4 个高度样本</text>`;
    } else {
      const family = fams.slice().sort((a, b) => b.pixelCount - a.pixelCount)[0];
      const recipe = family ? family.recipe : [];
      out += `<rect x="${gx0}" y="${y(sh)}" width="${gw}" height="${sh * scale}" fill="${esc(p.foundation.hex)}" stroke="rgba(0,0,0,.12)"/>`;
      recipe.forEach((fi, li) => {
        const z0 = sh + li * p.layerHeight, z1 = z0 + p.layerHeight;
        out += `<rect x="${gx0}" y="${y(z1)}" width="${gw}" height="${Math.max(0.5, (z1 - z0) * scale)}" fill="${esc(p.palette[fi].hex)}" stroke="rgba(0,0,0,.08)" stroke-width=".3"/>`;
      });
      out += `<text x="214" y="20" text-anchor="middle" fill="#7d8b84" font-size="7">${p.engine === 'lut' ? '5 色层 · 白色基底' : '等高层叠'}</text>`;
    }
    const gh = p.gradTopMm;
    out += `<text x="214" y="${y(gh) - 7}" text-anchor="middle" fill="#4c5a55" font-size="8">最高 ${gh.toFixed(2)} mm</text>
      <text x="86" y="${baseline + 12}" text-anchor="middle" fill="#7e715f" font-size="7.5">纯色区</text>
      <text x="214" y="${baseline + 12}" text-anchor="middle" fill="#7e715f" font-size="7.5">渐变区</text>`;
    if (Math.abs(p.reliefMm) > 0.001) {
      const up = p.reliefMm > 0;
      const x = 286;
      out += `<line x1="${x}" y1="${y(fh)}" x2="${x}" y2="${y(gh)}" stroke="#c25a3d" stroke-width="1"/>
        <text x="${x - 3}" y="${(y(fh) + y(gh)) / 2}" text-anchor="end" fill="#b14b31" font-size="7">${up ? '+' : ''}${p.reliefMm.toFixed(2)}</text>`;
    }
    svg.innerHTML = out;
  }

  /* ---------------- families ---------------- */
  function updateFamilyList(p) {
    const list = $('familyList');
    const fams = p.families.filter(f => f.pixelCount > 0).sort((a, b) => b.pixelCount - a.pixelCount);
    $('familyMeta').textContent = `${fams.length} 个配方` + ((p.stats.mergedGroups || 0) > 0 ? ` · ${p.stats.mergedGroups} 组共底` : '');
    if (!fams.length) {
      list.innerHTML = '<div class="placeholder-small">当前没有渐变区；整幅画都落在纯色区。</div>';
      return;
    }
    // F04: show the FINAL coordinated colour per family, not the nominal recipe
    // prediction (coordination re-assigns regions to near-color recipes).
    const finalHex = {};
    if (p.predicted && p.familyId) {
      const counts = {};
      for (let i = 0; i < p.n; i++) {
        if (p.printMask && !p.printMask[i]) continue;
        const f = p.familyId[i]; if (f < 0) continue;
        const hx = p.predicted[i] && p.predicted[i].hex; if (!hx) continue;
        const k = hx.toLowerCase(); (counts[f] = counts[f] || {})[k] = (counts[f][k] || 0) + 1;
      }
      for (const f in counts) { const keys = Object.keys(counts[f]); keys.sort((a, b) => counts[f][b] - counts[f][a]); finalHex[f] = keys[0]; }
    }
    const coordinated = !!(p.coordination && p.coordination.changedRegions > 0);
    list.innerHTML = fams.slice(0, 8).map(f => {
      const fi = p.families.indexOf(f);
      const shownHex = finalHex[fi] || f.predictedHex;
      const changed = coordinated && shownHex.toLowerCase() !== f.predictedHex.toLowerCase();
      const chips = f.recipe.map((pal_i, idx) => {
        const pal = p.palette[pal_i];
        return `<span class="recipe-chip" style="background:${esc(pal.hex)}" title="${esc(pal.name)} · 第 ${idx + 1} 层（底→顶）"></span>`;
      }).join('<span class="recipe-arrow">↑</span>');
      return `<div class="family-item">
        <div class="family-top">
          <span class="family-swatch" style="background:${esc(f.targetHex)}" title="目标色"></span>
          <b>${esc(f.targetHex)} → ${esc(shownHex)}</b>
          <em>ΔE ${f.deltaE.toFixed(1)} · ${f.pixelCount}px · ${f.recipe.length}层${f.sharedBaseLayers ? ' · 共底'+f.sharedBaseLayers : ''}${changed ? ' · 协调后色' : ''}</em>
        </div>
        <div class="recipe-chips">${chips}</div>
      </div>`;
    }).join('');
  }

  /* ---------------- metrics ---------------- */
  function updateLineStatus(p) {
    const el = $('lineStatus');
    if (!el) return;
    if (!p) { el.textContent = '自动检测'; return; }
    const li = p.lineInfo || {};
    if (p.lineMode === 'off') {
      el.textContent = li.active ? '已关闭 · 检测到线稿' : '关闭';
    } else if (p.lineMode === 'strong') {
      el.textContent = li.directPercent > 0 ? `强 · 直印 ${li.directPercent.toFixed(1)}%` : '强';
    } else if (li.active) {
      el.textContent = `已保护 · 细线 ${li.strokePercent.toFixed(1)}% 像素`;
    } else {
      el.textContent = '未检测到线稿';
    }
  }

  function updateEdgeStatus(p) {
    const el = $('edgeCleanValue');
    if (!el) return;
    const labels = ['关', '轻 1', '中 2', '强 3'];
    if (!p) { el.textContent = labels[state.edgeClean]; return; }
    const req = p.edgeCleanRequested == null ? state.edgeClean : p.edgeCleanRequested;
    if (req <= 0) { el.textContent = '关'; return; }
    el.textContent = labels[req] + (p.edgeClean > 0 ? ` · ${p.edgePixelPercent.toFixed(0)}%` : ' · 跳过');
  }

  function updateMetrics(p) {
    if (!p) {
      ['metricDE', 'metricP90', 'metricFlat', 'metricFamilies', 'metricSwaps', 'metricRelief'].forEach(id => $(id).textContent = '—');
      ['valUnder5', 'valUnder10', 'valGrad', 'valGamut', 'valShare'].forEach(id => $(id).textContent = '—');
      ['barUnder5', 'barUnder10', 'barGrad', 'barGamut', 'barShare'].forEach(id => $(id).style.width = '0%');
      $('warningList').innerHTML = '<li class="muted">暂无提醒</li>';
      $('btnApplyGamut').hidden = true;
      $('supportAudit').textContent = '悬空检查：—';
      $('supportAudit').style.color = '';
      $('smoothValue').textContent = state.smoothMm <= 0 ? '关' : (state.dirty ? '待计算' : '—');
      if ($('computeEngine')) $('computeEngine').hidden = true;
      updateLineStatus(null);
      updateEdgeStatus(null);
      return;
    }
    const s = p.stats;
    updateLineStatus(p);
    updateEdgeStatus(p);
    if (p.smoothMode === 'physical') {
      const sr = p.smoothRadiusPx || 0;
      $('smoothValue').textContent = p.smoothMm > 0 ? (sr ? sr + 'px' : '<1px') : '关';
    }
    $('metricDE').textContent = s.meanDE.toFixed(2);
    $('metricP90').textContent = String(s.p90);
    $('metricFlat').textContent = s.flatPercent.toFixed(1) + '%';
    $('metricFamilies').textContent = String(s.familyCount);
    $('metricSwaps').textContent = String(s.toolChanges);
    $('metricRelief').textContent = (p.reliefMm >= 0 ? '+' : '') + p.reliefMm.toFixed(2);
    // PERF2-GPU: show whether this plan was computed on GPU or CPU, plus the reason
    // (perf review: a bare GPU/CPU label hides why GPU was skipped / what accelerated).
    if ($('computeEngine')) {
      const eng = p.computeEngine === 'gpu' ? 'GPU' : 'CPU';
      $('computeEngine').hidden = false;
      $('computeEngineName').textContent = eng;
      $('computeEngineName').className = eng === 'GPU' ? 'eng-gpu' : 'eng-cpu';
      $('computeEngineMs').textContent = state.planMs ? ` · ${(state.planMs / 1000).toFixed(1)}s` : '';
      const d = p.computeDiag;
      let tip;
      if (d && d.path === 'gpu') tip = `GPU 预热加速：色域 ${d.gamutSize} 条，色层 ${d.colorLayers}${d.opticalModel ? '，已用标定模型' : ''}；预热中心 ${d.prewarm.centers}/单元 ${d.prewarm.cells}/精确 ${d.prewarm.exacts}。其余阶段（中性约束/协调等）仍在 CPU。`;
      else if (d && d.reason) {
        const reasons = { 'lut-engine': 'LUT 引擎', 'no-gpu-module': '无 WebGPU 模块', 'small-image': '图像小于 10 万像素（CPU 更快）', 'no-adapter': '无可用 GPU 适配器', 'all-flat': '全纯色无渐变', 'empty-gamut': '色域为空', 'no-matcher': 'GPU 匹配器创建失败', 'gpu-error': 'GPU 出错回退' };
        tip = `CPU 计算：${reasons[d.reason] || d.reason}${d.error ? '（' + d.error + '）' : ''}`;
      } else tip = 'CPU 计算';
      $('computeEngine').title = tip;
    }
    $('valUnder5').textContent = s.under5.toFixed(0) + '%';
    $('valUnder10').textContent = s.under10.toFixed(0) + '%';
    $('valGrad').textContent = s.gradPercent.toFixed(0) + '%';
    $('valGamut').textContent = (s.outOfGamutPercent || 0).toFixed(0) + '%';
    $('valShare').textContent = (s.sharedBasePercent || 0).toFixed(0) + '%';
    $('barUnder5').style.width = clamp(s.under5, 0, 100) + '%';
    $('barUnder10').style.width = clamp(s.under10, 0, 100) + '%';
    $('barGrad').style.width = clamp(s.gradPercent, 0, 100) + '%';
    $('barGamut').style.width = clamp(s.outOfGamutPercent || 0, 0, 100) + '%';
    $('barShare').style.width = clamp(s.sharedBasePercent || 0, 0, 100) + '%';
    const support = $('supportAudit');
    if (support) {
      if (s.supportAddedPixels > 0) {
        support.textContent = `悬空检查：第 ${s.supportAddedLayers.join('、')} 层新增 ${s.supportAddedPixels} px 无下层支撑，建议开支撑。`;
        support.style.color = '#b4573b';
      } else {
        support.textContent = '悬空检查：无新增面积（每层都有下层支撑）。';
        support.style.color = '';
      }
    }
    const warnings = p.warnings.slice();
    if (s.toolChanges > 160) warnings.push('层内换色下界较高，实际擦料和打印时间可能明显增加；可降低“渐变配色数”或扩大纯色区。');
    if (p.engine === 'lut' && Math.abs(p.layerHeight - 0.08) > 1e-6) warnings.push('LUT 校准层高为 0.08 mm，请勿在切片器中改成其他层高。');
    $('warningList').innerHTML = warnings.length
      ? warnings.map(w => `<li>${esc(w)}</li>`).join('')
      : '<li class="muted">暂无提醒</li>';
    const gap = (s.gamutGaps && s.gamutGaps[0]) || null;
    const btn = $('btnApplyGamut');
    if (gap && gap.suggested) {
      btn.hidden = false;
      btn.textContent = `加入建议耗材：${gap.suggested.name} (${gap.suggested.hex})`;
      btn.dataset.suggestHex = gap.suggested.hex;
      btn.dataset.suggestName = gap.suggested.name;
      btn.dataset.suggestBrand = gap.suggested.brand || '';
      btn.dataset.suggestMaterial = gap.suggested.material || 'PLA';
    } else {
      btn.hidden = true;
    }
  }

  /* ---------------- layer / legend ---------------- */
  function updateLayerControl(p) {
    const slider = $('layerSlider');
    slider.max = String(Math.max(0, p.maxLayers - 1));
    slider.value = String(clamp(state.layer, 0, p.maxLayers - 1));
    $('layerNumber').textContent = String(state.layer + 1);
    $('layerControl').classList.toggle('disabled', state.view !== 'layer');
  }

  function getLegend() {
    let el = document.getElementById('canvasLegend');
    if (!el) {
      el = document.createElement('div');
      el.id = 'canvasLegend';
      el.className = 'canvas-legend';
      el.hidden = true;
      $('canvasStage').appendChild(el);
    }
    return el;
  }

  function renderLegend(p) {
    const el = getLegend();
    if (!p) { el.hidden = true; el.style.display = 'none'; return; }
    el.hidden = false;
    el.style.display = '';
    if (state.view === 'regions') {
      el.innerHTML = `<span><i class="legend-dot" style="background:#d8a53a"></i>纯色直印</span><span><i class="legend-dot" style="background:#2f6f6a"></i>局部层叠</span><span>拖动调整阈值或手绘修整</span>`;
    } else if (state.view === 'height') {
      const hs = actualHeightStats(p, state.overrideMask || p.flatMask);
      el.innerHTML = `<span>高度 ${hs.minMm.toFixed(2)}–${hs.maxMm.toFixed(2)} mm</span><span>阶梯 ${hs.min}–${hs.max} 层</span><span>纯色区 ${p.flatTopMm.toFixed(2)} mm</span>`;
    } else if (state.view === 'gamut') {
      el.innerHTML = `<span><i class="legend-dot" style="background:#d8b05c"></i>纯色直印</span><span><i class="legend-dot" style="background:#2f6f6a"></i>可达 ≤5</span><span><i class="legend-dot" style="background:#808e4b"></i>5–8</span><span><i class="legend-dot" style="background:#d08a3e"></i>8–12</span><span><i class="legend-dot" style="background:#c94a32"></i>&gt;12</span>`;
    } else if (state.view === 'three') {
      const stack = state.threeMode === 'stack';
      el.innerHTML = `<span>${stack ? '材料堆叠：顶面光学混色，侧面/剖面真实耗材' : '成品混色：最终预测色'}</span><span>高度夸张 <b>${state.exaggeration}×</b>（仅预览）</span><span>拖动旋转 · 滚轮缩放</span>`;
    } else if (state.view === 'layer') {
      const z = Math.min(state.layer, p.maxLayers - 1);
      const arr = p.stats.layerFilaments[z] || [];
      el.innerHTML = `<span>第 ${z + 1} / ${p.maxLayers} 层 · ${(z * p.layerHeight).toFixed(2)} mm</span>` +
        arr.map(fi => `<span><i class="legend-dot" style="background:${esc(p.palette[fi].hex)}"></i>${esc(p.palette[fi].name)}</span>`).join('') + '<span><i class="legend-dot checker-dot"></i>该层无材料（配方已结束）</span><span>最终表面看模拟/3D</span>';
    } else if (state.view === 'original') {
      el.innerHTML = `<span>原图 · ${p.w}×${p.h}px 工作分辨率</span>`;
    } else {
      const dg = p.diagnostics && p.diagnostics.groups;
      const groupText = dg ? `<span>线 <b>${dg.line.meanDE}</b> · 纯 <b>${dg.flat.meanDE}</b> · 渐 <b>${dg.gradient.meanDE}</b></span>` : '';
      el.innerHTML = `<span>模拟成画 · 正面漫射光近似</span><span>ΔE00 平均 <b>${p.stats.meanDE.toFixed(2)}</b></span><span>P90 <b>${p.stats.p90}</b></span>${groupText}`;
    }
  }

  /* ---------------- stage render ---------------- */

  /* Chrome's bilinear drawImage softens badly at >2x reduction (a 1280 plan
     squeezed into a ~590 px stage looked blurrier than the 640 plan). Halve
     progressively so large plans downscale with proper box-like filtering. */
  function drawDownscaled(ctx, src, dw, dh) {
    let cur = src, cw = src.width || src.naturalWidth, ch = src.height || src.naturalHeight;
    while (cw > dw * 2 && ch > dh * 2) {
      const nw = Math.max(dw, Math.round(cw / 2)), nh = Math.max(dh, Math.round(ch / 2));
      const tmp = document.createElement('canvas');
      tmp.width = nw; tmp.height = nh;
      const tctx = tmp.getContext('2d');
      tctx.imageSmoothingEnabled = true; tctx.imageSmoothingQuality = 'high';
      tctx.drawImage(cur, 0, 0, nw, nh);
      cur = tmp; cw = nw; ch = nh;
    }
    ctx.drawImage(cur, 0, 0, dw, dh);
  }

  function renderStage() {
    const canvas = $('stageCanvas');
    const stage = $('canvasStage');
    const p = state.plan;
    if (!state.imageData) {
      $('stageEmpty').hidden = false;
      $('threeCanvas').hidden = true;
      $('threeHud').hidden = true;
      canvas.hidden = false;
      canvas.style.display = 'none';
      return;
    }
    $('stageEmpty').hidden = true;
    const is3D = state.view === 'three';
    $('threeCanvas').hidden = !is3D;
    $('threeHud').hidden = !is3D;
    canvas.hidden = is3D;
    if (is3D) {
      const p3 = state.plan;
      if (p3 && CS.view3d && CS.view3d.isReady()) {
        if (view3dPlanRef !== p3 || view3dExag !== state.exaggeration) {
          CS.view3d.setPlan(p3, state.exaggeration);
          view3dPlanRef = p3;
          view3dExag = state.exaggeration;
        } else {
          CS.view3d.resize();
          CS.view3d.render();
        }
        const leg = document.getElementById('canvasLegend');
        if (leg) leg.remove();
      } else {
        getLegend().hidden = true;
        if (CS.view3d.clear) CS.view3d.clear();
      }
      return;
    }
    $('threeCanvas').hidden = true;
    $('threeHud').hidden = true;
    canvas.hidden = false;
    canvas.style.display = '';
    getLegend().style.display = '';
    const rectW = Math.max(120, stage.clientWidth - 32);
    const rectH = Math.max(120, stage.clientHeight - 32);
    const srcW = p ? p.w : state.imageData.width;
    const srcH = p ? p.h : state.imageData.height;
    const scale = Math.min(rectW / srcW, rectH / srcH);
    const cssW = Math.max(1, Math.round(srcW * scale));
    const cssH = Math.max(1, Math.round(srcH * scale));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const silhouette = !!(p && p.background && p.background.enabled);
    if (state.view === 'original' || !p) {
      drawDownscaled(ctx, state.workingCanvas, cssW, cssH);
    } else if (state.view === 'sim') {
      const off = imageDataCanvas(new ImageData(new Uint8ClampedArray(p.preview), p.w, p.h));
      if (silhouette) drawChecker(ctx, cssW, cssH, 12);
      drawDownscaled(ctx, off, cssW, cssH);
    } else if (state.view === 'regions') {
      const off = buildRegionCanvas(p, state.overrideMask || p.flatMask);
      if (silhouette) drawChecker(ctx, cssW, cssH, 12);
      drawDownscaled(ctx, off, cssW, cssH);
    } else if (state.view === 'height') {
      const off = buildHeightCanvas(p, state.overrideMask || p.flatMask);
      if (silhouette) drawChecker(ctx, cssW, cssH, 12);
      drawDownscaled(ctx, off, cssW, cssH);
    } else if (state.view === 'gamut') {
      const off = buildGamutCanvas(p, state.overrideMask || p.flatMask);
      if (silhouette) drawChecker(ctx, cssW, cssH, 12);
      drawDownscaled(ctx, off, cssW, cssH);
    } else if (state.view === 'three') {
      const stack = state.threeMode === 'stack';
      el.innerHTML = `<span>${stack ? '材料堆叠：顶面光学混色，侧面/剖面真实耗材' : '成品混色：最终预测色'}</span><span>高度夸张 <b>${state.exaggeration}×</b>（仅预览）</span><span>拖动旋转 · 滚轮缩放</span>`;
    } else if (state.view === 'layer') {
      const off = buildLayerCanvas(p, state.layer, state.overrideMask || p.flatMask);
      drawChecker(ctx, cssW, cssH, 12);
      drawDownscaled(ctx, off, cssW, cssH);
      drawLayerHud(ctx, p, cssW);
    }
    renderLegend(p);
    canvas.classList.toggle('brush', state.brushOn);
    if (state.brushOn) drawBrushCursor(ctx, p, cssW, cssH);
  }

  function imageDataCanvas(imgData) {
    const c = document.createElement('canvas');
    c.width = imgData.width; c.height = imgData.height;
    c.getContext('2d').putImageData(imgData, 0, 0);
    return c;
  }

  function buildRegionCanvas(p, mask) {
    const out = new Uint8ClampedArray(p.w * p.h * 4);
    const orig = state.imageData.data;
    for (let i = 0; i < p.w * p.h; i++) {
      if (p.printMask && !p.printMask[i]) continue;
      let r, g, b;
      if (mask[i]) {
        const pal = p.palette[p.flatFilament[i] !== 0xffff ? p.flatFilament[i] : p.nearest[i]] || p.palette[0];
        const c = C.hexToRgb(pal.hex);
        r = c.r * 0.78 + 246 * 0.22; g = c.g * 0.78 + 238 * 0.22; b = c.b * 0.78 + 219 * 0.22;
      } else {
        r = orig[i * 4] * 0.52 + 47 * 0.48;
        g = orig[i * 4 + 1] * 0.52 + 111 * 0.48;
        b = orig[i * 4 + 2] * 0.52 + 106 * 0.48;
      }
      // boundary darkening
      const x = i % p.w, y = (i / p.w) | 0;
      let edge = false;
      if (x > 0 && mask[i - 1] !== mask[i]) edge = true;
      if (x + 1 < p.w && mask[i + 1] !== mask[i]) edge = true;
      if (y > 0 && mask[i - p.w] !== mask[i]) edge = true;
      if (y + 1 < p.h && mask[i + p.w] !== mask[i]) edge = true;
      if (edge) { r *= 0.66; g *= 0.66; b *= 0.66; }
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
    }
    return imageDataCanvas(new ImageData(out, p.w, p.h));
  }

  function actualTopLayer(p, i, mask) {
    if (p.printMask && !p.printMask[i]) return 0;
    // 亮度浮雕: per-pixel luminance height field.
    if (p.luminanceHeight && p.topLayer) return p.topLayer[i];
    // F02: the heightmap/height stats must follow the FINAL material source, same as
    // view3d.samplePlan / engine.filamentAt — coordinated region recipe length, or the
    // equal-height common top (incl. envelope support). The old rule drew the envelope
    // low (gradStartLayer) and ignored coordinated recipe lengths.
    if (p.regionRecipes && p.regionOf) {
      const rr = p.regionRecipes[p.regionOf[i]];
      if (rr) return p.gradStartLayer + rr.length;
    }
    if (p.equalHeight) return p.commonTopLayer;
    if (mask[i]) return p.flatLayers;
    const f = p.familyId[i];
    return f >= 0 ? p.gradStartLayer + p.families[f].recipe.length : p.gradStartLayer;
  }

  function actualHeightStats(p, mask) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < p.w * p.h; i++) {
      if (p.printMask && !p.printMask[i]) continue;
      const z = actualTopLayer(p, i, mask);
      if (z < min) min = z;
      if (z > max) max = z;
    }
    if (!isFinite(min)) { min = 0; max = 0; }
    return { min, max, minMm: min * p.layerHeight, maxMm: max * p.layerHeight };
  }

  function heightColor(t) {
    // low: deep charcoal teal; mid: teal; high: warm cream/gold
    const stops = [
      { t: 0, c: [37, 52, 55] },
      { t: 0.45, c: [47, 111, 106] },
      { t: 0.75, c: [176, 151, 94] },
      { t: 1, c: [231, 207, 162] }
    ];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i].t) {
        const a = stops[i - 1], b = stops[i];
        const k = (t - a.t) / (b.t - a.t || 1);
        return [a.c[0] + (b.c[0] - a.c[0]) * k, a.c[1] + (b.c[1] - a.c[1]) * k, a.c[2] + (b.c[2] - a.c[2]) * k];
      }
    }
    return stops[stops.length - 1].c;
  }

  function buildHeightCanvas(p, mask) {
    const out = new Uint8ClampedArray(p.w * p.h * 4);
    const st = actualHeightStats(p, mask);
    const span = Math.max(1, st.max - st.min);
    for (let i = 0; i < p.w * p.h; i++) {
      if (p.printMask && !p.printMask[i]) continue;
      const z = actualTopLayer(p, i, mask);
      const t = (z - st.min) / span;
      let c = heightColor(t);
      const x = i % p.w, y = (i / p.w) | 0;
      let edge = false;
      if (x > 0 && actualTopLayer(p, i - 1, mask) !== z) edge = true;
      if (x + 1 < p.w && actualTopLayer(p, i + 1, mask) !== z) edge = true;
      if (y > 0 && actualTopLayer(p, i - p.w, mask) !== z) edge = true;
      if (y + 1 < p.h && actualTopLayer(p, i + p.w, mask) !== z) edge = true;
      if (edge) c = [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55];
      out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
    }
    return imageDataCanvas(new ImageData(out, p.w, p.h));
  }

  function buildGamutCanvas(p, mask) {
    const out = new Uint8ClampedArray(p.w * p.h * 4);
    for (let i = 0; i < p.w * p.h; i++) {
      if (p.printMask && !p.printMask[i]) continue;
      let c;
      if (mask[i]) {
        c = [216, 176, 92]; // direct solid
      } else {
        const f = p.familyId[i];
        const de = f >= 0 ? p.families[f].deltaE : 30;
        c = de <= 5 ? [47, 111, 106] : de <= 8 ? [128, 142, 75] : de <= 12 ? [208, 138, 62] : [201, 74, 50];
      }
      const x = i % p.w, y = (i / p.w) | 0;
      let edge = false;
      if (x > 0 && mask[i - 1] !== mask[i]) edge = true;
      if (x + 1 < p.w && mask[i + 1] !== mask[i]) edge = true;
      if (y > 0 && mask[i - p.w] !== mask[i]) edge = true;
      if (y + 1 < p.h && mask[i + p.w] !== mask[i]) edge = true;
      if (edge) c = [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55];
      out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
    }
    return imageDataCanvas(new ImageData(out, p.w, p.h));
  }

  function buildLayerCanvas(p, z, mask) {
    const out = new Uint8ClampedArray(p.w * p.h * 4);
    for (let i = 0; i < p.w * p.h; i++) {
      if (p.printMask && !p.printMask[i]) continue;
      // F08: single material source (coordinated regions / equal-height support).
      const fi = CS.engine.filamentAt(p, i % p.w, (i / p.w) | 0, z);
      if (fi >= 0) {
        const c = C.hexToRgb(p.palette[fi].hex);
        out[i * 4] = c.r; out[i * 4 + 1] = c.g; out[i * 4 + 2] = c.b; out[i * 4 + 3] = 255;
      }
    }
    return imageDataCanvas(new ImageData(out, p.w, p.h));
  }

  function drawChecker(ctx, w, h, size) {
    ctx.save();
    ctx.fillStyle = '#dcd5c8';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f3ede2';
    const s = Math.max(6, size || 12);
    for (let y = 0; y < h; y += s) {
      for (let x = 0; x < w; x += s) {
        if (((x / s) | 0) % 2 === ((y / s) | 0) % 2) continue;
        ctx.fillRect(x, y, s, s);
      }
    }
    ctx.strokeStyle = 'rgba(30,42,48,.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    ctx.restore();
  }

  function drawLayerHud(ctx, p, cssW) {
    const z = Math.min(state.layer, p.maxLayers - 1);
    ctx.save();
    ctx.font = '600 11px "Microsoft YaHei UI", sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,.48)';
    ctx.fillRect(10, 10, Math.min(cssW - 20, 260), 24);
    ctx.fillStyle = '#f3eee2';
    ctx.fillText(`第 ${z + 1} / ${p.maxLayers} 层 · Z ${(z * p.layerHeight).toFixed(2)} mm`, 18, 26);
    ctx.restore();
  }

  function drawBrushCursor(ctx, p, cssW, cssH) {
    // Reserved for a hover ring; keep render lightweight.
  }

  /* ---------------- brush ---------------- */
  let painting = false;

  function beginBackgroundHolePick() {
    if (state.dirty || state.analyzing || state.backgroundMode === 'off' || !state.backgroundEnvelope) {
      toast('请先计算并应用当前背景参数，再编辑内部区域'); return;
    }
    const b = state.plan && state.plan.background;
    if (!b || !b.envelope || !(b.holes && b.holes.length)) { toast('当前包络没有可编辑的内部封闭区域'); return; }
    state.backgroundHolePick = true;
    state.backgroundPick = false;
    state.brushOn = false;
    $('brushBar').hidden = true;
    $('btnBrush').classList.remove('active');
    state.view = 'sim';
    document.querySelectorAll('#viewTabs button').forEach(b => b.classList.toggle('active', b.dataset.view === 'sim'));
    updateBackgroundUI();
    renderStage();
    toast('点击包络内部的封闭区域，切换删除 / 恢复');
  }

  function toggleBackgroundHoleAt(evt) {
    if (state.dirty || state.analyzing || state.backgroundMode === 'off' || !state.backgroundEnvelope) {
      toast('请先计算并应用当前背景参数，再编辑内部区域'); return;
    }
    const pt = canvasPoint(evt);
    if (!pt) { toast('请等待当前计算完成后再选择内部区域'); return; }
    const x = clamp(Math.floor(pt.x), 0, pt.p.w - 1), y = clamp(Math.floor(pt.y), 0, pt.p.h - 1);
    const i = y * pt.p.w + x, id = pt.p.holeMap ? pt.p.holeMap[i] : -1;
    if (id == null || id < 0) { toast('这里不是可编辑的内部封闭区域'); return; }
    const restoring = state.backgroundHoleIds.has(id);
    if (restoring) state.backgroundHoleIds.delete(id);
    else state.backgroundHoleIds.add(id);
    markDirty(false);
    toast(restoring ? '已恢复这处内部区域，点击计算生效' : '已删除这处内部区域，点击计算生效');
  }

  function beginBackgroundPick() {
    if (!state.imageData) { toast('先导入画稿'); return; }
    state.backgroundMode = 'pick';
    state.backgroundHoleIds.clear();
    state.backgroundHolePick = false;
    markDirty(false);
    state.backgroundPick = true;
    state.brushOn = false;
    $('brushBar').hidden = true;
    $('btnBrush').classList.remove('active');
    state.view = 'original';
    document.querySelectorAll('#viewTabs button').forEach(b => b.classList.toggle('active', b.dataset.view === 'original'));
    updateBackgroundUI();
    renderStage();
    toast('请在原图上点击要移除的背景颜色');
  }

  function pickBackgroundAt(evt) {
    const pt = canvasPoint(evt);
    if (!pt) { toast('请等待当前计算完成后再取色'); return; }
    const x = clamp(Math.floor(pt.x), 0, pt.p.w - 1), y = clamp(Math.floor(pt.y), 0, pt.p.h - 1);
    const i = (y * pt.p.w + x) * 4, data = state.imageData.data;
    state.backgroundColor = C.rgbToHex(data[i], data[i + 1], data[i + 2]);
    state.backgroundMode = 'pick';
    state.backgroundPick = false;
    state.view = 'sim';
    document.querySelectorAll('#viewTabs button').forEach(b => b.classList.toggle('active', b.dataset.view === 'sim'));
    markDirty(false);
    renderStage();
    toast(`已选择背景色 ${state.backgroundColor}；点击计算生成轮廓`);
  }

  function canvasPoint(evt) {
    const p = state.plan;
    if (!p) return null;
    const canvas = $('stageCanvas');
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = (evt.clientX - rect.left) / rect.width * p.w;
    const y = (evt.clientY - rect.top) / rect.height * p.h;
    return { x, y, rect, p };
  }

  /* Manual edits are sparse persistent locks. overrideMask is only the brush
     display canvas (rebased to the final plan after every computation);
     lockMask/lockValue carry the painted positions and values across
     recomputes, image-independent of any automatic result. */
  function clearManualEdits() {
    state.overrideMask = null;
    state.lockMask = null;
    state.lockValue = null;
    state.undo = [];
  }

  function ensureBrushCanvas() {
    if (state.plan && !state.overrideMask) state.overrideMask = new Uint8Array(state.plan.flatMask);
  }

  function ensureLockArrays(p) {
    const n = p.w * p.h;
    if (!state.lockMask || state.lockMask.length !== n) { state.lockMask = new Uint8Array(n); state.lockValue = new Uint8Array(n); }
  }

  function rebaseBrushCanvas(plan) {
    // The final plan already contains every lock; the 2D mask readout must
    // show exactly that, not a stale pre-computation snapshot.
    if (state.overrideMask || state.brushOn) state.overrideMask = new Uint8Array(plan.flatMask);
  }

  function snapshotUndo() {
    ensureBrushCanvas();
    state.undo.push({
      mask: state.overrideMask ? new Uint8Array(state.overrideMask) : null,
      locks: state.lockMask ? new Uint8Array(state.lockMask) : null,
      values: state.lockValue ? new Uint8Array(state.lockValue) : null
    });
    if (state.undo.length > 14) state.undo.shift();
  }

  function applyPaint(p, cx, cy, radiusWork, val) {
    ensureBrushCanvas();
    ensureLockArrays(p);
    const x0 = Math.max(0, Math.floor(cx - radiusWork)), x1 = Math.min(p.w - 1, Math.ceil(cx + radiusWork));
    const y0 = Math.max(0, Math.floor(cy - radiusWork)), y1 = Math.min(p.h - 1, Math.ceil(cy + radiusWork));
    const r2 = radiusWork * radiusWork;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) {
          const i = y * p.w + x;
          state.overrideMask[i] = val;
          state.lockMask[i] = 1;
          state.lockValue[i] = val;
        }
      }
    }
  }

  function paintAt(evt) {
    const pt = canvasPoint(evt);
    if (!pt) return;
    const p = pt.p;
    const radiusWork = Math.max(1, (state.brushSize / 2) * (p.w / pt.rect.width));
    applyPaint(p, pt.x, pt.y, radiusWork, state.brushMode === 'flat' ? 1 : 0);
    renderStage();
  }

  function beginBrush(evt) {
    if (state.backgroundHolePick) { evt.preventDefault(); toggleBackgroundHoleAt(evt); return; }
    if (state.backgroundPick) { evt.preventDefault(); pickBackgroundAt(evt); return; }
    if (!state.brushOn || !state.plan) return;
    evt.preventDefault();
    ensureBrushCanvas();
    snapshotUndo();
    markDirty(false);
    painting = true;
    $('stageCanvas').setPointerCapture && $('stageCanvas').setPointerCapture(evt.pointerId);
    paintAt(evt);
  }

  function moveBrush(evt) {
    if (!painting) return;
    paintAt(evt);
  }

  function endBrush(evt) {
    if (!painting) return;
    painting = false;
    if (state.overrideMask) {
      state.view = 'regions';
      document.querySelectorAll('#viewTabs button').forEach(b => b.classList.toggle('active', b.dataset.view === 'regions'));
      $('layerControl').classList.add('disabled');
      markDirty(false);
    }
  }

  function undoBrush() {
    if (!state.undo.length) { toast('没有可撤销的修整'); return; }
    const u = state.undo.pop();
    state.overrideMask = u.mask;
    state.lockMask = u.locks;
    state.lockValue = u.values;
    markDirty(false);
    toast('已撤销一笔区域修整');
  }

  function clearBrush() {
    clearManualEdits();
    markDirty(false);
    toast('已清除手绘修整，回到自动分区');
  }

  /* ---------------- luminance curve editor ---------------- */
  const CURVE_PAD = 14;
  function curveToCanvas(p, W, H) { return [CURVE_PAD + p.x * (W - 2 * CURVE_PAD), H - CURVE_PAD - p.y * (H - 2 * CURVE_PAD)]; }
  function canvasToCurve(cx, cy, W, H) { return { x: clamp((cx - CURVE_PAD) / (W - 2 * CURVE_PAD), 0, 1), y: clamp((H - CURVE_PAD - cy) / (H - 2 * CURVE_PAD), 0, 1) }; }
  function renderCurveEditor() {
    const c = $('luminanceCurve'); if (!c || !c.getContext) return;
    const ctx = c.getContext('2d'), W = c.width, H = c.height, pad = CURVE_PAD;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#1c2328'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) { const gx = pad + g / 4 * (W - 2 * pad), gy = H - pad - g / 4 * (H - 2 * pad); ctx.beginPath(); ctx.moveTo(gx, pad); ctx.lineTo(gx, H - pad); ctx.stroke(); ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(W - pad, gy); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.moveTo(pad, H - pad); ctx.lineTo(W - pad, pad); ctx.stroke();
    const pts = state.luminanceCurve.slice().sort((a, b) => a.x - b.x);
    const evalC = CS.heightCurve ? CS.heightCurve.evalCurve : (p, x) => x;
    ctx.strokeStyle = '#d8a53a'; ctx.lineWidth = 2; ctx.beginPath();
    for (let px = 0; px <= W - 2 * pad; px++) { const x = px / (W - 2 * pad); const y = evalC(pts, x); const cx = pad + px, cy = H - pad - y * (H - 2 * pad); if (px === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy); }
    ctx.stroke();
    for (const p of pts) { const [cx, cy] = curveToCanvas(p, W, H); ctx.fillStyle = '#ffe16b'; ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#1c2328'; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '9px sans-serif';
    ctx.fillText('暗', pad, H - 3); ctx.fillText('亮', W - pad - 9, H - 3); ctx.fillText('高', 2, pad + 3); ctx.fillText('低', 2, H - pad);
  }
  function bindCurveEditor() {
    const c = $('luminanceCurve'); if (!c) return;
    const W = c.width, H = c.height;
    let dragPt = null;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)]; };
    const hit = (mx, my) => { for (const p of state.luminanceCurve) { const [cx, cy] = curveToCanvas(p, W, H); if (Math.hypot(mx - cx, my - cy) < 8) return p; } return null; };
    c.addEventListener('mousedown', (e) => {
      const [mx, my] = pos(e); dragPt = hit(mx, my);
      if (!dragPt) { dragPt = canvasToCurve(mx, my, W, H); state.luminanceCurve.push(dragPt); state.luminanceCurve.sort((a, b) => a.x - b.x); renderCurveEditor(); markDirty(false); }
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragPt) return;
      const [mx, my] = pos(e); const p = canvasToCurve(mx, my, W, H);
      dragPt.x = p.x; dragPt.y = p.y; state.luminanceCurve.sort((a, b) => a.x - b.x); renderCurveEditor();
    });
    window.addEventListener('mouseup', () => { if (dragPt) { dragPt = null; markDirty(false); } });
    c.addEventListener('dblclick', (e) => {
      const [mx, my] = pos(e); const p = hit(mx, my);
      if (p && state.luminanceCurve.length > 2) { state.luminanceCurve.splice(state.luminanceCurve.indexOf(p), 1); renderCurveEditor(); markDirty(false); }
    });
    const preset = (fn) => () => { state.luminanceCurve = fn(); renderCurveEditor(); markDirty(false); };
    if ($('curvePresetInvert')) $('curvePresetInvert').addEventListener('click', preset(() => CS.heightCurve.invertCurve()));
    if ($('curvePresetLinear')) $('curvePresetLinear').addEventListener('click', preset(() => CS.heightCurve.defaultCurve()));
    if ($('curvePresetContrast')) $('curvePresetContrast').addEventListener('click', preset(() => CS.heightCurve.contrastCurve()));
  }

  /* ---------------- events ---------------- */
  function bindEvents() {
    $('btnOpenImage').addEventListener('click', () => $('fileInput').click());
    $('btnEmptyImport').addEventListener('click', () => $('fileInput').click());
    $('dropZone').addEventListener('click', (e) => { if (!e.target.closest('.sample-btn')) $('fileInput').click(); });
    $('fileInput').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const url = URL.createObjectURL(f);
      loadImageURL(url, f.name.replace(/\.[^.]+$/, ''), url, false);
    });
    ['dragenter', 'dragover'].forEach(ev => $('dropZone').addEventListener(ev, (e) => { e.preventDefault(); $('dropZone').classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => $('dropZone').addEventListener(ev, (e) => { e.preventDefault(); $('dropZone').classList.remove('drag'); }));
    $('dropZone').addEventListener('drop', (e) => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f || !f.type.startsWith('image/')) return;
      const url = URL.createObjectURL(f);
      loadImageURL(url, f.name.replace(/\.[^.]+$/, ''), url, false);
    });
    document.querySelectorAll('[data-sample]').forEach(btn => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      loadImageURL(btn.dataset.sample, '油画风景', 'samples/landscape-thumb.jpg', true);
    }));
    $('btnSyntheticSample').addEventListener('click', (e) => { e.stopPropagation(); makeSyntheticSample(); });

    document.querySelectorAll('#engineSwitch button').forEach(b => b.addEventListener('click', () => setEngine(b.dataset.engine)));
    $('lutSelect').addEventListener('change', (e) => { state.lutKey = e.target.value; clearManualEdits(); renderPalette(); markDirty(false); });
    $('widthMm').addEventListener('input', (e) => {
      state.widthMm = clamp(Number(e.target.value) || 150, 40, 400);
      state.backgroundHoleIds.clear(); state.backgroundHolePick = false;
      markDirty(false);
    });
    $('flatTopMm').addEventListener('input', (e) => { state.flatTopMm = clamp(Number(e.target.value) || 1.6, 0.4, 8); markDirty(false); });
    $('reliefMm').addEventListener('input', (e) => { state.reliefMm = clamp(Number(e.target.value) || 0, -1, 1); state.gradStartOverride = null; state.gradTopMmOverride = null; markDirty(false); });
    $('gradStartLayer').addEventListener('input', (e) => { state.gradStartOverride = clamp(Number(e.target.value) || 1, 1, 240); markDirty(false); });
    $('gradTopMm').addEventListener('input', (e) => { state.gradTopMmOverride = clamp(Number(e.target.value) || 0.8, 0.08, 20); state.gradStartOverride = clamp(Number($('gradStartLayer').value) || 1, 1, 240); markDirty(false); });
    $('variableHeight').addEventListener('change', (e) => { state.variableHeight = !!e.target.checked; markDirty(false); });
    $('geometryMode').addEventListener('change', (e) => { state.geometryMode = ['flat', 'luminance'].includes(e.target.value) ? e.target.value : 'relief'; if ($('luminanceCurveField')) $('luminanceCurveField').hidden = state.geometryMode !== 'luminance'; if (state.geometryMode === 'luminance') renderCurveEditor(); markDirty(false); });
    $('qualityPolicy').addEventListener('change', (e) => { state.qualityPolicy = e.target.value; markDirty(false); });
    bindCurveEditor();
    $('layerHeight').addEventListener('change', (e) => {
      if (state.engine !== 'td') return;
      const next = Number(e.target.value) || 0.08;
      if (state.plan) {
        // Keep the physical start/top heights when changing layer thickness;
        // layer counts are derived again at the new thickness.
        const startMm = state.plan.gradStartLayer * state.plan.layerHeight;
        const topMm = state.plan.gradTopMm;
        state.layerHeight = next;
        state.gradStartOverride = Math.max(1, Math.round(startMm / next));
        state.gradTopMmOverride = topMm;
      } else {
        state.layerHeight = next;
        state.gradTopMmOverride = null;
      }
      markDirty(false);
    });
    $('gradLayers').addEventListener('input', (e) => { state.gradLayers = clamp(Number(e.target.value) || 6, 1, 24); state.gradTopMmOverride = null; markDirty(false); });
    $('foundationSelect').addEventListener('change', (e) => { state.foundationIndex = Number(e.target.value) || 0; markDirty(false); });
    $('backgroundMode').addEventListener('change', e => {
      const mode = ['off', 'auto', 'pick'].includes(e.target.value) ? e.target.value : 'off';
      state.backgroundMode = mode;
      state.backgroundPick = false;
      state.backgroundHolePick = false;
      state.backgroundHoleIds.clear();
      if (mode === 'pick') beginBackgroundPick();
      else markDirty(false);
    });
    $('backgroundTolerance').addEventListener('input', e => {
      state.backgroundTolerance = clamp(Number(e.target.value) || 8, 1, 30);
      state.backgroundHoleIds.clear(); state.backgroundHolePick = false;
      markDirty(false);
    });
    $('backgroundTolerance').addEventListener('change', e => { e.target.value = String(state.backgroundTolerance); });
    $('backgroundEnvelope').addEventListener('change', e => {
      state.backgroundEnvelope = !!e.target.checked;
      state.backgroundHoleIds.clear(); state.backgroundHolePick = false;
      markDirty(false);
    });
    $('backgroundEnvelopeMm').addEventListener('input', e => {
      state.backgroundEnvelopeMm = clamp(Number(e.target.value) || 1.5, 0.2, 10);
      state.backgroundHoleIds.clear(); state.backgroundHolePick = false;
      markDirty(false);
    });
    $('backgroundEnvelopeMm').addEventListener('change', e => { e.target.value = state.backgroundEnvelopeMm.toFixed(1); });
    $('btnPickBackground').addEventListener('click', beginBackgroundPick);
    $('btnBackgroundHole').addEventListener('click', beginBackgroundHolePick);

    $('stdThreshold').addEventListener('input', (e) => {
      state.stdThreshold = Number(e.target.value);
      $('stdValue').textContent = state.stdThreshold > 0 ? state.stdThreshold.toFixed(1) : '自动';
      markDirty(false);
    });
    $('residualThreshold').addEventListener('input', (e) => {
      state.residualThreshold = Number(e.target.value);
      $('resValue').textContent = state.residualThreshold.toFixed(1) + ' ΔE';
      markDirty(false);
    });
    $('minFlatPercent').addEventListener('input', (e) => {
      state.minFlatPercent = Number(e.target.value);
      $('areaValue').textContent = state.minFlatPercent.toFixed(1) + '%';
      markDirty(false);
    });
    $('smoothMm').addEventListener('input', (e) => {
      state.smoothMm = clamp(Number(e.target.value) || 0, 0, 3);
      markDirty(false);
    });
    $('smoothMm').addEventListener('change', (e) => {
      e.target.value = state.smoothMm.toFixed(1);
    });
    const workRes = $('workRes');
    workRes.value = String(workMax);
    $('workResValue').textContent = workMax + 'px';
    workRes.addEventListener('change', (e) => {
      const next = Number(e.target.value) || WORK_RESOLUTIONS[0];
      workMax = WORK_RESOLUTIONS.includes(next) ? next : WORK_RESOLUTIONS[0];
      $('workResValue').textContent = workMax + 'px';
      if (!state.sourceImage) {
        if (state.imageData) toast('当前画布不是文件图片，重新导入图片后分辨率档位才对它生效');
        return;
      }
      const name = state.imageName;
      setImage(state.sourceImage, name);
    });
    $('lineWidthMm').addEventListener('input', (e) => {
      state.lineWidthMm = clamp(Number(e.target.value) || 0.42, 0.2, 1.2);
      $('lineWidthHint').textContent = `平滑 ≥ ${(state.lineWidthMm * 2).toFixed(2)} mm`;
      markDirty(false);
    });
    $('mergeDeltaE').addEventListener('input', (e) => {
      state.mergeDeltaE = clamp(Number(e.target.value) || 0, 0, 10);
      $('mergeValue').textContent = state.mergeDeltaE > 0 ? state.mergeDeltaE.toFixed(1) : '关';
      markDirty(false);
    });
    $('heightMergeDeltaE').addEventListener('input', (e) => {
      state.heightMergeDeltaE = clamp(Number(e.target.value) || 0, 0, 5);
      $('heightMergeValue').textContent = state.heightMergeDeltaE > 0 ? state.heightMergeDeltaE.toFixed(1) : '关';
      markDirty(false);
    });
    $('edgeClean').addEventListener('input', (e) => {
      state.edgeClean = clamp(Number(e.target.value) || 0, 0, 3);
      $('edgeCleanValue').textContent = ['关', '轻 1', '中 2', '强 3'][state.edgeClean];
      markDirty(false);
    });
    $('vectorFlat').addEventListener('change', (e) => {
      state.vectorFlat = !!e.target.checked;
      markDirty(false);
    });
    $('lineProtect').addEventListener('change', (e) => {
      state.lineProtect = ['auto', 'strong', 'off'].includes(e.target.value) ? e.target.value : 'auto';
      markDirty(false);
    });
    $('families').addEventListener('input', (e) => {
      state.families = Number(e.target.value);
      $('familiesValue').textContent = String(state.families);
      markDirty(false);
    });
    $('btnAnalyze').addEventListener('click', () => analyze());
    $('btnAnalyzeStage').addEventListener('click', () => analyze());
    $('btnResetSettings').addEventListener('click', resetSettings);
    $('useMode').addEventListener('change', (e) => {
      const id = e.target.value;
      state.useMode = id;
      const patch = CS.modes.preset(id);
      if (patch) {
        Object.assign(state, patch);
        syncControlsFromState();
        markDirty(false);
        toast(CS.modes.label(id) + ' 预设已应用，点「应用并计算」生效');
      }
    });
    const markModeCustom = () => {
      if (state.useMode === 'custom') return;
      state.useMode = 'custom';
      if ($('useMode')) $('useMode').value = 'custom';
    };
    for (const ev of ['input', 'change']) {
      document.addEventListener(ev, (e) => {
        const t = e.target;
        if (!t || !t.matches) return;
        if (t.matches('#lineProtect,#vectorFlat,#edgeClean,#smoothMm,#reliefMm,#minFlatPercent,#families,#variableHeight,#gradLayers')) markModeCustom();
      });
    }
    $('profileSelect').addEventListener('change', e => switchProfile(e.target.value));
    if ($('profileSyncStatus')) $('profileSyncStatus').addEventListener('click', resolveProfileConflict);
    $('btnNewProfile').addEventListener('click', createProfile);
    if ($('btnRestoreBackup')) $('btnRestoreBackup').addEventListener('click', restoreCalibrationBackup);
    $('btnRenameProfile').addEventListener('click', renameProfile);
    $('btnDeleteProfile').addEventListener('click', deleteProfile);

    document.querySelectorAll('#viewTabs button').forEach(b => b.addEventListener('click', () => {
      state.view = b.dataset.view;
      if (state.view === 'three' && state.brushOn) {
        state.brushOn = false;
        $('brushBar').hidden = true;
        $('btnBrush').classList.remove('active');
      }
      document.querySelectorAll('#viewTabs button').forEach(x => x.classList.toggle('active', x === b));
      $('layerControl').classList.toggle('disabled', state.view !== 'layer');
      if (state.view !== 'three') renderLegend(state.plan);
      renderStage();
    }));
    $('layerSlider').addEventListener('input', (e) => {
      state.layer = Number(e.target.value) || 0;
      $('layerNumber').textContent = String(state.layer + 1);
      renderLegend(state.plan);
      renderStage();
    });
    $('btnBrush').addEventListener('click', () => {
      if (!state.plan) { toast('先完成一次分析'); return; }
      state.brushOn = !state.brushOn;
      state.view = state.brushOn ? 'regions' : state.view;
      document.querySelectorAll('#viewTabs button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
      $('brushBar').hidden = !state.brushOn;
      $('btnBrush').classList.toggle('active', state.brushOn);
      $('layerControl').classList.toggle('disabled', state.view !== 'layer');
      renderStage();
    });
    document.querySelectorAll('#brushBar [data-brush]').forEach(b => b.addEventListener('click', () => {
      state.brushMode = b.dataset.brush;
      document.querySelectorAll('#brushBar [data-brush]').forEach(x => x.classList.toggle('active', x === b));
    }));
    $('brushSize').addEventListener('input', (e) => state.brushSize = Number(e.target.value) || 18);
    $('btnUndoBrush').addEventListener('click', undoBrush);
    $('btnClearBrush').addEventListener('click', clearBrush);
    const stageCanvas = $('stageCanvas');
    stageCanvas.addEventListener('pointerdown', beginBrush);
    stageCanvas.addEventListener('pointermove', moveBrush);
    stageCanvas.addEventListener('pointerup', endBrush);
    stageCanvas.addEventListener('pointercancel', endBrush);
    stageCanvas.addEventListener('lostpointercapture', endBrush);

    $('paletteList').addEventListener('input', (e) => {
      const hexIdx = e.target.dataset.hex;
      const tdIdx = e.target.dataset.td;
      const trIdx = e.target.dataset.tdr, tgIdx = e.target.dataset.tdg, tbIdx = e.target.dataset.tdb;
      if (hexIdx != null) {
        const i = Number(hexIdx);
        if (state.tdPalette[i]) {
          state.tdPalette[i].hex = e.target.value;
          markDirty(false);
        }
      } else if (trIdx != null || tgIdx != null || tbIdx != null) {
        const i = Number(trIdx != null ? trIdx : (tgIdx != null ? tgIdx : tbIdx));
        if (state.tdPalette[i]) {
          const p = state.tdPalette[i];
          const cur = { R: p.tdR != null ? p.tdR : p.td, G: p.tdG != null ? p.tdG : p.td, B: p.tdB != null ? p.tdB : p.td };
          const channel = trIdx != null ? 'R' : (tgIdx != null ? 'G' : 'B');
          cur[channel] = clamp(Number(e.target.value) || 5, 0.1, 20);
          p.tdR = cur.R; p.tdG = cur.G; p.tdB = cur.B;
          p.td = 0.2126 * p.tdR + 0.7152 * p.tdG + 0.0722 * p.tdB;
          markDirty(false);
        }
      } else if (tdIdx != null) {
        const i = Number(tdIdx);
        if (state.tdPalette[i]) {
          const v = clamp(Number(e.target.value) || 5, 0.1, 20);
          // Manual single-value edit overrides the per-channel calibration.
          Object.assign(state.tdPalette[i], CS.settings.uniformTd(v));
          markDirty(false);
        }
      }
    });
    $('paletteList').addEventListener('click', (e) => {
      const remove = e.target.closest('[data-remove]');
      if (!remove) return;
      const i = Number(remove.dataset.remove);
      state.tdPalette.splice(i, 1);
      state.foundationIndex = clamp(state.foundationIndex, 0, Math.max(0, state.tdPalette.length - 1));
      renderPalette();
      markDirty(false);
    });
    $('btnAddFilament').addEventListener('click', () => openLibrary());
    document.querySelectorAll('[data-quick]').forEach(b => b.addEventListener('click', () => quickAddFilament(b.dataset.quick)));
    $('btnApplyGamut').addEventListener('click', applyGamutSuggestion);
    $('btnRecommend').addEventListener('click', recommendPalette);

    $('btnExport3MF').addEventListener('click', export3MF);
    $('btnExportPreview').addEventListener('click', exportPreview);
    $('btnExportPlan').addEventListener('click', exportPlanBundle);
    $('btnCalibrate').addEventListener('click', openCalibration);
    $('btnComputeCalib').addEventListener('click', computeCalibration);
    $('btnBatchPlate').addEventListener('click', downloadBatchPlate);
    $('btnComboPlate').addEventListener('click', downloadComboPlate);
    $('btnComboImport').addEventListener('click', () => $('comboObsInput').click());
    $('comboObsInput').addEventListener('change', e => { importComboObservations(e.target.files[0]); e.target.value = ''; });
    $('btnComboPublish').addEventListener('click', publishComboModel);
    $('btnPhotoCalibration').addEventListener('click', () => $('batchPhotoInput').click());
    $('batchPhotoInput').addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      analyzeBatchPhotoFile(file);
    });
    $('btnMatrixPhoto').addEventListener('click', () => $('matrixPhotoInput').click());
    $('matrixPhotoInput').addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      analyzeMatrixPhotoFile(file);
    });
    $('btnApplyBatchPhoto').addEventListener('click', applyBatchPhoto);
    $('btnDownloadCalib').addEventListener('click', downloadCalibration);
    $('btnHelp').addEventListener('click', () => openModal('helpModal'));

    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
    document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', (e) => { if (e.target === m) closeModal(m.id); }));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.querySelectorAll('.modal:not([hidden])').forEach(m => closeModal(m.id));
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && state.brushOn) { e.preventDefault(); undoBrush(); }
    });

    $('librarySearch').addEventListener('input', (e) => { state.librarySearch = e.target.value; renderLibrary(); });
    document.querySelectorAll('#libraryFilters .chip').forEach(b => b.addEventListener('click', () => {
      state.libraryFilter = b.dataset.brand;
      document.querySelectorAll('#libraryFilters .chip').forEach(x => x.classList.toggle('active', x === b));
      renderLibrary();
    }));
    $('libraryList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-add]');
      if (!btn) return;
      const entry = CS.FILAMENT_DB.filaments.find(f => f.id === btn.dataset.add);
      if (!entry) return;
      const ok = addFilamentToTd(entry);
      if (ok) {
        if (state.engine === 'lut') setEngine('td', false);
        renderPalette();
        markDirty(false);
        toast(`已加入 ${entry.brand} ${entry.name}`);
      }
    });
  }

  /* ---------------- library ---------------- */
  function openLibrary() {
    renderLibrary();
    openModal('libraryModal');
    setTimeout(() => $('librarySearch').focus(), 30);
  }

  function renderLibrary() {
    const list = $('libraryList');
    const q = state.librarySearch.trim().toLowerCase();
    const brand = state.libraryFilter;
    const all = CS.FILAMENT_DB.filaments;
    const zh = {
      'black': '黑', 'white': '白', 'jade white': '玉白 白玉', 'red': '红', 'yellow': '黄',
      'blue': '蓝', 'cyan': '青 青色', 'magenta': '品红 洋红 洋红色', 'green': '绿',
      'bambulab green': '绿', 'gray': '灰', 'grey': '灰', 'blue gray': '蓝灰',
      'brown': '棕 棕褐', 'orange': '橙', 'pink': '粉', 'beige': '米色', 'silver': '银'
    };
    const filtered = all.filter(f => {
      if (brand && f.brand !== brand) return false;
      if (!q) return true;
      const hay = (f.name + ' ' + f.brand + ' ' + f.material + ' ' + f.hex + ' ' + (zh[f.name.toLowerCase()] || '')).toLowerCase();
      return hay.includes(q);
    });
    const shown = filtered.slice(0, 400);
    $('libraryCount').textContent = `${filtered.length} 条结果${filtered.length > shown.length ? '（显示前 400）' : ''} · 库 ${all.length} 条`;
    list.innerHTML = shown.map(f => `<div class="library-row">
      <span class="swatch-wrap" style="background:${esc(f.hex)}"></span>
      <span class="lib-name">${esc(f.brand)} · ${esc(f.name)}<small>${esc(f.material)} · ${esc(f.hex)}</small></span>
      <span class="lib-td">TD ${f.td != null ? f.td : '—'}</span>
      <button class="btn small" data-add="${esc(f.id)}">加入</button>
    </div>`).join('') || '<div class="placeholder-small">没有匹配的耗材。</div>';
  }

  /* ---------------- export ---------------- */
  function setExportEnabled(on) {
    ['btnExport3MF', 'btnExportPreview', 'btnExportPlan'].forEach(id => $(id).disabled = !on);
  }

  function filenameBase(plan) {
    const p = plan || state.plan;
    if (!p) return '叠彩_未计算';
    return `叠彩_${p.engine === 'lut' ? 'LUT' : 'TD'}_${Math.round(p.widthMm)}x${Math.round(p.heightMm)}mm`;
  }

  // F-OUTLINE-02: render the ACTUAL export grid top surface (not the native preview),
  // so the user sees exactly what the 3MF will contain after downsampling.
  function exportPreviewPlan(p) {
    const grid = X.exportGridFor(p);
    const plane = X.samplePlane(p, grid.width, grid.height);
    const ew = grid.width, eh = grid.height, n = ew * eh;
    const out = new Uint8ClampedArray(n * 4);
    const tops = new Int32Array(n);
    const zSet = new Set();
    for (let i = 0; i < n; i++) {
      let top = null;
      if (plane.luminanceHeight && plane.topLayer) top = plane.topLayer[i];
      if (top == null && plane.regionRecipes && plane.regionOf) { const rr = plane.regionRecipes[plane.regionOf[i]]; if (rr) top = p.gradStartLayer + rr.length; }
      if (top == null) { if (p.equalHeight) top = p.commonTopLayer; else if (plane.flatMask[i]) top = p.flatLayers; else { const f = plane.familyId[i]; top = p.gradStartLayer + (f >= 0 ? p.families[f].recipe.length : 0); } }
      tops[i] = top;
      if (plane.printMask && !plane.printMask[i]) continue;
      if (top > 0) zSet.add(top - 1);
    }
    const masksByZ = {};
    for (const z of zSet) masksByZ[z] = X.buildLayerMasks(p, plane, z);
    for (let i = 0; i < n; i++) {
      if (plane.printMask && !plane.printMask[i]) continue;
      const masks = masksByZ[tops[i] - 1]; if (!masks) continue;
      for (let f = 0; f < p.palette.length; f++) if (masks[f][i]) { const c = C.hexToRgb(p.palette[f].hex); out[i * 4] = c.r; out[i * 4 + 1] = c.g; out[i * 4 + 2] = c.b; out[i * 4 + 3] = 255; break; }
    }
    return { width: ew, height: eh, data: out };
  }

  // F-OUTLINE-02: pre-export confirmation describing the downsample change. Native
  // (line-art) exports return null — no confirmation needed.
  function exportConfirmMessage(p) {
    const grid = X.exportGridFor(p);
    if (!grid.downscaled) return null;
    const rep = X.exportReport(p);
    const changed = rep.change ? rep.change.changedPercent : null;
    return `导出将把长边缩到 ${grid.width}×${grid.height}（工作网格 ${p.w}×${p.h}）${changed == null ? '' : `，约 ${changed}% 源像素被重新归类`}。未保护的细线可能变细/消失、窄白缝可能合并。建议先点“导出预览”核对最终导出网格，或开启线稿保护以原生分辨率导出。确认继续导出？`;
  }

  /* PERF3: parallel 3MF export. Meshing is independent per prism, so a pool of
     mesh-workers meshes contiguous chunks off the main thread; the shared
     assemble3MFParts then builds byte-identical XML/config. Falls back to the serial
     async export if workers are unavailable or fail. */
  let meshPool = null, meshTaskId = 0;
  function getMeshPool() {
    if (meshPool) return meshPool;
    const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    const workers = [];
    for (let i = 0; i < n; i++) {
      try { workers.push(new Worker(workerUrl('mesh-worker.js'))); }
      catch (e) { for (const w of workers) { try { w.terminate(); } catch (_) {} } e.workerStartup = true; throw e; }
    }
    meshPool = { workers, n };
    return meshPool;
  }
  // R7: a stuck/dead mesh worker must not be reused forever (the old persistent pool
  // hung subsequent exports). Reset on failure so the next export spawns fresh workers.
  function resetMeshPool() {
    if (!meshPool) return;
    for (const w of meshPool.workers) { try { w.terminate(); } catch (e) { /* ignore */ } }
    meshPool = null;
  }
  function runMeshChunk(pool, slot, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const worker = pool.workers[slot];
      const id = ++meshTaskId;
      let settled = false;
      const cleanup = () => { clearTimeout(timer); worker.removeEventListener('message', onMsg); worker.removeEventListener('error', onErr); };
      const timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); const err = new Error('网格化 worker 超时'); err.meshTimeout = true; reject(err); }, timeoutMs || 120000);
      const onMsg = (e) => { const d = e.data || {}; if (d.id !== id || settled) return; settled = true; cleanup(); if (d.ok) resolve(d.objects); else { const err = new Error(d.error || 'mesh failed'); err.meshRuntime = true; reject(err); } };
      const onErr = (e) => { if (settled) return; settled = true; cleanup(); const err = new Error((e && e.message) || 'mesh worker error'); err.meshRuntime = true; reject(err); };
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', onErr);
      const transfer = payload.tasks.map(t => t.mask.buffer);
      try { worker.postMessage(Object.assign({ id }, payload), transfer); }
      catch (e) { if (!settled) { settled = true; cleanup(); e.meshRuntime = true; reject(e); } }
    });
  }
  // R7: assembly + zip run in a dedicated worker so the main thread never builds the
  // (potentially millions of lines of) vertex/triangle XML. Objects are transferred
  // zero-copy; the plan is stripped to metadata via litePlan.
  let exportWorker = null, exportTaskId = 0;
  // Review P2: create/verify the export worker BEFORE meshing (preflight). A late
  // constructor failure after mesh work is done must not be classed as a startup
  // failure (which would discard finished meshing and redo everything serially).
  function preflightExportWorker() {
    if (exportWorker) return;
    try { exportWorker = new Worker(workerUrl('export-worker.js')); }
    catch (e) { e.workerStartup = true; throw e; }
  }
  function runExportWorker(p, rawObjects, grid, plane, ew, eh, pixelSize) {
    return new Promise((resolve, reject) => {
      if (!exportWorker) { const e = new Error('export worker unavailable after preflight'); e.assemblyRuntime = true; reject(e); return; }
      const w = exportWorker;
      const id = ++exportTaskId;
      let settled = false;
      const drop = () => { try { w.terminate(); } catch (e) { /* ignore */ } exportWorker = null; };
      const cleanup = () => { clearTimeout(timer); w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); };
      const timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); drop(); const err = new Error('3MF 组装超时'); err.exportTimeout = true; reject(err); }, 180000);
      const onMsg = (e) => { const d = e.data || {}; if (d.id !== id || settled) return; settled = true; cleanup(); if (d.ok) resolve(d); else { const err = new Error(d.error || '3MF assembly failed'); err.assemblyRuntime = true; reject(err); } };
      const onErr = (e) => { if (settled) return; settled = true; cleanup(); drop(); const err = new Error((e && e.message) || 'export worker error'); err.assemblyRuntime = true; reject(err); };
      w.addEventListener('message', onMsg);
      w.addEventListener('error', onErr);
      const objects = rawObjects.map(o => ({ filament: o.filament, name: o.name, positions: o.positions.buffer, indices: o.indices.buffer }));
      const transfer = []; for (const o of objects) { transfer.push(o.positions, o.indices); }
      const msg = { id, plan: X.litePlan(p), objects, grid: { downscaled: grid.downscaled }, plane: { changeStats: plane.changeStats }, ew, eh, pixelSize };
      try { w.postMessage(msg, transfer); }
      catch (e) { if (!settled) { settled = true; cleanup(); e.assemblyRuntime = true; reject(e); } }
    });
  }
  async function build3MFParallel(p, options) {
    const grid = X.exportGridFor(p, options && options.exportMax);
    const ew = grid.width, eh = grid.height;
    const plane = X.samplePlane(p, ew, eh);
    const pixelSize = p.widthMm / ew;
    const prisms = X.buildPrisms(p, plane);
    const tasks = [];
    for (let f = 0; f < p.palette.length; f++) for (const pr of prisms[f]) tasks.push({ f, mask: pr.mask, z0: pr.z0, z1: pr.z1 });
    if (!tasks.length) throw new Error('没有可导出的几何体（检查纯色区/渐变区层数）');
    const pool = getMeshPool();
    preflightExportWorker(); // before any mesh task: a startup failure here is a true preflight failure
    const paletteLite = p.palette.map(pp => ({ name: pp.name, hex: pp.hex }));
    // E2 (export review): dynamic task queue instead of static equal-count chunks.
    // Static chunking handed one worker all the heavy black/white prisms while the
    // others idled (2x: 11s vs 40.7s; 4x: timeout). Workers pull the next task as they
    // finish; results are stored by original index so object order/bytes stay identical.
    const results = new Array(tasks.length);
    let nextTask = 0;
    const workerLoop = (slot) => (async () => {
      for (;;) {
        const i = nextTask++;
        if (i >= tasks.length) return;
        results[i] = await runMeshChunk(pool, slot, { palette: paletteLite, layerHeight: p.layerHeight, ew, eh, pixelSize, tasks: [tasks[i]] }, 120000);
      }
    })();
    try {
      await Promise.all(pool.workers.map((_, slot) => workerLoop(slot)));
    } catch (e) { resetMeshPool(); throw e; }
    const rawObjects = [];
    for (const r of results) if (r) for (const o of r) rawObjects.push(o);
    const out = await runExportWorker(p, rawObjects, grid, plane, ew, eh, pixelSize);
    // Streaming worker returns a lazy Blob; buffered compat returns bytes. Wrap either.
    const blob = new Blob([out.blob || out.bytes], { type: 'model/3mf' });
    return { blob, meta: out.meta, ew, eh, pixelSize, exportDownscaled: grid.downscaled, exportChange: plane.changeStats };
  }

  function export3MF() {
    const p = state.plan;
    if (!p || state.dirty || state.analyzing) { toast('请先计算并应用当前修改'); return; }
    // F-OUTLINE-02: confirm before exporting a downscaled grid so the user knows the
    // export may differ from the native preview (thin lines / narrow gaps).
    const confirmMsg = exportConfirmMessage(p);
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    showProgress('正在生成水密 3MF…');
    setTimeout(async () => {
      try {
        // The started export intentionally uses the clicked plan snapshot even
        // if the user keeps editing; later edits never change its content/name.
        // PERF3: mesh across a worker pool (off the main thread). E3 (export review):
        // a task timeout must NOT trigger a full serial recompute from scratch (that
        // discards finished work and re-stalls the UI). Only worker-unsupported /
        // startup failures fall back to the serial compat path.
        let out;
        if (typeof Worker !== 'undefined' && location.protocol !== 'file:') {
          try { out = await build3MFParallel(p); }
          catch (e) {
            // F-EXP-02: only a Worker-unsupported / startup failure uses the serial
            // compat path. Any failure AFTER processing started (mesh/assembly runtime
            // error, worker error, timeout) must stop — a full serial recompute would
            // discard finished work and re-stall the main thread. Errors are classified
            // at their source (workerStartup / meshRuntime / assemblyRuntime / *Timeout).
            if (e && e.workerStartup) {
              console.warn('Worker 不可用，回退串行兼容导出', e);
              out = await X.build3MFBlobAsync(p);
            } else {
              console.warn('导出失败，停止（不整单重算）', e);
              const stage = e && e.meshTimeout ? '网格化超时' : e && e.exportTimeout ? '组装超时' : e && e.meshRuntime ? '网格化' : e && e.assemblyRuntime ? '组装/压缩' : '导出';
              toast(`3MF ${stage}失败：${(e && e.message) || e}。请降低精度（如 2× 而非 4×）或减小成品尺寸后重试。`);
              return;
            }
          }
        } else {
          out = await X.build3MFBlobAsync(p);
        }
        downloadBlob(out.blob, filenameBase(p) + '.3mf');
        const g = X.exportGridFor(p);
        const changed = out.exportChange ? out.exportChange.changedPercent : null;
        toast(g.downscaled
          ? `3MF 导出网格 ${g.width}×${g.height}（工作 ${p.w}×${p.h}）${changed == null ? '' : `；约 ${changed}% 源像素被重新归类`}，细节以切片预览为准。`
          : `3MF 已按 ${p.w}×${p.h} 原生网格生成；导入切片器后核对耗材槽位。`);
      } catch (e) {
        console.error(e);
        toast('3MF 导出失败：' + (e.message || e));
      } finally { hideProgress(); }
    }, 30);
  }

  function exportPreview() {
    const p = state.plan;
    if (!p || state.dirty || state.analyzing) { toast('请先计算并应用当前修改'); return; }
    // F-OUTLINE-02: preview the FINAL export grid, not the native preview.
    const pv = exportPreviewPlan(p);
    const c = document.createElement('canvas');
    c.width = pv.width; c.height = pv.height;
    c.getContext('2d').putImageData(new ImageData(pv.data, pv.width, pv.height), 0, 0);
    c.toBlob((blob) => { if (blob) downloadBlob(blob, filenameBase(p) + '_导出预览.png'); }, 'image/png');
  }

  async function exportPlanBundle() {
    const p = state.plan;
    if (!p || state.dirty || state.analyzing) { toast('请先计算并应用当前修改'); return; }
    showProgress('正在打包打印计划…');
    try {
      const base = filenameBase(p);
      const files = [];
      files.push({ name: 'print_plan.json', data: JSON.stringify(X.planSummary(p), null, 2) });
      files.push({ name: 'export_report.json', data: JSON.stringify(X.exportReport(p), null, 2) });
      files.push({ name: 'print_plan.md', data: X.buildPlanMarkdown(p) });
      const prev = document.createElement('canvas');
      prev.width = p.w; prev.height = p.h;
      prev.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(p.preview), p.w, p.h), 0, 0);
      files.push({ name: 'preview.png', data: new Uint8Array(await canvasBlob(prev).then(b => b.arrayBuffer())) });
      const region = buildRegionMapCanvas(p);
      files.push({ name: 'region_map.png', data: new Uint8Array(await canvasBlob(region).then(b => b.arrayBuffer())) });
      for (let z = 0; z < p.maxLayers; z++) {
        const c = buildLayerCanvas(p, z, p.flatMask);
        const blob = await canvasBlob(c);
        files.push({ name: `layer_maps/L${String(z + 1).padStart(3, '0')}_z${(z * p.layerHeight).toFixed(2)}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
        if (z % 8 === 0) await new Promise(r => setTimeout(r, 0));
      }
      files.push({ name: 'README.txt', data: printPlanReadme(p) });
      const bytes = CS.zip.createZip(files);
      downloadBlob(new Blob([bytes], { type: 'application/zip' }), base + '_打印计划.zip');
      toast('打印计划包已生成');
    } catch (e) {
      console.error(e);
      toast('计划包导出失败：' + (e.message || e));
    } finally { hideProgress(); }
  }

  function regionMapHex(p, i) {
    if (p.printMask && !p.printMask[i]) return '#1c2328';
    // F04: the region map shows the FINAL colour, not pre-coordination family data.
    if (p.flatMask[i]) {
      // coordinated flat regions may top out in a different material than nominal
      const top = actualTopLayer(p, i, p.flatMask);
      const fi = CS.engine.filamentAt(p, i % p.w, (i / p.w) | 0, Math.max(0, top - 1));
      if (fi >= 0) return p.palette[fi].hex;
      return p.palette[p.flatFilament[i] !== 0xffff ? p.flatFilament[i] : p.nearest[i]].hex;
    }
    if (p.predicted && p.predicted[i]) return p.predicted[i].hex;
    const f = p.familyId[i];
    return f >= 0 ? p.families[f].predictedHex : '#1c2328';
  }

  function buildRegionMapCanvas(p) {
    const out = new Uint8ClampedArray(p.w * p.h * 4);
    for (let i = 0; i < p.w * p.h; i++) {
      if (p.printMask && !p.printMask[i]) continue;
      const c = C.hexToRgb(regionMapHex(p, i));
      out[i * 4] = c.r; out[i * 4 + 1] = c.g; out[i * 4 + 2] = c.b; out[i * 4 + 3] = 255;
    }
    return imageDataCanvas(new ImageData(out, p.w, p.h));
  }

  function printPlanReadme(p) {
    return [
      '叠彩 ChromaStack 打印计划包',
      '============================',
      `尺寸：${p.widthMm.toFixed(2)} × ${p.heightMm.toFixed(2)} mm`,
      `层高：${p.layerHeight} mm；纯色区 ${p.flatBaseLayers || 0} 层基底 + ${p.flatLayers - (p.flatBaseLayers || 0)} 层纯色（共 ${p.flatLayers} 层）；渐变区 ${p.gradStartLayer}–${p.gradTopLayer} 层（最高）；浮雕差 ${p.reliefMm.toFixed(2)} mm${p.variableHeight ? '；各色块顶高 '+(p.gradStartLayer*p.layerHeight).toFixed(2)+'–'+p.actualGradTopMm.toFixed(2)+' mm' : ''}`,
      (() => { const g = X.exportGridFor(p); return `导出网格：${g.width}×${g.height}${g.downscaled ? `（工作 ${p.w}×${p.h}，导出重新离散化）` : '（与工作网格一致）'}`; })(),
      `引擎：${p.engine === 'lut' ? '物理 LUT（Bambu PLA Basic 5 层）' : 'TD 立体浮雕（自定义耗材）'}；平滑 ${p.smoothMm != null ? p.smoothMm.toFixed(2) + ' mm (≈' + (p.smoothRadiusPx || 0) + 'px, 线宽 ' + (p.lineWidthMm || 0.42).toFixed(2) + 'mm)' : (p.smoothLevel || 0) + '/4'}；层序合并 ${p.mergeDeltaE || 0} ΔE`,
      '',
      '文件说明：',
      '- preview.png：最终颜色模拟图',
      '- region_map.png：纯色/渐变区域与预测颜色',
      '- print_plan.json / print_plan.md：完整配方、AMS 槽位、逐层耗材与切片建议',
      '- layer_maps/：每一层的颜色图（透明=该层没有材料）',
      '',
      '注意：本包不含 G-code。请使用 Chrome/Edge 打开 app 导出 3MF，再导入 Bambu Studio / OrcaSlicer。',
      'LUT 校准条件为 0.08 mm 层高、0.42 mm 线宽、白色基底；换批次/层高/线宽需重新标定。'
    ].join('\n');
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas toBlob failed')), 'image/png'));
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function currentCalibrationPalette() {
    return state.engine === 'lut' ? currentLutPalette() : state.tdPalette;
  }

  function downloadBatchPlate() {
    const palette = currentCalibrationPalette();
    if (!palette.length) { toast('请先添加需要标定的耗材'); return; }
    try {
      const { blob, meta } = CS.batchCalibration.buildBatchCalibrationBlob({ palette, layerHeight: state.layerHeight });
      state.batchLayout = meta.layout;
      state.batchPalette = palette.map(p => ({ ...p }));
      // P0/C04: persist the board identity (thickness manifest) so a later photo
      // analysis after refresh uses the SAME layer height, not a silent default.
      try { localStorage.setItem('chromastack.batch-layout.v1', JSON.stringify({ layout: meta.layout, palette: state.batchPalette })); } catch (e) { /* private mode */ }
      downloadBlob(blob, `批量标定板_${palette.length}种耗材.3mf`);
      const changes = meta.layout.layerFilaments.reduce((n, f, i) => n + (i > 0 && f !== meta.layout.layerFilaments[i - 1] ? 1 : 0), 0);
      $('batchCalibStatus').textContent = `已生成 ${palette.length} 色金字塔：${meta.layout.boardW}×${meta.layout.boardD} mm，高 ${meta.layout.maxHeight.toFixed(2)} mm。每个 Z 层仅一种耗材，仅 ${changes} 次段边界换色（擦料另计）；拍照时请让四个定位点完整入镜。`;
      toast('批量标定板已生成');
    } catch (e) { toast('标定板生成失败：' + (e.message || e)); }
  }

  /* ---- P2 combination calibration: board / observation import / atomic publish ---- */
  function downloadComboPlate() {
    const palette = currentCalibrationPalette();
    if (!palette.length) { toast('请先添加需要标定的耗材'); return; }
    try {
      const { blob, meta } = CS.calibrationJoint.buildComboBoardBlob(palette, { layerHeight: state.layerHeight });
      state.comboManifest = meta.manifest;
      downloadBlob(blob, `组合标定板_${palette.length}种_${state.layerHeight}mm.3mf`);
      $('comboCalibStatus').textContent = `组合板 ${meta.manifest.cells.length} 格（单材/正反序/多段/保留/重复），${meta.manifest.boardW}×${meta.manifest.boardD} mm，层高 ${state.layerHeight} mm；manifest 已内嵌，分析时读同一厚度。`;
      toast('组合标定板已生成');
    } catch (e) { toast('组合板生成失败：' + (e.message || e)); }
  }
  function importComboObservations(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(String(reader.result));
        if (!obj.manifest || !Array.isArray(obj.observations)) throw new Error('需要 {manifest, observations}');
        // F07: reject mismatched/tampered board info and non-finite model params on import.
        const mv = CS.calibrationData.validateManifest(obj.manifest);
        if (!mv.ok) throw new Error('标定板 manifest 校验失败：' + mv.error);
        if (obj.model) { const v = CS.calibrationData.validateV2({ schemaVersion: 2, models: [obj.model] }); if (!v.ok) throw new Error('模型校验失败：' + v.error); }
        state.comboObs = { manifest: obj.manifest, observations: obj.observations, relative: !!obj.relative, photoHash: obj.photoHash || '' };
        $('comboCalibStatus').textContent = `已导入 ${obj.observations.length} 条组合观测（manifest ${obj.manifest.manifestHash || '?'}${obj.relative ? '，相对标定' : ''}）。点击"联合拟合并发布模型"。`;
        toast('组合观测已导入');
      } catch (e) { toast('观测导入失败：' + (e.message || e)); }
    };
    reader.readAsText(file);
  }
  async function publishComboModel() {
    if (!state.comboObs) { toast('请先导入组合观测 JSON'); return; }
    try {
      const manifest = state.comboObs.manifest;
      const fitted = CS.calibrationJoint.fitJointModel(state.comboObs.observations, manifest, { relative: !!state.comboObs.relative });
      const sessionId = CS.calibrationData.makeSessionId(manifest, state.comboObs.photoHash || '');
      const session = { sessionId, manifestHash: manifest.manifestHash, observations: state.comboObs.observations };
      const pub = CS.calibrationJoint.publishModel(state.calibrationV2, fitted, session);
      if (!pub) {
        const reasons = (fitted.gate && fitted.gate.reasons) || [];
        $('comboCalibStatus').textContent = `未发布（保留原生效模型）：${reasons.length ? reasons.join('；') : 'held-out 超容差或存在未解决通道'}。最差留出 ΔE ${fitted.worstTestDE == null ? '—' : fitted.worstTestDE.toFixed(1)} / 平均 ${fitted.testDE == null ? '—' : fitted.testDE.toFixed(1)}。`;
        toast('拟合未达发布条件，保留原模型');
        return;
      }
      const prevV2 = state.calibrationV2;
      // Commit locally and push, then bind confirmation to the SERVER ACK (F06): a
      // local-only validate is not enough when a cloud profile is active.
      state.calibrationV2 = pub;
      CS.settings.save(state);
      let ack = null;
      if (CS.profiles && CS.profiles.activeId && CS.profiles.activeId()) {
        try { await CS.profiles.flush(false); } catch (e) { /* push failure surfaces via revision/conflict */ }
        const cached = CS.profiles.cachedData() || {};
        const ackV2 = cached.calibrationV2 || cached;
        ack = { profileId: CS.profiles.activeId(), revision: CS.profiles.revision(), activeModelId: ackV2 ? ackV2.activeModelId : null };
      }
      const confirm = CS.calibrationJoint.confirmPublish(pub, fitted.model.modelId, ack);
      if (!confirm.ok) {
        // F06: the server did not acknowledge — roll back to the previous active model
        // so local and cloud state cannot diverge into a false "published" claim.
        state.calibrationV2 = prevV2;
        CS.settings.save(state);
        $('comboCalibStatus').textContent = `发布未确认：${confirm.error}；已保留原生效模型。`;
        toast('发布事务确认失败：' + confirm.error + '；保留原模型');
        return;
      }
      // Lifecycle: a newly published model invalidates any stale plan so the next
      // compute uses the new activeModel (review m44 item 4). F01: keep manual region
      // locks + undo history — calibration does not change the image segmentation.
      state.plan = null; markDirty(false);
      $('comboCalibStatus').textContent = `已发布模型 ${fitted.model.modelId}（train ${fitted.trainLoss.toFixed(3)} / dev ${fitted.devDE == null ? '—' : fitted.devDE.toFixed(1)} / test ${fitted.testDE.toFixed(1)} / 最差 ${fitted.worstTestDE == null ? '—' : fitted.worstTestDE.toFixed(1)} ΔE），activeModelId 已原子切换${confirm.serverRevision != null ? `，服务器 revision ${confirm.serverRevision} 已确认` : '并确认'}；留存 ${confirm.observations} 条观测，适用域层高 ${confirm.domain ? confirm.domain.layerHeightMm : '?'} mm；旧计划已失效，请重新计算。`;
      toast('组合标定模型已发布并确认，旧计划已失效');
    } catch (e) { toast('发布失败：' + (e.message || e)); }
  }

  function showBatchPhotoResult(result, imageData) {
    state.batchPhotoResult = result;
    const canvas = $('batchPhotoCanvas');
    canvas.width = imageData.width; canvas.height = imageData.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(imageData, 0, 0);
    ctx.lineWidth = Math.max(2, Math.round(imageData.width / 700));
    for (const m of result.markers) {
      ctx.strokeStyle = '#55ff88'; ctx.beginPath(); ctx.arc(m.cx, m.cy, 8, 0, Math.PI * 2); ctx.stroke();
    }
    for (const r of result.results) {
      ctx.strokeStyle = '#55ff88'; ctx.lineWidth = Math.max(1, Math.round(imageData.width / 900));
      for (const s of r.samples) { ctx.strokeRect(s.x - 4, s.y - 4, 8, 8); }
      ctx.strokeStyle = '#ffe16b'; ctx.strokeRect(r.railSample.x - 5, r.railSample.y - 5, 10, 10);
    }
    const checks = result.matrixChecks ? ` · 混色交叉验证 ΔE 平均 ${result.matrixChecks.meanDE.toFixed(1)} / 最大 ${result.matrixChecks.maxDE.toFixed(1)}` : '';
    $('batchPhotoSummary').textContent = `拟合残差分数 ${(result.score * 100).toFixed(0)}%（非准确率） · 白平衡增益 ${result.whiteBalance.gains.map(g => g.toFixed(2)).join(' / ')}${checks}`;
    const warn = $('batchPhotoWarn');
    const unresolved = result.results.filter(r => (r.channelState || []).some(s => s === 'unresolved'));
    if (unresolved.length) {
      warn.hidden = false;
      warn.textContent = `缺信息通道，禁止应用：${unresolved.map(r => `${r.name}(${(r.channelState || []).map((s, i) => s === 'unresolved' ? 'RGB'[i] : '').filter(Boolean).join('/')})`).join('、')} 的观测饱和/无对比，无法解出该通道；不会伪造 TD 值。请补拍或保留原标定。`;
    } else if (result.matrixChecks && result.matrixChecks.meanDE > 6) {
      warn.hidden = false;
      warn.textContent = matrixPhotoBad(result)
        ? '交叉验证色差过大，禁止应用：照片疑似经过 HDR/AI 场景优化/美颜（黑底被提亮、白底被压暗、颜色被加饱和），或反光/阴影严重。请关闭 HDR 与 AI 优化、用均匀漫射光重拍后再识别。'
        : (result.matrixChecks.meanDE > 10
          ? '交叉验证色差偏大，但单色锚点自洽：混色格可能受换色冲刷不足污染（如 R>K 发灰）。单色锚点解出的 HD/TD 仍可用，请核对采样框后自行决定是否应用。'
          : '交叉验证色差偏大：请检查反光、阴影与对焦，必要时关闭 HDR/AI 优化重拍；应用前请自行确认采样框对齐。');
    } else { warn.hidden = true; warn.textContent = ''; }
    const fmtTd = v => v == null ? '—' : v.toFixed(2);
    const stateLabel = s => s === 'estimated' ? '' : s === 'bounded' ? '界' : '缺';
    $('batchPhotoResults').innerHTML = result.results.map(r => `<div class="family-item"><span class="family-swatch" style="background:${r.hex}"></span><b>${esc(r.name)}</b> · ${r.hex} · TD R/G/B ${fmtTd(r.tdR)}/${fmtTd(r.tdG)}/${fmtTd(r.tdB)}${(r.channelState || []).some(s => s !== 'estimated') ? ' · ' + (r.channelState || []).map((s, i) => s !== 'estimated' ? 'RGB'[i] + stateLabel(s) : '').filter(Boolean).join(' ') : ''} · 残差分数 ${(r.score * 100).toFixed(0)}%</div>`).join('');
    openModal('batchPhotoModal');
  }

  function analyzeBatchPhotoFile(file) {
    if (!file) return;
    // P0/C04: recover the persisted board identity before choosing palette/layout.
    if (!state.batchLayout) {
      try {
        const persisted = JSON.parse(localStorage.getItem('chromastack.batch-layout.v1') || 'null');
        if (persisted && persisted.layout) { state.batchLayout = persisted.layout; state.batchPalette = persisted.palette; }
      } catch (e) { /* ignore */ }
    }
    const palette = state.batchLayout && state.batchPalette ? state.batchPalette : currentCalibrationPalette();
    if (!palette.length) { toast('请先添加需要标定的耗材'); return; }
    const layout = CS.batchCalibration.resolveAnalysisLayout(palette, state.batchLayout);
    if (!layout) { toast('缺少标定板身份（层高 manifest）：请重新生成标定板后再识别；不会按默认 0.08 mm 猜测旧板厚度'); return; }
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = CS.batchCalibration.analyzeBatchPhoto(imageData, palette, { layout });
        showBatchPhotoResult(result, imageData);
      } catch (e) {
        console.error(e);
        toast('照片识别失败：' + (e.message || e));
      } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('标定照片读取失败'); };
    img.src = url;
  }

  function analyzeMatrixPhotoFile(file) {
    if (!file) return;
    const palette = currentCalibrationPalette();
    const version = ($('matrixBoardType') && $('matrixBoardType').value) || 'v2';
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = CS.matrixCalibration.analyzeMatrixPhoto(imageData, palette, { version });
        showBatchPhotoResult(result, imageData);
        $('matrixCalibStatus').textContent = `矩阵识别完成（${version === 'v1' ? '75mm 四色旧板' : '100mm 六色板'}）：混色交叉验证平均 ΔE ${result.matrixChecks.meanDE.toFixed(1)}、最大 ${result.matrixChecks.maxDE.toFixed(1)}。请在弹窗核对采样框与定位点后应用。`;
      } catch (e) {
        console.error(e);
        toast('矩阵照片识别失败：' + (e.message || e));
      } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('矩阵照片读取失败'); };
    img.src = url;
  }

  /* Distinguish a radiometrically broken photo (phone HDR/AI: lifted blacks,
     compressed whites, gain > 1) from a good photo of a board whose mixed cells
     suffer purge contamination — the latter's single anchors are still valid. */
  function matrixPhotoBad(result) {
    const q = result.quality;
    if (!q) return true;
    const y = rgb => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return q.gainsMax > 1.15 || y(q.blackBase) > 45 || q.whiteFitError > 150;
  }

  function applyBatchPhoto() {
    const result = state.batchPhotoResult;
    if (!result) return;
    // P0: missing channel information must never be saved as a measurement.
    if (!CS.matrixCalibration.canPublish(result.results)) {
      const bad = result.results.filter(r => (r.channelState || []).some(s => s === 'unresolved')).map(r => r.name).join('、');
      toast(`已阻止应用：${bad || '部分耗材'} 存在未解决通道（观测缺信息），不能写成标定值；请补拍该通道或保留原标定`);
      return;
    }
    // F05: pyramid/batch path — bound-only / unidentifiable fits must not be saved as
    // photo calibration (nominal TD would otherwise masquerade as a measurement).
    const nominal = (result.results || []).filter(r => r.opaqueFit === false);
    if (nominal.length) {
      toast(`已阻止应用：${nominal.map(r => r.name).join('、')} 信息不足（仅界限/名义值），不能保存为照片标定；请补拍或保留原标定`);
      return;
    }
    if (result.matrixChecks && result.matrixChecks.meanDE > 10 && matrixPhotoBad(result)) {
      toast('交叉验证色差过大，已阻止应用：请关闭 HDR/AI 优化并用均匀漫射光重拍');
      return;
    }
    const palette = currentCalibrationPalette();
    for (const r of result.results) {
      const index = palette.findIndex(p => (r.id && p.id === r.id) || (p.name === r.name && p.brand === r.brand && p.material === r.material));
      const p = index >= 0 ? palette[index] : palette[r.index];
      if (!p) continue;
      const tdR = r.tdR != null ? r.tdR : r.td;
      const tdG = r.tdG != null ? r.tdG : r.td;
      const tdB = r.tdB != null ? r.tdB : r.td;
      p.hex = r.hex; p.td = r.td; p.tdR = tdR; p.tdG = tdG; p.tdB = tdB;
      const key = CS.settings.filamentKey(p);
      state.filamentCalibrations[key] = {
        id: p.id || '', name: p.name, brand: p.brand || '', material: p.material || 'PLA',
        hex: r.hex, td: r.td, tdR, tdG, tdB, source: 'photo', score: r.score, channelState: r.channelState || null, updatedAt: Date.now()
      };
      if (state.engine === 'lut') {
        const tdOverrides = state.lutTdOverrides[state.lutKey] || (state.lutTdOverrides[state.lutKey] = {});
        const hexOverrides = state.lutHexOverrides[state.lutKey] || (state.lutHexOverrides[state.lutKey] = {});
        tdOverrides[index >= 0 ? index : r.index] = r.td; hexOverrides[index >= 0 ? index : r.index] = r.hex;
      }
    }
    renderPalette();
    markDirty(false);
    closeModal('batchPhotoModal');
    toast(`已应用并保存 ${result.results.length} 种耗材的照片标定`);
  }

  /* ---------------- calibration ---------------- */
  function openCalibration() {
    if (state.dirty || state.analyzing) { toast('请先计算并应用当前修改，再进行标定'); return; }
    const palette = state.engine === 'lut' ? currentLutPalette() : state.tdPalette;
    const sel = $('calibFilament');
    sel.innerHTML = palette.map((p, i) => `<option value="${i}">${esc(p.name)} · ${esc(p.hex)}</option>`).join('');
    sel.value = '0';
    $('calibLayer').value = String(state.engine === 'lut' ? 0.08 : state.layerHeight);
    $('calibPatches').value = '10';
    $('calibResult').textContent = '—';
    openModal('calibrationModal');
  }

  function solveTStar(fgHex, bgHex, jnd = 2) {
    const fgLab = C.hexToLab(fgHex), bgLab = C.hexToLab(bgHex);
    if (C.deltaE2000(fgLab, bgLab) < jnd + 0.2) return null;
    const fg = C.hexToRgb01(fgHex), bg = C.hexToRgb01(bgHex);
    const fgLin = { r: C.srgbToLinear(fg.r), g: C.srgbToLinear(fg.g), b: C.srgbToLinear(fg.b) };
    const bgLin = { r: C.srgbToLinear(bg.r), g: C.srgbToLinear(bg.g), b: C.srgbToLinear(bg.b) };
    const labAt = (T) => {
      const lin = {
        r: fgLin.r * (1 - T) + bgLin.r * T,
        g: fgLin.g * (1 - T) + bgLin.g * T,
        b: fgLin.b * (1 - T) + bgLin.b * T
      };
      return C.rgb01ToLab({ r: C.linearToSrgb(lin.r), g: C.linearToSrgb(lin.g), b: C.linearToSrgb(lin.b) });
    };
    let lo = 0, hi = 1;
    if (C.deltaE2000(labAt(hi), fgLab) < jnd) return null;
    for (let i = 0; i < 44; i++) {
      const mid = (lo + hi) / 2;
      if (C.deltaE2000(labAt(mid), fgLab) >= jnd) hi = mid; else lo = mid;
    }
    return hi;
  }

  function downloadCalibration() {
    const palette = state.engine === 'lut' ? currentLutPalette() : state.tdPalette;
    const i = Number($('calibFilament').value) || 0;
    const p = palette[i];
    if (!p) { toast('先选择耗材'); return; }
    const baseHex = $('calibBase').value;
    const baseName = baseHex.toLowerCase() === '#ffffff' ? '白色基底' : '黑色基底';
    const patches = clamp(Number($('calibPatches').value) || 10, 4, 24);
    const layerHeight = clamp(Number($('calibLayer').value) || 0.08, 0.02, 0.4);
    try {
      const { blob } = CS.calibration.buildCalibrationBlob({
        targetName: p.name, targetHex: p.hex, baseHex, baseName, patches, layerHeight
      });
      downloadBlob(blob, `标定楔形_${p.name}_${patches}片_${layerHeight}mm.3mf`);
      toast(`已生成 ${patches} 片楔形：第 1 片 ${layerHeight} mm，逐片加高；旁边是 ${patches} 层参考条。`);
    } catch (e) {
      console.error(e);
      toast('标定楔形生成失败：' + (e.message || e));
    }
  }

  function computeCalibration() {
    if (state.dirty || state.analyzing) { toast('请先计算并应用当前修改，再写入标定'); return; }
    const palette = state.engine === 'lut' ? currentLutPalette() : state.tdPalette;
    const i = Number($('calibFilament').value) || 0;
    const p = palette[i];
    if (!p) { toast('先选择耗材'); return; }
    const base = $('calibBase').value;
    const h = clamp(Number($('calibLayer').value) || 0.08, 0.02, 0.4);
    const k = clamp(Number($('calibPatch').value) || 1, 1, 60);
    const d = k * h;
    const T = solveTStar(p.hex, base, 2);
    if (T == null || !(T > 0 && T < 1)) {
      toast('底色与耗材色差太小，无法用这个底色标定；换黑/白底或改用更长的楔形。');
      return;
    }
    const HD = -d / Math.log10(T);
    const TD = clamp(HD * 10, 0.1, 20);
    if (state.engine === 'td') {
      Object.assign(state.tdPalette[i], CS.settings.uniformTd(Number(TD.toFixed(2))));
      renderPalette();
      markDirty(false);
    } else {
      const overrides = state.lutTdOverrides[state.lutKey] || (state.lutTdOverrides[state.lutKey] = {});
      overrides[i] = Number(TD.toFixed(2));
      renderPalette();
      markDirty(false);
    }
    $('calibResult').textContent = `T* ${(T * 100).toFixed(1)}% · HD ${HD.toFixed(3)} mm · TD ${TD.toFixed(2)}`;
    toast(`已更新 ${p.name} 的 TD 为 ${TD.toFixed(2)}`);
  }

  /* ---------------- modals / toast / progress ---------------- */
  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
  }

  function showProgress(text) {
    $('progressText').textContent = text || '处理中…';
    $('progressOverlay').hidden = false;
  }
  function hideProgress() { $('progressOverlay').hidden = true; }

  /* labels initial */
  $('stdValue').textContent = '自动';
  $('resValue').textContent = '5.0 ΔE';
  $('areaValue').textContent = '0.6%';
  $('familiesValue').textContent = '192';
  $('smoothValue').textContent = '—';
  $('lineWidthHint').textContent = `平滑 ≥ ${(state.lineWidthMm * 2).toFixed(2)} mm`;
  $('mergeValue').textContent = '4.0';

  window.__chromastack = { state, CS };

  // Automated-acceptance handle: the real state, option builder and brush
  // primitives so tests can run state -> buildOptions -> buildPlan end to end
  // without a browser. Internal diagnostics only, not a user-facing feature.
  CS.appDebug = { state, buildOptions, ensureBrushCanvas, applyPaint, snapshotUndo, undoBrush, clearBrush, clearManualEdits, rebaseBrushCanvas, markDirty, resetSettings, publishComboModel, actualTopLayer, actualHeightStats, regionMapHex, runPlanInWorker, exportPreviewPlan, exportConfirmMessage, build3MFParallel };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
