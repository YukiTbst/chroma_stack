/* Two-material calibration wedge: N stepped patches + a fully opaque reference rail.
   Generates a slicer-ready 3MF (base filament + target filament). */
(function (root) {
  'use strict';
  const CS = root.CS = root.CS || {};
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const round = (v, d = 4) => { const p = Math.pow(10, d); return Math.round(v * p) / p; };
  const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function addBox(positions, indices, x0, y0, z0, x1, y1, z1) {
    const base = positions.length / 3;
    const v = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]
    ];
    for (const p of v) positions.push(p[0], p[1], p[2]);
    const faces = [
      [0, 2, 1], [0, 3, 2],
      [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4],
      [3, 7, 6], [3, 6, 2],
      [0, 4, 7], [0, 7, 3],
      [1, 2, 6], [1, 6, 5]
    ];
    for (const f of faces) indices.push(base + f[0], base + f[1], base + f[2]);
  }

  function buildCalibration3MF(options = {}) {
    const targetName = String(options.targetName || '目标耗材').slice(0, 40);
    const targetHex = String(options.targetHex || '#c00d1e').replace('#', '').toUpperCase();
    const baseHex = String(options.baseHex || '#000000').replace('#', '').toUpperCase();
    const baseName = String(options.baseName || (baseHex === 'FFFFFF' ? '白色基底' : '黑色基底')).slice(0, 40);
    const patches = clamp(Math.round(Number(options.patches) || 10), 4, 24);
    const layerHeight = clamp(Number(options.layerHeight) || 0.08, 0.02, 0.4);
    const baseHeight = 2.0;
    const bw = 8.0, bd = 10.0, gap = 2.0, margin = 5.0;
    const railY = margin + bd + 4.0, railD = 6.0;
    const boardW = patches * bw + (patches - 1) * gap + margin * 2;
    const boardD = railY + railD + margin;
    const cx = boardW / 2, cy = boardD / 2;
    const basePos = [], baseIdx = [], targetPos = [], targetIdx = [];
    addBox(basePos, baseIdx, -cx, -cy, 0, boardW - cx, boardD - cy, baseHeight);
    for (let i = 0; i < patches; i++) {
      const x0 = -cx + margin + i * (bw + gap);
      const x1 = x0 + bw;
      const y0 = -cy + margin, y1 = y0 + bd;
      addBox(targetPos, targetIdx, x0, y0, baseHeight, x1, y1, baseHeight + (i + 1) * layerHeight);
    }
    const railX0 = -cx + margin;
    const railX1 = railX0 + patches * bw + (patches - 1) * gap;
    const railY0 = -cy + railY, railY1 = railY0 + railD;
    addBox(targetPos, targetIdx, railX0, railY0, baseHeight, railX1, railY1, baseHeight + patches * layerHeight);

    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    parts.push('<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">');
    parts.push(' <metadata name="Application">ChromaStack Calibration</metadata>');
    parts.push(' <metadata name="BambuStudio:3mfVersion">1</metadata>');
    parts.push(' <resources>');
    parts.push('  <basematerials id="1">');
    parts.push(`   <base name="${escapeXml(baseName)}" displaycolor="#${baseHex}FF" />`);
    parts.push(`   <base name="${escapeXml(targetName)}" displaycolor="#${targetHex}FF" />`);
    parts.push('  </basematerials>');
    const writeObj = (id, name, pindex, pos, idx) => {
      parts.push(`  <object id="${id}" type="model" pid="1" pindex="${pindex}" name="${escapeXml(name)}">`);
      parts.push('   <mesh><vertices>');
      for (let i = 0; i < pos.length; i += 3) parts.push(`    <vertex x="${round(pos[i])}" y="${round(pos[i + 1])}" z="${round(pos[i + 2])}" />`);
      parts.push('   </vertices><triangles>');
      for (let i = 0; i < idx.length; i += 3) parts.push(`    <triangle v1="${idx[i]}" v2="${idx[i + 1]}" v3="${idx[i + 2]}" />`);
      parts.push('   </triangles></mesh>');
      parts.push('  </object>');
    };
    writeObj(2, baseName, 0, basePos, baseIdx);
    writeObj(3, targetName + ' 阶梯与参考条', 1, targetPos, targetIdx);
    parts.push('  <object id="4" type="model" name="Calibration_Wedge"><components>');
    parts.push('   <component objectid="2" /><component objectid="3" />');
    parts.push('  </components></object>');
    parts.push(' </resources><build><item objectid="4" /></build></model>');

    const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
 <object id="4">
  <metadata key="name" value="ChromaStack Calibration Wedge"/>
  <metadata key="extruder" value="1"/>
  <part id="2" subtype="normal_part"><metadata key="name" value="${escapeXml(baseName)}"/><metadata key="extruder" value="1"/></part>
  <part id="3" subtype="normal_part"><metadata key="name" value="${escapeXml(targetName)}"/><metadata key="extruder" value="2"/></part>
 </object>
 <plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value=""/><metadata key="locked" value="false"/>
  <model_instance><metadata key="object_id" value="4"/><metadata key="instance_id" value="0"/></model_instance>
 </plate>
 <assemble><assemble_item object_id="4" instance_id="0" transform="1 0 0 0 1 0 0 0 1 128 128 0" offset="0 0 0" /></assemble>
</config>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="config" ContentType="text/xml"/>
 <Default Extension="json" ContentType="application/json"/>
</Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
    const meta = {
      app: 'ChromaStack Calibration', target: targetName, targetHex: '#' + targetHex,
      base: baseName, baseHex: '#' + baseHex, patches, layerHeight, baseHeight,
      patchTopMm: Array.from({ length: patches }, (_, i) => +(baseHeight + (i + 1) * layerHeight).toFixed(3)),
      railTopMm: +(baseHeight + patches * layerHeight).toFixed(3),
      boardMm: [+boardW.toFixed(2), +boardD.toFixed(2)]
    };
    const projectSettings = {
      layer_height: String(layerHeight), initial_layer_print_height: String(baseHeight),
      wall_loops: '2', sparse_infill_density: '100%',
      printer_model: 'ChromaStack', printer_settings_id: 'ChromaStack 0.4 nozzle',
      nozzle_diameter: ['0.4'], printable_height: '256',
      filament_colour: ['#' + baseHex, '#' + targetHex],
      filament_type: ['PLA', 'PLA'],
      filament_settings_id: ['Generic PLA @ChromaStack 0.4 nozzle', 'Generic PLA @ChromaStack 0.4 nozzle'],
      filament_vendor: ['Generic', 'Generic']
    };
    const files = [
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rels },
      { name: '3D/3dmodel.model', data: parts.join('\n') },
      { name: 'Metadata/model_settings.config', data: modelSettings },
      { name: 'Metadata/project_settings.config', data: JSON.stringify(projectSettings, null, 2) },
      { name: 'Metadata/chromastack-calibration.json', data: JSON.stringify(meta, null, 2) }
    ];
    const bytes = CS.zip.createZip(files);
    return { bytes, meta };
  }

  function buildCalibrationBlob(options) {
    const out = buildCalibration3MF(options);
    return { blob: new Blob([out.bytes], { type: 'model/3mf' }), meta: out.meta };
  }

  CS.calibration = { buildCalibration3MF, buildCalibrationBlob, addBox };
})(typeof globalThis !== 'undefined' ? globalThis : this);
