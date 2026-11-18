"""Generate the 100 mm six-filament TD calibration matrix (multi-colour per layer).

Design goals vs the old 75 mm board:
- Anchors at 1/2/4/8 layers (0.08/0.16/0.32/0.64 mm) on BOTH black and white
  bases, so semi-opaque filaments keep three measurable thickness points instead
  of a single one.
- Six filaments: black, white, orange, yellow, cyan, magenta (AMS 1..6).
- 16 cross-colour recipe cells (8 per base) for independent ΔE cross-checks.

Layer budget: first layer 0.24 mm, subsequent 0.08 mm; base = 2 layers = 0.32 mm;
colour layers 3..10; max height 0.96 mm.
"""
from pathlib import Path
import json
import zipfile
from xml.sax.saxutils import escape

OUT = Path(r'D:\3d models\HybridColorPrint\tests\ChromaStack_TD_Matrix_100mm_6color.3mf')
BOARD = 100.0
FIRST_LAYER = 0.24
LAYER = 0.08
BASE_LAYERS = 2
BASE_HEIGHT = FIRST_LAYER + LAYER
STEPS = [1, 2, 4, 8]
TOTAL_LAYERS = BASE_LAYERS + max(STEPS)
MAX_HEIGHT = FIRST_LAYER + (TOTAL_LAYERS - 1) * LAYER

# AMS slots 1..6 in print order.
PALETTE = [
    {'code': 'K', 'name': 'Black',   'hex': '#000000', 'hd': 0.30, 'ams': 1},
    {'code': 'W', 'name': 'White',   'hex': '#ffffff', 'hd': 0.50, 'ams': 2},
    {'code': 'O', 'name': 'Orange',  'hex': '#ff6a13', 'hd': 0.70, 'ams': 3},
    {'code': 'Y', 'name': 'Yellow',  'hex': '#fce300', 'hd': 0.80, 'ams': 4},
    {'code': 'C', 'name': 'Cyan',    'hex': '#0086d6', 'hd': 0.90, 'ams': 5},
    {'code': 'M', 'name': 'Magenta', 'hex': '#ec008c', 'hd': 0.65, 'ams': 6},
]
INDEX = {p['code']: i for i, p in enumerate(PALETTE)}
FILAMENTS = [p['code'] for p in PALETTE]

MIX_BLACK = [['W', 'O'], ['O', 'W'], ['W', 'M'], ['M', 'W'],
             ['W', 'Y'], ['Y', 'W'], ['W', 'C'], ['C', 'W']]
MIX_WHITE = [['O', 'Y'], ['Y', 'O'], ['C', 'M'], ['M', 'C'],
             ['O', 'M'], ['M', 'O'], ['Y', 'C'], ['C', 'Y']]

MARGIN = 8.0
SEAM_GAP = 2.0          # keep the white half's top-row substrate strip on white
PITCH = 10.5
CELL = 9.0


