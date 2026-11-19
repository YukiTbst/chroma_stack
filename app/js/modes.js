/* Result-level use-case presets. A preset is a documented bundle of existing
   engine parameters; the user can still adjust everything afterwards. */
(function (root) {
  'use strict';
  const CS = root.CS = root.CS || {};

  const MODES = [
    { id: 'custom', label: '自定义（当前参数）' },
    { id: 'sticker', label: '贴纸 / 动漫：等高、黑线直印' },
    { id: 'photo', label: '照片 / 绘画：保留渐变与浮雕' },
    { id: 'pixel', label: '像素画 / 硬边：不吸附、不补线' }
  ];

  /* Values are partial state fields; null id means "leave everything". */
  function preset(id) {
    if (id === 'sticker') {
      return {
        lineProtect: 'strong', variableHeight: false, reliefMm: 0,
        edgeClean: 1, vectorFlat: false, smoothMm: 0.4, minFlatPercent: 0.2,
        edgeSnap: true, lineRepair: true
      };
    }
    if (id === 'photo') {
      return {
        lineProtect: 'auto', variableHeight: true, reliefMm: 0.16,
        edgeClean: 2, vectorFlat: false, smoothMm: 0.8, minFlatPercent: 0.2,
        edgeSnap: true, lineRepair: true
      };
    }
    if (id === 'pixel') {
      return {
        lineProtect: 'off', variableHeight: false, reliefMm: 0,
        edgeClean: 0, vectorFlat: false, smoothMm: 0, minFlatPercent: 0.6,
        edgeSnap: false, lineRepair: false
      };
    }
    return null;
  }

  function label(id) {
    const m = MODES.find(x => x.id === id);
    return m ? m.label : '自定义';
  }

  CS.modes = { list: () => MODES.slice(), preset, label };
})(typeof globalThis !== 'undefined' ? globalThis : this);