def add_box(objects, material, x0, y0, z0, x1, y1, z1):
    pos = objects[material]['pos']
    idx = objects[material]['idx']
    x0 -= BOARD / 2
    x1 -= BOARD / 2
    # Flip Y into model space the same way the web exporter does
    # (image row 0 -> model +Y). Without this the printed board comes out
    # vertically mirrored relative to the metadata/preview.
    y0, y1 = BOARD / 2 - y1, BOARD / 2 - y0
    base = len(pos) // 3
    for v in [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
              (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]:
        pos.extend(v)
    for a, b, c in [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
                    (0, 1, 5), (0, 5, 4), (3, 7, 6), (3, 6, 2),
                    (0, 4, 7), (0, 7, 3), (1, 2, 6), (1, 6, 5)]:
        idx.extend((base + a, base + b, base + c))


objects = {p['code']: {'pos': [], 'idx': []} for p in PALETTE}

# Two-layer substrate halves: black on top (y < 50), white on bottom.
add_box(objects, 'K', 0, 0, 0, BOARD, BOARD / 2, BASE_HEIGHT)
add_box(objects, 'W', 0, BOARD / 2, 0, BOARD, BOARD, BASE_HEIGHT)

cells = []
for side in (0, 1):
    base = 'K' if side == 0 else 'W'
    mixes = MIX_BLACK if side == 0 else MIX_WHITE
    for row in range(4):
        for col in range(8):
            x = MARGIN + col * PITCH
            side_top = MARGIN if side == 0 else BOARD / 2 + SEAM_GAP
            y = side_top + row * PITCH
            cx, cy = x + CELL / 2, y + CELL / 2
            if col < 6:
                f = FILAMENTS[col]
                recipe = [f] * STEPS[row]
                cell = {'id': f'{"B" if side == 0 else "W"}-{row + 1}{col + 1}',
                        'x': x, 'y': y, 'size': CELL, 'cx': cx, 'cy': cy,
                        'base': base, 'kind': 'single', 'filament': f,
                        'recipe': recipe, 'layers': len(recipe)}
            else:
                recipe = mixes[(row * 2) + (col - 6)]
                cell = {'id': f'{"B" if side == 0 else "W"}-{row + 1}{col + 1}',
                        'x': x, 'y': y, 'size': CELL, 'cx': cx, 'cy': cy,
                        'base': base, 'kind': 'mixed',
                        'recipe': recipe, 'layers': len(recipe)}
            cells.append(cell)
            z = BASE_HEIGHT
            i = 0
            while i < len(recipe):
                j = i
                while j + 1 < len(recipe) and recipe[j + 1] == recipe[i]:
                    j += 1
                count = j - i + 1
                add_box(objects, recipe[i], x, y, z, x + CELL, y + CELL, z + count * LAYER)
                z += count * LAYER
                i = j + 1

# Corner markers: white on the black half, black on the white half, 2 layers.
markers = []
for x, y, f in [(1.5, 1.5, 'W'), (95.5, 1.5, 'W'), (95.5, 95.5, 'K'), (1.5, 95.5, 'K')]:
    add_box(objects, f, x, y, BASE_HEIGHT, x + 3, y + 3, BASE_HEIGHT + 2 * LAYER)
    markers.append({'x': x, 'y': y, 'cx': x + 1.5, 'cy': y + 1.5, 'size': 3,
                    'filament': f, 'z0': BASE_HEIGHT, 'z1': BASE_HEIGHT + 2 * LAYER})

base_samples = {
    'K': [[20, 4], [80, 4], [50, 17.75]],
    'W': [[20, 96], [80, 96], [50, 82.25]],
}

layer_materials = []
for layer in range(TOTAL_LAYERS):
    if layer < BASE_LAYERS:
        active = ['K', 'W']
    else:
        active = [f for f in FILAMENTS if any(f in c['recipe'] for c in cells)]
        if layer - BASE_LAYERS < 2:
            active = sorted(set(active) | {m['filament'] for m in markers}, key=FILAMENTS.index)
    layer_materials.append([INDEX[f] for f in active])

metadata = {
    'app': 'ChromaStack TD Matrix',
    'version': 2,
    'boardMm': [BOARD, BOARD],
    'firstLayerHeight': FIRST_LAYER,
    'layerHeight': LAYER,
    'baseLayers': BASE_LAYERS,
    'baseHeight': BASE_HEIGHT,
    'totalLayers': TOTAL_LAYERS,
    'maxHeight': MAX_HEIGHT,
    'steps': STEPS,
    'printMode': 'multi-filament-per-layer',
    'palette': PALETTE,
    'cells': cells,
    'markers': markers,
    'baseSamples': base_samples,
    'layerMaterials': layer_materials,
    'note': 'L1=0.24mm; L2-L10=0.08mm. Anchors 1/2/4/8 layers on black+white bases; 16 two-layer cross-colour cells.',
}

parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">',
    ' <metadata name="Application">ChromaStack TD Matrix</metadata>',
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>',
    ' <resources>',
    '  <basematerials id="1">',
]
for p in PALETTE:
    parts.append(f'   <base name="{p["name"]}" displaycolor="{p["hex"].upper()}FF" />')
parts.append('  </basematerials>')
for i, p in enumerate(PALETTE):
    data = objects[p['code']]
    parts.append(f'  <object id="{i + 2}" type="model" pid="1" pindex="{i}" name="{p["name"]} · AMS {p["ams"]} · 基底与色格">')
    parts.append('   <mesh><vertices>')
    pos = data['pos']
    for j in range(0, len(pos), 3):
        parts.append(f'    <vertex x="{pos[j]:.4f}" y="{pos[j + 1]:.4f}" z="{pos[j + 2]:.4f}" />')
    parts.append('   </vertices><triangles>')
    idx = data['idx']
    for j in range(0, len(idx), 3):
        parts.append(f'    <triangle v1="{idx[j]}" v2="{idx[j + 1]}" v3="{idx[j + 2]}" />')
    parts.append('   </triangles></mesh>')
    parts.append('  </object>')
assembly_id = len(PALETTE) + 2
parts.append(f'  <object id="{assembly_id}" type="model" name="ChromaStack_TD_Matrix_100mm_6color"><components>')
for i in range(len(PALETTE)):
    parts.append(f'   <component objectid="{i + 2}" />')
parts.extend(['  </components></object>', ' </resources>', f' <build><item objectid="{assembly_id}" /></build></model>'])

model_settings = f'''<?xml version="1.0" encoding="UTF-8"?>
<config>
 <object id="{assembly_id}">
  <metadata key="name" value="ChromaStack TD Matrix 100mm 6colour"/>
  <metadata key="extruder" value="1"/>
{chr(10).join(f'  <part id="{i + 2}" subtype="normal_part"><metadata key="name" value="{escape(p["name"])}"/><metadata key="extruder" value="{p["ams"]}"/></part>' for i, p in enumerate(PALETTE))}
 </object>
 <plate>
  <metadata key="plater_id" value="1"/><metadata key="plater_name" value="TD Matrix 100mm 6colour"/><metadata key="locked" value="false"/>
  <model_instance><metadata key="object_id" value="{assembly_id}"/><metadata key="instance_id" value="0"/></model_instance>
 </plate>
 <assemble><assemble_item object_id="{assembly_id}" instance_id="0" transform="1 0 0 0 1 0 0 0 1 90 90 0" offset="0 0 0" /></assemble>
</config>'''
content_types = '''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="config" ContentType="text/xml"/>
 <Default Extension="json" ContentType="application/json"/>
 <Override PartName="/Metadata/model_settings.config" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Override PartName="/Metadata/chromastack-td-matrix.json" ContentType="application/json"/>
</Types>'''
rels = '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>'''

assert TOTAL_LAYERS == 10 and abs(MAX_HEIGHT - 0.96) < 1e-9
assert len(cells) == 64 and sum(c['kind'] == 'mixed' for c in cells) == 16
assert all(len(m) == 6 for m in layer_materials[2:])
with zipfile.ZipFile(OUT, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    z.writestr('[Content_Types].xml', content_types)
    z.writestr('_rels/.rels', rels)
    z.writestr('3D/3dmodel.model', '\n'.join(parts))
    z.writestr('Metadata/model_settings.config', model_settings)
    z.writestr('Metadata/chromastack-td-matrix.json', json.dumps(metadata, ensure_ascii=False, indent=2))
print(OUT)
print(f'100 x 100 x {MAX_HEIGHT:.2f} mm; {TOTAL_LAYERS} layers; 64 cells (48 anchors + 16 mixes); AMS K/W/O/Y/C/M')
print('global material changes lower bound:', sum(len(m) for m in layer_materials) - 1)